import { describe, it, expect } from 'vitest';
import {
  classifySession, inPollWindow, isMarketOpen, tokyoCashOpen,
  CASH_HOLIDAYS, DERIV_NON_TRADING, HOLIDAY_TABLE_COVERED_THROUGH, HOLIDAY_TABLE_RENEW_LEAD_DAYS,
  holidayTableNeedsRenewal,
} from '../core/session.js';

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
  it('週末・年末年始は false', () => {
    expect(tokyoCashOpen(jst(...SAT, 10, 0))).toBe(false);
    expect(tokyoCashOpen(jst(2026, 1, 1, 10, 0))).toBe(false);   // 元日
  });

  // ★事故の形: 現物の休場判定に**先物の**非取引日表(DERIV_NON_TRADING)を使い回していた。
  //   先物は 2022/9 以降 国民の祝日も「祝日取引」で取引あり=表に載らない。だから祝日の東証現物が
  //   「立会中」と判定され、前営業日の古い株価を AI に「今リアルタイムに動いている」材料として渡していた。
  //   年15回ほど、無言で誤情報。→ 現物専用表 CASH_HOLIDAYS に分離。
  it('国民の祝日(先物は祝日取引で稼働・現物は休場)は false', () => {
    expect(tokyoCashOpen(jst(2026, 5, 4, 10, 0))).toBe(false);    // みどりの日(月) ★報告された実測ケース
    expect(tokyoCashOpen(jst(2026, 1, 12, 10, 0))).toBe(false);   // 成人の日(月)
    expect(tokyoCashOpen(jst(2026, 5, 6, 10, 0))).toBe(false);    // 憲法記念日 振替休日(水)
    expect(tokyoCashOpen(jst(2026, 9, 22, 10, 0))).toBe(false);   // 国民の休日(火)
    expect(tokyoCashOpen(jst(2026, 11, 3, 10, 0))).toBe(false);   // 文化の日(火)
    expect(tokyoCashOpen(jst(2027, 3, 22, 10, 0))).toBe(false);   // 春分の日 振替休日(月)
    expect(tokyoCashOpen(jst(2027, 5, 3, 10, 0))).toBe(false);    // 憲法記念日(月)
    expect(tokyoCashOpen(jst(2027, 8, 11, 10, 0))).toBe(false);   // 山の日(水)
  });

  it('祝日の前後の平日は true(現物表を広げすぎていないことの対照)', () => {
    expect(tokyoCashOpen(jst(2026, 5, 1, 10, 0))).toBe(true);     // 5/1(金) 平日
    expect(tokyoCashOpen(jst(2026, 5, 7, 10, 0))).toBe(true);     // 5/7(木) 連休明け
    expect(tokyoCashOpen(jst(2026, 11, 24, 10, 0))).toBe(true);   // 11/24(火)
    expect(tokyoCashOpen(jst(2027, 1, 4, 10, 0))).toBe(true);     // 2027 大発会(月)
    expect(tokyoCashOpen(jst(2027, 12, 30, 10, 0))).toBe(true);   // 2027 大納会(木)
  });
});

