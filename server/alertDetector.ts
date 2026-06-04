import type { Bar } from './correlation.js';

// v0.3.17: アラート検知を fixed-% から z-score 適応型へ全面置換。
// 過去 60min の 1m return から σ を継続計算、|z| > 閾値 + 静寂前提 + 横断確認の三段で発火。
// changeDetector (client side) は廃止、本モジュールがサーバ単一の発火源。

export type DetectionKind = 'slope' | 'magnitude' | 'granville' | 'shock' | 'dtb' | 'break';  // 既存 LLM プロンプトとの互換維持。shock = 価格変化スコア急変(短期/長期の後継)。dtb = ダブルトップ/ボトム。break = 水準ブレイク
                                                     // slope = 1m burst, magnitude = 5m trend
export interface PriceAction { open: number; high: number; low: number; current: number; }

export interface AlertEvent {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: DetectionKind;
  direction: 'up' | 'down';
  triggeredAt: number;
  change15min: number | null;
  pa15min: PriceAction | null;
  range1h: { high: number; low: number } | null;
  zscore: number;          // 新フィールド: 発火時の |z| (UI 表示・LLM 文脈用)
  note?: string;           // 任意: バナーの「%/秒」の代わりに表示する説明(例「グランビル買い転換」)
}

// v0.3.35: 横断確認(他資産の同方向確認)を全面削除。日経単独の急変を握り潰す原因だったため
// (ユーザ指示)。発火は日経自身の z-score(+静寂前提) のみで判定する。
export interface DetectorParams {
  zThreshold: number;       // |z| 閾値 (例 2.5)
  quietMedianRatio: number; // 直前 N 本の |return| 中央値 < σ × ratio (例 0.8)
  quietLookback: number;    // 直前 N 本 (例 5)
  baselineLookback: number; // baseline σ 算出窓 (例 60 本 = 60分)
}

export const DEFAULT_PARAMS: DetectorParams = {
  zThreshold: 2.5,
  quietMedianRatio: 0.8,
  quietLookback: 5,
  baselineLookback: 60,
};

export function returns(bars: Bar[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1]!.close, c = bars[i]!.close;
    if (p > 0) r.push((c - p) / p);
  }
  return r;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** 5-min トレンド return (close[t] - close[t-5]) / close[t-5] のシリーズ */
export function returns5m(bars: Bar[]): number[] {
  const r: number[] = [];
  for (let i = 5; i < bars.length; i++) {
    const p = bars[i - 5]!.close, c = bars[i]!.close;
    if (p > 0) r.push((c - p) / p);
  }
  return r;
}

/**
 * 1m burst (slope kind) 検知。
 * 条件: |latest z| > zThreshold AND median(直前 quietLookback |returns|) < σ * quietMedianRatio。
 * (v0.3.35: 横断確認は廃止。日経自身の z と静寂前提のみ)
 */
export function detectBurst(
  bars: Bar[],
  params: DetectorParams = DEFAULT_PARAMS,
): { z: number; latestRet: number; sigma: number } | null {
  if (bars.length < params.baselineLookback + 1) return null;
  const baseline = bars.slice(-(params.baselineLookback + 1), -1);
  const baselineReturns = returns(baseline);
  if (baselineReturns.length < 10) return null;
  const sigma = stdDev(baselineReturns);
  if (sigma <= 0) return null;

  const prev = bars[bars.length - 2]!.close;
  const cur = bars[bars.length - 1]!.close;
  if (prev <= 0) return null;
  const latestRet = (cur - prev) / prev;
  const z = Math.abs(latestRet) / sigma;
  if (z < params.zThreshold) return null;

  // 静寂前提
  const recent = baselineReturns.slice(-params.quietLookback);
  if (recent.length < params.quietLookback) return null;
  const recentMedian = median(recent.map(Math.abs));
  if (recentMedian >= sigma * params.quietMedianRatio) return null;

  return { z, latestRet, sigma };
}

/**
 * 5m trend (magnitude kind) 検知。
 * 5-min return = (close[t] - close[t-5])/close[t-5]。
 * baseline σ_5m を計算し、|latest 5m return| > σ_5m * zThreshold で発火。
 * 静寂前提は省略 (5-min は本質的に累積、静寂と合わない)。(v0.3.35: 横断確認は廃止)
 */
export function detectTrend(
  bars: Bar[],
  params: DetectorParams = DEFAULT_PARAMS,
): { z: number; latestRet: number; sigma: number } | null {
  if (bars.length < params.baselineLookback + 5) return null;
  const r5 = returns5m(bars);
  if (r5.length < 10) return null;
  const sigma = stdDev(r5.slice(0, -1));   // exclude latest
  if (sigma <= 0) return null;
  const latest = r5[r5.length - 1]!;
  const z = Math.abs(latest) / sigma;
  if (z < params.zThreshold) return null;

  return { z, latestRet: latest, sigma };
}

/** 発火コンテキスト (15min OHLC + 1h range + 15min %change) */
export function computeContext(bars: Bar[]): {
  pa15min: PriceAction | null;
  change15min: number | null;
  range1h: { high: number; low: number } | null;
} {
  const cur = bars[bars.length - 1]?.close;
  const last15 = bars.slice(-15);
  const last60 = bars.slice(-60);
  const pa15min: PriceAction | null = last15.length >= 2 && cur !== undefined ? {
    open: last15[0]!.close,
    high: Math.max(...last15.map(b => b.close)),
    low: Math.min(...last15.map(b => b.close)),
    current: cur,
  } : null;
  const change15min = pa15min ? ((pa15min.current - pa15min.open) / pa15min.open) * 100 : null;
  const range1h = last60.length >= 2 ? {
    high: Math.max(...last60.map(b => b.close)),
    low: Math.min(...last60.map(b => b.close)),
  } : null;
  return { pa15min, change15min, range1h };
}
