import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateBarsNiy, _resetShockCooldown } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown } from './alertCooldown.js';
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
});
