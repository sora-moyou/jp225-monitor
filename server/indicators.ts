// テクニカル指標(RSI / SMA / ボリンジャーバンド)の純関数モジュール。
//
// 対象は日経225先物(NIY=F)の 5分足 close 列。IO/時計/DB/config を一切持たない純関数で、
// 与えられた close 配列だけから指標を計算する(テスト容易・SSOT)。
//   ・rsi14  = Wilder の RSI(期間14・最初の14変化を単純平均でシードし以降を Wilder 平滑化)。
//   ・sma    = 単純移動平均(直近 period 本)。
//   ・bollinger = 中央=SMA14 / 上下=中央 ± BB_SIGMA·σ(σ は直近14本の母集団標準偏差=alertDetector.stdDev を再利用)。
//     ★倍率は core/indicatorSpec.ts の BB_SIGMA が唯一の定義(表示ラベルも同ファイル)。ここに数値を書かない。
//   ・pctB   = (現値 − 下限)/(上限 − 下限)= バンド内の相対位置(0=下限・1=上限)。
//
// 呼び出し側(indicatorsLoop / scalpContext)は、安定値のために「確定した(まだ形成中でない)足の close」を渡し、
// 別途「形成中の足を含む速報 close」で live 値も計算できる(computeIndicators を2回呼ぶ)。

import { stdDev } from './alertDetector.js';
import {
  BB_SIGMA, SQUEEZE_BB_PERIOD, SQUEEZE_BB_SIGMA, SQUEEZE_BW_LOOKBACK,
} from '../core/indicatorSpec.js';

export { BB_SIGMA };

const MIN = 60_000;

/** 1分足などの OHLC バー(t 昇順)。 */
export interface OHLCBar { t: number; o: number; h: number; l: number; c: number; }

/** 1分足(昇順)を tfMs 足へ集約(O=最初/H=最大/L=最小/C=最後)。5分足生成に使う。
 *  scalpContext のローカル実装と同一仕様(この純関数モジュールに置き、loop から再利用する)。 */
export function aggregateBars(bars: OHLCBar[], tfMs: number): OHLCBar[] {
  const m = new Map<number, OHLCBar>();
  for (const b of bars) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    const e = m.get(k);
    if (!e) m.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c });
    else { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; e.c = b.c; }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** 5分足へ集約するショートカット。 */
export function aggregate5m(bars: OHLCBar[]): OHLCBar[] { return aggregateBars(bars, 5 * MIN); }

/** Wilder の RSI(期間14)。最低15本(=14変化)必要。不足は null。
 *  最初の14変化を単純平均で avgGain/avgLoss にシードし、それ以降は Wilder 平滑化
 *  (avg = (avg*(period-1) + 当該変化) / period)で更新する。avgLoss=0 なら 100。 */
