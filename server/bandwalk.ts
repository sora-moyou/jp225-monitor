// バンドウォーク(ボリンジャーバンドに沿った一方向の推移)の判定 — 純関数モジュール。
//
// ユーザー定義(v0.9.61):
//   上のバンドウォーク: RSI ≥ 50 かつ 終値 ≥ +BB_SIGMA·σ(上限バンド)
//   下のバンドウォーク: RSI ≤ 50 かつ 終値 ≤ −BB_SIGMA·σ(下限バンド)
//   「価格の急変までは その判断を維持できる」
//
// ★なぜ「瞬間の成立」で判定しないか(実データ 2026-06-05〜08-04・NIY=F 1分足 50,410本 / 5分足 9,941本):
//   σ=0.7 は浅いので、上下どちらかの条件が成立している確定5分足は **全体の 62.9%**(上 32.2% / 下 30.7%)。
//   瞬間成立をそのままアラートにすると 120回/取引日 になり、意味を持たない。
//   → 判定は「直近 W 本のうち条件成立が R 以上」という **占有率** で行う(ユーザー確定仕様)。
//
// ★窓の純粋性(ユーザー確定仕様): 窓の中に逆向きの成立が **1本でも** 混じっていたら不成立。
//   実測では、この純粋性の有無で発火は 5.4→5.0 回/取引日(-8%)、+30分の順行率は 51%→53% で
//   ほとんど動かなかった(= 除外の効果は小さい)。それでも「方向が定まっている区間だけを
//   バンドウォークと呼ぶ」という意味づけを守るため既定で有効にしている。
//   ※純粋性を課すと「上と下が同時に成立する」ことは構造的に起こり得ない(片方が R≥0.5 を満たす時点で
//     もう片方の窓には逆向きが混じる)。よって下の evaluateBandwalk は up を先に見て良い。
//
// ★急変(shock)の扱い: **新しい閾値の概念は作らない**。既存の shockDetector.detectShock(本番の
//   resolveShockParams と同じパラメータ)をそのまま使い、「逆方向の急変」が起きた足までを窓から切り捨てる
//   (= 急変で判断を打ち切り、そこから観測し直す)。実測ではバンドウォークの解除の 70〜78% が
//   この逆方向の急変によるもので、ユーザーの「急変までは維持できる」は **解除要因としては支持された**。
//   ※順方向の急変では打ち切らない(バンドウォークを加速させる動きなので判断は壊れない)。
//   ※向きを問わず打ち切る設計も測ったが、急変は 61回/取引日 と頻繁(イベント間隔の中央値 10分)なので
//     窓がほぼ常に切り詰められ、発火が静かな時間帯(=方向の無い相場)に偏り成績が悪化した。
//
// ★目線(買い/売り)との一致(ユーザー確定仕様・v0.9.61 で確定):
//   ・'long'(買い目線)  → 上のバンドウォークだけ成立(下は成立させない)
//   ・'short'(売り目線) → 下のバンドウォークだけ成立(上は成立させない)
//   ・'none'(未設定 / AI委任) → **方向一致を問わない**(上下どちらも成立しうる)
//   ★'none' を「不成立」にすると、既定設定(scalpBias 未設定)ではアラートが 0回/日 になり
//     機能そのものが無言で消える(実測で確認)。目線との合致は「目線が設定されているときに効く」
//     制約であって、目線が無いときに機能ごと消すことは意図ではない、というのがユーザーの確定判断。
//   ★目線の定義に **何を使うか**(実装を読んで判断した結果):
//     採用 = monitor 設定の売買バイアス scalpBias(手動 'long'=買い中心 / 'short'=売り中心 / 'none'=両方向。
//            委任 mode='ai' は buildScalpPlan と同じく実効 'none' 扱い)。
//     理由 = ①永続する設定値なので、どのプロセス(monitor の levelsLoop / 単独 collector)からも同じ値が読める。
//            ②実際に AI プランの方向 veto(enforcePlanConstraints)を効かせている値そのものなので、
//              「アラートの向き」と「システムが実際に取る向き」が構造的に一致する。
//     ★実測(2026-08-05・σ0.7/W60分/R0.7/Nmin6): 'none' を不成立にすると **発火 0回/取引日**(現在の実設定は
//       scalpBias 未設定)。'none' で両方向を許すと 5.0回/取引日・成立時間 12.9%。
//     不採用 = signalPanel の待機表示に出る「目線」(state.armedTimeout.bias)。これは **直前に失効した
//              ブラケットの向き** で、(a)約定が起きた時点で null に戻る(clearArmedTimeoutStreak)ため
//              ほとんどの時間 取得できない、(b)A シグナルエンジンの内部状態なので collector 側の検知からは
//              参照できず monitor と collector で判定が食い違う、(c)意味も「約定しなかった計画の向き」で
//              相場観ではない。ゆえに同じ語を流用せず、上の scalpBias を目線とする。
//
// IO/時計/DB/config を持たない(呼び出し側が 1分足・shock パラメータ・目線を渡す)。

