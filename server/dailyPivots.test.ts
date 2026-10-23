import { describe, it, expect } from 'vitest';
import {
  buildTradingDays, buildWeeks, findTfPivots, computeDailyPivots, dailyPivotLabel,
  latestConfirmedTradingDate, buildDailyPivotCache, updateDailyPivotCache, dailyPivotsOf,
  WEEKLY_PIVOT_SPAN, type PivotSrcBar, type DailyPivot,
} from './dailyPivots.js';
import { classifySession } from '../core/session.js';

// JST 壁時計 'YYYY-MM-DD HH:MM' → epoch ms
const jst = (s: string): number => {
  const [d, hm] = s.split(' ');
  const [y, m, dd] = d!.split('-').map(Number);
  const [hh, mm] = hm!.split(':').map(Number);
  return Date.UTC(y!, m! - 1, dd!, hh!, mm!) - 9 * 3600_000;
};
// 4番目の引数(終値)は読みやすさのためだけ(役割判定は日足の h/l で行うので使わない)。
const b = (s: string, l: number, h: number, _c?: number): PivotSrcBar => ({ t: jst(s), l, h });

/** start(含む)から取引のある平日を n 日ぶん(Day セッションの有無は classifySession で判定)。 */
function tradingDates(start: string, n: number): string[] {
  const out: string[] = [];
  let t = jst(`${start} 10:00`);
  while (out.length < n) {
    const s = classifySession(t);
    if (s?.session === 'Day') out.push(s.sessionDate);
    t += 86_400_000;
  }
  return out;
}
/** 各取引日の 10:00 に1本だけ(日足の高安 = その1本の高安)。 */
const dayBars = (dates: string[], lows: number[], highs?: number[]): PivotSrcBar[] =>
  dates.map((d, i) => b(`${d} 10:00`, lows[i]!, highs ? highs[i]! : lows[i]! + 100));

