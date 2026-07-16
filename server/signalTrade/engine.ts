// トレードシグナルの「紙(表示専用)エンジン」。
//
//   FLAT ──(一定間隔で AI scalp-plan)──▶ ARMED(ブラケット: 指値+逆指値の新規, 各初期LC)
//   ARMED ─(現在値が entry を跨ぐ=擬似約定, 他レッグは自動キャンセル)─▶ FILLED(保有)
//   FILLED ─(非公開 phase-exit がラチェット決済逆指値を動かし、現在値が達したら擬似決済)─▶ FLAT
//
// 実発注・endpoint・売買命令送信は一切持たない。SSE の現在値 tick だけで擬似約定/擬似決済し、
// 決済確定ごとに signal_trades へ1行 INSERT する。trade2(forward.db/engine/API)には触れない。
//
// 約定判定・phase 遷移・equity 集計は純関数(下記 export)にして単体テストする。
// LLM(buildScalpPlan)は dynamic import で遅延ロードし、engine の静的 import を軽く保つ。

import type { SignalTradeState } from '../types.js';
import { computeExitStop, loadExitImpl } from './exit/index.js';
import { broadcast } from '../sse/broker.js';
import { getPrices } from '../cache.js';
import { openDb, resolveDbPath, insertSignalTrade } from '../db/store.js';
import { inPollWindow } from '../../collector/session.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { shouldRearmOnLevel, rearmBounds } from './levelGate.js';

const NIKKEI_SYMBOL = 'NIY=F';
const QTY = 1;   // 紙トラッキングは常に1枚。

// ─── 型 ───────────────────────────────────────────────

export type SignalPhase = 'flat' | 'armed' | 'filled';

export interface ArmedBracket {
  direction: 'buy' | 'sell';
  limitEntry?: number;
  stopEntry?: number;
  stopLossForLimit?: number;
  stopLossForStop?: number;
  rationale: string;
  at: number;
}

export interface OpenPosition {
  direction: 'buy' | 'sell';
  entryPrice: number;
  qty: number;
  initialStop: number;
  peakProfit: number;
  rationale: string;
  at: number;     // 約定時刻(= 記録の entry_t)
}

export interface EngineState {
  phase: SignalPhase;
  armed?: ArmedBracket;
  position?: OpenPosition;
  lastExit?: { exitPrice: number; pnl: number; at: number };
}

export interface RecordedTrade {
  entryT: number; entryPrice: number; dir: 'buy' | 'sell';
  exitT: number; exitPrice: number; pnl: number; qty: number; rationale: string;
}

// ─── 純関数(単体テスト対象) ─────────────────────────────

/** ブラケットのどちらのレッグが約定したか。両レッグが同 tick で満たす場合は指値を優先。無ければ null。 */
export function detectFill(a: ArmedBracket, price: number): { leg: 'limit' | 'stop'; entryPrice: number; initialStop: number } | null {
  const buy = a.direction === 'buy';
  if (a.limitEntry != null && a.stopLossForLimit != null) {
    // 指値: buy は現値が指値以下へ下落 / sell は指値以上へ上昇で約定。
    const hit = buy ? price <= a.limitEntry : price >= a.limitEntry;
    if (hit) return { leg: 'limit', entryPrice: a.limitEntry, initialStop: a.stopLossForLimit };
  }
  if (a.stopEntry != null && a.stopLossForStop != null) {
    // 逆指値: buy は現値が逆指値以上へ上昇 / sell は逆指値以下へ下落で約定。
    const hit = buy ? price >= a.stopEntry : price <= a.stopEntry;
    if (hit) return { leg: 'stop', entryPrice: a.stopEntry, initialStop: a.stopLossForStop };
  }
  return null;
}

/** 含み損益(pt)。buy は上昇で+、sell は下落で+。 */
export function unrealizedPt(direction: 'buy' | 'sell', entry: number, price: number): number {
  return direction === 'buy' ? price - entry : entry - price;
}

/** 現在の決済逆指値(絶対価格)。非公開 phase-exit(または簡易フォールバック)に委譲。 */
export function restingStopOf(pos: OpenPosition): number | null {
  return computeExitStop({
    direction: pos.direction, entryPrice: pos.entryPrice,
    initialStop: pos.initialStop, peakProfit: pos.peakProfit,
  });
}