import { aggregate5m, rsi14, bollinger, BB_SIGMA, type OHLCBar } from './indicators.js';
import { detectShock, DEFAULT_SHOCK_PARAMS, type ShockParams } from './shockDetector.js';

const MIN = 60_000;
const TF_MS = 5 * MIN;                      // 判定の足種(5分足)
const INDICATOR_WINDOW_MS = 6 * 60 * MIN;   // 指標の参照窓(indicatorsLoop / scalpContext と同じ 6時間)
const MIN_CLOSES = 15;                      // RSI14 に必要な確定 close 本数

/** バンドウォーク判定のチューニング。 */
export interface BandwalkParams {
  /** 占有率を測る窓の本数(5分足)。 */
  windowBars: number;
  /** 成立に必要な占有率(0〜1)。 */
  minRatio: number;
  /** 占有率を評価するのに必要な最小本数(急変で窓が切り詰められた直後の過小標本を弾く)。 */
  minBars: number;
  /** 同方向の再発火を抑えるクールダウン[ms]。 */
  cooldownMs: number;
}

/** 既定値(実データの掃引から決定・根拠は下表)。
 *
 *  実測(NIY=F・直近60日・取引日52日・Nmin=6本・逆方向急変で打ち切り・クールダウン30分・純粋性ON):
 *    W(分)  R  | 発火/取引日(目線条件なし) | 成立時間 | +30分(平均/順行率) | +60分(平均/順行率)
 *     30   0.7 |        7.5               |  16.8%   | +12円 / 49%        |  +4円 / 50%
 *     45   0.7 |        5.8               |  14.2%   | +13円 / 52%        | +14円 / 51%
 *     60   0.7 |        5.0               |  12.9%   | +15円 / 53%        |  +6円 / 50%   ← 既定
 *     90   0.8 |        3.6               |   7.9%   | +11円 / 52%        |  −7円 / 47%
 *  目線を 買い/売り に設定すると片方向だけになるので上表のおよそ半分(既定で 買い目線 2.6/日・売り目線 2.4/日)。
 *
 *  ★σ の掃引(2026-08-05・σ=0.7/1.0/1.3/1.5/2.0 × W/R/Nmin を σ ごとに最適化・計230セル):
 *      σ    瞬間成立率  2本キープ後の継続  σごとの最良    発火/日  +30分順行率(n,z)   +60分順行率(n,z)
 *     0.7    62.9%        81.3%          W120/R0.7/N6    4.3     54.4%(206, z=1.3)  50.5%(198, z=0.1)
 *     1.0    51.3%        75.4%          W120/R0.8/N6    2.3     55.9%(111, z=1.2)  47.7%(107, z=-0.5)
 *     1.3    37.0%        66.5%          W60 /R0.8/N4    2.1     56.6%( 99, z=1.3)  49.5%( 91, z=-0.1)
 *     1.5    28.0%        59.8%          W30 /R1.0/N4    1.5     54.4%( 68, z=0.7)  52.4%( 63, z=0.4)
 *     2.0    10.3%        36.8%          W45 /R0.5/N4    1.4     52.1%( 73, z=0.4)  45.5%( 66, z=-0.7)
 *    ★230セル中 |z|≥1.96(5%有意)は **0 セル**。σ を深くしても「その方向に伸びる」は出ず、
 *      逆に持続性(継続ハザード)は 81%→37% と壊れる。よって σ=0.7 のまま(表示と同一)を採用する。
 *  ★既定 W/R/Nmin は「どのセルも有意でない」以上、最良 z(=多重比較で選んだ最大値)を追わず、
 *    **運用上の読みやすさ**(鳴りすぎず・成立時間が相場の1割強)で選んでいる。 */
