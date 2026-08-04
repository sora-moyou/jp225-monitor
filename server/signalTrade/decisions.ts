// トレードシグナル紙エンジンの「純粋な決定コア」。
//
// ここには engine の状態遷移/約定判定/phase 遷移/SSE state 組み立て/plan→armed 変換など、
// EngineState を引数で受け取り副作用を持たない純関数(と、それらが扱う型)だけを置く。
// SignalEngine インスタンスの状態には一切依存しない(instance state を閉包しない)。
// DB / LLM / broadcast / configStore は呼ばない(それらは engine.ts / persist.ts が担う)。

import type { SignalTradeState, SignalSettingsSnapshot } from '../types.js';
import type { RangeLeg, AiPlan } from '../llm/openai.js';
import { computeExitStop, type ExitFn } from './exit/index.js';
import type { ExitReason } from '../../core/exitReasons.js';

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
  // ★ドテン(反転): このブラケットが保有中の反転評価で armed された「反対方向の反転建て」であることを示す。
  //   在るときだけ true(add-only)=非ドテンの armed は従来と byte 一致。armedToCurrentSignal / position / recorded へ持ち回る。
  doten?: true;
  // ★遡り解析用(RECORD-ONLY・ADD-ONLY): ARM した瞬間に monitor が見ていた live 価格(新鮮値のみ)。
  //   at(ARM 時刻)と対で position→recorded→signal_trades(armed_t/armed_price)へ持ち回る。
  //   ★これが要る理由: 事後に prices_*.db の ticks で代用すると collector(別プロセス・別位相・AJAXキャッシュ)の
  //     価格列になり monitor が feed した価格と一致しない=「武装時点で通過済みだったか」を誤判定する。
  //   取れない/stale なら欠落(=記録は NULL)。engine が ARM の3経路(flat計画/ドテン反対建て/レンジ再評価差替え)で据える。
  armedPrice?: number;
  // ★v0.9.59: このブラケット固有の未約定待ち時間[ms]。ARM 時にエントリーまでの距離とその時間帯の
  //   ボラティリティから決める(armWait.ts の computeArmWait)。欠落なら従来どおり ARMED_TIMEOUT_MS(15分)。
  //   ADD-ONLY: 据えない呼び出し元(テスト/影シミュ)は byte 一致で従来挙動のまま。
  waitMs?: number;
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
  // ★ドテン(反転)シグナル。在るときだけ true(add-only)。反転指示=保有と反対方向・limit/stop/SL は新規反対建玉のもの・
  //   signalId は新規採番。trade2 は「doten:true + 新 signalId + FILLED」を専用トリガーにする。
  doten?: true;
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
  doten?: true;          // ★ドテン(反転)で建てた建玉(add-only)。決済記録(RecordedTrade)まで持ち回る。
  armedAt?: number;      // ★遡り解析用: この建玉の ARM(武装)時刻(= armed.at)。at−armedAt = ARM→約定の経過。
  armedPrice?: number;   // ★遡り解析用: ARM 時点で monitor が見ていた価格(取れない/stale は欠落)。
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
  doten?: true;   // ★ドテン(反転)関連トレード(add-only)。P の反転決済 or 反転建玉の決済。meta.doten に残す。
  armedAt?: number;      // ★遡り解析用: この建玉の ARM 時刻 → signal_trades.armed_t(entryT−armedAt=ARM→約定の経過)。
  armedPrice?: number;   // ★遡り解析用: ARM 時点の価格 → signal_trades.armed_price(取れない/stale は欠落=NULL)。
  // ── ★決済パラメータ分析用(RECORD-ONLY・必須3点)。決済の判断/価格/タイミングには一切関与しない ──────
  //   ★必須(optional にしない)理由: 決済経路が増えたときに「記録だけ忘れる」ことを型で不可能にするため。
  //     RecordedTrade を作る = この3つを埋める、以外の道が無い(core/exitReasons.ts の契約を参照)。
  /** R1: 決済理由。どの経路で建玉が閉じたか(core/exitReasons.ts の表のキー)。 */
  exitReason: ExitReason;
  /** R2: **約定したレッグ**の初期LC(絶対価格)= OpenPosition.initialStop。
   *   ★meta.settings の LC は「代表レッグ(指値優先)」の幅であり、2レッグのブラケットでは実際に約定した
   *     レッグと食い違う。反実仮想(初期LCを変えていたら)には約定レッグの実値でなければ再現できない。 */
  exitInitialStop: number;
  /** R3: 決済時点の含み益ピーク[pt]= OpenPosition.peakProfit(エンジンがラチェット床の決定に使っている値そのもの)。
   *   これで「床の何段目が効いたか」が設定値から逆算でき、各エントリーの MFE が価格再生なしで分かる。 */
  peakProfit: number;
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

