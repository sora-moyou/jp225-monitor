import { describe, it, expect, beforeEach } from 'vitest';
import { evaluateBarsNiy } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown } from './alertCooldown.js';
import type { Bar } from './correlation.js';
import type { AlertEventPayload } from './types.js';

const META = INSTRUMENTS.find(i => i.symbol === 'NIY=F')!;

// 60 quiet bars then a sharp jump → burst should fire via the sink exactly once.
function quietThenJump(): Bar[] {
  const bars: Bar[] = [];
  let price = 30000;
  for (let i = 0; i < 64; i++) { price += (i % 2 === 0 ? 1 : -1); bars.push({ t: i * 60_000, close: price }); }
  bars.push({ t: 64 * 60_000, close: price + 120 });   // ~0.4% jump
  return bars;
}

describe('evaluateBarsNiy', () => {
  beforeEach(() => resetCooldown());

  it('fires a burst alert through the sink on a quiet-then-jump series', () => {
    const fired: AlertEventPayload[] = [];
    const now = 65 * 60_000;
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.length).toBe(1);
    expect(fired[0]!.symbol).toBe('NIY=F');
    expect(fired[0]!.direction).toBe('up');
    expect(fired[0]!.detectionKind === 'slope' || fired[0]!.detectionKind === 'magnitude').toBe(true);
  });

  it('does not fire on a flat series', () => {
    const flat: Bar[] = Array.from({ length: 70 }, (_, i) => ({ t: i * 60_000, close: 30000 }));
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(flat, META, DEFAULT_PARAMS, 70 * 60_000, (e) => fired.push(e));
    expect(fired.length).toBe(0);
  });
});