export const DEFAULT_BANDWALK: BandwalkParams = {
  windowBars: 12,          // 60分
  minRatio: 0.7,
  minBars: 6,              // 30分ぶんは観測してから判定する
  cooldownMs: 30 * MIN,    // nwave / dailyband と同じ 30分クールダウン
};

/** 確定5分足1本ぶんの観測。 */
export interface BandwalkSample {
  t: number;
  close: number;
  rsi: number | null;
  upper: number | null;
  lower: number | null;
  /** その足で成立していた向き(null=非成立)。 */
  dir: 'up' | 'down' | null;
  /** その足の5分間に 1分足の急変(上/下)があったか。 */
  shockUp: boolean;
  shockDown: boolean;
}

/** 成立中のバンドウォーク。 */
export interface Bandwalk {
  direction: 'up' | 'down';
  /** 評価に使った窓の中の占有率(0〜1)。 */
  ratio: number;
  /** 評価に使った窓の本数(急変で切り詰められた後の本数)。 */
  bars: number;
  /** 評価窓の開始時刻(= 判定の起点)。 */
  sinceT: number;
  /** 判定した確定足の時刻(= 最新の確定足)。 */
  t: number;
  /** 判定した確定足の終値。 */
  close: number;
  /** その足のバンド(up=上限 / down=下限)。 */
  band: number;
  /** その足の RSI14。 */
  rsi: number;
}

/** 1本ぶんの条件判定(純関数)。RSI≥50 かつ 終値≥上限 → 'up' / RSI≤50 かつ 終値≤下限 → 'down'。
 *  ※RSI がちょうど 50 かつ 終値が両バンド外という状態は(上限>下限である限り)起こり得ない。 */
export function bandwalkDirOf(close: number, rsi: number | null, upper: number | null, lower: number | null): 'up' | 'down' | null {
  if (rsi == null || upper == null || lower == null) return null;
  if (rsi >= 50 && close >= upper) return 'up';
  if (rsi <= 50 && close <= lower) return 'down';
  return null;
}

/** 1分足(昇順)から「確定5分足ごとの観測列」を作る純関数。
 *  ・5分足へ集約し、**最後の1本(形成中)は落とす**(indicatorsLoop / scalpContext と同じ扱い)。
 *  ・各足の指標は「その足を末尾とする直近6時間の確定 close」で算出する(本番の算出経路と同一)。
 *  ・急変は 1分足の detectShock(本番パラメータ)で、その足の5分間に含まれる分足を評価する。
 *  戻り値は古い→新しい順。maxBars を渡すと末尾からその本数だけ作る(計算量の削減)。 */
