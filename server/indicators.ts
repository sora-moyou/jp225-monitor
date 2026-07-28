// テクニカル指標(RSI / SMA / ボリンジャーバンド)の純関数モジュール。
//
// 対象は日経225先物(NIY=F)の 5分足 close 列。IO/時計/DB/config を一切持たない純関数で、
// 与えられた close 配列だけから指標を計算する(テスト容易・SSOT)。
//   ・rsi14  = Wilder の RSI(期間14・最初の14変化を単純平均でシードし以降を Wilder 平滑化)。
//   ・sma    = 単純移動平均(直近 period 本)。
//   ・bollinger = 中央=SMA14 / 上下=中央 ± 1.5σ(σ は直近14本の母集団標準偏差=alertDetector.stdDev を再利用)。
//   ・pctB   = (現値 − 下限)/(上限 − 下限)= バンド内の相対位置(0=下限・1=上限)。
//
// 呼び出し側(indicatorsLoop / scalpContext)は、安定値のために「確定した(まだ形成中でない)足の close」を渡し、
// 別途「形成中の足を含む速報 close」で live 値も計算できる(computeIndicators を2回呼ぶ)。

import { stdDev } from './alertDetector.js';

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
 *  本数不足は全て null。σ=0(全同値)のとき上下=中央(幅0)。 */
export function bollinger(
  closes: number[], period = 14, mult = 1.5,
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

/** 指標スナップショット。現在値 + 直近~12点の系列。live は loop が形成中足込みで埋める速報値(任意)。 */
export interface IndicatorSnapshot extends IndicatorValues {
  series: IndicatorPoint[];
  t?: number;                // 参照した最新 close の timestamp(あれば)
  live?: IndicatorValues;    // 形成中足を含む速報値(パネル/連携の補助・loop が付与)
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
  const bb = bollinger(closes, 14, 1.5);
  const pctB = pctBOf(price, bb.upper, bb.lower);
  const series: IndicatorPoint[] = [];
  const points = Math.min(12, n);
  for (let k = n - points; k < n; k++) {
    const prefix = closes.slice(0, k + 1);
    const b = bollinger(prefix, 14, 1.5);
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
