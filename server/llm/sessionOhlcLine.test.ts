// 「■ 本日の日経」行が、本日でないセッションを「本日」と書かないこと(server/llm/dataTools.ts formatSessionOhlcLine)。
//
// ★実例(2026-11-10): collector が 10/28 に止まり bars_1m の最新が古いセッションのまま残った。
//   buildMonitorContext は直近1セッションを **無条件に「本日の日経」「現値」** と書いていたので、
//   11/10 に 11/6 Night の値を本日の現値として AI に渡していた。
// ★変更前の実装(常に `■ 本日の日経(${session}) … / 現値 …`)に戻すと、下の「本日ではない」2件が赤になる。
//   「立会中で足も新しい」ケースは従来の文字列と1バイトも変わらないことを固定する(取引系の旧経路も読む文字列)。

import { describe, it, expect } from 'vitest';
import { formatSessionOhlcLine, SESSION_BAR_STALE_MS } from './dataTools.js';
import type { SessionOHLC } from '../db/store.js';

const J = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 9, mi);
const hhmm = (t: number): string =>
  new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
/** 変更前の実装をそのまま写したもの(git show HEAD:server/llm/dataTools.ts の buildMonitorContext)。 */
const legacy = (s: SessionOHLC): string =>
  `■ 本日の日経(${s.session}): 高値 ${Math.round(s.high).toLocaleString('ja-JP')}(${hhmm(s.highT)}) / `
  + `安値 ${Math.round(s.low).toLocaleString('ja-JP')}(${hhmm(s.lowT)}) / 現値 ${Math.round(s.close).toLocaleString('ja-JP')}`;

// 2026-11-06(金) Night: 実時刻 11/06 17:00 〜 11/07 06:00 JST。
const night1106: SessionOHLC = {
  sessionDate: '2026-11-06', session: 'Night',
  open: 64_000, high: 64_500, low: 63_900, close: 64_395,
  highT: J(2026, 11, 6, 22, 10), lowT: J(2026, 11, 6, 18, 0), openT: J(2026, 11, 6, 17, 0),
};
// 2026-11-10(火) Day: 08:45 〜 15:45 JST。
const day1110: SessionOHLC = {
  sessionDate: '2026-11-10', session: 'Day',
  open: 61_000, high: 61_300, low: 60_900, close: 61_050,
  highT: J(2026, 11, 10, 9, 30), lowT: J(2026, 11, 10, 10, 0), openT: J(2026, 11, 10, 8, 45),
};

describe('formatSessionOhlcLine — 本日でないセッションを「本日」と書かない', () => {
  it('★実例: 11/10 の日中に 11/6 Night が最新 → 「本日」「現値」と書かず、セッション日付を明記する', () => {
    const now = J(2026, 11, 10, 11, 0);
    const lastBar = J(2026, 11, 7, 5, 59);
    const line = formatSessionOhlcLine(night1106, now, lastBar);
    expect(line).not.toContain('本日');
    expect(line).not.toContain('現値');
    expect(line).toContain('2026-11-06 Night');
    expect(line).toContain('終値 64,395');
    expect(line).toContain('最終足 11/07 05:59 JST');
    expect(line).not.toBe(legacy(night1106));
  });

  it('立会中のセッションだが足が古い(収集停止)→ 「現値」と書かず最終足の時刻を出す', () => {
    const now = J(2026, 11, 10, 14, 0);
    const lastBar = J(2026, 11, 10, 10, 0);
    const line = formatSessionOhlcLine(day1110, now, lastBar);
    expect(line).toContain('■ 本日の日経(Day)');
    expect(line).not.toContain('現値');
    expect(line).toContain('最終値 61,050(最終足 11/10 10:00 JST・以降の足なし)');
  });

  it('立会中で足も新しい → 従来の文字列と1バイトも変えない', () => {
    const now = J(2026, 11, 10, 11, 0);
    expect(formatSessionOhlcLine(day1110, now, now - 30_000)).toBe(legacy(day1110));
    expect(formatSessionOhlcLine(day1110, now, now - SESSION_BAR_STALE_MS)).toBe(legacy(day1110));
  });

  it('引け後(時間外)は当日の Day でも「現在のセッションではない」と書く(現値と誤読させない)', () => {
    const now = J(2026, 11, 10, 16, 0);
    const line = formatSessionOhlcLine(day1110, now, J(2026, 11, 10, 15, 44));
    expect(line).toContain('■ 直近セッションの日経(2026-11-10 Day・現在のセッションではない)');
    expect(line).not.toContain('現値');
  });
});
