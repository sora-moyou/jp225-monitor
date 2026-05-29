import { describe, it, expect, beforeEach } from 'vitest';
import { _internals } from './correlationTracker.js';

describe('pairedReturns (v0.3.11 time-aligned, stale-aware)', () => {
  beforeEach(() => _internals.reset());

  it('produces aligned returns when both symbols are always present', () => {
    _internals.pushSnapshot(0, { 'NIY=F': 100, 'NQ=F': 200 });
    _internals.pushSnapshot(1000, { 'NIY=F': 101, 'NQ=F': 202 });
    _internals.pushSnapshot(2000, { 'NIY=F': 102, 'NQ=F': 204 });
    const { a, b } = _internals.pairedReturns('NIY=F', 'NQ=F');
    expect(a.length).toBe(2);
    expect(b.length).toBe(2);
    expect(a[0]).toBeCloseTo(0.01, 5);   // 100 -> 101
    expect(b[0]).toBeCloseTo(0.01, 5);   // 200 -> 202
  });

  it('skips snapshot where either symbol is stale (missing), resets prev on both sides', () => {
    _internals.pushSnapshot(0,    { 'NIY=F': 100, 'NQ=F': 200 });
    _internals.pushSnapshot(1000, { 'NIY=F': 101, 'NQ=F': null });   // NQ=F stale -> skip
    _internals.pushSnapshot(2000, { 'NIY=F': 102, 'NQ=F': 210 });    // prev reset, no return yet
    _internals.pushSnapshot(3000, { 'NIY=F': 103, 'NQ=F': 215 });    // first paired return after stale
    const { a, b } = _internals.pairedReturns('NIY=F', 'NQ=F');
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0]).toBeCloseTo((103 - 102) / 102, 5);
    expect(b[0]).toBeCloseTo((215 - 210) / 210, 5);
  });

  it('returns empty when fewer than 2 consecutive non-stale snapshots exist', () => {
    _internals.pushSnapshot(0,    { 'NIY=F': 100, 'NQ=F': 200 });
    _internals.pushSnapshot(1000, { 'NIY=F': 101, 'NQ=F': null });
    _internals.pushSnapshot(2000, { 'NIY=F': null, 'NQ=F': 210 });
    const { a, b } = _internals.pairedReturns('NIY=F', 'NQ=F');
    expect(a.length).toBe(0);
    expect(b.length).toBe(0);
  });

  it('preserves alignment when sym order is swapped (commutative pairing)', () => {
    _internals.pushSnapshot(0,    { 'NIY=F': 100, 'NQ=F': 200 });
    _internals.pushSnapshot(1000, { 'NIY=F': 101, 'NQ=F': 202 });
    const fwd = _internals.pairedReturns('NIY=F', 'NQ=F');
    const rev = _internals.pairedReturns('NQ=F', 'NIY=F');
    expect(fwd.a).toEqual(rev.b);
    expect(fwd.b).toEqual(rev.a);
  });
});
