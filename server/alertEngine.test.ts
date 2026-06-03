import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateBarsNiy, _resetShockCooldown } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown, markFired } from './alertCooldown.js';
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
    expect(shock.note).toContain('急変');
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

  it('急変は共有クールダウンが有効なら抑制される(グランビル/超短期からのクールダウン)', () => {
    const now = 65 * 60_000;
    markFired('NIY=F', 'up', 30000, now);   // グランビル/超短期が直前に発火した想定
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'shock')).toBe(false);   // 抑制
  });

  it('グランビルは共有クールダウンが有効でも発火する(クールダウンから外す)', () => {
    const now = 110 * 60_000;
    markFired('NIY=F', 'up', 67000, now);   // クールダウンを発火状態にしてもブロックされない
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(gradualReversalUp(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.some(e => e.detectionKind === 'granville')).toBe(true);
  });
});
