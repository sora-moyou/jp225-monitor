import { describe, it, expect } from 'vitest';
import { barsAreFresh } from './alertLoop.js';
import type { Bar } from '../correlation.js';

const M = 60_000;
const bar = (t: number): Bar => ({ t, close: 67000 });

describe('barsAreFresh (検知の鮮度ゲート)', () => {
  const now = 10 * M;          // 現在 = 10分
  const maxLag = 150_000;      // 2.5分

  it('最新バーが maxLag 以内なら fresh=true', () => {
    expect(barsAreFresh([bar(8 * M), bar(9 * M), bar(10 * M)], now, maxLag)).toBe(true);   // 0s 遅れ
    expect(barsAreFresh([bar(8 * M)], now, maxLag)).toBe(true);                            // 2分遅れ < 2.5分
  });

  it('最新バーが maxLag より古ければ fresh=false(フィード停止/復帰中)', () => {
    expect(barsAreFresh([bar(6 * M), bar(7 * M)], now, maxLag)).toBe(false);   // 3分遅れ > 2.5分
    expect(barsAreFresh([bar(3 * M)], now, maxLag)).toBe(false);               // 7分遅れ(今回の不具合相当)
  });

  it('空配列は fresh=false', () => {
    expect(barsAreFresh([], now, maxLag)).toBe(false);
  });
});
