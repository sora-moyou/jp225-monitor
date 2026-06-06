import { describe, it, expect } from 'vitest';
import { computeVolumeProfile, type VolBar } from './volumeProfile.js';

const bar = (h: number, l: number, volume: number): VolBar => ({ h, l, volume });

describe('computeVolumeProfile', () => {
  it('最大出来高の価格帯を POC とする', () => {
    // 65,000 帯に出来高が集中、65,500/64,500 は少なめ
    const bars = [
      ...Array.from({ length: 10 }, () => bar(65020, 64990, 1000)),  // 65,000 帯に厚い
      bar(65520, 65490, 100), bar(64520, 64490, 100),
    ];
    const nodes = computeVolumeProfile(bars, 50);
    const poc = nodes.find(n => n.isPoc)!;
    expect(Math.abs(poc.price - 65000)).toBeLessThanOrEqual(50);
    expect(poc.rel).toBe(1);
  });

  it('局所極大の高出来高ノードを複数返す(谷は除外)', () => {
    const bars = [
      ...Array.from({ length: 8 }, () => bar(65010, 64990, 1000)),   // HVN 65,000
      bar(64510, 64490, 50),                                          // 谷(低出来高)
      ...Array.from({ length: 6 }, () => bar(64010, 63990, 800)),    // HVN 64,000
    ];
    const nodes = computeVolumeProfile(bars, 50, 8, 0.4);
    const prices = nodes.map(n => n.price);
    expect(prices.some(p => Math.abs(p - 65000) <= 50)).toBe(true);
    expect(prices.some(p => Math.abs(p - 64000) <= 50)).toBe(true);
  });

  it('volume 無し/空はガード', () => {
    expect(computeVolumeProfile([], 50)).toEqual([]);
    expect(computeVolumeProfile([bar(65000, 64900, 0)], 50)).toEqual([]);
  });
});