describe('buildTradingDays(取引日 = 前の夜間 + 当日日中)', () => {
  it('夜間セッションは翌取引日の日足に入る(ラベルは Day の sessionDate)', () => {
    const bars = [
      b('2026-10-05 10:00', 60000, 60100),   // 月 Day
      b('2026-10-05 20:00', 59000, 59100),   // 月 夜間 → 火の日足へ
      b('2026-10-06 03:00', 59500, 61000),   // 月 夜間(翌朝)→ 火の日足へ
      b('2026-10-06 10:00', 60200, 60300),   // 火 Day
    ];
    const days = buildTradingDays(bars, jst('2026-10-07 08:00'));
    expect(days.map(d => d.date)).toEqual(['2026-10-05', '2026-10-06']);
    expect(days[0]).toMatchObject({ l: 60000, h: 60100, confirmed: true });
    expect(days[1]).toMatchObject({ l: 59000, h: 61000, confirmed: true });
  });

  it('金曜夜間(土曜早朝含む)は翌月曜の日足に入る', () => {
    const bars = [
      b('2026-10-09 10:00', 60000, 60100),   // 金 Day
      b('2026-10-09 22:00', 58000, 58100),   // 金 夜間
      b('2026-10-10 05:30', 58500, 62000),   // 土 早朝(= 金 夜間の続き)
      b('2026-10-12 10:00', 60200, 60300),   // 月 Day(スポーツの日だが先物は取引あり)
    ];
    const days = buildTradingDays(bars, jst('2026-10-13 08:00'));
    expect(days.map(d => d.date)).toEqual(['2026-10-09', '2026-10-12']);
    expect(days[1]).toMatchObject({ l: 58000, h: 62000 });
  });

  it('休場日(classifySession=null)の足は無視し、その前の夜間は次の取引日へ', () => {
    const bars = [
      b('2026-11-20 10:00', 60000, 60100),   // 金 Day
      b('2026-11-20 22:00', 59000, 59100),   // 金 夜間
      b('2026-11-23 10:00', 1, 99999),       // 月 = 先物休場(BCP テスト)→ 無視
      b('2026-11-23 20:00', 1, 99999),       // 月 夜間も休場 → 無視
      b('2026-11-24 10:00', 60200, 60300),   // 火 Day
    ];
    const days = buildTradingDays(bars, jst('2026-11-25 08:00'));
    expect(days.map(d => d.date)).toEqual(['2026-11-20', '2026-11-24']);
    expect(days[1]).toMatchObject({ l: 59000, h: 60300 });
  });

  it('最後の Day より後の夜間は進行中の取引日 = 日足を作らない。進行中の Day は未確定', () => {
    const bars = [
      b('2026-10-05 10:00', 60000, 60100),
      b('2026-10-05 20:00', 59000, 59100),   // 末尾の夜間(進行中の取引日)
    ];
    expect(buildTradingDays(bars, jst('2026-10-05 21:00')).map(d => d.date)).toEqual(['2026-10-05']);
    // 日中の途中(15:45 前)は進行中 = 未確定
    const mid = buildTradingDays([b('2026-10-05 10:00', 60000, 60100)], jst('2026-10-05 11:00'));
    expect(mid[0]!.confirmed).toBe(false);
    const after = buildTradingDays([b('2026-10-05 10:00', 60000, 60100)], jst('2026-10-05 15:45'));
    expect(after[0]!.confirmed).toBe(true);
  });

  it('週足は Day の sessionDate の週(月曜始まり)でまとめ、キーは月曜日', () => {
    const dates = tradingDates('2026-10-05', 7);   // 10/5〜10/9, 10/12, 10/13
    const days = buildTradingDays(dayBars(dates, [1, 2, 3, 4, 5, 6, 7].map(x => 60000 + x)), jst('2026-10-13 16:00'));
    const weeks = buildWeeks(days, jst('2026-10-13 16:00'));
    expect(weeks.map(w => w.date)).toEqual(['2026-10-05', '2026-10-12']);
    expect(weeks[0]).toMatchObject({ l: 60001, confirmed: true });
    expect(weeks[1]).toMatchObject({ l: 60006, confirmed: false });   // 金曜の引け前 = 進行中の週
  });
});

