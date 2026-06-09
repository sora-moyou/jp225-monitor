import { INSTRUMENTS } from './config.js';
import { tokyoCashOpen } from '../collector/session.js';
import { barsFor } from './loops/alertLoop.js';
import { returns, stdDev, returns5m, DEFAULT_PARAMS } from './alertDetector.js';
import type { Bar } from './correlation.js';

export const CROSS_ASSET_Z_THRESHOLD = 4.0;

export interface Mover {
  symbol: string;
  label: string;
  changePercent: number;   // 採用された窓のリターン (%)
  windowSeconds: number;   // 60 (1分burst) または 300 (5分trend)
  z: number;               // 採用された |z|
  direction: 'up' | 'down';
}

interface WindowZ { z: number; ret: number; windowSeconds: number; }

// 1分 burst z (detectBurst の z 部分をミラー。静寂前提・横断確認は無し)
function burstZ(bars: Bar[]): WindowZ | null {
  const L = DEFAULT_PARAMS.baselineLookback;
  if (bars.length < L + 1) return null;
  const baseline = bars.slice(-(L + 1), -1);
  const br = returns(baseline);
  if (br.length < 10) return null;
  const sigma = stdDev(br);
  const prev = bars[bars.length - 2]!.close;
  const cur = bars[bars.length - 1]!.close;
  if (prev <= 0) return null;
  const ret = (cur - prev) / prev;
  const z = sigma > 0 ? Math.abs(ret) / sigma : 0;
  return { z, ret, windowSeconds: 60 };
}

// 5分 trend z (detectTrend の z 部分をミラー)
function trendZ(bars: Bar[]): WindowZ | null {
  const L = DEFAULT_PARAMS.baselineLookback;
  if (bars.length < L + 5) return null;
  const r5 = returns5m(bars);
  if (r5.length < 10) return null;
  const sigma = stdDev(r5.slice(0, -1));
  const ret = r5[r5.length - 1]!;
  const z = sigma > 0 ? Math.abs(ret) / sigma : 0;
  return { z, ret, windowSeconds: 300 };
}

/**
 * excludeSymbol を除く全 INSTRUMENTS を評価し、|z| >= threshold で
 * 大きく動いた銘柄を |z| 降順で返す。getBars はテスト用に注入可。
 */
export function getSignificantMovers(
  excludeSymbol: string,
  threshold: number = CROSS_ASSET_Z_THRESHOLD,
  getBars: (symbol: string) => Bar[] = barsFor,   // v0.3.32: 既定をリアルタイム足優先に
): Mover[] {
  const movers: Mover[] = [];
  const cashOpen = tokyoCashOpen(Date.now());
  for (const inst of INSTRUMENTS) {
    const sym = inst.symbol;
    if (sym === excludeSymbol) continue;
    // 東証個別株(.T)は 9:00-15:30 のみ取引。場外(夜間等)は前回終値で動かないので「同時刻に動いた他資産」に含めない。
    if (inst.category === 'heavyweight' && !cashOpen) continue;
    const bars = getBars(sym);
    const b = burstZ(bars);
    const t = trendZ(bars);
    // 2窓のうち |z| が大きい方を採用 (両方 null ならスキップ)
    let chosen: WindowZ | null = null;
    if (b && t) chosen = b.z >= t.z ? b : t;
    else chosen = b ?? t;
    if (!chosen) continue;
    if (chosen.z < threshold) continue;
    movers.push({
      symbol: sym,
      label: inst.labelJa,
      changePercent: chosen.ret * 100,
      windowSeconds: chosen.windowSeconds,
      z: chosen.z,
      direction: chosen.ret >= 0 ? 'up' : 'down',
    });
  }
  movers.sort((a, b) => b.z - a.z);
  return movers;
}
