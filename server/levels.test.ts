import { describe, it, expect } from 'vitest';
import { computeLevels, FIB_SWING_SESSIONS, type SessionOHLC } from './levels.js';

function s(sessionDate: string, session: 'Day' | 'Night', high: number, low: number,
           extra: Partial<SessionOHLC> = {}): SessionOHLC {
  return {
    sessionDate, session, high, low,
    open: extra.open ?? low, close: extra.close ?? high,
    highT: extra.highT ?? 0, lowT: extra.lowT ?? 0,
    openT: extra.openT ?? 0,   // 既定0=寄り前→「寄りから揃っている」扱い
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

  it('当日が寄り欠け(openT が寄りより大幅後)なら当日高/安/始を出さない', () => {
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const lateOpenT = Date.UTC(2026, 5, 2, 13 - 9, 32);   // 最初のバーが 13:32 JST (寄り8:45欠け)
    const sessions = [
      s('2026-06-02', 'Day', 66215, 66085, { open: 66100, openT: lateOpenT }),
      s('2026-06-01', 'Night', 67250, 66900),              // 完了(openT=0=揃い扱い)
    ];
    const r = computeLevels(sessions, 66200, 0, cur);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('当日'))).toBe(false);          // 当日高/安/始は出ない
    expect([...r.up, ...r.down].some(l => l.price === 67250 || l.price === 66900)).toBe(true);  // 完了分は出る
  });

  it('当日が寄りから揃っていれば当日高/安を出す', () => {
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const goodOpenT = Date.UTC(2026, 5, 2, 8 - 9, 46);    // 8:46 JST ≈ 寄り
    const sessions = [s('2026-06-02', 'Day', 66215, 66085, { open: 66100, openT: goodOpenT })];
    const r = computeLevels(sessions, 66200, 0, cur);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => x.includes('当日'))).toBe(true);
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

describe('computeLevels フィボナッチ', () => {
  function swingSessions(opts: { highT: number; lowT: number }): SessionOHLC[] {
    return [
      s('2026-06-01', 'Night', 67200, 66500, { highT: 10, lowT: 11 }),
      s('2026-05-31', 'Day',   67100, 66400, { highT: 8, lowT: 9 }),
      s('2026-05-30', 'Night', 67000, 66300, { highT: 6, lowT: 7 }),
      s('2026-05-30', 'Day',   68000, 66800, { highT: opts.highT, lowT: 5 }),
      s('2026-05-29', 'Day',   67300, 66000, { highT: 3, lowT: opts.lowT }),
    ];
  }

  it('下げ脚(安値が新しい): 50%戻し=swingLow+0.5*range、現値が上なら転換成立', () => {
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    const r = computeLevels(sessions, 67100, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'down' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);
    expect(r.reversalSatisfied).toBe(true);
  });

  it('上げ脚(高値が新しい): 50%戻し=swingHigh-0.5*range、現値が下なら転換成立', () => {
    const sessions = swingSessions({ highT: 20, lowT: 4 });
    const r = computeLevels(sessions, 66800, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'up' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);
    expect(r.reversalSatisfied).toBe(true);
  });

  it('fib50(転換ライン)は近傍4に入らなくても必ず含める', () => {
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    const r = computeLevels(sessions, 67100, 0, null);
    expect([...r.up, ...r.down].some(l => l.reversalLine)).toBe(true);
  });

  it('セッションが5本未満ならフィボ省略（swing=null）', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66500)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect(r.swing).toBeNull();
    expect([...r.up, ...r.down].some(l => l.fib !== undefined)).toBe(false);
  });
});

describe('computeLevels extraLevels (ADR等の外部レベル)', () => {
  it('extraLevels が候補に混ざり、近傍選抜に乗る', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800),
      s('2026-06-01', 'Day',   67500, 66600),
    ];
    const r = computeLevels(sessions, 67000, 0, null, [
      { price: 67400, label: 'ADR上限予測' },
      { price: 66700, label: 'ADR下限予測' },
    ]);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('ADR上限予測'))).toBe(true);
    expect(labels.some(x => x.includes('ADR下限予測'))).toBe(true);
  });

  it('extraLevels 省略時は従来どおり(既存挙動不変)', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66600)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect([...r.up, ...r.down].flatMap(l => l.labels).some(x => x.includes('ADR'))).toBe(false);
  });
});