describe('日足ピボット = さかのぼり方式(高値/安値の階段)', () => {
  // ユーザー例: h[5] > h[4] > h[2] > h[0] >= 現値(h[1], h[3] は飛ばす) / 現値 >= l[0] > l[1] > l[3]。
  // ★h[0]/l[0](当日)は階段の起点としてだけ使い、出力には含めない。
  //   n:    5      4      3      2      1      0(当日)
  //   h: 61000  60800  60500  60600  60300  60400
  //   l: 60020  60050  60000  60150  60100  60200   現値 60350
  const dates = tradingDates('2026-09-01', 6);   // dates[0] = n5 … dates[5] = 当日(n0)
  const H = [61000, 60800, 60500, 60600, 60300];
  const L = [60020, 60050, 60000, 60150, 60100];
  const now = jst(`${dates[5]} 12:00`);
  const bars = [...dayBars(dates.slice(0, 5), L, H), b(`${dates[5]} 10:00`, 60200, 60400)];
  const unflipped = (ps: DailyPivot[], type: 'high' | 'low') =>
    ps.filter(p => p.tf === 'D' && p.type === type && !p.flipped).map(p => [p.price, p.date]).sort((a, c) => Number(c[0]) - Number(a[0]));

  it('ユーザー例(高値列): h[5] > h[4] > h[2](> h[0] は起点で出さない)。h[1], h[3] は列に入らない', () => {
    const ps = computeDailyPivots(bars, 60350, now);
    expect(unflipped(ps, 'high')).toEqual([[61000, dates[0]], [60800, dates[1]], [60600, dates[3]]]);
    // h[1]=60300 は当日の高値 60400 に超えられた → 「超え→支持」で残る(当日反転=当日中は削除しない)。
    expect(ps.find(p => p.tf === 'D' && p.price === 60300)).toMatchObject({ type: 'high', role: 'support', flipped: true, flippedToday: true });
    // h[3]=60500 は h[2] の日に超えられ(反転)、翌取引日(n1)の安値 60100 < 60500 で戻された → 削除。
    expect(ps.find(p => p.tf === 'D' && p.price === 60500)).toBeUndefined();
  });

  it('ユーザー例(安値列): (l[0] は起点で出さない)> l[1] > l[3]。l[2], l[4], l[5] は反転後に戻されて消える', () => {
    const ps = computeDailyPivots(bars, 60350, now);
    expect(unflipped(ps, 'low')).toEqual([[60100, dates[4]], [60000, dates[2]]]);
    expect(ps.filter(p => p.tf === 'D' && p.type === 'low' && p.flipped)).toEqual([]);
  });

  it('同値は採用しない: 後の日に同じ高値が付いたら古い方は外れ、新しい日が列に残る', () => {
    const d = tradingDates('2026-09-01', 4);
    const ps = computeDailyPivots([...dayBars(d.slice(0, 3), [59000, 59000, 59000], [61000, 60600, 60600]), b(`${d[3]} 10:00`, 59500, 60000)], 59800, jst(`${d[3]} 12:00`));
    const at = ps.filter(p => p.tf === 'D' && p.type === 'high' && p.price === 60600);
    expect(at.map(p => p.date)).toEqual([d[2]]);   // 1行だけ・新しい日
    // 安値も同値: 3日とも 59000 → 最新の日だけ
    expect(ps.filter(p => p.tf === 'D' && p.type === 'low' && p.price === 59000).map(p => p.date)).toEqual([d[2]]);
  });

  it('当日の現値で h[0] が更新されると列が変わる(超えられた要素は当日反転=支持)', () => {
    const cache = buildDailyPivotCache(bars, now);
    const c1 = updateDailyPivotCache(cache, 60650, now + 60_000);   // 当日高値 60400 → 60650
    const ps = dailyPivotsOf(c1);
    expect(unflipped(ps, 'high')).toEqual([[61000, dates[0]], [60800, dates[1]]]);   // 60650(当日)は起点で出さない
    expect(ps.find(p => p.tf === 'D' && p.price === 60600)).toMatchObject({ role: 'support', flipped: true, flippedToday: true });
    // 入力は書き換えない(純関数)
    expect(unflipped(dailyPivotsOf(cache), 'high').map(x => x[0])).toEqual([61000, 60800, 60600]);
  });

  it('★出力に当日(todayDate)の要素は含まれない(dailyPivotsOf / computeDailyPivots とも)', () => {
    const cache = buildDailyPivotCache(bars, now);
    expect(cache.todayDate).toBe(dates[5]);
    expect(cache.todayHi).toBe(60400);
    expect(cache.todayLo).toBe(60200);
    expect(dailyPivotsOf(cache).filter(p => p.date === cache.todayDate)).toEqual([]);
    const c1 = updateDailyPivotCache(cache, 60650, now + 60_000);
    expect(dailyPivotsOf(c1).filter(p => p.date === c1.todayDate)).toEqual([]);
    expect(computeDailyPivots(bars, 60350, now).filter(p => p.date === dates[5])).toEqual([]);
    // 価格としても当日高安は出ない
    const prices = dailyPivotsOf(c1).filter(p => p.tf === 'D').map(p => p.price);
    expect(prices).not.toContain(60650);
    expect(prices).not.toContain(60200);
  });

  it('★現値が下げ続けても、日足ピボットの集合に当日安値は入らない(新安値ごとに水準が増えない)', () => {
    let c = updateDailyPivotCache(buildDailyPivotCache(bars, now), 60350, now);
    const before = dailyPivotsOf(c).map(p => `${p.tf}|${p.type}|${p.date}|${p.price}`);
    for (let k = 1; k <= 30; k++) {
      const px = 60200 - k * 10;   // 60190 → 59900(当日安値を刻み続ける)
      c = updateDailyPivotCache(c, px, now + k * 60_000);
      expect(c.todayLo).toBe(px);
      const ps = dailyPivotsOf(c);
      expect(ps.some(p => p.price === c.todayLo)).toBe(false);
      expect(ps.some(p => p.date === c.todayDate)).toBe(false);
      // 集合は「既存要素の反転(割れ→抵抗)/削除」だけで変わり、新しい要素は増えない
      for (const p of ps) expect(before).toContain(`${p.tf}|${p.type}|${p.date}|${p.price}`);
    }
    // 下げで割れた l[1]=60100 / l[3]=60000 は当日反転(割れ→抵抗)で残る(起点としての役割は保たれる)
    const ps = dailyPivotsOf(c);
    expect(ps.find(p => p.tf === 'D' && p.type === 'low' && p.price === 60100)).toMatchObject({ role: 'resistance', flipped: true, flippedToday: true });
    expect(ps.find(p => p.tf === 'D' && p.type === 'low' && p.price === 60000)).toMatchObject({ role: 'resistance', flipped: true, flippedToday: true });
  });

  it('★チェーン起点の役割は保たれる: 当日高 > h[1] なら h[1] は列から外れ(超え→支持)、当日高 < h[1] なら h[1] が列に残る', () => {
    // 当日高 60400 > h[1]=60300 → h[1] は未反転の列に居ない(当日反転)
    const above = computeDailyPivots(bars, 60350, now);
    expect(unflipped(above, 'high').map(x => x[0])).not.toContain(60300);
    expect(above.find(p => p.tf === 'D' && p.price === 60300)).toMatchObject({ flipped: true, role: 'support' });
    // 当日高が h[1] 未満なら h[1] が列の先頭(出力される最も新しい要素)
    const lowDay = [...dayBars(dates.slice(0, 5), L, H), b(`${dates[5]} 10:00`, 60150, 60250)];
    const below = computeDailyPivots(lowDay, 60200, now);
    expect(unflipped(below, 'high')).toEqual([[61000, dates[0]], [60800, dates[1]], [60600, dates[3]], [60300, dates[4]]]);
    // 当日高が h[1] と同値なら、h[1] は列から外れる(列は当日=起点へ引き継がれ、当日は出さない)
    const tieDay = [...dayBars(dates.slice(0, 5), L, H), b(`${dates[5]} 10:00`, 60150, 60300)];
    const tie = computeDailyPivots(tieDay, 60200, now);
    expect(tie.find(p => p.tf === 'D' && p.type === 'high' && p.price === 60300)).toBeUndefined();
  });
});

