import { describe, it, expect } from 'vitest';
import { sessionKey } from './levelsLoop.js';

describe('sessionKey', () => {
  it('classifySession の結果を安定キー文字列にする', () => {
    expect(sessionKey({ sessionDate: '2026-06-01', session: 'Night' })).toBe('2026-06-01/Night');
    expect(sessionKey(null)).toBe('none');
  });
});
