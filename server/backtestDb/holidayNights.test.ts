import { describe, it, expect } from 'vitest';
import {
  findMisplacedNights, nightsWithoutDay, overlappingSessions, weekendOnlyPrevYmd, type SessionSpan,
} from './holidayNights.js';

// ─── バックテスト用DB の「祝日の前夜の夜間が祝日の夜に置かれている」不備の判定 ───
// 実データの形を写した小さな系列で確かめる(日付は実在の 2018 年の並び)。

const H = 3600_000;
const jstMs = (ymd: string, hh: number, mm = 0) => Date.parse(`${ymd}T00:00:00Z`) + (hh * 60 + mm) * 60_000 - 9 * H;
const day = (d: string): SessionSpan => ({ sessionDate: d, session: 'Day', startT: jstMs(d, 8, 45), endT: jstMs(d, 15, 15), bars: 391 });
const nextYmd = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
const night = (d: string): SessionSpan => ({ sessionDate: d, session: 'Night', startT: jstMs(d, 17), endT: jstMs(nextYmd(d), 5, 30), bars: 751 });

describe('weekendOnlyPrevYmd(旧 rowToBar の近似を再現)', () => {
  it('土日だけを飛ばし、祝日は飛ばさない', () => {
    expect(weekendOnlyPrevYmd('2018-01-09')).toBe('2018-01-08');   // 火 → 月(成人の日だが飛ばさない)
    expect(weekendOnlyPrevYmd('2018-01-08')).toBe('2018-01-05');   // 月 → 金
    expect(weekendOnlyPrevYmd('2018-01-04')).toBe('2018-01-03');
  });
});

