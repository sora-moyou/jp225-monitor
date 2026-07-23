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

import type { SignalTradeState, SignalSettingsSnapshot, KnobSettingSnapshot } from '../types.js';
import type { RangeLeg } from '../llm/openai.js';
import { computeExitStop, loadExitImpl } from './exit/index.js';
import { checkSanity } from './sanity.js';
import { broadcast } from '../sse/broker.js';
import { getPrices } from '../cache.js';
import { openDb, resolveDbPath, insertSignalTrade } from '../db/store.js';
import { inPollWindow } from '../../core/session.js';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';
import { shouldRearmOnLevel, rearmBounds } from './levelGate.js';
import {
  resolveScalpCooldownDirective,
  resolveScalpLcFloorDirective, resolveScalpLcCeilingDirective, resolveScalpTrendVetoDirective,
  resolveScalpBiasDirective, resolveScalpRangeDirective, resolveScalpLcHardMax,
  type KnobDirective, type SignalProfile,
} from '../configStore.js';
import type { SignalTradeInsert } from '../db/store.js';

const NIKKEI_SYMBOL = 'NIY=F';
const QTY = 1;   // 紙トラッキングは常に1枚。

// ─── 型 ───────────────────────────────────────────────

export type SignalPhase = 'flat' | 'armed' | 'filled';

/** AI 自己レジーム/確信度 + トレンド veto 発火フラグ(v0.7.54・計測用に持ち回り、決済時 meta へ保存)。 */
export interface PlanMeta {
  regime?: 'trend_up' | 'trend_down' | 'range' | 'unclear';
  confidence?: number;
  vetoFired?: boolean;
}

export interface ArmedBracket {
  direction: 'buy' | 'sell';
  limitEntry?: number;
  stopEntry?: number;
  stopLossForLimit?: number;
  stopLossForStop?: number;
  rationale: string;
  at: number;
  // レンジ両面ストラドル(実験・紙で別枠計測)。mode==='range' の時は range で判定し、
  // direction はプレースホルダ(range 分岐は必ず mode/range で gating し direction では判定しない)。
  mode?: 'range';
  range?: { upper?: RangeLeg; lower?: RangeLeg };
  // v0.7.54: AI 自己レジーム/確信度 + トレンド veto 発火(記録のみ・約定→決済へ持ち回り)。
  planMeta?: PlanMeta;
  // ★v0.7.56: このシグナルの実効設定スナップショット(委任モード+値)。約定→決済→meta/SSE へ持ち回る。
  settings?: SignalSettingsSnapshot;
}

/** 現在シグナル(trade2 追従用)。ARM ごとに signalId を単調増加で採番し、最新 armed プランを保持する。
 *  擬似約定(filled)へ進んでも保持し続ける(次の ARM でのみ signalId を更新)。 */
export interface CurrentSignal {
  signalId: number;
  at: number;
  direction: 'buy' | 'sell';
  limitEntry?: number;
  stopEntry?: number;
  stopLossForLimit?: number;
  stopLossForStop?: number;
  rationale: string;
  // レンジ両面ストラドル(trade2 追従用)。mode==='range' の時は range に上下2レッグ(片レッグ落ちも可)。
  mode?: 'range';
  range?: { upper?: RangeLeg; lower?: RangeLeg };
  // ★v0.7.56: このシグナルの実効設定スナップショット(委任モード+値)。trade2 が SSE/GET で受け取り記録する。
  settings?: SignalSettingsSnapshot;
}

export interface OpenPosition {
  direction: 'buy' | 'sell';
  entryPrice: number;
  qty: number;
  initialStop: number;
  peakProfit: number;
  rationale: string;
  at: number;     // 約定時刻(= 記録の entry_t)
  mode?: 'range';  // レンジ由来の建玉(タグ計測用)。rangeTp が無ければ約定後も通常の単方向ポジション扱い(決済は既存 exitStop)。
  rangeTp?: number;  // レンジ建玉のTP目標(反対側レンジ節目・利益側にある場合のみ設定)。設定時は損側=固定initialStop・利側=節目手前で成行決済(phase-exit を使わない)。
  planMeta?: PlanMeta;   // v0.7.54: AI 自己レジーム/確信度 + veto 発火(決済 meta へ引き継ぐ)。
  settings?: SignalSettingsSnapshot;   // ★v0.7.56: 実効設定スナップショット(決済 meta へ引き継ぐ)。
}

export interface EngineState {
  phase: SignalPhase;
  armed?: ArmedBracket;
  position?: OpenPosition;
  lastExit?: { exitPrice: number; pnl: number; at: number };
}

/** 保有中の意図(trade2 追従用)。filled の間だけ算出し、決済逆指値(computeExitStop の絶対価格)を公開する。
 *  signalId=そのエントリーの ARM 采番=trade2 が「どの建玉のストップか」を対応づける。 */
export interface SignalHold {
  signalId: number;
  direction: 'buy' | 'sell';
  entryPrice: number;
  exitStop: number | null;
  at: number;   // エントリー約定時刻(= position.at)。建玉の対応キー。
  // ★レンジ建玉のTP(反対側レンジ節目・利益側のみ設定)。設定時は exitStop=固定initialStop(ラチェットせず)。
  //   directional / rangeTp 無しの建玉では付与しない(=既存の exitStop 契約と byte 一致)。
  rangeTp?: number;      // 反対側レンジ節目(TP目標の生値)。
  tpTrigger?: number;    // 成行TPの発火価格(buy=rangeTp−5 / sell=rangeTp+5)。
}

export interface RecordedTrade {
  entryT: number; entryPrice: number; dir: 'buy' | 'sell';
  exitT: number; exitPrice: number; pnl: number; qty: number; rationale: string;
  mode?: 'range';   // レンジ由来の紙トレード(別枠集計タグ)。directional は付与しない=既存記録と互換。
  planMeta?: PlanMeta;   // v0.7.54: 決済時に signal_trades.meta へ JSON 保存する自己レジーム/確信度/veto。
  settings?: SignalSettingsSnapshot;   // ★v0.7.56: 決済時に signal_trades.meta へ保存する実効設定スナップショット。
}

