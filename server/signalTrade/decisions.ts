// トレードシグナル紙エンジンの「純粋な決定コア」。
//
// ここには engine の状態遷移/約定判定/phase 遷移/SSE state 組み立て/plan→armed 変換など、
// EngineState を引数で受け取り副作用を持たない純関数(と、それらが扱う型)だけを置く。
// SignalEngine インスタンスの状態には一切依存しない(instance state を閉包しない)。
// DB / LLM / broadcast / configStore は呼ばない(それらは engine.ts / persist.ts が担う)。

import type { SignalTradeState, SignalSettingsSnapshot } from '../types.js';
import type { RangeLeg } from '../llm/openai.js';
import { computeExitStop } from './exit/index.js';

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

/** 指値(LIMIT)の約定は「節目をちょうどタッチ」ではなく、指値を LIMIT_FILL_MARGIN_YEN 円 “行き過ぎ” て
 *  はじめて成立とみなす保守モデル。現実の指値は主要水準ちょうどでは約定しづらいため。逆指値(STOP)は成行転換
 *  なのでタッチ約定のまま。trade2 も概念的に同値を共有できるよう export する。記録建値は指値価格のまま(=トリガ条件のみ厳格化)。 */
export const LIMIT_FILL_MARGIN_YEN = 5;

/** ブラケットのどちらのレッグが約定したか。両レッグが同 tick で満たす場合は指値を優先。無ければ null。 */
export function detectFill(a: ArmedBracket, price: number): { leg: 'limit' | 'stop'; entryPrice: number; initialStop: number } | null {
  const buy = a.direction === 'buy';
  if (a.limitEntry != null && a.stopLossForLimit != null) {
    // 指値: buy は指値より 5円 下 / sell は指値より 5円 上まで行き過ぎて約定(保守モデル)。記録建値は指値のまま。
    const hit = buy ? price <= a.limitEntry - LIMIT_FILL_MARGIN_YEN : price >= a.limitEntry + LIMIT_FILL_MARGIN_YEN;
    if (hit) return { leg: 'limit', entryPrice: a.limitEntry, initialStop: a.stopLossForLimit };
  }
  if (a.stopEntry != null && a.stopLossForStop != null) {
    // 逆指値: buy は現値が逆指値以上へ上昇 / sell は逆指値以下へ下落で約定(成行転換=タッチ約定のまま)。
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
  // レンジ両面は逆張り指値(LIMIT)なので detectFill と同じ保守マージンを課す(節目を 5円 行き過ぎて約定)。記録建値は据置。
  const upper = a.range?.upper;
  const lower = a.range?.lower;
  if (upper && price >= upper.entry + LIMIT_FILL_MARGIN_YEN) {
    return { side: upper.side, entryPrice: upper.entry, initialStop: upper.stopLoss };
  }
  if (lower && price <= lower.entry - LIMIT_FILL_MARGIN_YEN) {
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
 *  signal(現在シグナル・trade2 追従用)は在れば付与する。既存フィールドは不変=パネル表示互換。
 *  ★lastExitedSignalId(RECORD/ADD-ONLY): 直近に決済(filled→flat)したシグナルの signalId。
 *   在るときだけ露出する(初回決済まで undefined=既存 JSON 不変=broadcast dedupe を壊さない)。 */
export function toSignalTradeState(
  st: EngineState, price: number | null, now: number, signal?: CurrentSignal | null,
  lastExitedSignalId?: number,
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
  // ★直近決済シグナルID(ADD-ONLY): 在るときだけ露出(初回決済まで欠落=既存 JSON 不変)。
  if (lastExitedSignalId != null) s.lastExitedSignalId = lastExitedSignalId;
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