/** **純粋な成行(market)**約定の不利方向スリッページ[円]= 1tick(N225刻み)。trade2 の slippageTicks*TICK と一致。
 *  ★適用先は「板を叩きに行く成行」だけ: ドテンの成行クローズ / レンジTPの成行決済。
 *  ★**逆指値(stop)には適用しない**(→ STOP_SLIPPAGE_YEN)。 */
export const SLIPPAGE_YEN = 5;

/** **逆指値(stop)がトリガして成行転換したとき**の不利方向スリッページ[円]= **0**(=逆指値価格ちょうどで約定)。
 *  新規(open)・決済(close)とも同じ。trade2 matchingEngine.tryFill の stop 分岐と同一規約。
 *
 *  ★根拠(実測・業者の実約定174件・forward_kabu.db の order_events[id-captured 送信価格] ⇔
 *    order_inquiries[status='filled' 業者返却の実約定価格] 突合。不利方向を + とする):
 *      stop/open  n=54  mean −0.19円  median 0  (43/54=80% が逆指値価格ちょうど)  95%CI[−1.96,+1.59]
 *      stop/close n=45  mean +1.22円  median 0  (18/45=40% ちょうど・+5が17件・−5が9件) 95%CI[−0.03,+2.47]
 *    → open/close とも **5円は t≈−5.7/−5.9 で棄却**・0 は棄却できない(CI が 0 を含む)。
 *    → 決済側の残差 +1.2円 は 5円刻みでは表現できず、部分集合(勝ち/負け・タグ別・日別)のどれを見ても
 *      5円を支持する層は無い(全層で 5 を棄却)。n=45 の弱いノイズ性の残差として 0 を採る。
 *    ★既知の残差: 決済は平均 +1.2円ぶん紙が楽観(旧モデルの −3.8円の誤差より小さい)。
 *  ★これが重い理由: 旧実装の一律5円は、いま計測中の効果(4.3pt/件)と同じ桁の系統誤差を
 *    紙の損益・影の模擬・TP/SL検証のすべてに載せていた。 */
export const STOP_SLIPPAGE_YEN = 0;

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
    // ★建値は **逆指値価格ちょうど**(STOP_SLIPPAGE_YEN=0)。実測で 8割が逆指値価格ちょうど・平均は実質ゼロ
    //   (根拠は STOP_SLIPPAGE_YEN の定義を参照)。trade2 の matchingEngine.tryFill(stop)と一致。
    const hit = buy ? price >= a.stopEntry : price <= a.stopEntry;
    if (hit) return { leg: 'stop', entryPrice: a.stopEntry + (buy ? STOP_SLIPPAGE_YEN : -STOP_SLIPPAGE_YEN), initialStop: a.stopLossForStop };
  }
  return null;
}

/** レンジ両面ストラドルの約定判定(純関数)。現在値が上レッグの約定条件を満たせば上レッグ、
 *  そうでなく下レッグの条件を満たせば下レッグを約定。約定 side/建値/初期LC を返す。未到達は null。
 *  ★条件はレッグ type 別: limit=節目を LIMIT_FILL_MARGIN_YEN 行き過ぎ / stop=タッチ(下の legHit を参照)。
 *  ★どちらか約定した時点で もう片方は暗黙にキャンセル(OCO)= 呼び出し側は position へ遷移するだけ。
 *  upper/lower はどちらか欠落しうる(enforce/parse で片レッグに落ちた range = 実質片面)。 */
export function detectRangeFill(
  a: ArmedBracket, price: number,
): { side: 'buy' | 'sell'; entryPrice: number; initialStop: number } | null {
  // ★約定条件はレッグ type で分岐する(detectFill の指値/逆指値と同じ規約に統一):
  //   type==='limit'(fade=逆張り指値): 節目を LIMIT_FILL_MARGIN_YEN 円 “行き過ぎ” て約定(保守モデル。
  //     現実の指値は主要水準ちょうどでは約定しづらいため)。
  //   type==='stop'(breakout=抜け追随の逆指値): タッチ(0円)で約定。実弾(trade2)の逆指値はタッチで発火して
  //     成行になるため、紙が 5円 待つと「タッチして反転した回=実弾は建玉あり・紙は建玉なし」の台帳食い違いが出る。
  //   type 欠落は limit 扱い(保守側=行き過ぎ要求)。
  const legHit = (leg: RangeLeg, up: boolean): boolean => {
    const margin = leg.type === 'stop' ? 0 : LIMIT_FILL_MARGIN_YEN;
    return up ? price >= leg.entry + margin : price <= leg.entry - margin;
  };
  // ★約定建値: type==='stop'(breakout=逆指値)は **逆指値価格ちょうど**(STOP_SLIPPAGE_YEN=0・実測どおり)。
  //   type==='limit'(fade)も指値ちょうどで約定=スリップ無し(trade2 と一致)。type 欠落は limit 扱い。
  const legEntry = (leg: RangeLeg): number =>
    leg.type === 'stop' ? leg.entry + (leg.side === 'buy' ? STOP_SLIPPAGE_YEN : -STOP_SLIPPAGE_YEN) : leg.entry;
  const upper = a.range?.upper;
  const lower = a.range?.lower;
  if (upper && legHit(upper, true)) {
    return { side: upper.side, entryPrice: legEntry(upper), initialStop: upper.stopLoss };
  }
  if (lower && legHit(lower, false)) {
    return { side: lower.side, entryPrice: legEntry(lower), initialStop: lower.stopLoss };
  }
  return null;
}

