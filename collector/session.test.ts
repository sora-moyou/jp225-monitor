import { describe, it, expect } from 'vitest';
import { classifySession, inPollWindow, isMarketOpen, tokyoCashOpen } from './session.js';

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

describe('tokyoCashOpen (東証現物 9:00-15:30・AI連動材料の引用可判定)', () => {
  it('平日 9:00 開始(含む)〜15:30 終了(除く)。昼休みも引用可で true', () => {
    expect(tokyoCashOpen(jst(...MON, 9, 0))).toBe(true);    // 寄り(含む)
    expect(tokyoCashOpen(jst(...MON, 8, 59))).toBe(false);  // 寄り前
    expect(tokyoCashOpen(jst(...MON, 11, 45))).toBe(true);  // 昼休み=引用可(ユーザー指定)
    expect(tokyoCashOpen(jst(...MON, 12, 30))).toBe(true);  // 後場寄り
    expect(tokyoCashOpen(jst(...MON, 15, 29))).toBe(true);  // 大引け直前
    expect(tokyoCashOpen(jst(...MON, 15, 30))).toBe(false); // 大引け(除く)
  });
  it('夜間・早朝(先物Nightセッション)は false=引用しない', () => {
    expect(tokyoCashOpen(jst(...MON, 17, 0))).toBe(false);  // 夜間
    expect(tokyoCashOpen(jst(...TUE, 3, 0))).toBe(false);   // 早朝
    expect(tokyoCashOpen(jst(...MON, 16, 0))).toBe(false);  // 引け後
  });
  it('週末・休場日は false', () => {
    expect(tokyoCashOpen(jst(...SAT, 10, 0))).toBe(false);
    expect(tokyoCashOpen(jst(2026, 1, 1, 10, 0))).toBe(false);   // 元日(HOLIDAYS)
  });
});

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

describe('isMarketOpen (価格ボードの「取引時間外」表示用)', () => {
  it('true 場中(セッション内)', () => {
    expect(isMarketOpen(jst(...MON, 9, 0))).toBe(true);     // Day session
    expect(isMarketOpen(jst(...MON, 18, 0))).toBe(true);    // Night session
    expect(isMarketOpen(jst(...TUE, 3, 0))).toBe(true);     // Night 早朝継続
  });
  it('false 週末', () => {
    expect(isMarketOpen(jst(...SAT, 10, 0))).toBe(false);   // Saturday day
    expect(isMarketOpen(jst(...SUN, 12, 0))).toBe(false);   // Sunday
  });
  it('false 休場日(元日=HOLIDAYS)', () => {
    expect(isMarketOpen(jst(2026, 1, 1, 12, 0))).toBe(false);
  });
  it('false セッション間(引け後の休憩帯)', () => {
    expect(isMarketOpen(jst(...MON, 16, 0))).toBe(false);   // Day 引け〜Night 開場の間
  });
});