// ─── 純関数(単体テスト対象) ─────────────────────────────

/** 損切りがエントリーの正しい外側(買い=下 / 売り=上)にあるか。境界(等値=幅0)は不正。純関数。
 *  ★実害バグ対策の最終ガード: 買いなのに損切りが上(逆側)のような不正プランを紙エンジンが arm/約定しないようにする
 *    (発生源は llm/openai の parse/enforce で落とすが、engine 単独でも同じ向き規約を保証する=trade2 サニティと一致)。
 *  openai.stopSideOk と同一規約。engine の静的 import を軽く保つため、依存を作らずここに小さく持つ。 */
function stopOnCorrectSide(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}

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

/** レンジ両面ストラドルの約定判定(純関数)。現在値が upper.entry に到達(≥)なら上レッグ、
 *  そうでなく lower.entry に到達(≤)なら下レッグを約定。約定 side/建値/初期LC を返す。未到達は null。
 *  ★どちらか約定した時点で もう片方は暗黙にキャンセル(OCO)= 呼び出し側は position へ遷移するだけ。
 *  upper/lower はどちらか欠落しうる(enforce/parse で片レッグに落ちた range = 実質片面)。 */
export function detectRangeFill(
  a: ArmedBracket, price: number,
): { side: 'buy' | 'sell'; entryPrice: number; initialStop: number } | null {
  const upper = a.range?.upper;
  const lower = a.range?.lower;
  if (upper && price >= upper.entry) {
    return { side: upper.side, entryPrice: upper.entry, initialStop: upper.stopLoss };
  }
  if (lower && price <= lower.entry) {
    return { side: lower.side, entryPrice: lower.entry, initialStop: lower.stopLoss };
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

/** 保有中の意図(hold)を組み立てる純関数。filled かつ position かつ現在シグナルが在るときだけ返す。
 *  signalId は currentSignal から取る(ARM ごとに采番され filled 中は不変=そのエントリーの采番)。
 *  exitStop は毎tick算出する resting stop の絶対価格(null=有効な逆指値なし)。flat/armed/未シグナルは null。 */
export function computeHold(st: EngineState, signal: CurrentSignal | null): SignalHold | null {
  if (st.phase !== 'filled' || !st.position || !signal) return null;
  const p = st.position;
  // ★レンジ建玉(rangeTp 設定済): 損側は固定初期LC(ラチェットしない)、利側は反対側節目手前の成行TP。
  //   exitStop=initialStop(固定)+ rangeTp/tpTrigger を公開する(trade2 が固定LC/成行TPを追従できる)。
  if (p.mode === 'range' && p.rangeTp != null) {
    return {
      signalId: signal.signalId,
      direction: p.direction,
      entryPrice: p.entryPrice,
      exitStop: p.initialStop,
      at: p.at,
      rangeTp: p.rangeTp,
      tpTrigger: rangeTpTrigger(p.direction, p.rangeTp),
    };
  }
  return {
    signalId: signal.signalId,
    direction: p.direction,
    entryPrice: p.entryPrice,
    exitStop: restingStopOf(p),
    at: p.at,
  };
}

/** 決済(filled→flat)後クールダウン中か(=再ARMを抑止すべきか)を判定する純関数。
 *  cooldownSec<=0 は無効(常に false)・lastExitAt が null(まだ決済無し)も false。
 *  決済からの経過が cooldownSec 秒未満なら true(=まだ再ARMしない)。 */
export function inCooldown(lastExitAt: number | null, now: number, cooldownSec: number): boolean {
  if (!(cooldownSec > 0) || lastExitAt == null) return false;
  return now - lastExitAt < cooldownSec * 1000;
}

/** ★レンジ建玉のTP発火価格。反対側レンジ節目の「手前(offset 円内側)」で成行決済する目標価格を返す純関数。
 *  buy(下レッグ約定・上節目がTP): rangeTp−offset に上昇したら決済 / sell(上レッグ約定・下節目がTP): rangeTp+offset に下落したら決済。
 *  offset だけ内側に置くのは、反対側の指値まで完全到達する前に確実に利食うため(反対側到達=そこで逆張り指値が待つ水準)。 */
export const RANGE_TP_OFFSET_YEN = 5;
export function rangeTpTrigger(direction: 'buy' | 'sell', rangeTp: number, offset: number = RANGE_TP_OFFSET_YEN): number {
  return direction === 'buy' ? rangeTp - offset : rangeTp + offset;
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

/** 未約定ブラケット(armed)のタイムアウト[ms]。この時間内に指値/逆指値のどちらも約定しなければ
 *  ブラケットを取消して FLAT に戻す(=次の計画を再要求できるようにする)。trade2 側の 15分と揃える。
 *  ★これが無いと「価格が到達しない指値」で armed のまま永久固着し、maybeRequestPlan が phase!=flat で
 *    弾かれてエンジンが全シグナルを停止する(2026-07-21 の System B 停止の実原因)。 */
export const ARMED_TIMEOUT_MS = 15 * 60_000;

/** 現在値 price を受けて armed→filled / filled→flat の遷移を1歩進める純関数(DB/LLM は呼ばない)。
 *  filled では peakProfit を更新し、ラチェット逆指値に達したら決済して RecordedTrade を返す。
 *  armed が ARMED_TIMEOUT_MS を超えて未約定なら取消して FLAT(armedTimedOut=true)。 */
export function advance(
  st: EngineState, price: number, now: number,
): { next: EngineState; recorded?: RecordedTrade; armedTimedOut?: boolean } {
  if (st.phase === 'armed' && st.armed) {
    // ★未約定タイムアウト: どちらのレッグも約定しないまま一定時間経過 → 取消して FLAT(再計画可能に)。
    //   armed.at はブラケット武装時刻。約定判定より前に評価する(タイムアウトが最優先)。
    if (st.armed.at != null && now - st.armed.at >= ARMED_TIMEOUT_MS) {
      return { next: { phase: 'flat', lastExit: st.lastExit }, armedTimedOut: true };
    }
    // ★レンジ両面ストラドル: mode/range で gating(direction では判定しない)。上下どちらか跨いだ side を約定。
    if (st.armed.mode === 'range' || st.armed.range != null) {
      const rf = detectRangeFill(st.armed, price);
      if (!rf) return { next: st };
      // 片側約定 → もう片方は暗黙キャンセル(OCO)。約定後は約定 side の通常ポジション(以降は既存 exitStop 追従)。
      const position: OpenPosition = {
        direction: rf.side,
        entryPrice: rf.entryPrice,
        qty: QTY,
        initialStop: rf.initialStop,
        peakProfit: Math.max(0, unrealizedPt(rf.side, rf.entryPrice, price)),
        rationale: st.armed.rationale,
        at: now,
        mode: 'range',   // タグ計測用: この建玉は range 由来。
      };
      // ★レンジTP: 反対側(未約定)レッグの建値を求め、それが利益側にあるときだけ rangeTp に据える。
      //   detectRangeFill と同じ選択ロジックで「どちらが約定したか」を判定し反対側 entry を取る。
      //   fade(指値)ストラドルは反対節目=利益側 → TP。breakout(逆指値)は反対節目=損側 → 設定せず既存 phase-exit に落ちる(自動で安全)。
      const upper = st.armed.range?.upper;
      const lower = st.armed.range?.lower;
      let oppositeEntry: number | undefined;
      if (upper && price >= upper.entry) oppositeEntry = lower?.entry;        // 上レッグ約定 → 反対=下レッグ
      else if (lower && price <= lower.entry) oppositeEntry = upper?.entry;   // 下レッグ約定 → 反対=上レッグ
      if (oppositeEntry != null && Number.isFinite(oppositeEntry)) {
        // 節目(rangeTp)だけでなく、5円内側の成行トリガ(rangeTpTrigger)も利益側にあるときだけ TP を据える。
        //   これで幅<5円の退化レンジ(trigger が建値近辺=小損TP)を弾き、fill 直後の誤決済を防ぐ(現実のAIは出さないが防御)。
        const trigger = rangeTpTrigger(rf.side, oppositeEntry);
        const onProfitSide = rf.side === 'buy'
          ? (oppositeEntry > rf.entryPrice && trigger > rf.entryPrice)
          : (oppositeEntry < rf.entryPrice && trigger < rf.entryPrice);
        if (onProfitSide) position.rangeTp = oppositeEntry;
      }
      if (st.armed.planMeta) position.planMeta = st.armed.planMeta;   // 自己レジーム/確信度/veto を引き継ぐ。
      if (st.armed.settings) position.settings = st.armed.settings;   // ★v0.7.56: 実効設定を引き継ぐ。
      return { next: { phase: 'filled', position, lastExit: st.lastExit } };
    }
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
    if (st.armed.planMeta) position.planMeta = st.armed.planMeta;   // 自己レジーム/確信度/veto を引き継ぐ。
    if (st.armed.settings) position.settings = st.armed.settings;   // ★v0.7.56: 実効設定を引き継ぐ。
    return { next: { phase: 'filled', position, lastExit: st.lastExit } };
  }

  if (st.phase === 'filled' && st.position) {
    const pos = st.position;
    // ★レンジ建玉(rangeTp 設定済)= 損側は固定初期LC(ラチェットしない)/ 利側は反対側節目手前で成行決済(phase-exit を使わない)。
    //   directional / rangeTp 無しの建玉はこの分岐に入らず、既存の phase-exit(下)へ落ちる=byte 不変。
    if (pos.mode === 'range' && pos.rangeTp != null) {
      // 決済記録の共通組み立て(range タグ + planMeta/settings 引き継ぎ)。
      const mkRecorded = (exitPrice: number, pnl: number): RecordedTrade => {
        const r: RecordedTrade = {
          entryT: pos.at, entryPrice: pos.entryPrice, dir: pos.direction,
          exitT: now, exitPrice, pnl, qty: pos.qty, rationale: pos.rationale, mode: 'range',
        };
        if (pos.planMeta) r.planMeta = pos.planMeta;
        if (pos.settings) r.settings = pos.settings;
        return r;
      };
      // 損側: 固定初期LC(ラチェットせず)。到達したらその逆指値で決済。両側が同 tick で満たす場合は損側優先(安全)。
      const stopHit = detectExit(pos, price, pos.initialStop);
      if (stopHit != null) {
        const pnl = realizedPnl(pos.direction, pos.entryPrice, stopHit, pos.qty);
        return { next: { phase: 'flat', lastExit: { exitPrice: stopHit, pnl, at: now } }, recorded: mkRecorded(stopHit, pnl) };
      }
      // 利側: 反対側レンジ節目の手前(RANGE_TP_OFFSET_YEN 内側)に達したら成行(=現在値)で決済。
      const trigger = rangeTpTrigger(pos.direction, pos.rangeTp);
      const tpHit = pos.direction === 'buy' ? price >= trigger : price <= trigger;
      if (tpHit) {
        const pnl = realizedPnl(pos.direction, pos.entryPrice, price, pos.qty);
        return { next: { phase: 'flat', lastExit: { exitPrice: price, pnl, at: now } }, recorded: mkRecorded(price, pnl) };
      }
      // どちらも未到達 → 保有継続(peak 更新は range 決済に不要)。
      return { next: { phase: 'filled', position: pos, lastExit: st.lastExit } };
    }
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
    // range 由来のみ mode タグを付与(directional は無付与=既存記録とバイト互換)。
    if (pos.mode === 'range') recorded.mode = 'range';
    if (pos.planMeta) recorded.planMeta = pos.planMeta;   // 自己レジーム/確信度/veto を決済記録へ。
    if (pos.settings) recorded.settings = pos.settings;   // ★v0.7.56: 実効設定を決済記録へ。
    return { next: { phase: 'flat', lastExit: { exitPrice: exit, pnl, at: now } }, recorded };
  }

  return { next: st };
}

/** エンジン状態 + 現在値 + now から SSE state を組み立てる純関数。
 *  signal(現在シグナル・trade2 追従用)は在れば付与する。既存フィールドは不変=パネル表示互換。 */
export function toSignalTradeState(
  st: EngineState, price: number | null, now: number, signal?: CurrentSignal | null,
): SignalTradeState {
  const s: SignalTradeState = { phase: st.phase, updatedAt: now };
  if (st.phase === 'armed' && st.armed) {
    const a = st.armed;
    if (a.mode === 'range' || a.range != null) {
      // レンジ両面: パネルが上下2レッグを描けるよう entry に mode/range を載せる(direction は
      // プレースホルダ=いずれかのレッグ side。パネルは mode==='range' で分岐し direction は見ない)。
      s.entry = {
        direction: a.range?.upper?.side ?? a.range?.lower?.side ?? 'buy',
        mode: 'range',
        range: a.range,
        rationale: a.rationale,
        at: a.at,
      };
    } else {
      s.entry = {
        direction: a.direction,
        limitEntry: a.limitEntry,
        stopEntry: a.stopEntry,
        // 初期LC はレッグ別に露出(指値レッグ=stopLossForLimit / 逆指値レッグ=stopLossForStop)。
        //   initialStop は後方互換の単一正規化値(指値優先)。途中の LC 移動は出さない。
        initialStop: a.stopLossForLimit ?? a.stopLossForStop,
        stopLossForLimit: a.stopLossForLimit,
        stopLossForStop: a.stopLossForStop,
        rationale: a.rationale,
        at: a.at,
      };
    }
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
  const hold = computeHold(st, signal ?? null);
  if (hold) s.hold = hold;
  if (signal) {
    s.signal = {
      signalId: signal.signalId,
      direction: signal.direction,
      limitEntry: signal.limitEntry,
      stopEntry: signal.stopEntry,
      stopLossForLimit: signal.stopLossForLimit,
      stopLossForStop: signal.stopLossForStop,
      rationale: signal.rationale,
      at: signal.at,
    };
    // レンジ両面は mode/range を露出(trade2 追従用・directional では付与しない)。
    if (signal.mode === 'range' || signal.range != null) {
      s.signal.mode = 'range';
      s.signal.range = signal.range;
    }
    // ★v0.7.56: 実効設定スナップショットを露出(在るときだけ・trade2 が entry_meta に記録)。
    if (signal.settings) s.signal.settings = signal.settings;
  }
  return s;
}

/** scalp-plan の AiPlan を armed ブラケットへ変換(純関数)。direction==='none' や両レッグ欠落は null。
 *  direction==='range' は range に≥1レッグあれば range ArmedBracket(mode:'range')へ。0レッグは null。 */
export function planToArmed(
  plan: {
    direction: 'buy' | 'sell' | 'none' | 'range';
    limitEntry?: number; stopEntry?: number;
    stopLossForLimit?: number; stopLossForStop?: number;
    rationale: string;
    range?: { upper?: RangeLeg; lower?: RangeLeg };
    // v0.7.54: AI 自己レジーム/確信度(記録のみ)。plan に載っていれば armed へ引き継ぐ。
    regime?: PlanMeta['regime']; confidence?: number;
  },
  now: number,
  extra?: { vetoFired?: boolean },
): ArmedBracket | null {
  // AI 自己レジーム/確信度 + トレンド veto 発火を1つの planMeta にまとめる(いずれも欠落可=記録のみ)。
  const planMeta = buildPlanMeta(plan.regime, plan.confidence, extra?.vetoFired);
  // ★レンジ両面ストラドル: range に上/下いずれかのレッグがあれば range ブラケットを作る。
  if (plan.direction === 'range') {
    let upper = plan.range?.upper;
    let lower = plan.range?.lower;
    // ★向きの belt-and-suspenders: 損切りがエントリーの内側/反対側(境界=幅0 含む)のレッグは arm しない。
    //   発生源(parse/enforce)で落ちている想定だが、万一到達しても紙エンジンが不正約定しないよう最終ガード。
    if (upper && !stopOnCorrectSide(upper.side, upper.entry, upper.stopLoss)) upper = undefined;
    if (lower && !stopOnCorrectSide(lower.side, lower.entry, lower.stopLoss)) lower = undefined;
    if (!upper && !lower) return null;
    // direction はプレースホルダ(range 分岐は mode/range で gating)。range に採用レッグを載せる。
    const a: ArmedBracket = { direction: 'buy', rationale: plan.rationale, at: now, mode: 'range', range: {} };
    if (upper) a.range!.upper = upper;
    if (lower) a.range!.lower = lower;
    if (planMeta) a.planMeta = planMeta;
    return a;
  }
  if (plan.direction !== 'buy' && plan.direction !== 'sell') return null;
  // ★向きの belt-and-suspenders(directional): buy は損切りが entry の下・sell は上。境界(==)は不正。
  //   有限性に加えて向きも満たすレッグだけを arm する(不正な向きの損切りは紙エンジンでも約定させない)。
  const hasLimit = Number.isFinite(plan.limitEntry) && Number.isFinite(plan.stopLossForLimit)
    && stopOnCorrectSide(plan.direction, plan.limitEntry as number, plan.stopLossForLimit as number);
  const hasStop = Number.isFinite(plan.stopEntry) && Number.isFinite(plan.stopLossForStop)
    && stopOnCorrectSide(plan.direction, plan.stopEntry as number, plan.stopLossForStop as number);
  if (!hasLimit && !hasStop) return null;
  const a: ArmedBracket = { direction: plan.direction, rationale: plan.rationale, at: now };
  if (hasLimit) { a.limitEntry = plan.limitEntry; a.stopLossForLimit = plan.stopLossForLimit; }
  if (hasStop) { a.stopEntry = plan.stopEntry; a.stopLossForStop = plan.stopLossForStop; }
  if (planMeta) a.planMeta = planMeta;
  return a;
}

/** regime/confidence/vetoFired から PlanMeta を組み立てる(全欠落は undefined=記録しない)。純関数。 */
export function buildPlanMeta(
  regime?: PlanMeta['regime'], confidence?: number, vetoFired?: boolean,
): PlanMeta | undefined {
  const m: PlanMeta = {};
  if (regime !== undefined) m.regime = regime;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) m.confidence = confidence;
  if (vetoFired !== undefined) m.vetoFired = vetoFired;
  return Object.keys(m).length > 0 ? m : undefined;
}

/** armed ブラケット + 採番済み signalId から CurrentSignal を組み立てる純関数。
 *  レッグ欠落フィールドは undefined のまま(付与しない)。 */
export function armedToCurrentSignal(a: ArmedBracket, signalId: number): CurrentSignal {
  const s: CurrentSignal = { signalId, at: a.at, direction: a.direction, rationale: a.rationale };
  if (a.limitEntry != null) s.limitEntry = a.limitEntry;
  if (a.stopEntry != null) s.stopEntry = a.stopEntry;
  if (a.stopLossForLimit != null) s.stopLossForLimit = a.stopLossForLimit;
  if (a.stopLossForStop != null) s.stopLossForStop = a.stopLossForStop;
  // レンジ両面は mode/range を引き継ぐ(trade2 追従用)。
  if (a.mode === 'range' || a.range != null) {
    s.mode = 'range';
    s.range = a.range;
  }
  // ★v0.7.56: 実効設定スナップショットを引き継ぐ(在るときだけ)。
  if (a.settings) s.settings = a.settings;
  return s;
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

// 抑止中の安全弁: 節目を跨がなくてもこの長間隔が経てば1回だけ再計画を許す(詰まり防止)。
const SUPPRESS_SAFETY_MS = 20 * 60_000;

// ★診断ハートビートの間隔[ms]。各エンジンがこの間隔で phase/planning/経過を1行ログする(固着の早期発見)。
const HEARTBEAT_MS = 5 * 60_000;

/** System B(紙専用)を個別に無効化する env(既定は有効)。SIGNAL_TRADE_B=0/false/off でオフ。
 *  A は SIGNAL_TRADE(engineEnabled)配下で不変。B の並走(独立の AI 呼び出し)を止めたい時に使う。 */
function engineBEnabled(): boolean {
  const v = process.env.SIGNAL_TRADE_B;
  if (v === undefined) return true;
  return !/^(0|false|off|no)$/i.test(v.trim());
}

/** ★v0.8.2: エンジンインスタンスの構成。A(実売買・グローバル設定)と B(紙専用・signalB 設定)で切り替える。 */
export interface EngineConfig {
  profile: SignalProfile;                       // 設定解決 & scalp-plan プロファイル('A' | 'B')
  systemTag: 'A' | 'B' | null;                  // persist の system 列。A は null(=既存挙動と byte 一致)/ B は 'B'
  broadcastType: 'signalTrade' | 'signalTradeB'; // SSE イベント名
  maintainsCurrentSignal: boolean;              // A=true(currentSignal/hold を露出)/ B=false(絶対に露出しない)
}

/** ★v0.8.2: トレードシグナル紙エンジン(インスタンス化)。純関数(advance/detectFill/…)は共有・不変。
 *  A インスタンスは currentSignal/hold を露出し 'signalTrade' を出す(=trade2 が従来どおり追従・実売買A)。
 *  B インスタンスは currentSignal を一切持たず 'signalTradeB' を別露出する(紙のみ・trade2 は B を追わない)。
 *  ★A(profile:'A')の挙動は全て従来のモジュール singleton と byte 一致(提案/arm/約定/決済/記録/SSE/currentSignal)。 */
export class SignalEngine {
  private state: EngineState = { phase: 'flat' };
  // 現在シグナル(trade2 追従用・A のみ)。ARM ごとに signalId を単調増加で採番して更新し、
  // 擬似約定(filled)後も保持する(見送り none では更新しない)。null = まだ一度も ARM していない。
  private signalIdCounter = 0;
  private currentSignal: CurrentSignal | null = null;
  private running = false;
  private planning = false;
  private lastPlanAt = 0;
  private lastBroadcastJson = '';
  // 決済(filled→flat)時刻。この後 scalpCooldownSec 秒は再ARM(plan要求)を抑止する。null=まだ決済無し。
  private lastSignalExitAt: number | null = null;
  // cooldown ログの多重抑止(毎tick出さない)。決済ごとに false へ戻し、cooldown 中に一度だけ出す。
  private cooldownLogged = false;
  private readonly planIntervalMs = resolvePlanIntervalMs();
  // 見送り(direction:'none')後の再計画抑止アンカー。null = 抑止していない。
  private planSuppressedAnchor: number | null = null;

  constructor(private readonly cfg: EngineConfig) {}

  /** ログ接頭辞(A=[signalTrade] で従来ログと byte 一致 / B=[signalTradeB])。 */
  private get logTag(): string { return this.cfg.profile === 'B' ? '[signalTradeB]' : '[signalTrade]'; }

  /** SSE/hold に載せる現在シグナル。A は currentSignal / B は常に null(currentSignal を露出しない)。 */
  private signalForState(): CurrentSignal | null {
    return this.cfg.maintainsCurrentSignal ? this.currentSignal : null;
  }

  /** 起動: 非公開 exit 実装をロードしてエンジンを有効化(冪等)。 */
  async start(): Promise<void> {
    if (this.running) return;
    if (!engineEnabled()) { console.log(`${this.logTag} disabled (SIGNAL_TRADE=0)`); return; }
    if (this.cfg.profile === 'B' && !engineBEnabled()) { console.log('[signalTradeB] disabled (SIGNAL_TRADE_B=0)'); return; }
    const kind = await loadExitImpl();
    this.running = true;
    console.log(`${this.logTag} engine started (exit=${kind}, planInterval=${Math.round(this.planIntervalMs / 1000)}s)`);
  }

  stop(): void { this.running = false; }

  /** 現在の SSE state(stream.ts の初回送出 / 各 tick の broadcast 用)。 */
  getState(now = Date.now()): SignalTradeState {
    const price = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
    return toSignalTradeState(this.state, price, now, this.signalForState());
  }

  /** 現在シグナル(trade2 追従用)。A のみ。B は常に null(=露出しない)。 */
  getCurrentSignal(): CurrentSignal | null { return this.signalForState(); }

  getPhase(): SignalPhase { return this.state.phase; }

  /** 保有中の意図(hold・trade2 追従用)。A の filled 中のみ非 null。B は常に null。 */
  getHold(): SignalHold | null { return computeHold(this.state, this.signalForState()); }

  /** テスト/リセット用: エンジン内部状態を初期化する。 */
  reset(): void {
    this.state = { phase: 'flat' };
    this.signalIdCounter = 0;
    this.currentSignal = null;
    this.planning = false;
    this.lastPlanAt = 0;
    this.lastBroadcastJson = '';
    this.planSuppressedAnchor = null;
    this.lastSignalExitAt = null;
    this.cooldownLogged = false;
  }

  // 非公開: DB へ決済を1行記録(失敗は握りつぶす=表示専用ゆえ致命的にしない)。系統タグ(A=null/B='B')を付与する。
  private persistTrade(t: RecordedTrade): void {
    try {
      const db = openDb(resolveDbPath());
      try {
        insertSignalTrade(db, buildSignalTradeInsert(t, this.cfg.systemTag));
      } finally { db.close(); }
    } catch (e) {
      console.warn(`${this.logTag} persist failed:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 非公開: FLAT かつ間隔経過なら AI へプランを1本要求(非同期・多重発火ガード)。
  // 見送り(none)抑止中は、価格が節目を跨ぐ(shouldRearmOnLevel)まで要求しない。安全弁として
  // SUPPRESS_SAFETY_MS 経過時のみ抑止中でも1本要求を許す(詰まり防止)。
  private maybeRequestPlan(price: number, now: number): void {
    if (this.planning || this.state.phase !== 'flat') return;
    if (!inPollWindow(now)) return;   // 取引時間外は要求しない。

    // クールダウンゲート: 決済(filled→flat)後 scalpCooldownSec 秒は再ARM(plan要求)を抑止する。
    // ★v0.7.56: クールダウンが AI委任(mode==='ai')のときはゲートを無効化(AI の選択性に委ねる)。manual のみゲート。
    const cd = resolveScalpCooldownDirective(this.cfg.profile);
    if (cd.mode === 'manual' && inCooldown(this.lastSignalExitAt, now, cd.value)) {
      if (!this.cooldownLogged) {
        const remain = Math.max(0, Math.ceil((this.lastSignalExitAt! + cd.value * 1000 - now) / 1000));
        console.log(`${this.logTag} cooldown 決済後の再ARM抑止(あと${remain}秒)`);
        this.cooldownLogged = true;
      }
      return;
    }

    // 見送り抑止ゲート: アンカーが在れば、節目クロス or 安全弁時間まで再計画を抑止する。
    if (this.planSuppressedAnchor !== null) {
      const levels = getLevelsSnapshot();
      if (shouldRearmOnLevel(this.planSuppressedAnchor, price, levels)) {
        const b = rearmBounds(this.planSuppressedAnchor, levels);
        console.log(`${this.logTag} plan-rearm 節目クロス anchor=${Math.round(this.planSuppressedAnchor)} `
          + `price=${Math.round(price)} bounds=[${b.lower ?? '±'},${b.upper ?? '±'}]`
          + `${b.usedFallback ? ' (±50fallback)' : ''}`);
        this.planSuppressedAnchor = null;   // 再武装(=以降は通常の間隔判定へ)。
      } else if (now - this.lastPlanAt >= SUPPRESS_SAFETY_MS) {
        console.log(`${this.logTag} plan-rearm 安全弁(${Math.round(SUPPRESS_SAFETY_MS / 60_000)}分経過) `
          + `anchor=${Math.round(this.planSuppressedAnchor)} price=${Math.round(price)}`);
        // アンカーは維持(none が返れば下でアンカー更新)。安全弁として1本だけ要求へ進む。
      } else {
        return;   // 抑止継続。
      }
    }

    if (now - this.lastPlanAt < this.planIntervalMs) return;
    this.planning = true;
    this.lastPlanAt = now;   // 起動直後の多重要求を防ぐため、要求時点で更新する。
    const anchorPrice = price;   // 見送りが返った場合のアンカー(要求時点の現在値)。
    void (async () => {
      try {
        // route(/api/scalp-plan・trade2)と同一の共通関数を使う。profile で A/B の設定を解決する
        // (A=グローバル=trade2 と同条件 / B=signalB)。画像未生成/LLM 失敗は result.ok=false → FLAT 維持(見送り)。
        const { runScalpPlanWithChart } = await import('../llm/scalpPlanRunner.js');
        const result = await runScalpPlanWithChart({ profile: this.cfg.profile });
        if (this.state.phase === 'flat' && result.ok) {
          // ★正規シグナルのゲート(A/B 共通): trade2 の送信直前サニティ(src/ai/sanity.ts)を先取りして
          //   検証し、trade2 が REJECT する構造の計画は「正規シグナル」として出さない(=紙 ARM もしない・
          //   currentSignal も更新しない・broadcast もしない)。これで monitor の紙と trade2 の実弾が乖離しない。
          //   maintainsCurrentSignal に依らず適用(=計画が構造的にトレード可能かの判定・A/B とも通過した計画だけが
          //   シグナルになる)。anchorPrice=計画時の現在値(NIY=F)。非有限なら checkSanity が NG→抑止(安全)。
          const sanity = result.plan.direction === 'none' ? null : checkSanity(result.plan, anchorPrice);
          if (result.plan.direction === 'none') {
            // 見送り: アンカーを記録し、価格が節目を跨ぐまで再計画を抑止する。
            this.planSuppressedAnchor = anchorPrice;
            console.log(`${this.logTag} plan-suppress 見送り→節目まで抑止 anchor=${Math.round(anchorPrice)}`);
          } else if (sanity && !sanity.ok) {
            // サニティ不通過=見送り(none)と同じ扱い: アンカーを記録し節目まで抑止する。
            this.planSuppressedAnchor = anchorPrice;
            console.log(`${this.logTag} plan-suppress サニティ不通過(${sanity.reason})→ 正規シグナルにしない anchor=${Math.round(anchorPrice)}`);
          } else {
            const armed = planToArmed(result.plan, Date.now(), { vetoFired: result.vetoFired });
            if (armed) {
              // ★v0.7.56: 実効設定スナップショット(委任モード+値)を arm 時に確定して持ち回る(profile 別)。
              armed.settings = buildSettingsSnapshot(realizedLcFromArmed(armed), this.cfg.profile);
              this.state = { phase: 'armed', armed };   // 新規 armed で直近決済表示はクリア。
              this.planSuppressedAnchor = null;         // actionable で抑止解除。
              if (this.cfg.maintainsCurrentSignal) {
                // ARM ごとに signalId を単調増加で採番し、現在シグナルを更新(A のみ・filled 後も保持・none では更新しない)。
                this.signalIdCounter += 1;
                this.currentSignal = armedToCurrentSignal(armed, this.signalIdCounter);
              }
              this.broadcastSignalState(Date.now());    // ARM 時に即 broadcast(A は trade2 が即追従できるよう)。
            }
          }
        }
      } catch (e) {
        console.warn(`${this.logTag} plan request failed:`, e instanceof Error ? e.message : String(e));
      } finally {
        this.planning = false;
      }
    })();
  }

  // 非公開: 現在の state + (A のみ)currentSignal から SSE state を組み立てて broadcast(前回と同一 JSON なら抑止)。
  private broadcastSignalState(now: number): void {
    const price = getPrices().find(p => p.symbol === NIKKEI_SYMBOL)?.price ?? null;
    const s = toSignalTradeState(this.state, price, now, this.signalForState());
    const json = JSON.stringify(s);
    if (json !== this.lastBroadcastJson) {
      this.lastBroadcastJson = json;
      broadcast({ type: this.cfg.broadcastType, payload: s });
    }
  }

  /** priceLoop から毎 tick 呼ぶ。現在値で遷移を進め、決済を記録し、必要なら次プランを要求し、
   *  state を SSE broadcast する。エンジン未起動時は何もしない(既存 SSE を汚さない)。 */
  feed(price: number, now: number): void {
    if (!this.running) return;
    try {
      const { next, recorded, armedTimedOut } = advance(this.state, price, now);
      this.state = next;
      if (armedTimedOut) {
        // ★未約定ブラケットの取消。以降 phase=flat で maybeRequestPlan が再計画できる(固着解除)。
        console.log(`${this.logTag} armed-timeout 未約定ブラケットを取消→FLAT`
          + `(${Math.round(ARMED_TIMEOUT_MS / 60_000)}分 未約定・再計画へ)`);
      }
      if (recorded) {
        this.persistTrade(recorded);
        // 決済(filled→flat)= 全建玉クローズ。クールダウン起点を記録し、ログ抑止を解除(次tickで一度出す)。
        this.lastSignalExitAt = now;
        this.cooldownLogged = false;
      }
      this.maybeRequestPlan(price, now);
      this.heartbeat(now);   // ★診断: 定期にエンジン状態を1行ログ(固着の早期発見)。
      this.broadcastSignalState(now);
    } catch (e) {
      console.warn(`${this.logTag} tick error:`, e instanceof Error ? e.message : String(e));
    }
  }

  /** ★診断ログ(HEARTBEAT_MS 毎に1行): 各エンジンの生存と状態を可視化する。固着(armed のまま / planning が
   *  真のまま)を早期に発見できるよう、phase・planning・arm 経過・最終計画からの経過を出す。
   *  例) `[signalTradeB] hb phase=armed planning=false sinceArm=8m lastPlan=8m前 suppressed=false`
   *  → sinceArm が伸び続ける=未約定固着(ARMED_TIMEOUT_MS で自動取消される) / phase=flat かつ planning=true が
   *    続く=計画要求が返らず固着。今回のような無音停止の原因究明を容易にする(通常運用の負荷は無視できる)。 */
  private lastHeartbeatAt = 0;
  private heartbeat(now: number): void {
    if (now - this.lastHeartbeatAt < HEARTBEAT_MS) return;
    this.lastHeartbeatAt = now;
    const phase = this.state.phase;
    const mins = (t: number | undefined | null): string => (t ? `${Math.round((now - t) / 60_000)}m` : '-');
    const sinceArm = phase === 'armed' ? mins(this.state.armed?.at) : '-';
    console.log(`${this.logTag} hb phase=${phase} planning=${this.planning} sinceArm=${sinceArm} `
      + `lastPlan=${mins(this.lastPlanAt)}前 suppressed=${this.planSuppressedAnchor != null}`);
  }
}

// ─── インスタンス: A(実売買・グローバル設定)/ B(紙専用・signalB 設定) ─────────────
// ★A は従来の singleton と同一構成(profile:'A'・system=null・'signalTrade'・currentSignal 露出)=挙動 byte 不変。
const engineA = new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
// B は紙専用: signalB 設定・system='B'・'signalTradeB'・currentSignal を一切持たない(trade2 は B を追わない)。
const engineB = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });

/** 起動: A と B の両エンジンを有効化(冪等)。A の起動挙動/ログは従来と同一。 */
export async function startSignalEngine(): Promise<void> {
  await engineA.start();
  await engineB.start();
}

export function stopSignalEngine(): void { engineA.stop(); engineB.stop(); }

/** 現在の SSE state(A=実売買)。stream.ts の初回送出 / 各 tick の broadcast 用。外部契約は従来と byte 一致。 */
export function getSignalTradeState(now = Date.now()): SignalTradeState { return engineA.getState(now); }

/** ★v0.8.2: System B(紙専用)の現在 SSE state。signal/hold は含まない(currentSignal を露出しない)。 */
export function getSignalTradeStateB(now = Date.now()): SignalTradeState { return engineB.getState(now); }

/** 現在シグナル(trade2 追従用=A のみ)。まだ ARM していなければ null。表示/連携専用(発注はしない)。 */
export function getCurrentSignal(): CurrentSignal | null { return engineA.getCurrentSignal(); }

/** 現在の phase(flat|armed|filled・A)。trade2 の late-join 用 getter。エンジン挙動は不変(露出のみ)。 */
export function getSignalPhase(): SignalPhase { return engineA.getPhase(); }

/** 保有中の意図(hold・trade2 追従用=A)。filled の間だけ返す(決済逆指値=毎tick算出)。他は null。 */
export function getSignalHold(): SignalHold | null { return engineA.getHold(); }

/** priceLoop から毎 tick 呼ぶ。A と B の両エンジンへ同じ現在値を供給する(A の挙動は不変・B は独立に並走)。 */
export function feedSignalEngine(price: number, now: number): void {
  engineA.feed(price, now);
  engineB.feed(price, now);
}

/** テスト/リセット用: A エンジン内部状態を初期化する(従来と同一=A の回帰テスト互換)。 */
export function _resetSignalEngine(): void { engineA.reset(); }

/** テスト/リセット用: B エンジン内部状態を初期化する。 */
export function _resetSignalEngineB(): void { engineB.reset(); }

/** 決済記録の meta(JSON文字列)を組み立てる純関数。v0.7.54: AI 自己レジーム/確信度/veto発火 + ctxV。
 *  planMeta が空/欠落でも ctxV:'rich' は常に記録する(rich文脈で生成された世代の印)。 */
export function buildTradeMetaJson(planMeta?: PlanMeta, settings?: SignalSettingsSnapshot): string {
  const meta: Record<string, unknown> = { ctxV: 'rich' };
  if (planMeta?.regime !== undefined) meta.regime = planMeta.regime;
  if (planMeta?.confidence !== undefined) meta.confidence = planMeta.confidence;
  if (planMeta?.vetoFired !== undefined) meta.vetoFired = planMeta.vetoFired;
  // ★v0.7.56: 実効設定スナップショットを meta にマージ(在るときだけ・後方互換)。history/分析で「どの設定か」を残す。
  if (settings) meta.settings = settings;
  return JSON.stringify(meta);
}

/** ★v0.7.56: KnobDirective を1 knob 分のスナップショットへ整形する純関数。
 *  manual は設定値を value に載せる / ai は原則 value 省略(mode のみ)。ただし realizedLc を渡した LC 系
 *  (lcFloor/lcCeiling)は ai でも実測 LC 幅を value に入れる(AI委任項目の実現値を計測できるように)。 */
export function knobSnapshot<T>(d: KnobDirective<T>, realizedLcYen?: number): KnobSettingSnapshot {
  if (d.mode === 'manual') return { mode: 'manual', value: d.value as unknown as (number | string | boolean) };
  return typeof realizedLcYen === 'number' && Number.isFinite(realizedLcYen)
    ? { mode: 'ai', value: realizedLcYen }
    : { mode: 'ai' };
}

/** ★v0.7.56: 現在の設定(config)から実効設定スナップショットを組み立てる純関数(config 読みのみ)。
 *  realizedLcYen(採用/約定レッグの |entry−SL|)を渡すと、AI委任の LC(lcFloor/lcCeiling)の value に実測を入れる。
 *  ★v0.8.2: profile を渡すと B(signalB→A フォールバック)の実効設定を反映。省略/'A'=グローバル(現行と byte 一致)。 */
export function buildSettingsSnapshot(realizedLcYen?: number, profile?: SignalProfile): SignalSettingsSnapshot {
  const hardMax = resolveScalpLcHardMax(profile);
  return {
    lcFloor: knobSnapshot(resolveScalpLcFloorDirective(profile), realizedLcYen),
    lcCeiling: knobSnapshot(resolveScalpLcCeilingDirective(profile), realizedLcYen),
    lcHardMax: { enabled: hardMax.enabled, value: hardMax.value },
    trendVeto: knobSnapshot(resolveScalpTrendVetoDirective(profile)),
    cooldown: knobSnapshot(resolveScalpCooldownDirective(profile)),
    bias: knobSnapshot(resolveScalpBiasDirective(profile)),
    range: knobSnapshot(resolveScalpRangeDirective(profile)),
  };
}

/** ★v0.8.2: RecordedTrade + 系統タグ(A=null/B='B')から DB 挿入行を組み立てる純関数(テスト可能)。
 *  A(system=null)は従来と byte 一致の行を作る。mode/meta の付与規約も従来どおり。 */
export function buildSignalTradeInsert(t: RecordedTrade, system: 'A' | 'B' | null): SignalTradeInsert {
  return {
    entryT: t.entryT, entryPrice: t.entryPrice, dir: t.dir,
    exitT: t.exitT, exitPrice: t.exitPrice, pnl: t.pnl, qty: t.qty,
    rationale: t.rationale,
    // range 由来のみ 'range' タグ、それ以外は 'directional'(別枠集計・後方互換)。
    mode: t.mode === 'range' ? 'range' : 'directional',
    // v0.7.54: AI 自己レジーム/確信度/veto発火 + v0.7.56: 実効設定スナップショット を JSON で記録(後の A/B 実測用)。
    meta: buildTradeMetaJson(t.planMeta, t.settings),
    // ★v0.8.2: 系統タグ。A は null(=既存挙動と同一) / B は 'B'。
    system: system ?? undefined,
  };
}

/** ★v0.7.56: armed ブラケットの代表レッグの初期LC幅 |entry−SL| を返す純関数(実測値=AI委任 LC の value 用)。
 *  directional は指値レッグ優先(無ければ逆指値)/ range は upper 優先(無ければ lower)。測れなければ undefined。 */
export function realizedLcFromArmed(a: ArmedBracket): number | undefined {
  const abs = (x: number, y: number): number => Math.abs(x - y);
  if (a.mode === 'range' || a.range != null) {
    const u = a.range?.upper, l = a.range?.lower;
    if (u) return abs(u.entry, u.stopLoss);
    if (l) return abs(l.entry, l.stopLoss);
    return undefined;
  }
  if (a.limitEntry != null && a.stopLossForLimit != null) return abs(a.limitEntry, a.stopLossForLimit);
  if (a.stopEntry != null && a.stopLossForStop != null) return abs(a.stopEntry, a.stopLossForStop);
  return undefined;
}

