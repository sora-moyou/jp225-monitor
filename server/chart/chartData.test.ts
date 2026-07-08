import { describe, it, expect, vi } from 'vitest';
import type { LevelsResult } from '../levels.js';
import type { AlertRow } from '../db/store.js';

// getLevelsSnapshot をモック(chartData が参照)。
let snap: LevelsResult;
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: () => snap }));

import { levelsToChart, alertsToMarkers, buildChartSnapshot } from './chartData.js';

function lvl(price: number, tier: 0 | 1 | 2, label: string) {
  return { price, dist: 0, labels: [label], strong: tier >= 1, score: tier, tier, confluence: false };
}

describe('levelsToChart', () => {
  it('up/down を tier 降順で選抜し side を付ける', () => {
    const levels: LevelsResult = {
      current: 40000, reversalSatisfied: false, asOf: 1, swing: null,
      up: [lvl(40100, 1, '直近高'), lvl(40500, 2, '長期高')],
      down: [lvl(39900, 2, '長期安')],
    };
    const out = levelsToChart(levels);
    expect(out.find(l => l.price === 40500)?.side).toBe('up');
    expect(out.find(l => l.price === 39900)?.side).toBe('down');
    // tier2 が先(降順)。
    const up = out.filter(l => l.side === 'up');
    expect(up[0]!.tier).toBe(2);
  });

  it('合計12本を超えない', () => {
    const many = (n: number, base: number) =>
      Array.from({ length: n }, (_, i) => lvl(base + i * 10, 1, 'x'));
    const levels: LevelsResult = {
      current: 40000, reversalSatisfied: false, asOf: 1, swing: null,
      up: many(20, 41000), down: many(20, 39000),
    };
    expect(levelsToChart(levels).length).toBeLessThanOrEqual(12);
  });
});

describe('alertsToMarkers', () => {
  const now = 1_000_000_000_000;
  const row = (over: Partial<AlertRow>): AlertRow => ({
    id: 1, symbol: 'NIY=F', triggered_at: now - 60_000, direction: 'down',
    detection_kind: 'crash', window_seconds: 60, change_percent: -3, price: 40000,
    session_date: null, session: null, ret5: null, ret15: null, ret30: null,
    reference_kind: null, reference_price: null, ...over,
  });

  it('窓内のアラートだけをマーカー化し price/direction を引き継ぐ', () => {
    const rows = [
      row({ id: 1, triggered_at: now - 30 * 60_000, price: 40100 }),          // 30分前(窓内)
      row({ id: 2, triggered_at: now - 10 * 60 * 60_000, price: 39000 }),      // 10時間前(窓外)
    ];
    const m = alertsToMarkers(rows, now);
    expect(m.length).toBe(1);
    expect(m[0]!.price).toBe(40100);
    expect(m[0]!.direction).toBe('down');
  });

  it('price 無しは reference_price を代替に使う', () => {
    const m = alertsToMarkers([row({ price: null, reference_price: 40500 })], now);
    expect(m[0]!.price).toBe(40500);
  });
});

describe('buildChartSnapshot', () => {
  it('足なし/水準なしでも例外を投げず空スナップを返す', () => {
    snap = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
    // getRecentBars / getRecentAlerts が throw する DB を渡しても堅牢に空で返る。
    const badDb = { prepare: () => { throw new Error('no table'); } } as any;
    const out = buildChartSnapshot(badDb, 1_000);
    expect(out.symbol).toBe('NIY=F');
    expect(out.candles).toEqual([]);
    expect(out.levels).toEqual([]);
    expect(out.markers).toEqual([]);
    expect(out.barCount).toBe(0);
  });
});