/** 現在値が決済逆指値に達したか。達したら exit 価格(= 逆指値)、未達なら null。 */
export function detectExit(pos: OpenPosition, price: number, stop: number | null): number | null {
  if (stop == null || !Number.isFinite(stop)) return null;
  const hit = pos.direction === 'buy' ? price <= stop : price >= stop;
  return hit ? stop : null;
}

/** 実現損益(pt)= 方向込みグロス × 枚数。 */
export function realizedPnl(direction: 'buy' | 'sell', entry: number, exit: number, qty: number): number {
  const gross = direction === 'buy' ? exit - entry : entry - exit;
  return gross * qty;
}

export interface EquityPoint { t: number; pnl: number; cum: number; }

/** 決済履歴(任意順)から累積損益の点列(exit_t 昇順)を作る。収益曲線用。 */
export function equitySeries(trades: Array<{ exit_t: number; pnl: number }>): EquityPoint[] {
  const sorted = [...trades].sort((a, b) => a.exit_t - b.exit_t);
  let cum = 0;
  return sorted.map(t => { cum += t.pnl; return { t: t.exit_t, pnl: t.pnl, cum }; });
}

/** 現在値 price を受けて armed→filled / filled→flat の遷移を1歩進める純関数(DB/LLM は呼ばない)。
 *  filled では peakProfit を更新し、ラチェット逆指値に達したら決済して RecordedTrade を返す。 */
export function advance(
  st: EngineState, price: number, now: number,
): { next: EngineState; recorded?: RecordedTrade } {
  if (st.phase === 'armed' && st.armed) {
    const fill = detectFill(st.armed, price);
    if (!fill) return { next: st };
    // 片レッグ約定 → 他レッグは自動キャンセル(FILLED へ)。建値は約定レッグの価格。
    const position: OpenPosition = {
      direction: st.armed.direction,
      entryPrice: fill.entryPrice,
      qty: QTY,
      initialStop: fill.initialStop,
      peakProfit: Math.max(0, unrealizedPt(st.armed.direction, fill.entryPrice, price)),
      rationale: st.armed.rationale,
      at: now,
    };
    return { next: { phase: 'filled', position, lastExit: st.lastExit } };
  }

  if (st.phase === 'filled' && st.position) {
    const pos = st.position;
    const peak = Math.max(pos.peakProfit, unrealizedPt(pos.direction, pos.entryPrice, price));
    const updated: OpenPosition = { ...pos, peakProfit: peak };
    const stop = restingStopOf(updated);
    const exit = detectExit(updated, price, stop);
    if (exit == null) {
      return { next: { phase: 'filled', position: updated, lastExit: st.lastExit } };
    }
    const pnl = realizedPnl(pos.direction, pos.entryPrice, exit, pos.qty);
    const recorded: RecordedTrade = {
      entryT: pos.at, entryPrice: pos.entryPrice, dir: pos.direction,
      exitT: now, exitPrice: exit, pnl, qty: pos.qty, rationale: pos.rationale,
    };
    return { next: { phase: 'flat', lastExit: { exitPrice: exit, pnl, at: now } }, recorded };
  }

  return { next: st };
}

/** エンジン状態 + 現在値 + now から SSE state を組み立てる純関数。 */
export function toSignalTradeState(st: EngineState, price: number | null, now: number): SignalTradeState {
  const s: SignalTradeState = { phase: st.phase, updatedAt: now };
  if (st.phase === 'armed' && st.armed) {
    const a = st.armed;
    s.entry = {
      direction: a.direction,
      limitEntry: a.limitEntry,
      stopEntry: a.stopEntry,
      // 初期LC は1つに正規化(指値レッグ優先・無ければ逆指値レッグ)。途中の LC 移動は出さない。
      initialStop: a.stopLossForLimit ?? a.stopLossForStop,
      rationale: a.rationale,
      at: a.at,
    };
  }
  if (st.phase === 'filled' && st.position) {
    const p = st.position;
    s.position = {
      direction: p.direction, entryPrice: p.entryPrice, qty: p.qty,
      unrealized: price != null ? unrealizedPt(p.direction, p.entryPrice, price) : 0,
      at: p.at,
    };
  }
  if (st.lastExit) s.lastExit = st.lastExit;
  return s;
}