/** ★通過済み(stale)レッグの診断(記録専用)。checkStaleLegs が判定した各レッグの生数値と「もう通過しているか」。
 *  engine が1行ログに出す(名前は NoneLeg と同じ 'limit'|'stop'|'upper'|'lower')。 */
export interface StaleLegReport {
  name: 'limit' | 'stop' | 'upper' | 'lower';
  entry: number;
  stale: boolean;   // true = ARM 時点の live 価格で既に約定条件を満たす(=武装したら即約定する)
}

/** ★「もう通過した価格」のレッグを武装しない純関数(stale plan veto)。
 *  monitor は ARM 前サニティを plan.refPrice(チャート撮影時の価格)に対して行う(そこは設計判断として不変。
 *  anchorPrice で弾くと過剰抑止と trade2 との乖離が起きる)。しかし画像生成+LLM 応答に数秒〜十数秒かかる間に
 *  価格が動くため、refPrice には妥当でも **ARM 時点の live 価格では既にエントリーを通過している** 計画が届く。
 *  それを武装すると次の価格tickで即約定し、現実には執行不可能な取引が紙の成績に混ざる(紙と実弾の忠実性を損なう)。
 *  → ARM 時点で「そのレッグが即約定してしまう」なら、そのレッグを落とす。
 *  ★判定は detectFill / detectRangeFill を **そのまま再利用** する(1レッグだけのブラケットを組んで問う)ので、
 *    約定条件と完全に同一規約になる(指値=LIMIT_FILL_MARGIN_YEN 行き過ぎ / 逆指値=タッチ / レンジは type 別分岐)。
 *    同じ判定を2箇所に書かないための実装方針(規約が変わっても自動的に追従する)。
 *  戻り値 armed: 生き残ったレッグだけのブラケット。落とすレッグが無ければ **引数と同一参照**(=挙動 byte 不変)。
 *    全レッグが通過済みなら null(=ARM しない=見送り)。legs: 判定した全レッグの生数値(ログ用・記録専用)。
 *  ★live 価格が取れない/非有限(null/undefined/NaN/Inf)なら判定せず引数をそのまま返す(安全側=新しい抑止で
 *    取引を止めない)。 */
export function checkStaleLegs(
  a: ArmedBracket, livePrice: number | null | undefined,
): { armed: ArmedBracket | null; legs: StaleLegReport[] } {
  if (livePrice == null || !Number.isFinite(livePrice)) return { armed: a, legs: [] };
  const price = livePrice;
  const legs: StaleLegReport[] = [];
  if (a.mode === 'range' || a.range != null) {
    // レンジ: 片側だけの range を組んで detectRangeFill に問う(=レッグ type 別の約定条件をそのまま使う)。
    const upper = a.range?.upper;
    const lower = a.range?.lower;
    let keepUpper = upper;
    let keepLower = lower;
    if (upper) {
      const stale = detectRangeFill({ ...a, range: { upper } }, price) != null;
      legs.push({ name: 'upper', entry: upper.entry, stale });
      if (stale) keepUpper = undefined;
    }
    if (lower) {
      const stale = detectRangeFill({ ...a, range: { lower } }, price) != null;
      legs.push({ name: 'lower', entry: lower.entry, stale });
      if (stale) keepLower = undefined;
    }
    if (!keepUpper && !keepLower) return { armed: null, legs };
    if (keepUpper === upper && keepLower === lower) return { armed: a, legs };   // 何も落ちない=同一参照。
    const next: ArmedBracket = { ...a, range: {} };
    if (keepUpper) next.range!.upper = keepUpper;
    if (keepLower) next.range!.lower = keepLower;
    return { armed: next, legs };
  }
  // 単方向(directional): レッグ単独のブラケットを組んで detectFill に問う(指値=5円行き過ぎ / 逆指値=タッチ)。
  const hasLimit = a.limitEntry != null && a.stopLossForLimit != null;
  const hasStop = a.stopEntry != null && a.stopLossForStop != null;
  let keepLimit = hasLimit;
  let keepStop = hasStop;
  if (hasLimit) {
    const stale = detectFill({ ...a, stopEntry: undefined, stopLossForStop: undefined }, price) != null;
    legs.push({ name: 'limit', entry: a.limitEntry as number, stale });
    if (stale) keepLimit = false;
  }
  if (hasStop) {
    const stale = detectFill({ ...a, limitEntry: undefined, stopLossForLimit: undefined }, price) != null;
    legs.push({ name: 'stop', entry: a.stopEntry as number, stale });
    if (stale) keepStop = false;
  }
  if (!keepLimit && !keepStop) return { armed: null, legs };
  if (keepLimit === hasLimit && keepStop === hasStop) return { armed: a, legs };   // 何も落ちない=同一参照。
  const next: ArmedBracket = { ...a };
  if (!keepLimit) { delete next.limitEntry; delete next.stopLossForLimit; }
  if (!keepStop) { delete next.stopEntry; delete next.stopLossForStop; }
  return { armed: next, legs };
}

