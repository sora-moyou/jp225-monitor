import { describe, it, expect } from 'vitest';
import { crashDrawdown, isCrash, CRASH_DRAWDOWN_PCT } from './crash.js';

describe('crash (セッション高値からの暴落)', () => {
  it('下落率を計算', () => {
    expect(crashDrawdown(67000, 67000)).toBe(0);
    expect(crashDrawdown(67000, 64990)).toBeCloseTo(0.03, 4);   // -2010円 = -3.0%
    expect(crashDrawdown(0, 100)).toBe(0);                      // high<=0 ガード
  });

  it('3%以上で暴落判定', () => {
    expect(isCrash(67000, 64990)).toBe(true);                   // ちょうど 3%
    expect(isCrash(67000, 65000)).toBe(false);                  // -2.99%
    expect(isCrash(67000, 63000)).toBe(true);                   // -5.97%
  });

  it('既定しきい値は 3%', () => {
    expect(CRASH_DRAWDOWN_PCT).toBe(0.03);
  });
});
