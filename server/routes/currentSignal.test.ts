import { describe, it, expect } from 'vitest';
import { currentSignalPayload, currentSignalResponse } from './currentSignal.js';
import type { CurrentSignal, SignalHold } from '../signalTrade/engine.js';

// GET /api/current-signal のシェイプ整形(純関数)を検証する。発注系は持たない=表示/連携専用。

describe('currentSignalPayload', () => {
  it('null は { signalId: null }', () => {
    expect(currentSignalPayload(null)).toEqual({ signalId: null });
  });

  it('両レッグの現在シグナルを { signalId, at, direction, plan, rationale } へ整形', () => {
    const sig: CurrentSignal = {
      signalId: 4, at: 111, direction: 'buy', rationale: 'r',
      limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050,
    };
    expect(currentSignalPayload(sig)).toEqual({
      signalId: 4, at: 111, direction: 'buy', rationale: 'r',
      plan: { limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050 },
    });
  });

  it('片レッグ(指値のみ)は plan の欠落レッグが undefined', () => {
    const sig: CurrentSignal = { signalId: 1, at: 0, direction: 'sell', rationale: 'r', limitEntry: 38100, stopLossForLimit: 38150 };
    const out = currentSignalPayload(sig) as { plan: Record<string, unknown> };
    expect(out.plan.limitEntry).toBe(38100);
    expect(out.plan.stopLossForLimit).toBe(38150);
    expect(out.plan.stopEntry).toBeUndefined();
    expect(out.plan.stopLossForStop).toBeUndefined();
  });
});

describe('currentSignalResponse (hold 付き)', () => {
  const sig: CurrentSignal = {
    signalId: 4, at: 111, direction: 'buy', rationale: 'r',
    limitEntry: 37950, stopLossForLimit: 37900,
  };
  it('保有中は hold(signalId 対応・exitStop 絶対価格)を付ける', () => {
    const hold: SignalHold = { signalId: 4, direction: 'buy', entryPrice: 37950, exitStop: 37900, at: 222 };
    const out = currentSignalResponse(sig, hold) as { signalId: number; hold: SignalHold };
    expect(out.signalId).toBe(4);
    expect(out.hold).toEqual(hold);
    expect(out.hold.signalId).toBe(sig.signalId);   // entry と対応
  });
  it('保有していなければ hold は null(flat/armed)', () => {
    expect(currentSignalResponse(sig, null).hold).toBeNull();
    expect(currentSignalResponse(null, null)).toEqual({ signalId: null, hold: null });
  });
});
