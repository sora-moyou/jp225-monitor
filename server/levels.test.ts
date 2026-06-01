import { describe, it, expect } from 'vitest';
import { computeLevels, type SessionOHLC } from './levels.js';

function s(sessionDate: string, session: 'Day' | 'Night', high: number, low: number,
           extra: Partial<SessionOHLC> = {}): SessionOHLC {
  return {
    sessionDate, session, high, low,
    open: extra.open ?? low, close: extra.close ?? high,
    highT: extra.highT ?? 0, lowT: extra.lowT ?? 0,
  };
}

describe('computeLevels コア（H/L・コンフルエンス・選抜）', () => {
  it('完了セッションの H/L を現値近傍に上下分割して返す', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800),
      s('2026-06-01', 'Day',   67500, 66600),
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const upPrices = r.up.map(l => l.price);
    const downPrices = r.down.map(l => l.price);
    expect(upPrices).toContain(67300);
    expect(upPrices).toContain(67500);
    expect(downPrices).toContain(66800);
    expect(downPrices).toContain(66600);
    expect(r.up.every(l => l.price > 67000)).toBe(true);
    expect(r.up.map(l => l.price)).toEqual([...r.up.map(l => l.price)].sort((a, b) => a - b));
  });

  it('±30円以内で重なる H/L を強レベル(★)に束ね、ラベルを連結する', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67410, 66000),
      s('2026-05-31', 'Day',   67400, 66010),
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const strong = r.up.find(l => l.strong);
    expect(strong).toBeDefined();
    expect(strong!.labels.length).toBe(2);
    expect(strong!.price).toBeGreaterThanOrEqual(67400);
    expect(strong!.price).toBeLessThanOrEqual(67410);
  });

  it('進行中(当日)セッションは current で識別し、当日H/L/始値を出す', () => {
    const sessions = [
      s('2026-06-02', 'Day', 67200, 66900, { open: 67050 }),
      s('2026-06-01', 'Night', 67400, 66700),
    ];
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const r = computeLevels(sessions, 67000, 0, cur);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('当日高'))).toBe(true);
    expect(labels.some(x => x.includes('当日安'))).toBe(true);
    expect(labels.some(x => x.includes('当日始'))).toBe(true);
  });

  it('up/down は各最大4本', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      s(`2026-05-${10 + i}`, 'Day', 67000 + (i + 1) * 100, 67000 - (i + 1) * 100));
    const r = computeLevels(sessions, 67000, 0, null);
    expect(r.up.length).toBeLessThanOrEqual(4);
    expect(r.down.length).toBeLessThanOrEqual(4);
  });

  it('履歴ゼロなら空を返す（クラッシュしない）', () => {
    const r = computeLevels([], 67000, 0, null);
    expect(r.up).toEqual([]);
    expect(r.down).toEqual([]);
    expect(r.swing).toBeNull();
  });
});