describe('findTfPivots(週足: 前後 N 本の厳密な最安/最高)', () => {
  it(`週足は前後${WEEKLY_PIVOT_SPAN}本(確定週のみ)`, () => {
    // 5週(各5取引日)。3週目に最安。
    const dates = tradingDates('2026-08-31', 25);
    const lowsW = dates.map((_, i) => 60000 + (Math.floor(i / 5) === 2 ? (i === 12 ? 0 : 50) : 500 - Math.floor(i / 5) * 10));
    const now = jst(`${dates.at(-1)} 16:00`);
    const weeks = buildWeeks(buildTradingDays(dayBars(dates, lowsW), now), now);
    expect(weeks.length).toBe(5);
    const p = findTfPivots(weeks, WEEKLY_PIVOT_SPAN).filter(x => x.type === 'low');
    expect(p.map(x => weeks[x.i]!.date)).toEqual(['2026-09-14']);
  });

  it('右側の週が未確定(金曜の引け前)なら出ない', () => {
    const dates = tradingDates('2026-08-31', 25);
    const lowsW = dates.map((_, i) => 60000 + (Math.floor(i / 5) === 2 ? (i === 12 ? 0 : 50) : 500 - Math.floor(i / 5) * 10));
    const now = jst(`${dates.at(-1)} 11:00`);
    const weeks = buildWeeks(buildTradingDays(dayBars(dates, lowsW), now), now);
    expect(findTfPivots(weeks, WEEKLY_PIVOT_SPAN).filter(x => x.type === 'low')).toEqual([]);
  });

  it('窓内に同値があれば(厳密不等号)どちらもピボットにしない', () => {
    const dates = tradingDates('2026-08-31', 25);
    // 2週目と3週目の最安が同値
    const lowsW = dates.map((_, i) => 60000 + (i === 7 || i === 12 ? 0 : 500));
    const now = jst(`${dates.at(-1)} 16:00`);
    const weeks = buildWeeks(buildTradingDays(dayBars(dates, lowsW), now), now);
    expect(findTfPivots(weeks, WEEKLY_PIVOT_SPAN).filter(x => x.type === 'low')).toEqual([]);
  });
});