export function rsi14(closes: number[]): number | null {
  const period = 14;
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** 単純移動平均(直近 period 本)。本数不足/非正 period は null。 */
export function sma(closes: number[], period: number): number | null {
  if (!Array.isArray(closes) || period <= 0 || closes.length < period) return null;
  let s = 0;
  for (let i = closes.length - period; i < closes.length; i++) s += closes[i]!;
  return s / period;
}

/** ボリンジャーバンド。中央=SMA(period)/ 上下=中央 ± mult·σ(σ=直近 period 本の母集団標準偏差)。
 *  本数不足は全て null。σ=0(全同値)のとき上下=中央(幅0)。
 *  ★既定倍率は core/indicatorSpec.ts の BB_SIGMA(=画面/AI 文脈のラベルと同一の真実)。 */
export function bollinger(
  closes: number[], period = 14, mult: number = BB_SIGMA,
): { mid: number | null; upper: number | null; lower: number | null } {
  const mid = sma(closes, period);
  if (mid === null) return { mid: null, upper: null, lower: null };
  const last = closes.slice(closes.length - period);
  const sd = stdDev(last);   // 母集団標準偏差(N で割る)= alertDetector と共有
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
}

/** 指標の現在値(1スナップショット分)。 */
export interface IndicatorValues {
  rsi: number | null;
  sma: number | null;
  bbUpper: number | null;
  bbMid: number | null;
  bbLower: number | null;
  price: number;             // 参照 close(通常は末尾 close)
  pctB: number | null;       // (price − lower)/(upper − lower)。幅0/本数不足は null。
}

/** 指標系列の1点(AI へ渡す直近推移用)。 */
export interface IndicatorPoint {
  t?: number;
  close: number;
  rsi: number | null;
  sma: number | null;
  bbU: number | null;
  bbL: number | null;
}

/** 主指標(SMA14 / BB14)の算出に必要な確定 close の本数。RSI14 はこれ+1本(=15本)必要。
 *  5分足の本数で言えば「形成中の1本」を除くため +1 本(主指標15本 / RSI16本)。 */
export const MIN_CLOSES_FOR_MAIN = 14;

/** 蓄積状況。'no-bars'=窓内の1分足が0本(データ供給そのものが無い)/ 'warming'=足はあるが本数不足 /
 *  'ready'=主指標を算出済み / 'closed'=取引時間外(ドーマント)/ 'disabled'=機能OFF(設定)。
 *  パネルが「蓄積中…」の理由を画面だけで自己診断するために使う。
 *  'closed'/'disabled' は算出そのものをしないため remaining は目安(=満杯の要件本数)で意味を持たない。 */
export type IndicatorReadyState = 'no-bars' | 'warming' | 'ready' | 'closed' | 'disabled';
export interface IndicatorProgress { state: IndicatorReadyState; remaining: number; }

/** 主指標(RSI/SMA/BB)のいずれかが算出できているか。「値を残して印を付ける」か「理由だけを出す」かの分岐に使う
 *  (パネル側の空判定と同じ条件)。 */
export function hasMainValues(s: IndicatorSnapshot | null): boolean {
  return !!s && (s.rsi != null || s.sma != null || s.bbUpper != null);
}

/** 蓄積状況を判定する純関数。barCount=窓内の1分足の本数 / closesUsed=主指標に使った確定 close の本数。
 *  remaining は主指標(SMA/BB)が出るまでに不足している本数(ready は 0)。 */
export function indicatorProgress(barCount: number, closesUsed: number): IndicatorProgress {
  if (!(barCount > 0)) return { state: 'no-bars', remaining: MIN_CLOSES_FOR_MAIN };
  const remaining = Math.max(0, MIN_CLOSES_FOR_MAIN - Math.max(0, closesUsed));
  return { state: remaining > 0 ? 'warming' : 'ready', remaining };
}

/** 指標スナップショット。現在値 + 直近~12点の系列。live は loop が形成中足込みで埋める速報値(任意)。 */
export interface IndicatorSnapshot extends IndicatorValues {
  series: IndicatorPoint[];
  t?: number;                // 参照した最新 close の timestamp(あれば)
  live?: IndicatorValues;    // 形成中足を含む速報値(パネル/連携の補助・loop が付与)
  progress?: IndicatorProgress;   // ADD-ONLY: 蓄積状況(パネルの自己診断表示用・loop が付与)
}

// ─── ★スクイーズ用バンド(20本/2σ)の純関数(2026-08-15) ─────────────────────
//
// 既存の 14本/0.7σ 系列とは **別物**。あちらはバンドウォーク判定と AI プロンプトが共有しており、
// 触ると実走中の質問文 A/B の標本が割れる。こちらはパネル表示と スクイーズ/バルジ 判定専用。
// 定数は core/indicatorSpec.ts の SQUEEZE_* が唯一の定義(ここに数値を書かない)。

/** Bandwidth = (上−下)/中央 ×100。未算出・中央<=0 は null。
 *  ★幅0(全同値)は **0 を返す**: 「収縮しきっている」は観測値であって欠測ではない。 */
export function bandwidthOf(upper: number | null, mid: number | null, lower: number | null): number | null {
  if (upper == null || mid == null || lower == null || !(mid > 0)) return null;
  return ((upper - lower) / mid) * 100;
}

/** Bandwidth の極値。ready=窓が満杯か(足りない間の極値は数本で決まるので判定に使わない)。 */
export interface BandwidthExtremes { high: number | null; low: number | null; ready: boolean }

/** ★**現在足を含む**直近 lookback 本の最大/最小(null は無視)。
 *  ボリンジャー本人の定義(「Bandwidth が N 期間の最小 = スクイーズ」)に合わせるため、
 *  現在足を除外しない。除外すると「新記録に達した足」が判定できない。 */
export function bandwidthExtremes(bw: readonly (number | null)[], lookback: number): BandwidthExtremes {
  const win = bw.slice(Math.max(0, bw.length - lookback));
  const vals = win.filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) return { high: null, low: null, ready: false };
  return { high: Math.max(...vals), low: Math.min(...vals), ready: win.length >= lookback };
}

/** バンド幅の状態。null=どちらでもない。 */
export type SqueezeState = 'squeeze' | 'bulge' | null;

/** BW <= BWlow = スクイーズ / BW >= BWhigh = バルジ(= 125本の新記録に達した足)。 */
export function squeezeStateOf(bw: number | null, high: number | null, low: number | null): SqueezeState {
  if (bw == null || high == null || low == null) return null;
  if (bw <= low) return 'squeeze';
  if (bw >= high) return 'bulge';
  return null;
}

