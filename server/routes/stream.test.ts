import { describe, it, expect, vi } from 'vitest';
import type { LevelsResult } from '../levels.js';

vi.mock('../sse/broker.js', () => ({ register: vi.fn(), unregister: vi.fn() }));
vi.mock('../cache.js', () => ({ getPrices: () => [], getNews: () => [] }));

const levelsSnap: LevelsResult = {
  current: 67000,
  up: [{ price: 67100, dist: 100, labels: ['長期高'], strong: true, score: 5, tier: 2, confluence: true }],
  down: [],
  swing: null,
  reversalSatisfied: false,
  asOf: 1,
};
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: () => levelsSnap }));

import { streamHandler } from './stream.js';

function mockRes() {
  const writes: string[] = [];
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: (s: string) => { writes.push(s); return true; },
    writes,
  };
}
function mockReq() { return { on: vi.fn() }; }

describe('streamHandler connect snapshot', () => {
  it('sends the current levels snapshot on connect so a fresh client shows levels immediately', () => {
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamHandler(mockReq() as any, res as any);
    const joined = res.writes.join('');
    expect(joined).toContain('event: levels');
    expect(joined).toContain('67100');
  });
});
