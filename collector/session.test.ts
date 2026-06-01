import { describe, it, expect } from 'vitest';
import { classifySession, inPollWindow } from './session.js';

// JST epoch helper: y-m-d h:mm (JST) → epoch ms.  (JST = UTC+9, no DST)
function jst(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h - 9, mi, 0);
}
// 2026-06-01 is a Monday.
const MON = [2026, 6, 1] as const;
const TUE = [2026, 6, 2] as const;
const FRI = [2026, 6, 5] as const;
const SAT = [2026, 6, 6] as const;
const SUN = [2026, 5, 31] as const;

describe('classifySession', () => {
  it('Day session: Mon 08:45–15:44 inclusive of open, exclusive of 15:45', () => {
    expect(classifySession(jst(...MON, 8, 45))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 12, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 15, 44))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 15, 45))).toBeNull();   // close is exclusive
    expect(classifySession(jst(...MON, 8, 44))).toBeNull();    // before open
  });

  it('Night evening: Mon 17:00–23:59 → sessionDate = Monday', () => {
    expect(classifySession(jst(...MON, 17, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...MON, 23, 59))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...MON, 16, 59))).toBeNull();   // break 15:45–17:00
  });

  it('Night morning: Tue 00:00–05:59 → sessionDate = Monday (prev day)', () => {
    expect(classifySession(jst(...TUE, 0, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...TUE, 5, 59))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...TUE, 6, 0))).toBeNull();     // night close exclusive
  });

  it('week edges: Sat early morning belongs to Fri night; Sat day / Mon pre-open / Sun are closed', () => {
    expect(classifySession(jst(...SAT, 3, 0))).toEqual({ sessionDate: '2026-06-05', session: 'Night' }); // Fri night
    expect(classifySession(jst(...SAT, 6, 0))).toBeNull();      // Sat 06:00 → closed (weekend)
    expect(classifySession(jst(...SAT, 10, 0))).toBeNull();     // Sat day → closed
    expect(classifySession(jst(...MON, 2, 0))).toBeNull();      // Mon 02:00 → prev day Sun → closed
    expect(classifySession(jst(...SUN, 12, 0))).toBeNull();     // Sunday → closed
    expect(classifySession(jst(...FRI, 17, 30))).toEqual({ sessionDate: '2026-06-05', session: 'Night' });
  });
});

describe('classifySession 休場日', () => {
  it('元日(1/1)・年始(1/2)・年末(12/31)は Day も Night も null', () => {
    expect(classifySession(jst(2026, 1, 1, 9, 0))).toBeNull();    // 元日 Day
    expect(classifySession(jst(2026, 1, 1, 18, 0))).toBeNull();   // 元日 Night 夕
    expect(classifySession(jst(2026, 1, 2, 9, 0))).toBeNull();    // 年始 Day
    expect(classifySession(jst(2026, 12, 31, 9, 0))).toBeNull();  // 年末 Day
  });

  it('11/23(勤労感謝・2026はBCPで休場)は null、前後の平日は通常どおり', () => {
    expect(classifySession(jst(2026, 11, 23, 9, 0))).toBeNull();   // 月 休場 Day
    expect(classifySession(jst(2026, 11, 23, 18, 0))).toBeNull();  // 月 休場 Night
    // 翌朝(火 00:00-06:00)は月の Night の続きなので、月が休場→ null
    expect(classifySession(jst(2026, 11, 24, 2, 0))).toBeNull();
    // 火 8:45 からは通常の取引日
    expect(classifySession(jst(2026, 11, 24, 9, 0))).toEqual({ sessionDate: '2026-11-24', session: 'Day' });
  });

  it('休場前日の Night は開始日が平日なので運用される(翌朝の続きも含む)', () => {
    // 12/30(水)の Night は sessionDate=12/30(非休場)→ 翌朝 12/31 早朝も 12/30-Night として有効
    expect(classifySession(jst(2026, 12, 30, 18, 0))).toEqual({ sessionDate: '2026-12-30', session: 'Night' });
    expect(classifySession(jst(2026, 12, 31, 2, 0))).toEqual({ sessionDate: '2026-12-30', session: 'Night' });
  });
});

describe('inPollWindow', () => {
  it('true inside a session', () => {
    expect(inPollWindow(jst(...MON, 9, 0))).toBe(true);
  });
  it('true 5 min before open and 10 min after close (margin)', () => {
    expect(inPollWindow(jst(...MON, 8, 41))).toBe(true);    // 4 min before Day open → within 5-min lead
    expect(inPollWindow(jst(...MON, 15, 54))).toBe(true);   // 9 min after Day close → within 10-min trail
  });
  it('false well outside any session (and its margins)', () => {
    expect(inPollWindow(jst(...MON, 16, 0))).toBe(false);   // mid-break
    expect(inPollWindow(jst(...SUN, 12, 0))).toBe(false);   // weekend
  });
});
