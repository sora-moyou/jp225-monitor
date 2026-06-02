import { describe, it, expect, vi } from 'vitest';
import type { Bar } from './correlation.js';
import type { LevelsResult } from './levels.js';

// 単調増加 70 本: 現値 > 15分平均 > 60分平均(レベルパスでは現値表示に使う)
function rising(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10000 + i * 10 }));
}

// SP2 レベルパス + 予測ブロックの結合テスト。
// levelsLoop / forecastLoop をモックして「レベルが非空 → レベルパスが選ばれ、
// 末尾に 予測(ADR/シーズナリティ) ブロックが付く」ことを確認する。
// (15〜60分パスの既存テストは chatContext.test.ts 側に分離。モジュールモックの
//  ホイスティングで他テストの levels パスを誤って有効化しないよう別ファイルにする。)
vi.mock('./loops/levelsLoop.js', () => ({
  getLevelsSnapshot: (): LevelsResult => ({
    current: 67100,
    up: [{ price: 67300, dist: 200, labels: ['6/1夜高'], strong: false }],
    down: [{ price: 67000, dist: -100, labels: ['Fib50%'], strong: false }],
    swing: null,
    reversalSatisfied: false,
    asOf: 0,
  }),
}));
vi.mock('./loops/forecastLoop.js', () => ({
  getForecastSnapshot: () => ({
    adr: { adrUp: 300, adrDown: 280, samples: 18 },
    targets: { projHigh: 67300, projLow: 66720 },
    seasonalityNow: { slot: '13:00', avgReturn: 0.04, upRate: 0.6, avgRange: 0.18, samples: 18 },
    seasonalityNext: { slot: '13:30', avgReturn: -0.02, upRate: 0.45, avgRange: 0.15, samples: 18 },
    asOf: 0,
  }),
}));

const { buildNikkeiTechnical } = await import('./chatContext.js');

describe('buildNikkeiTechnical (levels path + forecast block)', () => {
  it('appends a 予測(ADR/シーズナリティ) block to the levels-path output', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars)!;
    expect(out).not.toBeNull();
    expect(out).toContain('セッションH/L・フィボ');   // レベルパスが選ばれている
    expect(out).toContain('予測');
    expect(out).toContain('ADR');
    expect(out).toContain('13:00');   // 現スロット
    expect(out).toContain('60');      // 上昇率 60%
  });
});