/** ★遡り解析用(RECORD-ONLY): ARM 時刻/ARM 時点価格を次の段(armed→建玉→決済記録)へ引き継ぐ。
 *  非有限/欠落はキーを作らない(=既存の記録と byte 一致・DB では NULL)。時刻は必ず「ARM 時刻」を明示的に
 *  渡す契約にしてある(建玉の at=約定時刻 と取り違えると armed_t が約定時刻になり経過が常に0になるため)。 */
function carryArmed(dst: { armedAt?: number; armedPrice?: number }, armedAt?: number, armedPrice?: number): void {
  if (armedAt != null && Number.isFinite(armedAt)) dst.armedAt = armedAt;
  if (armedPrice != null && Number.isFinite(armedPrice)) dst.armedPrice = armedPrice;
}

/** 含み損益(pt)。buy は上昇で+、sell は下落で+。 */
export function unrealizedPt(direction: 'buy' | 'sell', entry: number, price: number): number {
  return direction === 'buy' ? price - entry : entry - price;
}

/** 現在の決済逆指値(絶対価格)。非公開 phase-exit(または簡易フォールバック)に委譲。
 *  ★exitFn(省略可)は **分析用の影の模擬だけ** が渡す差し替え(既定=computeExitStop=実運用)。
 *    省略時の挙動は従来と byte 一致(実弾に繋がる呼び出し元は渡さない)。
 *  ★なぜ引数で渡すか: グローバル差し替え(_setExitImpl)にすると、影の模擬が走っている最中に
 *    **実建玉の決済逆指値が影のパラメータで算出される** 競合が起きる。引数なら並走しても干渉しない。
 *  ★OpenPosition → ExitState の写像はここ1箇所だけ(影も同じこの関数を通る=写像を二重に書かない)。 */
