import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── ★「外した文脈」を HTTP まで通す(D1 の記録の鎖: runner → 応答 → 台帳) ──────────
//
// 何を守っているか:
//   生成器のプロンプトからは A の紙成績を外している(母集団の独立性)。その事実は
//   **推測ではなく記録** として台帳に落ちなければならない。落とし方は既存の chartShot と同じ経路。
//   同時に、レガシー経路(caller 省略 かつ exitVariant 省略)の応答は **バイト一致** のまま。
//
// ★否定対照: git show HEAD:server/routes/scalpPlan.ts に戻すと「応答に載る」2件が赤
//   (旧版の planDiagnostics は contextOmitted を透過しない)。

const runMock = vi.fn();
vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: (...a: unknown[]) => runMock(...a),
}));
vi.mock('../configStore.js', () => ({ resolveGeneratorDailyBudget: () => 1000 }));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({
  exitVariantImplKind: () => 'private',
  exitVariantImplKindAll: () => 'private',
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest } from '../llm/generatorGate.js';

interface MockRes extends Response { _json: unknown; _status: number; }
function mockRes(): MockRes {
  const r = {
    _json: undefined as unknown, _status: 200,
    status(code: number) { r._status = code; return r; },
    json(body: unknown) { r._json = body; return r; },
  };
  return r as unknown as MockRes;
}
const reqOf = (body: Record<string, unknown> = {}) => ({ body, query: {} }) as unknown as Request;

const PLAN = { direction: 'buy', rationale: 'x', refPrice: 38250 };

describe('/api/scalp-plan — 外した文脈ブロックを応答に載せる', () => {
  beforeEach(() => {
    runMock.mockReset();
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  });

  it("★caller:'generator' の応答に contextOmitted が載る", async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN, contextOmitted: ['paper-trade-history'] });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), res);
    expect((res._json as Record<string, unknown>).contextOmitted).toEqual(['paper-trade-history']);
  });

  it('★レガシー経路(caller 省略 かつ exitVariant 省略)の応答は **バイト一致**', async () => {
    // runner は default では contextOmitted を付けないが、route 側のゲートも二重に効くことを固定する。
    runMock.mockResolvedValue({ ok: true, plan: PLAN, contextOmitted: ['paper-trade-history'] });
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    expect(res._json).toEqual({ ok: true, plan: PLAN });
    expect(Object.keys(res._json as object)).toEqual(['ok', 'plan']);
  });

  it('外していない結果ではフィールドを作らない(値が無いことを捏造しない)', async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect(Object.prototype.hasOwnProperty.call(res._json, 'contextOmitted')).toBe(false);
  });
});
