// sessionOpenMs / prevSessionCloseMs — 寄りの時刻と「直前に引けたセッション」の引け時刻。
// ★server/contextFreshness.ts が「寄り直後の正常な待ち」と「収集停止のまま寄りを迎えた」を区別するのに使う。
//   週末・祝日(DERIV_NON_TRADING)・夜間の日付またぎは classifySession の分類に従うこと。
import { describe, it, expect } from 'vitest';
import { sessionOpenMs, prevSessionCloseMs } from './session.js';

const J = (y: number, mo: number, d: number, h: number, mi = 0, s = 0): number => Date.UTC(y, mo - 1, d, h - 9, mi, s);

describe('sessionOpenMs', () => {
  it('Day は 08:45 / Night は 17:00(早朝の継続も前日 17:00)/ 立会外は null', () => {
    expect(sessionOpenMs(J(2026, 11, 10, 11, 0, 7))).toBe(J(2026, 11, 10, 8, 45));
    expect(sessionOpenMs(J(2026, 11, 10, 17, 0, 3))).toBe(J(2026, 11, 10, 17, 0));
    expect(sessionOpenMs(J(2026, 11, 11, 3, 30))).toBe(J(2026, 11, 10, 17, 0));
    expect(sessionOpenMs(J(2026, 11, 10, 16, 0))).toBeNull();
  });
});

describe('prevSessionCloseMs', () => {
  it('日中の寄り → 同日 06:00(前夜の夜間の引け)/ 夜間の寄り → 同日 15:45', () => {
    expect(prevSessionCloseMs(J(2026, 10, 27, 8, 45))).toBe(J(2026, 10, 27, 6, 0));
    expect(prevSessionCloseMs(J(2026, 10, 27, 17, 0))).toBe(J(2026, 10, 27, 15, 45));
  });
  it('週明け: 月曜 08:45 → 土曜 06:00(金曜夜間の引け)', () => {
    expect(prevSessionCloseMs(J(2026, 11, 9, 8, 45))).toBe(J(2026, 11, 7, 6, 0));
  });
  it('祝日(2026-11-23 月・祝日取引なし)明け: 火曜 08:45 → 土曜 06:00', () => {
    expect(prevSessionCloseMs(J(2026, 11, 24, 8, 45))).toBe(J(2026, 11, 21, 6, 0));
  });
  it('引けちょうどの瞬間はその引けを返す / 立会外(16:00)は直前の 15:45', () => {
    expect(prevSessionCloseMs(J(2026, 11, 10, 15, 45))).toBe(J(2026, 11, 10, 15, 45));
    expect(prevSessionCloseMs(J(2026, 11, 10, 16, 0))).toBe(J(2026, 11, 10, 15, 45));
  });
});
