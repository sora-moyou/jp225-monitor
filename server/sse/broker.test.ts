import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Response } from 'express';
import { register, unregister, clientCount, startHeartbeat, stopHeartbeat, HEARTBEAT_MS } from './broker.js';

function fakeClient() {
  const writes: string[] = [];
  const res = {
    write: (s: string) => { writes.push(s); return true; },
    writes,
  };
  return res as unknown as Response & { writes: string[] };
}

function throwingClient() {
  const res = {
    write: () => { throw new Error('EPIPE'); },
  };
  return res as unknown as Response;
}

describe('broker heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 前テストの登録・タイマーを掃除
    stopHeartbeat();
  });
  afterEach(() => {
    stopHeartbeat();
    vi.useRealTimers();
  });

  it('writes ": ping\\n\\n" to each client every HEARTBEAT_MS', () => {
    const a = fakeClient();
    register(a);
    startHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(a.writes).toContain(': ping\n\n');
    unregister(a);
  });

  it('unregisters a client whose write throws (dead-socket cleanup)', () => {
    const dead = throwingClient();
    register(dead);
    const before = clientCount();
    expect(before).toBeGreaterThanOrEqual(1);
    startHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(clientCount()).toBe(before - 1);
  });

  it('does not double-start the interval', () => {
    const a = fakeClient();
    register(a);
    startHeartbeat();
    startHeartbeat();   // second call must be a no-op
    vi.advanceTimersByTime(HEARTBEAT_MS);
    // exactly one ping despite two startHeartbeat calls
    expect(a.writes.filter((w) => w === ': ping\n\n').length).toBe(1);
    unregister(a);
  });

  it('stopHeartbeat clears the interval — no more writes after stop', () => {
    const a = fakeClient();
    register(a);
    startHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_MS);
    const count = a.writes.length;
    stopHeartbeat();
    vi.advanceTimersByTime(HEARTBEAT_MS * 3);
    expect(a.writes.length).toBe(count);
    unregister(a);
  });
});