/** scalp-plan の AiPlan を armed ブラケットへ変換(純関数)。direction==='none' や両レッグ欠落は null。 */
export function planToArmed(
  plan: {
    direction: 'buy' | 'sell' | 'none';
    limitEntry?: number; stopEntry?: number;
    stopLossForLimit?: number; stopLossForStop?: number;
    rationale: string;
  },
  now: number,
): ArmedBracket | null {
  if (plan.direction !== 'buy' && plan.direction !== 'sell') return null;
  const hasLimit = Number.isFinite(plan.limitEntry) && Number.isFinite(plan.stopLossForLimit);
  const hasStop = Number.isFinite(plan.stopEntry) && Number.isFinite(plan.stopLossForStop);
  if (!hasLimit && !hasStop) return null;
  const a: ArmedBracket = { direction: plan.direction, rationale: plan.rationale, at: now };
  if (hasLimit) { a.limitEntry = plan.limitEntry; a.stopLossForLimit = plan.stopLossForLimit; }
  if (hasStop) { a.stopEntry = plan.stopEntry; a.stopLossForStop = plan.stopLossForStop; }
  return a;
}

// ─── オーケストレーション(状態保持・副作用) ──────────────────

const DEFAULT_PLAN_INTERVAL_MS = 3 * 60_000;

