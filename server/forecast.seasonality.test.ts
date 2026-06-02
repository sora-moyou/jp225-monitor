import { describe, it, expect } from 'vitest';
import { slotKey, computeSeasonality, currentAndNextSlot } from './forecast.js';

const JST = 9 * 3600_000;
// JST 日時 → epoch
const at = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) - JST;

describe('slotKey', () => {
  it('JST 時刻を slotMin 分スロットに丸めた HH:MM', () => {
    expect(slotKey(at(2026, 6, 1, 13, 17), 30)).toBe('13:00');
    expect(slotKey(at(2026, 6, 1, 13, 45), 30)).toBe('13:30');
    expect(slotKey(at(2026, 6, 1, 9, 5), 15)).toBe('09:00');
  });
});

describe('computeSeasonality', () => {
  it('スロット×日で集計し avgReturn/upRate/avgRange/samples を出す', () => {
    // 13:00台スロット(30分)を 2 日分。slotMin=30。
    const bars = [
      // Day A: open100 close102 (+2%), high103 low99 → range4%
      { t: at(2026, 6, 1, 13, 0), o: 100, h: 100, l: 100, c: 100 },
      { t: at(2026, 6, 1, 13, 10), o: 100, h: 103, l: 99, c: 101 },
      { t: at(2026, 6, 1, 13, 29), o: 101, h: 102, l: 100, c: 102 },
      // Day B: open100 close99 (-1%), high101 low98 → range3%
      { t: at(2026, 6, 2, 13, 0), o: 100, h: 101, l: 100, c: 100 },
      { t: at(2026, 6, 2, 13, 29), o: 100, h: 100, l: 98, c: 99 },
    ];
    const stats = computeSeasonality(bars, 30);
    const s = stats.find(x => x.slot === '13:00')!;
    expect(s.samples).toBe(2);
    expect(s.avgReturn).toBeCloseTo(0.5, 5);   // (+2 + -1)/2
    expect(s.upRate).toBeCloseTo(0.5, 5);       // 1/2 が上昇
    expect(s.avgRange).toBeCloseTo(3.5, 5);     // (4 + 3)/2
  });
});

describe('currentAndNextSlot', () => {
  it('現在スロットと次スロットを返す', () => {
    const stats = [
      { slot: '13:00', avgReturn: 0.5, upRate: 0.5, avgRange: 3.5, samples: 2 },
      { slot: '13:30', avgReturn: -0.2, upRate: 0.4, avgRange: 2.0, samples: 2 },
    ];
    const r = currentAndNextSlot(stats, at(2026, 6, 1, 13, 10), 30);
    expect(r.now?.slot).toBe('13:00');
    expect(r.next?.slot).toBe('13:30');
  });
});
