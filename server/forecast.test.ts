import { describe, it, expect } from 'vitest';
import { computeADR, projectTargets } from './forecast.js';
import type { SessionOHLC } from './levels.js';

// 寄り(Day8:45 JST)に揃ったセッションを作るヘルパ。openT を寄り近辺にして isSessionComplete を満たす。
function sess(date: string, session: 'Day' | 'Night', open: number, high: number, low: number): SessionOHLC {
  const [y, m, d] = date.split('-').map(Number);
  const openMin = session === 'Day' ? 8 * 60 + 45 : 17 * 60;
  const openT = Date.UTC(y!, m! - 1, d!, Math.floor(openMin / 60), openMin % 60) - 9 * 3600_000 + 60_000; // 寄り+1分
  return { sessionDate: date, session, open, high, low, close: (high + low) / 2, highT: openT, lowT: openT, openT };
}

describe('computeADR', () => {
  it('指定セッション種別・寄り揃いの up/down レンジの中央値', () => {
    const sessions = [
      sess('2026-06-01', 'Day', 100, 110, 95),   // up=10 down=5
      sess('2026-05-29', 'Day', 100, 120, 90),   // up=20 down=10
      sess('2026-05-28', 'Day', 100, 130, 85),   // up=30 down=15
      sess('2026-05-28', 'Night', 100, 200, 0),  // 別種別 → 無視
    ];
    const adr = computeADR(sessions, 10, 'Day');
    expect(adr.samples).toBe(3);
    expect(adr.adrUp).toBe(20);    // median(10,20,30)
    expect(adr.adrDown).toBe(10);  // median(5,10,15)
  });

  it('寄り欠け(openT が寄りより大幅後)のセッションは除外', () => {
    const late = sess('2026-06-01', 'Day', 100, 110, 95);
    (late as { openT: number }).openT = Date.UTC(2026, 5, 1, 13 - 9, 0); // 13:00 JST = 寄り欠け
    const adr = computeADR([late], 10, 'Day');
    expect(adr.samples).toBe(0);
  });
});

describe('projectTargets', () => {
  it('寄り + adrUp / 寄り - adrDown', () => {
    expect(projectTargets(67000, { adrUp: 300, adrDown: 250, samples: 5 }))
      .toEqual({ projHigh: 67300, projLow: 66750 });
  });
});
