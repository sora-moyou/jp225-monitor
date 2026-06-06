import { describe, it, expect } from 'vitest';
import { computeCongestionProfile, type CongestBar } from './congestionProfile.js';

const M = 60_000;
// h/l が [lo, hi] を覆う 1分足を n 本、t0 から連続生成。
function dwellBars(t0: number, n: number, lo: number, hi: number): CongestBar[] {
  return Array.from({ length: n }, (_, i) => ({ t: t0 + i * M, h: hi, l: lo }));
}

describe('computeCongestionProfile', () => {
  it('空配列は []', () => {
    expect(computeCongestionProfile([])).toEqual([]);
  });

  it('往復して停滞した帯を検出(visits≥2・局所極大・ピーク比≥minRel)', () => {
    const bars = [
      ...dwellBars(0, 5, 66990, 67010),       // 67000帯(bin1340)に滞在
      ...dwellBars(5 * M, 3, 67290, 67310),   // 67300帯へ離脱(bin1345/1346, 滞在3=rel0.3)
      ...dwellBars(8 * M, 5, 66990, 67010),   // 67000帯へ戻る(=入り直し → visits 2)
    ];
    const nodes = computeCongestionProfile(bars, 50);
    // 67000帯(67025 or 66975)が往復2回で検出される。
    const hit = nodes.find(n => Math.abs(n.price - 67000) <= 30);
    expect(hit).toBeDefined();
    expect(hit!.visits).toBeGreaterThanOrEqual(2);
    expect(hit!.rel).toBe(1);
    // 67300帯は滞在3/10=0.3 < minRel0.4 で除外。
    expect(nodes.some(n => Math.abs(n.price - 67300) <= 30)).toBe(false);
  });

  it('一方向に通過しただけ(往復なし=visits1)の帯は採用しない', () => {
    // 同じ帯に連続滞在のみ → dwell は高いが visits=1 → もみ合いと見なさない。
    const bars = dwellBars(0, 10, 66990, 67010);
    expect(computeCongestionProfile(bars, 50)).toEqual([]);
  });

  it('時間ギャップ後の再到達も入り直し(visits)として数える', () => {
    const bars = [
      ...dwellBars(0, 4, 66990, 67010),
      ...dwellBars(60 * M, 4, 66990, 67010),   // 60分ギャップ後に同帯へ → 入り直し
    ];
    const nodes = computeCongestionProfile(bars, 50);
    const hit = nodes.find(n => Math.abs(n.price - 67000) <= 30);
    expect(hit).toBeDefined();
    expect(hit!.visits).toBeGreaterThanOrEqual(2);
  });
});
