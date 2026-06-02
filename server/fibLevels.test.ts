import { describe, it, expect } from 'vitest';
import { deriveSwing, fibLevelsForSwing, DEFAULT_RETR, DEFAULT_EXT, type Swing } from './fibLevels.js';
import type { SessionOHLC } from './levels.js';

function ses(date: string, session: 'Day'|'Night', o: number, h: number, l: number, c: number, highT: number, lowT: number): SessionOHLC {
  return { sessionDate: date, session, open: o, high: h, low: l, close: c, highT, lowT, openT: 0 };
}

describe('deriveSwing', () => {
  it('picks extreme high/low over the window and leg by newer extreme', () => {
    // 安値が新しい → down脚
    const s = [
      ses('2026-06-01','Day', 100, 120, 95, 110, 5000, 1000),   // high@5000 (extreme high)
      ses('2026-06-01','Night',110, 115, 90, 100, 2000, 6000),  // low@6000 (extreme low, newer)
    ];
    const sw = deriveSwing(s, 2);
    expect(sw).not.toBeNull();
    expect(sw!.high).toBe(120); expect(sw!.low).toBe(90);
    // 低値の時刻(6000) > 高値の時刻(5000) → down脚
    expect(sw!.leg).toBe('down');
  });
  it('returns null when fewer sessions than window', () => {
    expect(deriveSwing([], 5)).toBeNull();
  });
});

describe('fibLevelsForSwing', () => {
  it('produces retracement + extension levels with correct prices (up-leg)', () => {
    const sw: Swing = { high: 200, low: 100, leg: 'up', scaleLabel: '5S' };  // range=100
    const lv = fibLevelsForSwing(sw, [0.382, 0.5], [1.618]);
    const byRatio = new Map(lv.map(x => [x.ratio, x.price]));
    expect(byRatio.get(0.382)).toBeCloseTo(200 - 0.382 * 100);  // 161.8 戻し
    expect(byRatio.get(0.5)).toBeCloseTo(150);
    expect(byRatio.get(1.618)).toBeCloseTo(200 + 0.618 * 100);  // 261.8 拡張(上)
    // 50% は reversalLine
    expect(lv.find(x => x.ratio === 0.5)!.reversalLine).toBe(true);
  });
  it('down-leg retracement goes up from low, extension goes below low', () => {
    const sw: Swing = { high: 200, low: 100, leg: 'down', scaleLabel: '10S' };
    const lv = fibLevelsForSwing(sw, [0.382], [1.618]);
    const m = new Map(lv.map(x => [x.ratio, x.price]));
    expect(m.get(0.382)).toBeCloseTo(100 + 0.382 * 100);
    expect(m.get(1.618)).toBeCloseTo(100 - 0.618 * 100);
  });
});
