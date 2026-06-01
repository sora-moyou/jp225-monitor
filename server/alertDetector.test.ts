import { describe, it, expect } from 'vitest';
import {
  returns, stdDev, returns5m,
  detectBurst, detectTrend,
  computeContext,
  type DetectorParams,
} from './alertDetector.js';
import type { Bar } from './correlation.js';

const MIN = 60_000;

function makeBars(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: i * MIN, close: c }));
}

const TEST_PARAMS: DetectorParams = {
  zThreshold: 2.5,
  quietMedianRatio: 0.8,
  quietLookback: 5,
  baselineLookback: 60,
};

describe('returns / stdDev / returns5m', () => {
  it('returns computes 1-bar percent changes', () => {
    expect(returns(makeBars([100, 101, 102]))).toEqual([0.01, (102 - 101) / 101]);
  });
  it('stdDev computes sample-mean-relative population std', () => {
    expect(stdDev([0, 0, 0, 0])).toBe(0);
    expect(stdDev([1, 1, 1, 1])).toBe(0);
    expect(stdDev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 5);
  });
  it('returns5m computes 5-bar percent changes', () => {
    const bars = makeBars([100, 100, 100, 100, 100, 105, 105]);
    const r = returns5m(bars);
    expect(r[0]).toBeCloseTo(0.05, 5);
  });
});

describe('detectBurst (1m z-score)', () => {
  // 50 noisy bars (forms baseline σ) → 20 truly quiet bars (静寂前提を満たす窓) → 1 spike bar
  function buildQuietThenSpike(spikePct: number): Bar[] {
    const closes: number[] = [10000];
    for (let i = 1; i < 51; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      closes.push(closes[i - 1]! * (1 + sign * 0.0005));        // ±0.05% noise → σ ~ 0.0005
    }
    for (let i = 51; i < 71; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      closes.push(closes[i - 1]! * (1 + sign * 0.00005));       // ±0.005% quiet stretch
    }
    closes.push(closes[closes.length - 1]! * (1 + spikePct));
    return makeBars(closes);
  }

  it('fires when latest return |z| crosses threshold and recent bars are quiet', () => {
    const bars = buildQuietThenSpike(0.003);   // 0.3% spike vs σ ~0.0001 → z huge
    const r = detectBurst(bars, TEST_PARAMS);
    expect(r).not.toBeNull();
    expect(r!.z).toBeGreaterThan(TEST_PARAMS.zThreshold);
    expect(r!.latestRet).toBeGreaterThan(0);
  });

  it('does not fire when latest return is within volatility band', () => {
    const bars = buildQuietThenSpike(0.0005);  // 1σ, well below 2.5σ threshold
    expect(detectBurst(bars, TEST_PARAMS)).toBeNull();
  });

  it('does not fire when recent bars are already noisy (no quiet precondition)', () => {
    // ノイジーな baseline + 同程度の spike → 静寂前提に引っかかる
    const closes: number[] = [10000];
    for (let i = 1; i < 70; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      closes.push(closes[i - 1]! * (1 + sign * 0.003));   // 0.3% chops everywhere
    }
    closes.push(closes[closes.length - 1]! * 1.003);
    const bars = makeBars(closes);
    expect(detectBurst(bars, TEST_PARAMS)).toBeNull();
  });

  it('returns null when too few bars', () => {
    expect(detectBurst(makeBars([100, 101, 102]), TEST_PARAMS)).toBeNull();
  });
});

describe('detectTrend (5m z-score)', () => {
  it('fires on a sustained 5-min run when baseline is quiet', () => {
    // 70 quiet bars then 5 bars each +0.1% (cumulative 0.5%)
    const closes: number[] = [10000];
    for (let i = 1; i < 70; i++) {
      const sign = i % 2 === 0 ? 1 : -1;
      closes.push(closes[i - 1]! * (1 + sign * 0.0001));
    }
    for (let i = 0; i < 5; i++) {
      closes.push(closes[closes.length - 1]! * 1.001);
    }
    const bars = makeBars(closes);
    const r = detectTrend(bars, TEST_PARAMS);
    expect(r).not.toBeNull();
    expect(r!.latestRet).toBeGreaterThan(0);
  });
});

describe('computeContext', () => {
  it('produces pa15min/change15min/range1h from last 15/60 bars', () => {
    const closes = [];
    for (let i = 0; i < 60; i++) closes.push(100 + i);   // 100..159
    const ctx = computeContext(makeBars(closes));
    expect(ctx.pa15min).not.toBeNull();
    expect(ctx.pa15min!.current).toBe(159);
    expect(ctx.pa15min!.open).toBe(145);                  // 60-15 = index 45 → close 145
    expect(ctx.range1h!.low).toBe(100);
    expect(ctx.range1h!.high).toBe(159);
    expect(ctx.change15min).toBeCloseTo(((159 - 145) / 145) * 100, 5);
  });
});