describe('日足ピボットの役割と寿命(超え/割れ→反転→削除・同日規則)', () => {
  // 9/1 起点11取引日、index5 に安値 60000(以後の安値はすべて上 = 安値列の要素)。
  const lows = [60500, 60400, 60300, 60200, 60100, 60000, 60150, 60200, 60250, 60300, 60350];
  const dates = tradingDates('2026-09-01', lows.length + 3);
  const base = dayBars(dates.slice(0, lows.length), lows, lows.map(x => x + 200));
  const pivotDate = dates[5]!;
  const later = (i: number, time: string) => `${dates[lows.length + i]} ${time}`;
  const findD = (ps: DailyPivot[]) => ps.find(p => p.tf === 'D' && p.type === 'low' && p.price === 60000);

  it('未割れの間は支持として残る', () => {
    const now = jst(later(0, '12:00'));
    const p = findD(computeDailyPivots([...base, b(later(0, '10:00'), 60050, 60300)], 60100, now));
    expect(p).toMatchObject({ role: 'support', flipped: false, date: pivotDate });
  });

  it('初めて割れたら「割れ→抵抗」に反転して残る', () => {
    const now = jst(later(0, '12:00'));
    const p = findD(computeDailyPivots([...base, b(later(0, '10:00'), 59900, 60050), b(later(0, '10:01'), 59850, 59990)], 59900, now));
    expect(p).toMatchObject({ role: 'resistance', flipped: true });
  });

  it('反転後(翌取引日以降)に超えたら削除される', () => {
    const now = jst(later(1, '12:00'));
    const ps = computeDailyPivots([
      ...base,
      b(later(0, '10:00'), 59900, 59990),   // 割れ
      b(later(1, '10:00'), 59950, 60010),   // 翌取引日に 60000 超え → 削除
    ], 60005, now);
    expect(findD(ps)).toBeUndefined();
  });

  it('★同じ取引日に割れて戻しても、その日は「反転」まで(削除の判定は翌取引日から)', () => {
    // 確定日足: later(0) に 59,900 まで割って 60,050 まで戻した → 反転で残る。
    const now1 = jst(later(1, '09:00'));
    const p1 = findD(computeDailyPivots([...base, b(later(0, '10:00'), 59900, 59950), b(later(0, '11:00'), 59950, 60050)], 59990, now1));
    expect(p1).toMatchObject({ role: 'resistance', flipped: true, flippedToday: false });
    // 進行中の取引日でも同じ: 当日に割れて戻した → 反転(flippedToday)で残る。
    const now0 = jst(later(0, '12:00'));
    const p0 = findD(computeDailyPivots([...base, b(later(0, '10:00'), 59900, 59950), b(later(0, '11:00'), 59950, 60050)], 60020, now0));
    expect(p0).toMatchObject({ role: 'resistance', flipped: true, flippedToday: true });
    // 翌取引日に 60,000 を超えたら削除。
    const now2 = jst(later(1, '12:00'));
    const p2 = computeDailyPivots([...base, b(later(0, '10:00'), 59900, 60050), b(later(1, '10:00'), 59950, 60010)], 60005, now2);
    expect(findD(p2)).toBeUndefined();
  });

  it('1分足は割れていなくても、現値だけで割れたら反転を反映する', () => {
    const now = jst(later(0, '12:00'));
    const ps = computeDailyPivots([...base, b(later(0, '10:00'), 60050, 60300)], 59990, now);
    expect(findD(ps)).toMatchObject({ role: 'resistance', flipped: true });
  });

  it('updateDailyPivotCache: 再計算の間の現値で反転が即時に反映される(当日の反転は当日中は削除しない)', () => {
    const now = jst(later(0, '12:00'));
    const cache = updateDailyPivotCache(buildDailyPivotCache([...base, b(later(0, '10:00'), 60050, 60300)], now), 60100, now);
    expect(findD(dailyPivotsOf(cache))?.role).toBe('support');
    const flipped = updateDailyPivotCache(cache, 59990, now + 60_000);
    expect(findD(dailyPivotsOf(flipped))).toMatchObject({ role: 'resistance', flipped: true, flippedToday: true });
    expect(findD(dailyPivotsOf(updateDailyPivotCache(flipped, 60010, now + 120_000)))).toMatchObject({ role: 'resistance' });   // 同じ日は反転まで
    expect(findD(dailyPivotsOf(cache))?.role).toBe('support');   // 入力は書き換えない(純関数)
  });

  it('updateDailyPivotCache: 当日の途中で同値に並んでも、その後に超えれば「超え→支持」(日足からの再計算と一致)', () => {
    const highs = [60500, 60600, 60700, 60800, 60900, 61000, 60850, 60800, 60750, 60700, 60650];
    const hb = dayBars(dates.slice(0, highs.length), highs.map(x => x - 200), highs);
    const findH = (ps: DailyPivot[]) => ps.find(p => p.tf === 'D' && p.type === 'high' && p.price === 61000 && p.date === dates[5]);
    const now = jst(later(0, '12:00'));
    const c0 = buildDailyPivotCache([...hb, b(later(0, '10:00'), 60500, 60600)], now);
    const tie = updateDailyPivotCache(c0, 61000, now);                 // 当日高値が 61,000 に並ぶ → 列は当日へ(元の日は外れる)
    expect(findH(dailyPivotsOf(tie))).toBeUndefined();
    const over = updateDailyPivotCache(tie, 61010, now + 60_000);      // その後 超えた → 超え→支持(当日反転)
    expect(findH(dailyPivotsOf(over))).toMatchObject({ role: 'support', flipped: true, flippedToday: true });
    // 翌日に日足から再計算した結論と同じ
    const recomputed = computeDailyPivots([...hb, b(later(0, '10:00'), 60500, 61010)], 61050, jst(later(1, '09:00')));
    expect(findH(recomputed)).toMatchObject({ role: 'support', flipped: true });
  });

  it('updateDailyPivotCache: 前の取引日までに反転していたものは、現値で戻したら即削除', () => {
    const now = jst(later(1, '12:00'));
    const cache = buildDailyPivotCache([...base, b(later(0, '10:00'), 59900, 59990), b(later(1, '10:00'), 59900, 59980)], now);
    expect(findD(dailyPivotsOf(cache))).toMatchObject({ role: 'resistance', flippedToday: false });
    expect(findD(dailyPivotsOf(updateDailyPivotCache(cache, 60010, now)))).toBeUndefined();
  });

  it('高値は対称: 超えたら「超え→支持」、翌取引日以降に割れたら削除', () => {
    const highs = [60500, 60600, 60700, 60800, 60900, 61000, 60850, 60800, 60750, 60700, 60650];
    const hb = dayBars(dates.slice(0, highs.length), highs.map(x => x - 200), highs);
    const findH = (ps: DailyPivot[]) => ps.find(p => p.tf === 'D' && p.type === 'high' && p.price === 61000);
    const now = jst(later(1, '12:00'));
    const up = computeDailyPivots([...hb, b(later(0, '10:00'), 60900, 61050)], 61040, now);
    expect(findH(up)).toMatchObject({ role: 'support', flipped: true });
    expect(dailyPivotLabel(findH(up)!)).toBe(`日足高値(${Number(dates[5]!.slice(5, 7))}/${Number(dates[5]!.slice(8))})超え→支持`);
    const gone = computeDailyPivots([...hb, b(later(0, '10:00'), 60900, 61050), b(later(1, '10:00'), 60950, 61020)], 60960, now);
    expect(findH(gone)).toBeUndefined();
  });

  it('入力が昇順でなくても / now より先の足が混ざっていても、整った入力と同じ結果(絞り込みは1回)', () => {
    const now = jst(later(1, '12:00'));
    const clean = [...base, b(later(0, '10:00'), 59900, 59990), b(later(1, '10:00'), 59900, 59980)];
    const expected = computeDailyPivots(clean, 59950, now);
    const messy = [...clean].reverse().concat([b(later(2, '10:00'), 1, 99999)]);   // 逆順 + 未来の足
    expect(computeDailyPivots(messy, 59950, now)).toEqual(expected);
    expect(buildTradingDays(messy, now)).toEqual(buildTradingDays(clean, now));
    expect(findD(expected)).toMatchObject({ role: 'resistance' });
  });

  it('latestConfirmedTradingDate: 日中の引け(15:45)を過ぎた最後の取引日。週末/休場日は飛ばす', () => {
    expect(latestConfirmedTradingDate(jst('2026-10-15 15:44'))).toBe('2026-10-14');
    expect(latestConfirmedTradingDate(jst('2026-10-15 15:45'))).toBe('2026-10-15');
    expect(latestConfirmedTradingDate(jst('2026-10-17 12:00'))).toBe('2026-10-16');   // 土曜
    expect(latestConfirmedTradingDate(jst('2026-11-23 20:00'))).toBe('2026-11-20');   // 先物休場の月曜
  });

  it('進行中の取引日(todayDate)は夜間なら翌取引日。当日の h[0]/l[0] は出力に含めない', () => {
    // 金曜 10/9 の引け後・夜間 22:00 → 進行中の取引日は 10/12(月)
    const bars = [b('2026-10-09 10:00', 60000, 60100), b('2026-10-09 22:00', 60050, 60080)];
    const now = jst('2026-10-09 22:01');
    const cache = buildDailyPivotCache(bars, now);
    expect(cache).toMatchObject({ todayDate: '2026-10-12', todayHi: 60080, todayLo: 60050 });
    const ps = computeDailyPivots(bars, 60060, now);
    expect(ps.filter(p => p.date === '2026-10-12')).toEqual([]);
    // 確定日 10/9 の高安(当日の起点 60080/60050 より外側)は列に残る
    expect(ps.filter(p => p.tf === 'D').map(p => [p.type, p.price, p.date])).toEqual([['high', 60100, '2026-10-09'], ['low', 60000, '2026-10-09']]);
  });

  it('ラベル: ★は付けない(★は強さ欄=tier の役目)。週足は週の月曜日', () => {
    const d: DailyPivot = { price: 62530, tf: 'D', type: 'low', date: '2026-09-14', role: 'support', flipped: false, t: 0 };
    expect(dailyPivotLabel(d)).toBe('日足安値(9/14)');
    expect(dailyPivotLabel({ ...d, role: 'resistance', flipped: true })).toBe('日足安値(9/14)割れ→抵抗');
    expect(dailyPivotLabel({ ...d, tf: 'W' })).toBe('週足安値(9/14週)');
    expect(dailyPivotLabel({ ...d, tf: 'W', type: 'high', role: 'support', flipped: true })).toBe('週足高値(9/14週)超え→支持');
  });
});
