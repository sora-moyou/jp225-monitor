import { describe, it, expect } from 'vitest';
import { isWithinOpenGuard } from './session.js';

// JST 壁時計 → epoch ms (JST=UTC+9)
const jst = (y: number, mo: number, d: number, h: number, mi: number): number =>
  Date.UTC(y, mo - 1, d, h - 9, mi, 0);

describe('isWithinOpenGuard (寄りから3本)', () => {
  it('suppresses the first 3 bars of the Day session (8:45, 8:46, 8:47)', () => {
    expect(isWithinOpenGuard(jst(2026, 6, 3, 8, 45))).toBe(true);
    expect(isWithinOpenGuard(jst(2026, 6, 3, 8, 47))).toBe(true);
  });
  it('allows from the 4th Day bar (8:48)', () => {
    expect(isWithinOpenGuard(jst(2026, 6, 3, 8, 48))).toBe(false);
  });
  it('suppresses the first 3 bars of the Night session (17:00-17:02)', () => {
    expect(isWithinOpenGuard(jst(2026, 6, 3, 17, 0))).toBe(true);
    expect(isWithinOpenGuard(jst(2026, 6, 3, 17, 2))).toBe(true);
    expect(isWithinOpenGuard(jst(2026, 6, 3, 17, 3))).toBe(false);
  });
  it('does NOT suppress the early-morning night continuation (e.g. 02:00)', () => {
    expect(isWithinOpenGuard(jst(2026, 6, 4, 2, 0))).toBe(false);
  });
  it('returns false outside any session (e.g. Sunday 12:00)', () => {
    expect(isWithinOpenGuard(jst(2026, 6, 7, 12, 0))).toBe(false);
  });
});