// ★先物側の不変性: 上の祝日は現物では休場だが、先物は「祝日取引」で通常どおり動く。
//   分離後もここが緑 = 先物の挙動が 1 ミリも変わっていないことの対照。
describe('祝日取引(先物は稼働・現物は休場)の対照', () => {
  const HOLIDAY_BUT_DERIV_TRADES: Array<[number, number, number]> = [
    [2026, 5, 4], [2026, 1, 12], [2026, 5, 6], [2026, 9, 22], [2026, 11, 3],
    [2027, 3, 22], [2027, 5, 3], [2027, 8, 11],
  ];
  it('国民の祝日でも先物は Day/Night とも通常セッション', () => {
    for (const [y, m, d] of HOLIDAY_BUT_DERIV_TRADES) {
      const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      expect(classifySession(jst(y, m, d, 10, 0))).toEqual({ sessionDate: ds, session: 'Day' });
      expect(classifySession(jst(y, m, d, 18, 0))).toEqual({ sessionDate: ds, session: 'Night' });
      expect(isMarketOpen(jst(y, m, d, 10, 0))).toBe(true);
      expect(tokyoCashOpen(jst(y, m, d, 10, 0))).toBe(false);   // 同時刻に現物だけ休場
    }
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

  // ★事故の形: 休場表が 2026年の4日分しか無く、2027年以降が空だった。年を越すと正月が「取引時間」と
  //   判定され、isMarketOpen / inPollWindow が true になって実取引 bot が動く(無言の誤作動)。
  it('2027年の休場日(元日/年末/敬老の日BCP)は Day も Night も null', () => {
    expect(classifySession(jst(2027, 1, 1, 9, 0))).toBeNull();     // 元日(金) Day
    expect(classifySession(jst(2027, 1, 1, 18, 0))).toBeNull();    // 元日(金) Night 夕
    expect(classifySession(jst(2027, 1, 1, 12, 0))).toBeNull();
    expect(isMarketOpen(jst(2027, 1, 1, 10, 0))).toBe(false);      // 「取引時間」と言わない
    expect(inPollWindow(jst(2027, 1, 1, 10, 0))).toBe(false);      // ポーリングもしない
    expect(classifySession(jst(2027, 9, 20, 9, 0))).toBeNull();    // 敬老の日(月) JPX BCP テスト
    expect(classifySession(jst(2027, 12, 31, 9, 0))).toBeNull();   // 年末休業(金)
  });

  it('2027年の年始/年末まわりの通常営業日は動く(休場表を広げすぎていないことの対照)', () => {
    // 大発会 2028-01-04 ではなく 2027 の初営業日 = 1/4(月)。1/2(土)・1/3(日)は週末ロジックで除外。
    expect(classifySession(jst(2027, 1, 4, 9, 0))).toEqual({ sessionDate: '2027-01-04', session: 'Day' });
    // 2027年の大納会 = 12/30(木)。その Night は開始日が平日なので 12/31 早朝まで続く。
    expect(classifySession(jst(2027, 12, 30, 9, 0))).toEqual({ sessionDate: '2027-12-30', session: 'Day' });
    expect(classifySession(jst(2027, 12, 31, 2, 0))).toEqual({ sessionDate: '2027-12-30', session: 'Night' });
    // 祝日取引が有る祝日(2027-01-11 成人の日・月)は通常どおり取引日。
    expect(classifySession(jst(2027, 1, 11, 9, 0))).toEqual({ sessionDate: '2027-01-11', session: 'Day' });
  });

  it('休場前日の Night は開始日が平日なので運用される(翌朝の続きも含む)', () => {
    // 12/30(水)の Night は sessionDate=12/30(非休場)→ 翌朝 12/31 早朝も 12/30-Night として有効
    expect(classifySession(jst(2026, 12, 30, 18, 0))).toEqual({ sessionDate: '2026-12-30', session: 'Night' });
    expect(classifySession(jst(2026, 12, 31, 2, 0))).toEqual({ sessionDate: '2026-12-30', session: 'Night' });
  });
});

describe('休場日テーブルの不変条件', () => {
  const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
  it('両テーブルとも土日を含まない(土日は週末ロジックの責務・二重管理しない)', () => {
    const weekendEntries = [...DERIV_NON_TRADING, ...CASH_HOLIDAYS].filter(d => dow(d) === 0 || dow(d) === 6);
    expect(weekendEntries).toEqual([]);   // 混入していたら、その日付が失敗メッセージに出る
  });
  it('現物は先物の上位集合(先物が止まる日に現物が開くことはない)', () => {
    for (const d of DERIV_NON_TRADING) expect(CASH_HOLIDAYS.has(d)).toBe(true);
  });
  it('現物のほうが休みが多い(祝日取引=先物だけの制度であることの対照)', () => {
    expect(CASH_HOLIDAYS.size).toBeGreaterThan(DERIV_NON_TRADING.size);
  });
  it('両テーブルとも有効期限内の日付しか持たない', () => {
    for (const d of [...DERIV_NON_TRADING, ...CASH_HOLIDAYS]) {
      expect(d <= HOLIDAY_TABLE_COVERED_THROUGH).toBe(true);
    }
  });
});

describe('休場日テーブルの有効期限(次に足すべき年の検出)', () => {
  // ★これが赤くなったら「テーブルに次の年を足せ」の合図。期限の HOLIDAY_TABLE_RENEW_LEAD_DAYS 日前から
  //   赤くなるので、年を越して無言で誤判定するより前に必ず気づく。
  //   直し方: core/session.ts の CASH_HOLIDAYS(祝日カレンダーを写す)と DERIV_NON_TRADING(JPX の
  //   祝日取引の告知を調べる)に次年分を足し、HOLIDAY_TABLE_COVERED_THROUGH を更新する。
  it(`現在時刻から ${HOLIDAY_TABLE_RENEW_LEAD_DAYS} 日先までテーブルが有効(切れたら年を足す)`, () => {
    expect(holidayTableNeedsRenewal(Date.now())).toBe(false);
  });

  it('期限の前後で切り替わる(判定ロジック自体の対照)', () => {
    expect(holidayTableNeedsRenewal(jst(2027, 12, 31, 10, 0), 0)).toBe(false);
    expect(holidayTableNeedsRenewal(jst(2028, 1, 4, 10, 0), 0)).toBe(true);
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
  it('false 休場日(元日=DERIV_NON_TRADING)', () => {
    expect(isMarketOpen(jst(2026, 1, 1, 12, 0))).toBe(false);
  });
  it('false セッション間(引け後の休憩帯)', () => {
    expect(isMarketOpen(jst(...MON, 16, 0))).toBe(false);   // Day 引け〜Night 開場の間
  });
});
