import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── ★根拠文の突き合わせ2種を HTTP まで通す(記録の鎖: runner → 応答 → 生成器の台帳) ────
//
// 何を守っているか:
//   本線の台帳(signal_plans)には lc_audit_json / omission_audit_json が入るのに、生成器の台帳
//   (proposals)に無いと **A/B の母集団が揃わない**(同じ故障は生成器側にも出る)。
//   応答に載せる経路は既存の contextOmitted / contextAt / promptFp と同じ planDiagnostics。
//   ★どちらも記録専用。数値は AI が出したレッグ価格と幅だけで、非公開の決済仕様は入らない。
//
// ★否定対照: git show HEAD:server/routes/scalpPlan.ts の planDiagnostics は
//   lcAudit / omissionAudit を透過しないので「応答に載る」2件が赤。

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

const PLAN = { direction: 'sell', rationale: 'x', refPrice: 38250 };
const LC_AUDIT = [{ leg: 'stop', entry: 38200, stopLoss: 38205, actualYen: 5, declaredYen: 55, status: 'mismatch', source: 'width' }];
const OMISSION = [{ leg: 'limit', word: '省略', present: true, status: 'contradiction' }];

describe('/api/scalp-plan — 根拠文の突き合わせ2種を応答に載せる', () => {
  beforeEach(() => {
    runMock.mockReset();
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  });

  it("★caller:'generator' の応答に lcAudit / omissionAudit が載る", async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN, lcAudit: LC_AUDIT, omissionAudit: OMISSION });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), res);
    const body = res._json as Record<string, unknown>;
    expect(body.lcAudit).toEqual(LC_AUDIT);
    expect(body.omissionAudit).toEqual(OMISSION);
  });

  it('★レガシー経路(caller 省略 かつ exitVariant 省略)の応答は **バイト一致**', async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN, lcAudit: LC_AUDIT, omissionAudit: OMISSION });
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    expect(res._json).toEqual({ ok: true, plan: PLAN });
    expect(Object.keys(res._json as object)).toEqual(['ok', 'plan']);
  });

  it('観測ゼロの結果ではフィールドを作らない(値が無いことを捏造しない)', async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect(Object.prototype.hasOwnProperty.call(res._json, 'lcAudit')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(res._json, 'omissionAudit')).toBe(false);
  });
});
