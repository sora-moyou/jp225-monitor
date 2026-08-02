import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── GET /api/status: 公開版(lite)は提案生成器のスナップショットを出さない ────────────
//
// 存在しない機構の予算・従属停止・腕別消費を返しても意味が無い(画面に「使っていない機構の状態」が並ぶ)。
//
// ★否定対照(修正前の routes/status.ts): lite でも generator / generatorArms が必ず載る → 本ファイルが赤。
//   実証手順: git show HEAD:server/routes/status.ts でファイルを差し替えて実行。

vi.mock('../loops/priceLoop.js', () => ({ getYahooStatus: () => ({ fallback: false, skipUntil: 0 }) }));
vi.mock('../llm/openai.js', () => ({ getProviderStatus: () => [{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }] }));
vi.mock('../llm/generatorGate.js', () => ({
  generatorGateSnapshot: () => ({
    dayKey: '2026-06-01', sessionKey: '2026-06-01|Day', budget: 800, used: 3,
    haltedSessionKey: null, inFlight: 0, skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 },
  }),
  generatorArmUsage: () => ({ 'current': 2 }),
}));
vi.mock('../db/store.js', () => ({
  openDb: () => { throw new Error('no db in test'); },
  resolveDbPath: () => 'C:/nonexistent/test.db',
}));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({ exitVariantImplKindAll: () => 'private' }));

import { statusHandler, _resetExitStatusCacheForTest } from './status.js';

interface MockRes extends Response { _json: unknown; }
function mockRes(): MockRes {
  const r = { _json: undefined as unknown, json(b: unknown) { r._json = b; return r; } };
  return r as unknown as MockRes;
}

describe('/api/status — variant による generator スナップショットの有無', () => {
  const saved = process.env.MONITOR_VARIANT;
  beforeEach(() => { _resetExitStatusCacheForTest(); });
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_VARIANT;
    else process.env.MONITOR_VARIANT = saved;
  });

  it('lite: generator / generatorArms を **返さない**', async () => {
    process.env.MONITOR_VARIANT = 'lite';
    const res = mockRes();
    await statusHandler({} as Request, res);
    const b = res._json as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(b, 'generator')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(b, 'generatorArms')).toBe(false);
  });

  it('lite でも既存フィールド(yahoo / llm / exit)は従来どおり返る', async () => {
    process.env.MONITOR_VARIANT = 'lite';
    const res = mockRes();
    await statusHandler({} as Request, res);
    const b = res._json as Record<string, unknown>;
    expect(b.yahoo).toEqual({ fallback: false, skipUntil: 0 });
    expect(b.llm).toEqual([{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }]);
    expect(b.exit).toBeDefined();
  });

  it('★full(未設定): 従来どおり generator / generatorArms が載る', async () => {
    delete process.env.MONITOR_VARIANT;
    const res = mockRes();
    await statusHandler({} as Request, res);
    const b = res._json as Record<string, unknown>;
    expect((b.generator as { used: number }).used).toBe(3);
    expect(b.generatorArms).toEqual({ 'current': 2 });
  });
});
