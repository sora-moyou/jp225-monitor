import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ★B1: 従属停止は「セッション単位」ではなく「時限」 ────────────────────────────
//
// 何を守っているか(実測に基づく):
//   旧実装は default プールが429を1回踏んだ瞬間に **そのセッションの残り全部** を止めていた。
//   実取引PCのログ(4日・20,585行)では、完全な8セッションすべてで開始 0〜70分以内に初回429が来て、
//   セッションの 91〜100% が停止していた。設計 約600提案/取引日 に対し実際に取れたのは数十件。
//   しかもその429で A は困っていない(gemini 429 → groq 429 → openai 成功 が典型)。
//   → 停止は **A が実際に入れたポーズと同じ長さ** に限る。危険が続くのは A のポーズの間だけ。
//
// ★A を守る目的は弱めない: 深いラダー(最大8時間)を踏めば停止も8時間になる。下でそれを固定する。
//
// ★否定対照(修正前 = git show HEAD:server/llm/generatorGate.ts):
//   haltedSessionKey にセッションキーを立てるだけの実装なので、
//   「ポーズが明けたら自動で再開する」「深いポーズでは長く止まる」が **赤** になる
//   (明けるのは次のセッション境界だけなので、時間を進めても止まったまま)。

const h = vi.hoisted(() => ({ budget: 100 }));
vi.mock('../configStore.js', () => ({ resolveGeneratorDailyBudget: () => h.budget }));

import {
  checkGeneratorGate, notifyDefaultQuota, generatorGateSnapshot, generatorHaltRemainingMs,
  resetGeneratorGateForTest, DEFAULT_HALT_MS,
} from './generatorGate.js';

const jst = (y: number, mo: number, d: number, hh: number, mm = 0) => Date.UTC(y, mo - 1, d, hh - 9, mm);
const T = jst(2026, 6, 1, 10, 0);            // 2026-06-01 Day(取引時間内)
const SESSION_END = jst(2026, 6, 1, 15, 30); // 同じ Day セッションの終盤

function reason(now: number): string | true {
  const r = checkGeneratorGate(now);
  return r.allowed ? true : r.reason;
}

describe('★従属停止は時限(浅い429でセッションを丸ごと捨てない)', () => {
  beforeEach(() => {
    h.budget = 100;
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => { /* 静かに */ });
    vi.spyOn(console, 'log').mockImplementation(() => { /* 静かに */ });
  });

  it('A のポーズが 60秒 なら 60秒だけ止まり、明けたら **同じセッションのまま** 再開する', () => {
    notifyDefaultQuota('gemini', T, 60_000);
    expect(reason(T)).toBe('default-quota');
    expect(reason(T + 59_000)).toBe('default-quota');
    // ★ここが旧実装との分かれ目: セッションは変わっていないのに再開する。
    expect(reason(T + 60_000)).toBe(true);
    expect(generatorGateSnapshot(T + 60_000).haltedSessionKey).toBeNull();
  });

  it('★セッションの残りを捨てない: 60秒の停止のあと、同じセッションの終盤まで通り続ける', () => {
    notifyDefaultQuota('gemini', T, 60_000);
    expect(reason(T)).toBe('default-quota');
    for (const t of [T + 60_000, T + 3_600_000, SESSION_END]) expect(reason(t)).toBe(true);
  });

  it('★深いポーズ(8時間)なら停止も8時間 = A を守る目的は弱まらない', () => {
    const EIGHT_H = 8 * 3600_000;
    notifyDefaultQuota('gemini', T, EIGHT_H);
    expect(reason(T + 60_000)).toBe('default-quota');
    expect(reason(T + EIGHT_H - 1_000)).toBe('default-quota');
    // ★セッションが変わっても(10:00 Day → 17:30 Night)、A のポーズが明けるまでは止まったまま。
    const night = jst(2026, 6, 1, 17, 30);
    expect(reason(night)).toBe('default-quota');
    expect(generatorGateSnapshot(night).haltedSessionKey).toBe('2026-06-01|Day');
    expect(reason(T + EIGHT_H)).toBe(true);
  });

  it('停止時間が渡されなければ最短段ぶんは止める(「分からないから止めない」に倒さない)', () => {
    notifyDefaultQuota('gemini', T);
    expect(reason(T + DEFAULT_HALT_MS - 1)).toBe('default-quota');
    expect(reason(T + DEFAULT_HALT_MS)).toBe(true);
  });

  it('★停止は縮まらない: 長い停止中に短い429が来ても期限は短くならない', () => {
    notifyDefaultQuota('gemini', T, 30 * 60_000);
    notifyDefaultQuota('groq', T + 1_000, 60_000);
    expect(generatorHaltRemainingMs(T + 1_000)).toBe(30 * 60_000 - 1_000);
    expect(reason(T + 10 * 60_000)).toBe('default-quota');
  });

  it('★止まっていることは無音にしない: 見送りの detail に残り時間が入る', () => {
    notifyDefaultQuota('gemini', T, 120_000);
    const r = checkGeneratorGate(T + 20_000);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe('default-quota');
      expect(r.detail).toContain('残り 100秒');
    }
  });

  it('残り時間は別入口から読める(スナップショットの形=既存の契約は変えない)', () => {
    expect(generatorHaltRemainingMs(T)).toBe(0);
    notifyDefaultQuota('gemini', T, 300_000);
    expect(generatorHaltRemainingMs(T + 100_000)).toBe(200_000);
    expect(Object.keys(generatorGateSnapshot(T)).sort()).toEqual(
      ['budget', 'dayKey', 'haltedSessionKey', 'inFlight', 'sessionKey', 'skipped', 'used'],
    );
  });
});