function resolvePlanIntervalMs(): number {
  const v = Number(process.env.SIGNAL_PLAN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 30_000 ? v : DEFAULT_PLAN_INTERVAL_MS;
}

/** SIGNAL_TRADE=0/false/off でエンジン自体を無効化(既定は有効)。 */
function engineEnabled(): boolean {
  const v = process.env.SIGNAL_TRADE;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

let state: EngineState = { phase: 'flat' };
let running = false;
let planning = false;
let lastPlanAt = 0;
let lastBroadcastJson = '';
const planIntervalMs = resolvePlanIntervalMs();

// ── 見送り(direction:'none')後の再計画抑止 ──────────────────────
// none が返ったら「そのときの価格」をアンカーとして記録し、価格が節目(主要レベル)を跨ぐまで
// 再計画を抑止する(固定間隔で見送りを繰り返さない)。null = 抑止していない。
let planSuppressedAnchor: number | null = null;
// 抑止中の安全弁: 節目を跨がなくてもこの長間隔が経てば1回だけ再計画を許す(詰まり防止)。
const SUPPRESS_SAFETY_MS = 20 * 60_000;

/** 起動: 非公開 exit 実装をロードしてエンジンを有効化(冪等)。 */
export async function startSignalEngine(): Promise<void> {
  if (running) return;
  if (!engineEnabled()) { console.log('[signalTrade] disabled (SIGNAL_TRADE=0)'); return; }
  const kind = await loadExitImpl();
  running = true;
  console.log(`[signalTrade] engine started (exit=${kind}, planInterval=${Math.round(planIntervalMs / 1000)}s)`);
}

export function stopSignalEngine(): void {
  running = false;
}

/** 現在の SSE state(stream.ts の初回送出 / 各 tick の broadcast 用)。 */
export function getSignalTradeState(now = Date.now()): SignalTradeState {
  const price = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
  return toSignalTradeState(state, price, now);
}

/** テスト/リセット用: エンジン内部状態を初期化する。 */
export function _resetSignalEngine(): void {
  state = { phase: 'flat' };
  planning = false;
  lastPlanAt = 0;
  lastBroadcastJson = '';
  planSuppressedAnchor = null;
}

// 非公開: DB へ決済を1行記録(失敗は握りつぶす=表示専用ゆえ致命的にしない)。
function persistTrade(t: RecordedTrade): void {
  try {
    const db = openDb(resolveDbPath());
    try {
      insertSignalTrade(db, {
        entryT: t.entryT, entryPrice: t.entryPrice, dir: t.dir,
        exitT: t.exitT, exitPrice: t.exitPrice, pnl: t.pnl, qty: t.qty,
        rationale: t.rationale,
      });
    } finally { db.close(); }
  } catch (e) {
    console.warn('[signalTrade] persist failed:', e instanceof Error ? e.message : String(e));
  }
}

// 非公開: FLAT かつ間隔経過なら AI へプランを1本要求(非同期・多重発火ガード)。
// 見送り(none)抑止中は、価格が節目を跨ぐ(shouldRearmOnLevel)まで要求しない。安全弁として
// SUPPRESS_SAFETY_MS 経過時のみ抑止中でも1本要求を許す(詰まり防止)。
function maybeRequestPlan(price: number, now: number): void {
  if (planning || state.phase !== 'flat') return;
  if (!inPollWindow(now)) return;   // 取引時間外は要求しない。

  // 見送り抑止ゲート: アンカーが在れば、節目クロス or 安全弁時間まで再計画を抑止する。
  if (planSuppressedAnchor !== null) {
    const levels = getLevelsSnapshot();
    if (shouldRearmOnLevel(planSuppressedAnchor, price, levels)) {
      const b = rearmBounds(planSuppressedAnchor, levels);
      console.log(`[signalTrade] plan-rearm 節目クロス anchor=${Math.round(planSuppressedAnchor)} `
        + `price=${Math.round(price)} bounds=[${b.lower ?? '±'},${b.upper ?? '±'}]`
        + `${b.usedFallback ? ' (±50fallback)' : ''}`);
      planSuppressedAnchor = null;   // 再武装(=以降は通常の間隔判定へ)。
    } else if (now - lastPlanAt >= SUPPRESS_SAFETY_MS) {
      console.log(`[signalTrade] plan-rearm 安全弁(${Math.round(SUPPRESS_SAFETY_MS / 60_000)}分経過) `
        + `anchor=${Math.round(planSuppressedAnchor)} price=${Math.round(price)}`);
      // アンカーは維持(none が返れば下でアンカー更新)。安全弁として1本だけ要求へ進む。
    } else {
      return;   // 抑止継続。
    }
  }

  if (now - lastPlanAt < planIntervalMs) return;
  planning = true;
  lastPlanAt = now;   // 起動直後の多重要求を防ぐため、要求時点で更新する。
  const anchorPrice = price;   // 見送りが返った場合のアンカー(要求時点の現在値)。
  void (async () => {
    try {
      // route(/api/scalp-plan・trade2)と同一の共通関数を使う＝チャート撮影＋ビジョン＋ガードレール＋
      // LC 上限/バイアス(monitor 設定既定)込みで提案を得る。override は渡さない(＝trade2 と同条件)。
      // 画像未生成/LLM 失敗は result.ok=false → 下の分岐に入らず FLAT 維持(＝見送り)。
      const { runScalpPlanWithChart } = await import('../llm/scalpPlanRunner.js');
      const result = await runScalpPlanWithChart();
      if (state.phase === 'flat' && result.ok) {
        if (result.plan.direction === 'none') {
          // 見送り: アンカーを記録し、価格が節目を跨ぐまで再計画を抑止する。
          planSuppressedAnchor = anchorPrice;
          console.log(`[signalTrade] plan-suppress 見送り→節目まで抑止 anchor=${Math.round(anchorPrice)}`);
        } else {
          const armed = planToArmed(result.plan, Date.now());
          if (armed) {
            state = { phase: 'armed', armed };   // 新規 armed で直近決済表示はクリア。
            planSuppressedAnchor = null;         // actionable で抑止解除。
          }
        }
      }
    } catch (e) {
      console.warn('[signalTrade] plan request failed:', e instanceof Error ? e.message : String(e));
    } finally {
      planning = false;
    }
  })();
}

/** priceLoop から毎 tick 呼ぶ。現在値で遷移を進め、決済を記録し、必要なら次プランを要求し、
 *  state を SSE broadcast する。エンジン未起動時は何もしない(既存 SSE を汚さない)。 */
export function feedSignalEngine(price: number, now: number): void {
  if (!running) return;
  try {
    const { next, recorded } = advance(state, price, now);
    state = next;
    if (recorded) persistTrade(recorded);
    maybeRequestPlan(price, now);
    const s = toSignalTradeState(state, price, now);
    const json = JSON.stringify(s);
    if (json !== lastBroadcastJson) {
      lastBroadcastJson = json;
      broadcast({ type: 'signalTrade', payload: s });
    }
  } catch (e) {
    console.warn('[signalTrade] tick error:', e instanceof Error ? e.message : String(e));
  }
}