export function buildBandwalkSamples(
  bars1m: OHLCBar[], maxBars: number, shockParams: ShockParams = DEFAULT_SHOCK_PARAMS,
): BandwalkSample[] {
  if (!Array.isArray(bars1m) || bars1m.length === 0) return [];
  const bars5 = aggregate5m(bars1m);
  const confirmed = bars5.slice(0, -1);          // 形成中の最後の1本を除く
  if (confirmed.length === 0) return [];
  const from = Math.max(0, confirmed.length - Math.max(1, maxBars));
  const t1 = bars1m.map(b => b.t);
  const c1 = bars1m.map(b => b.c);
  const idxOfT = new Map<number, number>();
  for (let i = 0; i < t1.length; i++) idxOfT.set(t1[i]!, i);
  const need = shockParams.avgLen + 2;
  const shockAt = (t: number): 'up' | 'down' | null => {
    const i = idxOfT.get(t);
    if (i === undefined || i + 1 < need) return null;
    // 窓が連続した分足で埋まっていること(セッション跨ぎで嘘の急変を作らない)。
    if (t1[i]! - t1[i - need + 1]! > (need + 3) * MIN) return null;
    const s = detectShock(c1.slice(i - need + 1, i + 1), shockParams);
    return s ? s.dir : null;
  };
  const out: BandwalkSample[] = [];
  for (let i = from; i < confirmed.length; i++) {
    const t = confirmed[i]!.t;
    let j = i;
    while (j > 0 && confirmed[j - 1]!.t > t - INDICATOR_WINDOW_MS) j--;
    const closes = confirmed.slice(j, i + 1).map(b => b.c);
    const close = confirmed[i]!.c;
    let rsi: number | null = null, upper: number | null = null, lower: number | null = null;
    if (closes.length >= MIN_CLOSES) {
      rsi = rsi14(closes);
      const bb = bollinger(closes, 14, BB_SIGMA);
      upper = bb.upper; lower = bb.lower;
    }
    let shockUp = false, shockDown = false;
    for (let k = 0; k < 5; k++) {
      const s = shockAt(t + k * MIN);
      if (s === 'up') shockUp = true; else if (s === 'down') shockDown = true;
    }
    out.push({ t, close, rsi, upper, lower, dir: bandwalkDirOf(close, rsi, upper, lower), shockUp, shockDown });
  }
  return out;
}

/** 目線(売買バイアス)。'long'=買い目線(上のみ) / 'short'=売り目線(下のみ) /
 *  'none'=目線なし(**上下どちらも成立しうる**=方向一致を問わない)。
 *  値の解決は呼び出し側(config の scalpBias・委任 'ai' は 'none' 扱い)。ここは受け取るだけ=純関数。 */
export type BandwalkBias = 'long' | 'short' | 'none';

/** ★2026-08-25: 設定の目線(ScalpBias)を バンドウォークの目線へ写す。
 *  ★**'range'(レンジ目線)は 'none' に写す**: レンジは「どちらへ抜けるか決めていない」ので、
 *    上下どちらのバンドウォークも成立させてよい(片側だけに絞る理由が無い)。
 *  ★ここに写しを1つだけ置く: 呼び出し側(detect/registry.ts と scalpPlanRunner.ts)で
 *    別々に三項演算子を書くと、片方だけ直す事故が生まれる。 */
export function toBandwalkBias(bias: 'long' | 'short' | 'range' | 'none'): BandwalkBias {
  return bias === 'range' ? 'none' : bias;
}

/** 目線と向きが一致するか(純関数・SSOT)。'none' は方向一致を問わないので常に true。 */
export function bandwalkBiasAllows(bias: BandwalkBias, dir: 'up' | 'down'): boolean {
  if (bias === 'none') return true;
  return bias === 'long' ? dir === 'up' : dir === 'down';
}

/** 観測列(古い→新しい)からバンドウォークの成立を判定する純関数。成立していなければ null。
 *
 *  手順(方向 d ごと):
 *    ⓪目線と一致しない向きは見ない(bias='long' は up のみ / 'short' は down のみ / 'none' は上下とも見る)。
 *    ①直近 windowBars 本を取る。足が連続していない(セッション跨ぎ/欠測)ところで窓を打ち切る。
 *    ②窓の中で **最後に起きた逆方向の急変** を探し、その足の次から数える(急変=判断の打ち切り)。
 *    ③残り本数が minBars 未満なら不成立(標本が足りない)。
 *    ④窓に逆向きの成立が1本でもあれば不成立(純粋性)。
 *    ⑤成立本数 / 本数 が minRatio 以上なら成立。 */
