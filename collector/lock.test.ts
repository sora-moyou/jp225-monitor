import { describe, it, expect } from 'vitest';
import { shouldAcquire } from './lock.js';

describe('shouldAcquire', () => {
  it('acquires when no existing pid', () => {
    expect(shouldAcquire(null, () => true)).toBe(true);
  });
  it('refuses when existing pid is alive', () => {
    expect(shouldAcquire(1234, (pid) => pid === 1234)).toBe(false);
  });
  it('acquires (takes over) when existing pid is stale (dead)', () => {
    expect(shouldAcquire(1234, () => false)).toBe(true);
  });
});
