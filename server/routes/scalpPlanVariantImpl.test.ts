import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── POST /api/scalp-plan: 変種を要求されたのに **実体が無い** なら 400 ────────────
//
// 何を守っているか:
//   private(非公開の決済定義)が無い環境では describeExitLogicVariant が公開フォールバック
//   (数値が一切入らない定性文)のままになり、'candidate-a' のプロンプトが 'current' と
//   ほぼ同一になる。**2本の生成器が同じ質問を投げている**のに、応答は exitVariant:'candidate-a'
//   を返すので記録には「候補仕様で生成した」と残る。実験は何も測っていないのに標本は
//   測ったふりをする=exit/index.ts 自身が「最悪の壊れ方」と書いているものと同じ形。
//   未知の変種名を 400 にするのと同じ作法で、実体が無い変種も 400 で拒否する。
//
// ★否定対照(修正前の routes/scalpPlan.ts での結果):
//   実体の有無を一切見ずに 200 を返し、buildScalpPlan を呼び、exitVariant:'candidate-a' を
//   応答に載せていた → 「fallback なら 400」「AI を呼ばない」が赤。
//   (実証手順: git show HEAD:server/routes/scalpPlan.ts で旧版に差し替えて実行)

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,
  resolveEffectiveRangeEnabled: () => false,
}));
vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));
vi.mock('../chatContext.js', () => ({ buildNikkeiTechnical: () => 'tech' }));
vi.mock('../chart/chartShot.js', () => ({ captureChartPngCached: vi.fn() }));
vi.mock('../feedBars.js', () => ({ getRealtimeOHLCBars: () => [] }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 100,
  resolveScalpChartFallbackText: () => true,
  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => 1000,
}));

// ★実装種別だけを差し替える(決済の実数値には一切触れない)。private の有無に依存しない試験にするため。
const h = vi.hoisted(() => ({ kind: 'private' as 'private' | 'fallback' }));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({
  exitVariantImplKind: () => h.kind,
  exitVariantImplKindAll: () => h.kind,
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest, generatorGateSnapshot } from '../llm/generatorGate.js';

interface MockRes extends Response { _json: unknown; _status: number; }
function mockRes(): MockRes {
  const r = {
    _json: undefined as unknown,
    _status: 200,
    status(code: number) { r._status = code; return r; },
    json(body: unknown) { r._json = body; return r; },
  };
  return r as unknown as MockRes;
}
const reqOf = (body: Record<string, unknown> = {}) => ({ body, query: {} }) as unknown as Request;
const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

describe('/api/scalp-plan — 変種の実体が無ければ 400', () => {
  beforeEach(() => {
    h.kind = 'private';
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('★実体が無い(fallback)のに candidate-a を要求 → 400・AI を呼ばない・予算も使わない', async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), res);

    expect(res._status).toBe(400);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
    expect(generatorGateSnapshot().used).toBe(0);
    expect((res._json as { ok: boolean }).ok).toBe(false);
  });

  it('★400 応答は「候補仕様で生成した」と誤解される情報を返さない(exitVariant を載せない)', async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), res);
    expect('exitVariant' in (res._json as Record<string, unknown>)).toBe(false);
  });

  it('実体がある(private)なら従来どおり 200 で通る', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), res);

    expect(res._status).toBe(200);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    expect((res._json as { exitVariant?: string }).exitVariant).toBe('candidate-a');
  });

  it("★'current' は fallback でも 400 にしない(現行仕様はフォールバックと byte 一致するのが正しい)", async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'current' }), res);
    expect(res._status).toBe(200);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
  });

  it('★レガシー経路(変種省略)は fallback でも一切影響を受けない', async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    expect(res._status).toBe(200);
    expect(JSON.stringify(res._json)).toBe('{"ok":true,"plan":{"direction":"buy"}}');
  });

  it('400 応答に決済の数値やキーの類を含まない', async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a' }), res);
    const s = JSON.stringify(res._json);
    expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
    expect(s).not.toMatch(/\d{2,}/);
  });
});
