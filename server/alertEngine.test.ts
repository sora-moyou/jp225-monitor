import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateBarsNiy, _resetShockCooldown } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown, markFired, canFire } from './alertCooldown.js';
import type { Bar } from './correlation.js';
import type { AlertEventPayload } from './types.js';

const META = INSTRUMENTS.find(i => i.symbol === 'NIY=F')!;

// Quiet zigzag then a sharp jump on a COMPLETED bar → shock should fire via the sink.
// Two constraints: (1) evaluateBarsNiy has a top guard `bars.length < 65 return`, so we need
// ≥65 bars total. (2) shock evaluates bars.slice(0,-1) (excludes the in-progress last bar),
// so we append one extra trailing bar after the jump so the jump bar is COMPLETED.
// granville needs ~106 bars, so with 66 it won't fire — only shock is exercised.
function quietThenJump(): Bar[] {
  const bars: Bar[] = [];
  let price = 30000;
  for (let i = 0; i < 64; i++) { price += (i % 2 === 0 ? 1 : -1); bars.push({ t: i * 60_000, close: price }); }
  bars.push({ t: 64 * 60_000, close: price + 50 });   // jump bar (will be the last COMPLETED bar)
  bars.push({ t: 65 * 60_000, close: price + 50 });   // in-progress bar → excluded by slice(0,-1)
  return bars;
}

describe('evaluateBarsNiy', () => {
  beforeEach(() => { resetCooldown(); _resetShockCooldown(); });

  it('fires a shock alert through the sink on a quiet-then-jump series', () => {
    const fired: AlertEventPayload[] = [];
    const now = 65 * 60_000;
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(true);
    const shock = fired.find(e => e.detectionKind === 'shock')!;
    expect(shock.symbol).toBe('NIY=F');
    expect(shock.direction).toBe('up');
    // note は値幅データに専念(種別「急変」はタグ側に一本化したので含まない)。
    expect(shock.note).toContain('1分');
    expect(shock.note).toContain('↑');
    expect(shock.note).not.toContain('急変');
  });

  it('does not fire on a flat series', () => {
    const flat: Bar[] = Array.from({ length: 70 }, (_, i) => ({ t: i * 60_000, close: 30000 }));
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(flat, META, DEFAULT_PARAMS, 70 * 60_000, (e) => fired.push(e));
    expect(fired.length).toBe(0);
  });

  // 緩やかな反転(下降→上昇)。グランビル買い転換が出る系列(granville.test.ts と同形)。
  function gradualReversalUp(): Bar[] {
    const bars: Bar[] = [];
    let i = 0;
    for (; i < 90; i++) bars.push({ t: i * 60_000, close: 67500 - 1500 * (i / 89) });
    const b = bars[bars.length - 1]!.close;
    for (let k = 1; k <= 20; k++, i++) bars.push({ t: i * 60_000, close: b + 30 * k });
    return bars;
  }

  // グランビルのみ発火し急変は出ない系列。末尾を +3 で平坦化し最終足の急変を回避(probe で確認)。
  function granvilleOnlyUp(): Bar[] {
    const bars: Bar[] = [];
    let i = 0;
    for (; i < 90; i++) bars.push({ t: i * 60_000, close: 67500 - 1500 * (i / 89) });
    let c = bars[bars.length - 1]!.close;
    for (let k = 0; k < 20; k++, i++) { c += 30; bars.push({ t: i * 60_000, close: c }); }
    for (let k = 0; k < 6; k++, i++) { c += 3; bars.push({ t: i * 60_000, close: c }); }
    return bars;
  }

  it('急変は共有クールダウン中(直前の急変)なら抑制される', () => {
    const now = 65 * 60_000;
    markFired('NIY=F', 'up', 30000, now);   // 直前に急変が発火した想定
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(false);   // 抑制
  });

  it('急変は発火時に共有クールダウンを発生させる(自身の連続表示を抑制)', () => {
    const now = 65 * 60_000;
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(true);
    // 急変が markFired → 同方向の次の発火は共有クールダウンで不可
    expect(canFire('NIY=F', 'up', 30050, now + 60_000)).toBe(false);
  });

  it('グランビルは共有クールダウンが有効でも発火する(クールダウン完全無視)', () => {
    const now = 110 * 60_000;
    markFired('NIY=F', 'up', 67000, now);   // クールダウンを発火状態にしてもブロックされない
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(gradualReversalUp(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'granville')).toBe(true);
    // 中期/長期2本MA併用で検知するが、表示(note)に MA ラベルは出さない(ユーザー指定)。
    const g = fired.find(e => e.detectionKind === 'granville')!;
    expect(g.note).toMatch(/転換|押し目買い|戻り売り/);
    expect(g.note).not.toMatch(/中期|長期/);
  });

  it('グランビルは発火しても共有クールダウンを発生させない(シグナルは急変のみ)', () => {
    const now = 116 * 60_000;
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(granvilleOnlyUp(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'granville')).toBe(true);
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(false);   // この系列は急変を出さない
    // グランビルは markFired を呼ばない → 共有クールダウンは未発生(canFire は true のまま)
    expect(canFire('NIY=F', 'up', 67000, now + 1000)).toBe(true);
  });
});
