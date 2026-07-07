import { describe, it, expect } from 'vitest';
import { sessionKey, levelSignature, getLevelsSnapshot } from './levelsLoop.js';
import type { LevelsResult } from '../levels.js';

describe('sessionKey', () => {
  it('classifySession の結果を安定キー文字列にする', () => {
    expect(sessionKey({ sessionDate: '2026-06-01', session: 'Night' })).toBe('2026-06-01/Night');
    expect(sessionKey(null)).toBe('none');
  });
});

describe('getLevelsSnapshot', () => {
  it('最後に計算した水準(last)を返す。起動直後は空スナップショット', () => {
    // tick() を回さない状態では初期値(空)。stream.ts が接続時に安全に扱える形であることを確認。
    const snap = getLevelsSnapshot();
    expect(snap).toHaveProperty('up');
    expect(snap).toHaveProperty('down');
    expect(Array.isArray(snap.up)).toBe(true);
    expect(Array.isArray(snap.down)).toBe(true);
  });
});

describe('levelSignature — 現値凍結でも水準が同じなら署名は不変(de-dupe が正しく働く根拠)', () => {
  it('current(現値)を署名に含めない: 現値だけ動いても署名は変わらない', () => {
    const base = (current: number): LevelsResult => ({
      current,
      up: [{ price: 67200, dist: 200, labels: ['上値'], strong: true, score: 3, tier: 1, confluence: false }],
      down: [{ price: 66800, dist: -200, labels: ['下値'], strong: false, score: 1, tier: 0, confluence: false }],
      swing: null, reversalSatisfied: false, asOf: 1,
    });
    // 現値が動いても(66900→67100)署名は同じ → 定常時は再 broadcast しない。
    expect(levelSignature(base(66900))).toBe(levelSignature(base(67100)));
  });
});
