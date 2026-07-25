import { describe, it, expect } from 'vitest';
import { shouldAutoRun, localDateStr, type AutoRunDecision } from './autoPublish.js';

// 「有効・creds有り・full・平日(火=2)・8時・本日未実行・スロットル外」の基準ケース。
const base: AutoRunDecision = {
  enabled: true, hasCreds: true, variant: 'full',
  weekday: 2, hour: 8, todayStr: '2026-07-14',
  lastDate: null, lastAttemptMs: 0, nowMs: 10_000_000_000,
};

describe('shouldAutoRun', () => {
  it('基準ケース(平日8時・未実行)は true', () => {
    expect(shouldAutoRun(base)).toBe(true);
  });

  it('無効(enabled=false)は false', () => {
    expect(shouldAutoRun({ ...base, enabled: false })).toBe(false);
  });

  it('creds 無しは false', () => {
    expect(shouldAutoRun({ ...base, hasCreds: false })).toBe(false);
  });

  it('lite variant は false(ハードゲート)', () => {
    expect(shouldAutoRun({ ...base, variant: 'lite' })).toBe(false);
  });

  it('週末(日=0 / 土=6)は false', () => {
    expect(shouldAutoRun({ ...base, weekday: 0 })).toBe(false);
    expect(shouldAutoRun({ ...base, weekday: 6 })).toBe(false);
  });

  it('月(1)〜金(5)は曜日ゲートを通過', () => {
    for (const wd of [1, 2, 3, 4, 5]) expect(shouldAutoRun({ ...base, weekday: wd })).toBe(true);
  });

  it('7時(8時前)は false', () => {
    expect(shouldAutoRun({ ...base, hour: 7 })).toBe(false);
  });

  it('本日実行済み(lastDate===todayStr)は false', () => {
    expect(shouldAutoRun({ ...base, lastDate: '2026-07-14' })).toBe(false);
  });

  it('別日 lastDate なら true(本日はまだ)', () => {
    expect(shouldAutoRun({ ...base, lastDate: '2026-07-13' })).toBe(true);
  });

  it('30分スロットル中(直近試行が29分前)は false', () => {
    expect(shouldAutoRun({ ...base, lastAttemptMs: base.nowMs - 29 * 60_000 })).toBe(false);
  });

  it('スロットル明け(31分前)は true', () => {
    expect(shouldAutoRun({ ...base, lastAttemptMs: base.nowMs - 31 * 60_000 })).toBe(true);
  });
});

describe('localDateStr', () => {
  it('ローカル YYYY-MM-DD を返す(ゼロ埋め)', () => {
    expect(localDateStr(new Date(2026, 0, 3, 9, 5))).toBe('2026-01-03');
    expect(localDateStr(new Date(2026, 11, 25, 0, 0))).toBe('2026-12-25');
  });
});