describe('findMisplacedNights', () => {
  // 2018-01-05(金)Day の夜間が、2018-01-08(月・成人の日)の夜に置かれている実例の形
  const broken = [day('2018-01-04'), night('2018-01-04'), day('2018-01-05'), night('2018-01-08'), day('2018-01-09'), night('2018-01-09')];

  it('祝日の夜に置かれた夜間を、直前の Day の日付の夜へ戻す計画を出す', () => {
    const r = findMisplacedNights(broken);
    expect(r.problems).toEqual([]);
    expect(r.moves).toHaveLength(1);
    expect(r.moves[0]).toMatchObject({ fromDate: '2018-01-08', toDate: '2018-01-05', shiftDays: 3, shiftMs: 3 * 86400_000, nextDayDate: '2018-01-09', basis: 'prev-day' });
  });

  it('直した後の系列では 0 件(冪等)', () => {
    const fixed = broken.map(s => s.sessionDate === '2018-01-08'
      ? { ...s, sessionDate: '2018-01-05', startT: s.startT - 3 * 86400_000, endT: s.endT - 3 * 86400_000 } : s);
    const r = findMisplacedNights(fixed);
    expect(r).toEqual({ moves: [], problems: [] });
    expect(nightsWithoutDay(fixed)).toEqual([]);
    expect(overlappingSessions(fixed)).toEqual([]);
  });

  it('2022/9 以降の祝日取引(祝日に Day がある)は対象にしない', () => {
    const holidayTrading = [day('2023-09-15'), night('2023-09-15'), day('2023-09-18'), night('2023-09-18'), day('2023-09-19')];
    expect(findMisplacedNights(holidayTrading)).toEqual({ moves: [], problems: [] });
  });

  it('連休(GW)は何日でも直前の Day まで戻す', () => {
    // 2019: 4/26(金)Day の次が 5/7(火)。旧版は夜間を 5/6(月)に置いていた
    const r = findMisplacedNights([day('2019-04-25'), night('2019-04-25'), day('2019-04-26'), night('2019-05-06'), day('2019-05-07')]);
    expect(r.moves.map(m => [m.fromDate, m.toDate, m.shiftDays])).toEqual([['2019-05-06', '2019-04-26', 10]]);
  });

  it('旧 rowToBar の誤りで説明できない夜間は動かさず problems に積む(呼ぶ側は全体を中止)', () => {
    // 次の Day 1/11 の「土日だけ前営業日」は 1/10 で、夜間の日付 1/9 と合わない(= 日中の欠落など別の原因)
    const r = findMisplacedNights([day('2018-01-08'), night('2018-01-09'), day('2018-01-11')]);
    expect(r.moves).toEqual([]);
    expect(r.problems).toHaveLength(1);
  });

  // ★以下の安全条件は、それぞれ単独で突く(他の条件で偶然止まると、条件を消しても緑のままになる)。
  //   problems の文言まで確かめる = 中止したときログに出る「理由」が正しいことを守る。

  it('直前のセッションが夜間なら、理由「直前のセッションが Day でない」で止める', () => {
    const r = findMisplacedNights([day('2018-01-05'), night('2018-01-05'), night('2018-01-08'), day('2018-01-09')]);
    expect(r.moves).toEqual([]);
    expect(r.problems).toEqual([expect.stringContaining('直前のセッションが Day でない')]);
  });

  it('直前のセッションの session が Day/Night 以外(NULL 等)でも止める(既存夜間の照合では捕まらない)', () => {
    // session 列は NULL を許す。直前が不明なセッションなら、その日付は夜間の集合に無いので
    // 「直前が Day か」を見ないと、正体不明の行の日付へ夜間を動かしてしまう。
    const odd: SessionSpan = { ...day('2018-01-05'), session: null as unknown as string };
    const r = findMisplacedNights([day('2018-01-04'), night('2018-01-04'), odd, night('2018-01-08'), day('2018-01-09')]);
    expect(r.moves).toEqual([]);
    expect(r.problems).toEqual([expect.stringContaining('直前のセッションが Day でない')]);
  });

  it('移動先の日付の夜間が別の位置にあれば、理由「既に夜間がある」で止める(prev-day 経路)', () => {
    // 2018-01-05 の夜間が、時刻の異常で 01-09 の日中より後ろにある。直前は Day 01-05 なので
    // 「直前が Day か」は通る。既存夜間の照合だけがこれを止める。
    const stray: SessionSpan = { ...night('2018-01-05'), startT: jstMs('2018-01-10', 17), endT: jstMs('2018-01-11', 5, 30) };
    const r = findMisplacedNights([day('2018-01-05'), night('2018-01-08'), day('2018-01-09'), stray]);
    expect(r.moves).toEqual([]);
    expect(r.problems).toEqual([expect.stringContaining('2018-01-05 に既に夜間がある')]);
  });

  it('headTargets の日付に既に夜間があれば止める(head-target 経路)', () => {
    const stray: SessionSpan = { ...night('2017-12-29'), startT: jstMs('2018-01-05', 17), endT: jstMs('2018-01-06', 5, 30) };
    const r = findMisplacedNights([night('2018-01-03'), day('2018-01-04'), stray], { '2018-01-03': '2017-12-29' });
    expect(r.moves).toEqual([]);
    // stray 自身も「日中なし夜間」として別の理由(次が Day でない)で problems に入る。先頭の理由を確かめる
    expect(r.problems).toEqual(expect.arrayContaining([expect.stringContaining('2018-01-03 Night: 移動先 2017-12-29 に既に夜間がある')]));
  });

  it('headTargets の設定ミス(後ろの日付・土日)は止める', () => {
    const head = [night('2018-01-03'), day('2018-01-04')];
    // (移動先=自分の日付 は「修復済み」として読み飛ばす仕様なので、後ろの日付で試す)
    expect(findMisplacedNights(head, { '2018-01-03': '2018-01-05' }).problems).toEqual([expect.stringContaining('前ではない')]);
    expect(findMisplacedNights(head, { '2018-01-03': '2017-12-30' }).problems).toEqual([expect.stringContaining('土日')]);
  });

  it('先頭の夜間は headTargets が無ければ動かさない。あれば動かし、動かした後は 0 件', () => {
    const headBroken = [night('2018-01-03'), day('2018-01-04'), night('2018-01-04')];
    expect(findMisplacedNights(headBroken).moves).toEqual([]);
    expect(findMisplacedNights(headBroken).problems).toHaveLength(1);
    const HT = { '2018-01-03': '2017-12-29' };
    const r = findMisplacedNights(headBroken, HT);
    expect(r.problems).toEqual([]);
    expect(r.moves[0]).toMatchObject({ fromDate: '2018-01-03', toDate: '2017-12-29', shiftDays: 5, basis: 'head-target' });
    const fixed = [{ ...headBroken[0]!, sessionDate: '2017-12-29', startT: headBroken[0]!.startT - 5 * 86400_000, endT: headBroken[0]!.endT - 5 * 86400_000 }, ...headBroken.slice(1)];
    expect(findMisplacedNights(fixed, HT)).toEqual({ moves: [], problems: [] });
    // 先頭は日中がデータの外にあるだけ: 整合チェック(excludeFirst)では数えない
    expect(nightsWithoutDay(fixed)).toHaveLength(1);
    expect(nightsWithoutDay(fixed, { excludeFirst: true })).toEqual([]);
  });

  it('入力の並び順に依存しない', () => {
    expect(findMisplacedNights([...broken].reverse()).moves.map(m => m.fromDate)).toEqual(['2018-01-08']);
  });
});

describe('overlappingSessions', () => {
  it('時間が重なる組を返す', () => {
    const a = night('2018-01-05');
    const b = { ...day('2018-01-06'), startT: a.endT };   // 終了と同じ分に開始 = 重なり
    expect(overlappingSessions([a, b])).toHaveLength(1);
  });
});