export function restingStopOf(pos: OpenPosition, exitFn: ExitFn = computeExitStop): number | null {
  return exitFn({
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

/** このブラケットに適用する待ち時間[ms]。armed.waitMs が据わっていればそれ、無ければ従来の一律 15分。
 *  ★可変化(armWait.ts)後も「据えなかった呼び出し元は従来と完全に同じ」を保証するための単一の入口。 */
export function armedWaitMsOf(a: { waitMs?: number } | null | undefined): number {
  const v = a?.waitMs;
  return v != null && Number.isFinite(v) && v > 0 ? v : ARMED_TIMEOUT_MS;
}

/** advance の任意オプション。**実弾に繋がる呼び出し元は渡さない**(渡さなければ従来と byte 一致)。 */
export interface AdvanceOptions {
  /** 決済逆指値の算出を差し替える(既定=computeExitStop=実運用の非公開 phase-exit)。
   *  分析用の「影」は同じ advance を **パラメータだけ変えて** 呼ぶためにこれを渡す
   *  (約定判定 detectFill / 建玉組み立て / スリッページ / 決済理由の規約を一切再実装しない)。 */
  exitFn?: ExitFn;
}

/** 現在値 price を受けて armed→filled / filled→flat の遷移を1歩進める純関数(DB/LLM は呼ばない)。
 *  filled では peakProfit を更新し、ラチェット逆指値に達したら決済して RecordedTrade を返す。
 *  armed が ARMED_TIMEOUT_MS を超えて未約定なら取消して FLAT(armedTimedOut=true)。 */
export function advance(
  st: EngineState, price: number, now: number, opts?: AdvanceOptions,
): { next: EngineState; recorded?: RecordedTrade; armedTimedOut?: boolean } {
  if (st.phase === 'armed' && st.armed) {
    // ★未約定タイムアウト: どちらのレッグも約定しないまま一定時間経過 → 取消して FLAT(再計画可能に)。
    //   armed.at はブラケット武装時刻。約定判定より前に評価する(タイムアウトが最優先)。
    //   ★待ち時間はブラケット固有(armed.waitMs)。据わっていなければ従来の一律 ARMED_TIMEOUT_MS。
    if (st.armed.at != null && now - st.armed.at >= armedWaitMsOf(st.armed)) {
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
      carryArmed(position, st.armed.at, st.armed.armedPrice);   // ★遡り解析用: ARM 時刻/ARM 時点価格を建玉へ。
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
    if (st.armed.doten) position.doten = true;   // ★ドテン建玉フラグを約定後の建玉へ持ち回る(add-only)。
    carryArmed(position, st.armed.at, st.armed.armedPrice);   // ★遡り解析用: ARM 時刻/ARM 時点価格を建玉へ。
    return { next: { phase: 'filled', position, lastExit: st.lastExit } };
  }

  if (st.phase === 'filled' && st.position) {
    const pos = st.position;
    // ★決済で記録する約定価格に不利方向スリップを加える(ロング決済 dir='buy' は安く / ショート決済 dir='sell' は高く)。
    //   決済トリガ(detectExit / rangeTpTrigger / stop 水準)は不変=記録する fill 価格と pnl だけを補正(trade2 と一致)。
    //   ★スリップ量は決済の **執行形態** で決まる(実測に基づく・STOP_SLIPPAGE_YEN の定義を参照):
    //     ・逆指値ヒットの決済(初期LC / ラチェット床 / レンジ損側)= STOP_SLIPPAGE_YEN(0)= 逆指値価格ちょうど
    //     ・板を叩く純粋な成行決済(レンジTP)                       = SLIPPAGE_YEN(1tick)
    const withSlip = (raw: number, dir: 'buy' | 'sell', slip: number): number => raw + (dir === 'buy' ? -slip : slip);
    // ★レンジ建玉(rangeTp 設定済)= 損側は固定初期LC(ラチェットしない)/ 利側は反対側節目手前で成行決済(phase-exit を使わない)。
    //   directional / rangeTp 無しの建玉はこの分岐に入らず、既存の phase-exit(下)へ落ちる=byte 不変。
    if (pos.mode === 'range' && pos.rangeTp != null) {
      // 決済記録の共通組み立て(range タグ + planMeta/settings 引き継ぎ)。
      //   ★RECORD-ONLY: 決済理由(reason)は「どちらの条件で閉じたか」を呼び出し側が渡す(判断は下の分岐のまま=不変)。
      const mkRecorded = (exitPrice: number, pnl: number, reason: ExitReason): RecordedTrade => {
        const r: RecordedTrade = {
          entryT: pos.at, entryPrice: pos.entryPrice, dir: pos.direction,
          exitT: now, exitPrice, pnl, qty: pos.qty, rationale: pos.rationale, mode: 'range',
          // ★記録3点: 約定レッグの初期LC(レンジ建玉は固定=ラチェットしない)と、この建玉の含み益ピーク。
          //   ★レンジ建玉は peakProfit を約定時から更新しない(下の「peak 更新は range 決済に不要」参照)。
          //     つまりここに載るのは「約定 tick 時点のピーク」であって MFE ではない。エンジンが持っている値を
          //     そのまま残す(記録のために保有中の状態更新を足すと、それは挙動変更になるため足さない)。
          exitReason: reason, exitInitialStop: pos.initialStop, peakProfit: pos.peakProfit,
        };
        if (pos.planMeta) r.planMeta = pos.planMeta;
        if (pos.settings) r.settings = pos.settings;
        carryArmed(r, pos.armedAt, pos.armedPrice);   // ★遡り解析用: ARM 時刻/ARM 時点価格を決済記録へ。
        return r;
      };
      // 損側: 固定初期LC(ラチェットせず)。到達したらその逆指値で決済。両側が同 tick で満たす場合は損側優先(安全)。
      const stopHit = detectExit(pos, price, pos.initialStop);
      if (stopHit != null) {
        const exitFill = withSlip(stopHit, pos.direction, STOP_SLIPPAGE_YEN);   // 逆指値決済=逆指値価格ちょうど
        const pnl = realizedPnl(pos.direction, pos.entryPrice, exitFill, pos.qty);
        return { next: { phase: 'flat', lastExit: { exitPrice: exitFill, pnl, at: now } }, recorded: mkRecorded(exitFill, pnl, 'range_stop') };
      }
      // 利側: 反対側レンジ節目の手前(RANGE_TP_OFFSET_YEN 内側)に達したら成行(=現在値)で決済。
      const trigger = rangeTpTrigger(pos.direction, pos.rangeTp);
      const tpHit = pos.direction === 'buy' ? price >= trigger : price <= trigger;
      if (tpHit) {
        const exitFill = withSlip(price, pos.direction, SLIPPAGE_YEN);   // 板を叩く成行決済=不利1tick
        const pnl = realizedPnl(pos.direction, pos.entryPrice, exitFill, pos.qty);
        return { next: { phase: 'flat', lastExit: { exitPrice: exitFill, pnl, at: now } }, recorded: mkRecorded(exitFill, pnl, 'range_tp') };
      }
      // どちらも未到達 → 保有継続(peak 更新は range 決済に不要)。
      return { next: { phase: 'filled', position: pos, lastExit: st.lastExit } };
    }
    const peak = Math.max(pos.peakProfit, unrealizedPt(pos.direction, pos.entryPrice, price));
    const updated: OpenPosition = { ...pos, peakProfit: peak };
    const stop = restingStopOf(updated, opts?.exitFn);
    const exit = detectExit(updated, price, stop);
    if (exit == null) {
      return { next: { phase: 'filled', position: updated, lastExit: st.lastExit } };
    }
    const exitFill = withSlip(exit, pos.direction, STOP_SLIPPAGE_YEN);   // 逆指値決済=逆指値価格ちょうど
    const pnl = realizedPnl(pos.direction, pos.entryPrice, exitFill, pos.qty);
    const recorded: RecordedTrade = {
      entryT: pos.at, entryPrice: pos.entryPrice, dir: pos.direction,
      exitT: now, exitPrice: exitFill, pnl, qty: pos.qty, rationale: pos.rationale,
      // ★R1(RECORD-ONLY): ヒットした逆指値が初期LC そのものなら「初期LC」、そうでなければ「ラチェット床」。
      //   computeExitStop(非公開 phase-exit)は床が未発動/初期LC より不利なとき initialStop を **そのまま返す**
      //   契約なので、この同値比較で両者を判別できる(非公開の閾値/段数をここに持ち込まない=公開リポは不変)。
      //   ★簡易フォールバック(公開ビルド=ラチェット無し)では常に initialStop → 常に 'initial_stop' で正しい。
      exitReason: stop === pos.initialStop ? 'initial_stop' : 'ratchet_floor',
      // ★R2: 約定レッグの初期LC(建玉に載っている実値)。R3: この tick で更新済みの含み益ピーク(=床の決定に使った値)。
      exitInitialStop: pos.initialStop, peakProfit: peak,
    };
    // range 由来のみ mode タグを付与(directional は無付与=既存記録とバイト互換)。
    if (pos.mode === 'range') recorded.mode = 'range';
    if (pos.planMeta) recorded.planMeta = pos.planMeta;   // 自己レジーム/確信度/veto を決済記録へ。
    if (pos.settings) recorded.settings = pos.settings;   // ★v0.7.56: 実効設定を決済記録へ。
    if (pos.doten) recorded.doten = true;   // ★ドテン建玉の決済記録にフラグ(add-only)。
    carryArmed(recorded, pos.armedAt, pos.armedPrice);   // ★遡り解析用: ARM 時刻/ARM 時点価格を決済記録へ。
    return { next: { phase: 'flat', lastExit: { exitPrice: exitFill, pnl, at: now } }, recorded };
  }

  return { next: st };
}

/** 未約定失効の表示材料(engine が保持し SSE へ載せる)。
 *  count=累計(生涯・消さない=無音の失敗を数える指標) / streak=連続(約定のたびに 0)。
 *  lastWaitMs / lastBias は **直前に失効したブラケット** の実際の待ち時間と向き(待機表示用・不明なら欠落)。 */
export interface ArmedTimeoutView {
  count: number;
  streak: number;
  lastAt: number | null;
  lastWaitMs?: number | null;
  lastBias?: 'buy' | 'sell' | 'range' | null;
}

/** エンジン状態 + 現在値 + now から SSE state を組み立てる純関数。
 *  signal(現在シグナル・trade2 追従用)は在れば付与する。既存フィールドは不変=パネル表示互換。
 *  ★lastExitedSignalId(RECORD/ADD-ONLY): 直近に決済(filled→flat)したシグナルの signalId。
 *   在るときだけ露出する(初回決済まで undefined=既存 JSON 不変=broadcast dedupe を壊さない)。 */
export function toSignalTradeState(
  st: EngineState, price: number | null, now: number, signal?: CurrentSignal | null,
  lastExitedSignalId?: number,
  armedTimeout?: ArmedTimeoutView | null,
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
    // ★ドテン(反転)フラグ(ADD-ONLY): 実 doten の時だけ付与。非 doten の JSON は不変=dedupe/OFF byte 一致。
    if (signal.doten) s.signal.doten = true;
  }
  // ★直近決済シグナルID(ADD-ONLY): 在るときだけ露出(初回決済まで欠落=既存 JSON 不変)。
  if (lastExitedSignalId != null) s.lastExitedSignalId = lastExitedSignalId;
  // ★未約定失効(ADD-ONLY): 1件以上あるときだけ露出(0件=欠落=既存 JSON 不変=dedupe を壊さない)。
  //   count=累計(生涯) / streak=連続(約定でリセット・待機表示が使う)。waitMin/bias は在るときだけ足す
  //   (欠落=パネル側が該当部分を出さない=「不明」や空括弧を作らない)。
  if (armedTimeout && armedTimeout.count > 0) {
    s.armedTimeout = {
      count: armedTimeout.count,
      streak: armedTimeout.streak ?? 0,
      lastAt: armedTimeout.lastAt ?? 0,
    };
    if (armedTimeout.lastWaitMs != null && Number.isFinite(armedTimeout.lastWaitMs)) {
      s.armedTimeout.waitMin = Math.round(armedTimeout.lastWaitMs / 60_000);
    }
    if (armedTimeout.lastBias) s.armedTimeout.bias = armedTimeout.lastBias;
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
  // ★ドテン(反転)フラグを引き継ぐ(在るときだけ=add-only)。
  if (a.doten) s.doten = true;
  return s;
}

/** 保有方向の反対(buy↔sell)。ドテン(反転)の第一級ガードで使う純関数。 */
export function opposite(dir: 'buy' | 'sell'): 'buy' | 'sell' {
  return dir === 'buy' ? 'sell' : 'buy';
}

/** ★ドテン評価用の建玉識別(async 同一性再チェック)。要求時に控え、AI 応答解決時に「まだ filled かつ同一建玉」かを照合する。 */
export interface HeldIdentity { at: number; direction: 'buy' | 'sell'; signalId?: number; }

/** 現在の state が identity と同一建玉(まだ filled・同じ約定時刻・同じ方向)か。純関数。
 *  signalId の照合は currentSignal を持つ engine 側で別途行う(state には signalId が無いため)。 */
export function sameHeldPosition(st: EngineState, id: HeldIdentity): boolean {
  return st.phase === 'filled' && !!st.position
    && st.position.at === id.at && st.position.direction === id.direction;
}

/** 保有中に held-eval(ドテン評価)を AI へ要求すべきか(純関数・ゲート判定のみ)。
 *  ドテン許可 OFF / in-flight(planning)/ 非 filled / 取引時間外 / 間隔未達 のいずれかなら false。
 *  ★間隔は flat-plan 間隔以上(held は spend が倍化しやすいので長め)を呼び出し側が渡す。 */
export function shouldRequestHeldEval(a: {
  dotenEnabled: boolean; planning: boolean; phase: SignalPhase;
  inWindow: boolean; now: number; lastHeldEvalAt: number; intervalMs: number;
}): boolean {
  if (!a.dotenEnabled) return false;
  if (a.planning) return false;              // flat-plan と in-flight を共有(同時に AI を叩かない)。
  if (a.phase !== 'filled') return false;
  if (!a.inWindow) return false;
  if (a.now - a.lastHeldEvalAt < a.intervalMs) return false;
  return true;
}

/** ★ドテン(反転)の反映(純関数・肝)。filled の保有 P を「現在値で成行決済」し、AI の反対プランを
 *  反対ブラケット(doten:true)として armed に据える。engine は返る recorded を記録し、armed から新 signalId を
 *  1回だけ採番して currentSignal を更新し broadcast する。
 *  ★monitor 紙は即時約定しない: ここでは反対ブラケットを arm するだけ。反対建玉は以降 detectFill の交差で filled になる
 *   (=trade2 と同じタイミング/価格ソースで約定)。
 *  前提: 呼び出し側が「plan.direction === opposite(保有方向)」と checkSanity 通過を既に確認済み(第一級ガードは engine)。
 *  filled でない / planToArmed が null / range になった 場合は null(ドテンしない=保有継続)。 */
export function reverseToDoten(
  st: EngineState, plan: AiPlan, price: number, now: number, extra?: { vetoFired?: boolean },
): { next: EngineState; recorded: RecordedTrade; armed: ArmedBracket } | null {
  if (st.phase !== 'filled' || !st.position) return null;
  if (!Number.isFinite(price)) return null;
  const armed = planToArmed(plan, now, extra);
  if (!armed || armed.mode === 'range') return null;   // ドテンは directional の反対建てのみ。
  armed.doten = true;
  const p = st.position;
  // P を成行決済(不利方向 1tick): ロング決済は安く / ショート決済は高く約定。決済トリガは現在値(即時 close)。
  // ★ここは逆指値ではなく **板を叩く純粋な成行**(即時 close)なので SLIPPAGE_YEN のまま
  //   (逆指値決済の STOP_SLIPPAGE_YEN=0 とは別物)。
  const exitFill = p.direction === 'buy' ? price - SLIPPAGE_YEN : price + SLIPPAGE_YEN;
  const pnl = realizedPnl(p.direction, p.entryPrice, exitFill, p.qty);
  const recorded: RecordedTrade = {
    entryT: p.at, entryPrice: p.entryPrice, dir: p.direction,
    exitT: now, exitPrice: exitFill, pnl, qty: p.qty, rationale: p.rationale, doten: true,
    // ★記録3点(RECORD-ONLY): ドテンは逆指値ではなく成行クローズなので理由は 'doten'。
    //   初期LC/ピークは「もし決済せず持っていたら」の反実仮想に要るので、P 自身の値をそのまま残す。
    exitReason: 'doten', exitInitialStop: p.initialStop, peakProfit: p.peakProfit,
  };
  if (p.mode === 'range') recorded.mode = 'range';
  if (p.planMeta) recorded.planMeta = p.planMeta;
  if (p.settings) recorded.settings = p.settings;
  // ★遡り解析用: P の決済記録には P 自身の ARM 時刻/価格を残す(反対建ての新しい ARM を混ぜない)。
  //   反対建て(armed)の ARM 時点価格は engine が livePrice() で据える(at は now=新しい ARM 時刻)。
  carryArmed(recorded, p.armedAt, p.armedPrice);
  const next: EngineState = { phase: 'armed', armed, lastExit: { exitPrice: exitFill, pnl, at: now } };
  return { next, recorded, armed };
}

// ═══ レンジ両指値が平均以上未約定 → ブレイク(両逆指値)再評価 ══════════════════════
//   doten held-eval と同型の armed 再評価。ARMED かつ mode='range' かつ両レッグ limit(fade)が
//   「ARM→約定の移動平均 × REEVAL_FACTOR」を超えて未約定なら、AI に両逆指値(breakout)への切替を問う。

/** 再評価トリガの倍率(移動平均のこの倍を超えて未約定なら発火)。 */
export const REEVAL_FACTOR = 1.5;
/** ARM→約定所要の移動平均に使う直近サンプル数(これを超えたら古い方から捨てる)。 */
export const AVG_FILL_SAMPLES = 20;
/** 移動平均を信頼する最小サンプル数(未満はフォールバック既定を使う)。 */
export const MIN_SAMPLES = 5;
/** サンプル不足時のフォールバック平均約定所要[ms](3分)。 */
export const DEFAULT_AVG_FILL_MS = 180_000;
/** 発火閾値の上限[ms](12分・ARMED_TIMEOUT_MS 15分より手前でクランプ=暴走防止)。 */
export const REEVAL_CAP_MS = 720_000;

/** ARM→約定所要[ms]の配列から移動平均を返す純関数。サンプルが min 未満なら def(フォールバック既定)。
 *  呼び出し側が直近 AVG_FILL_SAMPLES 件だけを保持している前提(この関数は与えられた全件の平均を取る)。 */
export function computeAvgFillMs(samples: number[], opts: { min: number; def: number }): number {
  if (samples.length < opts.min) return opts.def;
  const sum = samples.reduce((a, b) => a + b, 0);
  return sum / samples.length;
}

/** range ブラケットが「両レッグとも limit(fade ストラドル)」か。片レッグ/欠落/どちらかが stop なら false。純関数。 */
export function bothRangeLegsLimit(a: ArmedBracket): boolean {
  if (a.mode !== 'range' || !a.range) return false;
  const { upper, lower } = a.range;
  return !!upper && !!lower && upper.type === 'limit' && lower.type === 'limit';
}

/** レンジ両指値の再評価を AI へ要求すべきか(純関数・ゲート判定のみ)。
 *  対象= enabled かつ phase==='armed' かつ mode==='range' かつ両レッグ limit(fade)。
 *  発火= now − armed.at > min(avgFillMs × factor, capMs)。上記いずれか外れたら false(単一レッグ/directional/
 *  既に breakout(stop)/OFF/閾値未達 は対象外)。planning/inPollWindow/クールダウンは呼び出し側(engine)が別途ゲート。 */
export function shouldRangeReeval(a: {
  enabled: boolean; phase: SignalPhase; mode?: 'range'; bothLegsLimit: boolean;
  armedAtMs: number; nowMs: number; avgFillMs: number; factor: number; capMs: number;
}): boolean {
  if (!a.enabled) return false;
  if (a.phase !== 'armed') return false;
  if (a.mode !== 'range') return false;
  if (!a.bothLegsLimit) return false;
  const threshold = Math.min(a.avgFillMs * a.factor, a.capMs);
  return a.nowMs - a.armedAtMs > threshold;
}

/** ★レンジ再評価用の armed 識別(async 同一性再チェック)。要求時に控え、AI 応答解決時に「まだ同じ未約定 armed」かを照合する。 */
export interface ArmedIdentity { armedAt: number; signalId?: number; mode?: 'range'; }

/** 現在の state が identity と同一 armed(まだ armed・同じ武装時刻・同じ mode)か。純関数。
 *  signalId の照合は currentSignal を持つ engine 側で別途行う(state には signalId が無いため)。 */
export function sameArmedBracket(st: EngineState, id: ArmedIdentity): boolean {
  return st.phase === 'armed' && !!st.armed && st.armed.at === id.armedAt && st.armed.mode === id.mode;
}

/** 2つの armed ブラケットが「実質同一形」か(direction/mode/各レッグ entry・SL・range が一致)。純関数。
 *  再評価で AI が同じ fade を返した(=維持)ときに差替えを起こさないための判定。at/settings/planMeta は無視する。 */
export function sameBracketShape(a: ArmedBracket, b: ArmedBracket): boolean {
  return a.direction === b.direction && a.mode === b.mode
    && a.limitEntry === b.limitEntry && a.stopEntry === b.stopEntry
    && a.stopLossForLimit === b.stopLossForLimit && a.stopLossForStop === b.stopLossForStop
    && JSON.stringify(a.range ?? null) === JSON.stringify(b.range ?? null);
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
