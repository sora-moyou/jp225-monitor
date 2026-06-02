import type { Bar } from './correlation.js';
import {
  detectBurst, detectTrend, computeContext, returns, returns5m, stdDev,
  type DetectorParams, type AlertEvent,
} from './alertDetector.js';
import { detectGranvilleReversal, detectGranvilleContinuation } from './granville.js';
import { canFire, markFired } from './alertCooldown.js';
import { getRollingReturn } from './feedBars.js';
import type { InstrumentMeta, AlertEventPayload } from './types.js';

export type AlertSink = (e: AlertEventPayload) => void;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/** Bar-confirmed detection for NIY=F: Granville (reversal/continuation) first, then burst(1m)/trend(5m).
 *  Mirrors alertLoop.evaluateAndFire's NIY branch exactly, but routes events to `sink`. */
export function evaluateBarsNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  if (!bars || bars.length < 65) return;
  const sym = 'NIY=F';

  // Granville (MA(75)) — evaluated first; if it fires, the shared cooldown suppresses same-dir burst/trend.
  const closes = bars.map(b => b.close);
  const rev = detectGranvilleReversal(closes);
  const cont = detectGranvilleContinuation(closes);
  const g = rev
    ? { sig: rev, note: `グランビル${rev.dir === 'up' ? '買い' : '売り'}転換` }
    : cont
      ? { sig: cont, note: cont.dir === 'up' ? 'グランビル押し目買い' : 'グランビル戻り売り' }
      : null;
  const gPrice = bars[bars.length - 1]!.close;
  if (g && canFire(sym, g.sig.dir, gPrice, now)) {
    const ctx = computeContext(bars);
    markFired(sym, g.sig.dir, gPrice, now);
    console.log(`[alertEngine] ${sym} ${g.note} dev=${g.sig.deviation.toFixed(2)}%`);
    sink({
      symbol: sym, symbolLabel: meta.labelJa, changePercent: g.sig.deviation,
      windowSeconds: 75 * 60, detectionKind: 'granville', direction: g.sig.dir,
      triggeredAt: bars[bars.length - 1]!.t, change15min: ctx.change15min,
      pa15min: ctx.pa15min, range1h: ctx.range1h, zscore: 0, note: g.note,
    });
  }

  const burst = detectBurst(bars, params);
  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;
  if (burst) result = { ...burst, kind: 'slope', windowSec: 60 };
  else {
    const trend = detectTrend(bars, params);
    if (trend) result = { ...trend, kind: 'magnitude', windowSec: 300 };
  }
  if (!result) return;

  const dir = result.latestRet >= 0 ? 'up' : 'down';
  const curPrice = bars[bars.length - 1]!.close;
  if (!canFire(sym, dir, curPrice, now)) return;

  const { pa15min, change15min, range1h } = computeContext(bars);
  const alert: AlertEvent = {
    symbol: sym, symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
    changePercent: result.latestRet * 100, windowSeconds: result.windowSec,
    detectionKind: result.kind, direction: dir, triggeredAt: bars[bars.length - 1]!.t,
    change15min, pa15min, range1h, zscore: result.z,
  };
  markFired(sym, dir, curPrice, now);
  console.log(`[alertEngine] ${sym} ${alert.detectionKind} ${dir} ${alert.changePercent.toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
  sink(alert);
}

/** Realtime (sub-minute) detection for NIY=F. Uses the per-process feedBars rolling buffers.
 *  Mirrors alertLoop.evaluateRealtime exactly, but routes events to `sink`. */
export function evaluateRealtimeNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  const sym = 'NIY=F';
  if (bars.length < params.baselineLookback + 1) return;
  const baselineReturns = returns(bars.slice(-(params.baselineLookback + 1), -1));
  if (baselineReturns.length < 10) return;
  const sigma1 = stdDev(baselineReturns);
  if (sigma1 <= 0) return;

  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;

  const ret60 = getRollingReturn(60_000, sym);
  if (ret60 !== null) {
    const z = Math.abs(ret60) / sigma1;
    const recent = baselineReturns.slice(-params.quietLookback);
    const quietOk = recent.length >= params.quietLookback
      && median(recent.map(Math.abs)) < sigma1 * params.quietMedianRatio;
    if (z >= params.zThreshold && quietOk) result = { z, latestRet: ret60, kind: 'slope', windowSec: 60 };
  }
  if (!result) {
    const r5 = returns5m(bars);
    const ret300 = getRollingReturn(300_000, sym);
    if (r5.length >= 11 && ret300 !== null) {
      const sigma5 = stdDev(r5.slice(0, -1));
      const z = sigma5 > 0 ? Math.abs(ret300) / sigma5 : 0;
      if (sigma5 > 0 && z >= params.zThreshold) result = { z, latestRet: ret300, kind: 'magnitude', windowSec: 300 };
    }
  }
  if (!result) return;

  const dir = result.latestRet >= 0 ? 'up' : 'down';
  const curPrice = bars[bars.length - 1]!.close;
  if (!canFire(sym, dir, curPrice, now)) return;

  const { pa15min, change15min, range1h } = computeContext(bars);
  markFired(sym, dir, curPrice, now);
  console.log(`[alertEngine:rt] ${sym} ${result.kind} ${dir} ${(result.latestRet * 100).toFixed(3)}% (|z|=${result.z.toFixed(2)})`);
  sink({
    symbol: sym, symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
    changePercent: result.latestRet * 100, windowSeconds: result.windowSec,
    detectionKind: result.kind, direction: dir, triggeredAt: now,
    change15min, pa15min, range1h, zscore: result.z,
  });
}
