import { describe, it, expect } from 'vitest';
import { pearsonAlignedReturns, type Bar } from './correlation.js';

const MIN = 60_000;

function makeBars(startMs: number, closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: startMs + i * MIN, close: c }));
}

describe('pearsonAlignedReturns (v0.3.13 server-side 1m bars)', () => {
  it('returns +1 for perfectly co-moving series', () => {
    const a = makeBars(0, [100, 101, 102, 103, 104, 105]);
    const b = makeBars(0, [200, 202, 204, 206, 208, 210]);
    const { corr, samples } = pearsonAlignedReturns(a, b);
    expect(samples).toBe(5);
    expect(corr).toBeCloseTo(1.0, 5);
  });

  it('returns -1 for series whose returns are exact negatives', () => {
    const aCloses = [100, 105, 110, 108, 103, 107];
    const a = makeBars(0, aCloses);
    // b constructed so each return is exactly -1 × the corresponding a return
    const bCloses: number[] = [100];
    for (let i = 1; i < aCloses.length; i++) {
      const aRet = (aCloses[i]! - aCloses[i - 1]!) / aCloses[i - 1]!;
      bCloses.push(bCloses[bCloses.length - 1]! * (1 - aRet));
    }
    const b = makeBars(0, bCloses);
    const { corr, samples } = pearsonAlignedReturns(a, b);
    expect(samples).toBe(5);
    expect(corr).toBeCloseTo(-1.0, 5);
  });

  it('aligns by timestamp, ignoring bars that have no counterpart', () => {
    const a = makeBars(0, [100, 101, 102, 103, 104]);
    // b shifted forward 2 minutes — last 3 timestamps overlap with a's last 3
    const b: Bar[] = [
      { t: 2 * MIN, close: 200 },
      { t: 3 * MIN, close: 202 },
      { t: 4 * MIN, close: 204 },
    ];
    const { samples } = pearsonAlignedReturns(a, b);
    expect(samples).toBe(2);  // 3 aligned bars → 2 return pairs
  });

  it('includes return pairs across multi-minute gaps (v0.3.15 — no gap skip)', () => {
    const a: Bar[] = [
      { t: 0,           close: 100 },
      { t: 1 * MIN,     close: 101 },
      // 5-minute gap (market break) — still produces a paired return
      { t: 6 * MIN,     close: 110 },
      { t: 7 * MIN,     close: 111 },
    ];
    const b: Bar[] = [
      { t: 0,           close: 200 },
      { t: 1 * MIN,     close: 202 },
      { t: 6 * MIN,     close: 220 },
      { t: 7 * MIN,     close: 222 },
    ];
    const { samples } = pearsonAlignedReturns(a, b);
    expect(samples).toBe(3);   // (0→1min), (1min→6min, gap-spanning), (6min→7min)
  });

  it('returns 0 / samples 0 when no timestamps overlap', () => {
    const a = makeBars(0, [100, 101, 102]);
    const b = makeBars(10 * MIN, [200, 202, 204]);
    const { corr, samples } = pearsonAlignedReturns(a, b);
    expect(samples).toBe(0);
    expect(corr).toBe(0);
  });
});
