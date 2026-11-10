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

  // ★エバリュエーター指摘(v0.9.114 の欠陥): 立会外・寄りの猶予内まで「現在のセッションではない」と書いていた。
  //   **本当に収集が止まっているとき** だけ書き方を変える。それ以外は従来の1行と1バイトも変えない。
  it('引け後(立会外)は従来の1行のまま(引け後に直近セッションが残っているのは正常)', () => {
    const now = J(2026, 11, 10, 16, 0);
    expect(formatSessionOhlcLine(day1110, now, J(2026, 11, 10, 15, 44))).toBe(legacy(day1110));
    // 週末も同じ(金曜 Night が残っているのは正常)
    expect(formatSessionOhlcLine(night1106, J(2026, 11, 7, 12, 0), J(2026, 11, 7, 5, 59))).toBe(legacy(night1106));
  });

  it('★寄りの猶予内(17:00:00〜+3分): 前のセッションしか無くても・足がまだ無くても従来の1行のまま', () => {
    const lastBar = J(2026, 11, 10, 15, 44);
    for (const sec of [0, 0.3, 4.7, 30, 179]) {
      const now = J(2026, 11, 10, 17, 0) + sec * 1000;
      expect(formatSessionOhlcLine(day1110, now, lastBar, now - 2_000)).toBe(legacy(day1110));   // 心拍 2秒前=生きている
    }
  });

  it('★猶予を過ぎても新しい足が来ない(17:03:01・最後は 15:44 の Day)→ 収集停止として日付を明記する', () => {
    const line = formatSessionOhlcLine(day1110, J(2026, 11, 10, 17, 3) + 1000, J(2026, 11, 10, 15, 44));
    expect(line).toContain('■ 直近セッションの日経(2026-11-10 Day・現在のセッションではない)');
  });

  // ★エバリュエーター指摘(寄り・立会外の猶予の穴): asIs にするのは「最新セッションが直前に引けたセッションで、
  //   その末尾(引けの3分以内)まで足があるとき」だけ。それより古い(収集停止で残った)セッションは「本日」と書かない。
  it('★立会外のチャット: 数日前のセッション(11/6 Night)が残っている火曜 16:00 は「本日」と書かない', () => {
    const line = formatSessionOhlcLine(night1106, J(2026, 11, 10, 16, 0), J(2026, 11, 7, 5, 59));
    expect(line).not.toContain('本日');
    expect(line).toContain('■ 直近セッションの日経(2026-11-06 Night・現在のセッションではない)');
  });

  it('★立会外: 直前のセッションでも末尾まで足が無い(10:00 で止まった Day を 16:00 に読む)なら「本日」と書かない', () => {
    const line = formatSessionOhlcLine(day1110, J(2026, 11, 10, 16, 0), J(2026, 11, 10, 10, 0));
    expect(line).toContain('■ 直近セッションの日経(2026-11-10 Day・現在のセッションではない)');
  });

  it('★停止中の寄り: 17:00+3秒 に最新が朝の Night(11/9 Night・末尾 11/10 05:59)→ 直前の Day ではないので日付を明記', () => {
    const night1109 = { ...night1106, sessionDate: '2026-11-09' } as SessionOHLC;
    const line = formatSessionOhlcLine(night1109, J(2026, 11, 10, 17, 0) + 3_000, J(2026, 11, 10, 5, 59));
    expect(line).toContain('■ 直近セッションの日経(2026-11-09 Night・現在のセッションではない)');
  });

  it('★週明け: 月曜 08:45+3秒 に最新が金曜 Night(末尾 土 05:59)→ 健全な寄りなので従来の1行', () => {
    const now = J(2026, 11, 9, 8, 45) + 3_000;
    expect(formatSessionOhlcLine(night1106, now, J(2026, 11, 7, 5, 59), now - 2_000)).toBe(legacy(night1106));
  });

  // ★818A/819B の形: 寄りの猶予内でも collector の心拍が古い/読めないなら猶予を認めない。
  it('★寄りの猶予内でも心拍が 08:01 で止まっている/読めない → 日付を明記する', () => {
    const now = J(2026, 11, 10, 8, 45) + 1_400;
    const night1109 = { ...night1106, sessionDate: '2026-11-09' } as SessionOHLC;
    for (const hb of [J(2026, 11, 10, 8, 1) + 8_000, null]) {
      expect(formatSessionOhlcLine(night1109, now, J(2026, 11, 10, 5, 59), hb))
        .toContain('■ 直近セッションの日経(2026-11-09 Night・現在のセッションではない)');
    }
    // 心拍が新しければ従来の1行
    expect(formatSessionOhlcLine(night1109, now, J(2026, 11, 10, 5, 59), now - 2_000)).toBe(legacy(night1109));
  });

  it('立会外は心拍を見ない(引けた後に collector が死んでも、完結したセッションの値は正しい)', () => {
    expect(formatSessionOhlcLine(day1110, J(2026, 11, 10, 16, 0), J(2026, 11, 10, 15, 44), null)).toBe(legacy(day1110));
  });

  // ★本日高安の側も同じ趣旨: 心拍は新しいが、直前のセッションの最終足が引けより十分前(SESSION_BAR_STALE_MS=3分超)。
  it('★心拍は新しいが、直前の夜間の最終足が引けの4分前(05:56)→ 寄り+2秒でも日付を明記する', () => {
    const now = J(2026, 11, 10, 8, 45) + 2_000;
    const night1109 = { ...night1106, sessionDate: '2026-11-09' } as SessionOHLC;
    expect(formatSessionOhlcLine(night1109, now, J(2026, 11, 10, 5, 56), now - 2_000))
      .toContain('■ 直近セッションの日経(2026-11-09 Night・現在のセッションではない)');
    // 対照: 最終足が引けの3分前(05:57)なら猶予を認める(境界の内側)
    expect(formatSessionOhlcLine(night1109, now, J(2026, 11, 10, 5, 57), now - 2_000)).toBe(legacy(night1109));
  });
});