export function evaluateBandwalk(
  samples: BandwalkSample[], bias: BandwalkBias, p: BandwalkParams = DEFAULT_BANDWALK,
): Bandwalk | null {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const last = samples[samples.length - 1]!;
  if (last.rsi == null || last.upper == null || last.lower == null) return null;
  // ①連続した確定足だけの窓(末尾から遡り、5分刻みが崩れたら打ち切る)。
  const win: BandwalkSample[] = [];
  for (let i = samples.length - 1; i >= 0 && win.length < p.windowBars; i--) {
    const s = samples[i]!;
    if (win.length > 0 && win[0]!.t - s.t !== TF_MS) break;
    win.unshift(s);
  }
  const tryDir = (d: 'up' | 'down'): Bandwalk | null => {
    if (!bandwalkBiasAllows(bias, d)) return null;   // ⓪目線と一致しない向きは見ない('none' は両方向とも見る)
    // ②逆方向の急変までを切り捨てる。
    let from = 0;
    for (let k = win.length - 1; k >= 0; k--) {
      if (d === 'up' ? win[k]!.shockDown : win[k]!.shockUp) { from = k + 1; break; }
    }
    const slice = win.slice(from);
    if (slice.length < p.minBars) return null;                            // ③
    const opp = d === 'up' ? 'down' : 'up';
    if (slice.some(s => s.dir === opp)) return null;                      // ④純粋性(逆向き0本)
    const hit = slice.filter(s => s.dir === d).length;                    // ⑤
    const ratio = hit / slice.length;
    if (ratio < p.minRatio) return null;
    return {
      direction: d, ratio, bars: slice.length, sinceT: slice[0]!.t, t: last.t,
      close: last.close, band: d === 'up' ? last.upper! : last.lower!, rsi: last.rsi!,
    };
  };
  // ★純粋性を課しているので上下が同時に成立することは無い(冒頭の注記)。up を先に見てよい。
  return tryDir('up') ?? tryDir('down');
}

/** アラート/AI文脈に載せる1行の説明(純関数)。private な決済数値は一切含まない。 */
export function describeBandwalk(bw: Bandwalk): string {
  const yen = (v: number): string => Math.round(v).toLocaleString('ja-JP');
  const dirWord = bw.direction === 'up' ? '上昇' : '下降';
  const bandLabel = bw.direction === 'up' ? `+${BB_SIGMA}σ` : `-${BB_SIGMA}σ`;
  const minutes = Math.round((bw.t - bw.sinceT) / MIN) + 5;   // 窓の先頭足の始まりから最新確定足の終わりまで
  const side = bw.direction === 'up' ? '以上' : '以下';
  return `${dirWord}バンドウォーク継続中 — 直近${minutes}分の${Math.round(bw.ratio * 100)}%で`
    + `RSI${bw.direction === 'up' ? '≥' : '≤'}50 かつ 終値が${bandLabel}(${yen(bw.band)})${side}`
    + `(現在 RSI${bw.rsi.toFixed(1)} / ${yen(bw.close)})`;
}

/** 発火(アラート)の抑制状態。方向別クールダウン + 「成立→成立」の連発防止。 */
export interface BandwalkFireState {
  /** 直近に判定した確定足の時刻(同じ足で二度評価しない)。 */
  lastBarT: number;
  /** 現在成立中の向き(null=非成立)。遷移の検出に使う。 */
  active: 'up' | 'down' | null;
  /** 方向別の最終発火時刻。 */
  lastFire: Map<'up' | 'down', number>;
}
export function createBandwalkFireState(): BandwalkFireState {
  return { lastBarT: 0, active: null, lastFire: new Map() };
}

/** 判定結果を状態へ反映し、アラートを出すべきかを返す純関数(状態は破壊的に更新する)。
 *  発火するのは「非成立(または逆向き)→ 成立」の遷移のみ。同方向はクールダウン内なら出さない。 */
export function shouldFireBandwalk(
  st: BandwalkFireState, bw: Bandwalk | null, p: BandwalkParams = DEFAULT_BANDWALK,
): boolean {
  const prev = st.active;
  st.active = bw ? bw.direction : null;
  if (!bw) return false;
  if (prev === bw.direction) return false;                      // 継続中は鳴らさない
  const last = st.lastFire.get(bw.direction) ?? -Infinity;
  if (bw.t - last <= p.cooldownMs) return false;                // 同方向の再発火抑制
  st.lastFire.set(bw.direction, bw.t);
  return true;
}
