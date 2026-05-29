import { describe, it, expect } from 'vitest';
import { getSignificantMovers } from './marketSnapshot.js';
import type { Bar } from './correlation.js';

// 60+ 本の極小ノイズ baseline の後に最終バーで spikePct の急変を1本足す。
// → 最終 1分リターン ≈ spikePct, baseline σ ≈ 0.00005 → |z| 巨大。
function quietThenSpike(spikePct: number, n = 70): Bar[] {
  const closes = [10000];
  for (let i = 1; i < n; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    closes.push(closes[i - 1]! * (1 + sign * 0.00005));
  }
  closes.push(closes[closes.length - 1]! * (1 + spikePct));
  return closes.map((c, i) => ({ t: i * 60000, close: c }));
}

// 終始極小ノイズのみ → |z| ≈ 1。
function quiet(n = 71): Bar[] {
  const closes = [10000];
  for (let i = 1; i < n; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    closes.push(closes[i - 1]! * (1 + sign * 0.00005));
  }
  return closes.map((c, i) => ({ t: i * 60000, close: c }));
}

describe('getSignificantMovers', () => {
  const bars: Record<string, Bar[]> = {
    'NIY=F': quietThenSpike(0.01),    // 巨大 z だが除外対象
    'NQ=F': quietThenSpike(-0.005),   // -0.5% 急変, 大 z, down
    'ES=F': quiet(),                  // 静か, 閾値未満
  };
  const getBars = (s: string) => bars[s] ?? [];

  it('excludes the alerting symbol itself', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    expect(movers.every(m => m.symbol !== 'NIY=F')).toBe(true);
  });

  it('includes a symbol with a large move (|z| >= threshold) and reports direction', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    const nq = movers.find(m => m.symbol === 'NQ=F');
    expect(nq).toBeDefined();
    expect(nq!.direction).toBe('down');
    expect(nq!.changePercent).toBeLessThan(0);
    expect(nq!.z).toBeGreaterThanOrEqual(4.0);
  });

  it('excludes quiet symbols below the threshold', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    expect(movers.every(m => m.symbol !== 'ES=F')).toBe(true);
  });

  it('sorts movers by |z| descending', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    for (let i = 1; i < movers.length; i++) {
      expect(movers[i - 1]!.z).toBeGreaterThanOrEqual(movers[i]!.z);
    }
  });
});