/** close 列から BW と %B の系列を作る(各点は「その点までの prefix」で再計算)。 */
export function computeSqueezeSeries(closes: number[]): { bw: (number | null)[]; pctB: (number | null)[] } {
  const bw: (number | null)[] = [];
  const pctB: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const b = bollinger(closes.slice(0, i + 1), SQUEEZE_BB_PERIOD, SQUEEZE_BB_SIGMA);
    bw.push(bandwidthOf(b.upper, b.mid, b.lower));
    pctB.push(pctBOf(closes[i]!, b.upper, b.lower));
  }
  return { bw, pctB };
}

/** パネル/検知が読むスナップショット。prev* は色(増加=緑/減少=橙)の判定に使う。 */
export interface SqueezeSnapshot {
  pctB: number | null;
  prevPctB: number | null;
  bw: number | null;
  prevBw: number | null;
  bwHigh: number | null;
  bwLow: number | null;
  /** 参照本数(125)が揃っているか。false の間は state を出さない。 */
  ready: boolean;
  state: SqueezeState;
  t?: number;
}

/** 確定足の close 列(と任意の時刻列)からスナップショットを組む。
 *  ★ready=false の間は state を **必ず null** にする: 窓が数本しか無い序盤は最大/最小が
 *    そのまま現在値になり、毎朝かならずスクイーズかバルジになってしまう(無意味な発火)。 */
export function buildSqueezeSnapshot(closes: number[], times?: number[]): SqueezeSnapshot {
  const { bw, pctB } = computeSqueezeSeries(closes);
  const ext = bandwidthExtremes(bw, SQUEEZE_BW_LOOKBACK);
  const last = bw.length - 1;
  const cur = last >= 0 ? bw[last]! ?? null : null;
  const state = ext.ready ? squeezeStateOf(cur, ext.high, ext.low) : null;
  return {
    pctB: last >= 0 ? pctB[last] ?? null : null,
    prevPctB: last >= 1 ? pctB[last - 1] ?? null : null,
    bw: cur,
    prevBw: last >= 1 ? bw[last - 1] ?? null : null,
    bwHigh: ext.high,
    bwLow: ext.low,
    ready: ext.ready,
    state,
    ...(times && times.length ? { t: times[times.length - 1] } : {}),
  };
}

/** BB 上下限と現値から %B を求める純関数(幅0/未算出は null)。 */
export function pctBOf(price: number, upper: number | null, lower: number | null): number | null {
  if (upper == null || lower == null || !(upper > lower)) return null;
  return (price - lower) / (upper - lower);
}

/** close 列(5分足を想定)から指標スナップショットを組み立てる純関数。
 *  price は末尾 close。series は直近最大12点で、各点は「その点までの prefix」で指標を再計算する
 *  (末尾へ向かって RSI/SMA/BB が正しく積み上がる)。times を渡すと系列/スナップショットに t を付す。 */
export function computeIndicators(closes: number[], times?: number[]): IndicatorSnapshot {
  const n = closes.length;
  const price = n > 0 ? closes[n - 1]! : 0;
  const rsi = rsi14(closes);
  const smaV = sma(closes, 14);
  const bb = bollinger(closes, 14, BB_SIGMA);
  const pctB = pctBOf(price, bb.upper, bb.lower);
  const series: IndicatorPoint[] = [];
  const points = Math.min(12, n);
  for (let k = n - points; k < n; k++) {
    const prefix = closes.slice(0, k + 1);
    const b = bollinger(prefix, 14, BB_SIGMA);
    const pt: IndicatorPoint = {
      close: closes[k]!,
      rsi: rsi14(prefix),
      sma: sma(prefix, 14),
      bbU: b.upper,
      bbL: b.lower,
    };
    if (times && times.length === n) pt.t = times[k];
    series.push(pt);
  }
  const snap: IndicatorSnapshot = {
    rsi, sma: smaV, bbUpper: bb.upper, bbMid: bb.mid, bbLower: bb.lower, price, pctB, series,
  };
  if (times && times.length === n && n > 0) snap.t = times[n - 1];
  return snap;
}

/** IndicatorSnapshot から現在値のみ(IndicatorValues)を取り出す(loop の live 付与用)。 */
export function valuesOf(s: IndicatorSnapshot): IndicatorValues {
  return { rsi: s.rsi, sma: s.sma, bbUpper: s.bbUpper, bbMid: s.bbMid, bbLower: s.bbLower, price: s.price, pctB: s.pctB };
}
