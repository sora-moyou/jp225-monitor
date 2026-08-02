import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── 公開版(lite)では分析用の入口(caller='generator' / exitVariant)が閉じている ───────
//
// なぜ:
//   caller='generator' と exitVariant は「決済パラメータの分析」専用の入口。公開版は分析を持たない。
//   黙って現行に倒すと、実験のつもりの要求が実弾と同じプール・同じ予算で走ってしまう(=このゲートが
//   守ろうとしたものが壊れる)。だから **受理せず 400 で落とす**。
//
// ★否定対照(修正前の routes/scalpPlan.ts での結果): MONITOR_VARIANT='lite' でも caller='generator' は
//   従来どおり受理され 200 が返る(生成器の予算まで消費する) → 「lite は 400」の 3本が赤。
//   実証手順: git show HEAD:server/routes/scalpPlan.ts でファイルを差し替えて実行。
//
// ★full(MONITOR_VARIANT 未設定)側の不変も同じファイルで確かめる(分岐を入れて壊していないこと)。

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,   // vision 無効=撮影経路を通さない(見たいのは入口の分岐)
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
  resolveGeneratorDailyBudget: () => 100,
}));

import { scalpPlanHandler, analysisOnlyRequestField } from './scalpPlan.js';
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
const reqOf = (body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) =>
  ({ body, query }) as unknown as Request;

const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

describe('analysisOnlyRequestField(純関数)', () => {
  it('caller の指定(default 以外)を見つける', () => {
    expect(analysisOnlyRequestField({ caller: 'generator' }, {})).toBe('caller');
    expect(analysisOnlyRequestField({}, { caller: 'generator' })).toBe('caller');
    expect(analysisOnlyRequestField({ caller: 'nope' }, {})).toBe('caller');
  });

  it('exitVariant の指定を見つける(既定名 current でも「指定」は指定)', () => {
    expect(analysisOnlyRequestField({ exitVariant: 'candidate-a' }, {})).toBe('exitVariant');
    expect(analysisOnlyRequestField({ exitVariant: 'current' }, {})).toBe('exitVariant');
    expect(analysisOnlyRequestField({}, { exitVariant: 'candidate-a' })).toBe('exitVariant');
  });

  it('既存経路(省略 / caller:default / 空文字)は null=素通し', () => {
    expect(analysisOnlyRequestField({}, {})).toBeNull();
    expect(analysisOnlyRequestField({ caller: 'default' }, {})).toBeNull();
    expect(analysisOnlyRequestField({ caller: '', exitVariant: null }, {})).toBeNull();
    expect(analysisOnlyRequestField({ symbol: 'NIY=F', lcFloorYen: 50 }, {})).toBeNull();
    expect(analysisOnlyRequestField(undefined, undefined)).toBeNull();
  });
});

describe('/api/scalp-plan — lite(公開版)は分析用の入口を閉じる', () => {
  const saved = process.env.MONITOR_VARIANT;
  beforeEach(() => {
    process.env.MONITOR_VARIANT = 'lite';
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_VARIANT;
    else process.env.MONITOR_VARIANT = saved;
  });

  it("caller:'generator' は 400 で拒否され、AI を1回も呼ばない", async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect(res._status).toBe(400);
    expect((res._json as { ok: boolean }).ok).toBe(false);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
  });

  it('拒否は生成器の予算を1回も消費しない(存在しない機構の帳簿を動かさない)', async () => {
    await scalpPlanHandler(reqOf({ caller: 'generator' }), mockRes());
    await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a' }), mockRes());
    expect(generatorGateSnapshot().used).toBe(0);
  });

  it('exitVariant の指定も 400(query でも同じ)', async () => {
    const a = mockRes();
    await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a' }), a);
    expect(a._status).toBe(400);
    const b = mockRes();
    await scalpPlanHandler(reqOf({}, { exitVariant: 'current' }), b);
    expect(b._status).toBe(400);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
  });

  it('★既存経路(caller 省略 / default)は lite でも従来どおり 200(取引の挙動は分岐させない)', async () => {
    const a = mockRes();
    await scalpPlanHandler(reqOf({ lcFloorYen: 50 }), a);
    expect(a._status).toBe(200);
    expect(a._json).toEqual(GOOD_PLAN);

    const b = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'default' }), b);
    expect(b._status).toBe(200);
    expect(b._json).toEqual(GOOD_PLAN);
  });

  it('拒否のメッセージに決済の実数値や API キーが混ざらない', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const text = JSON.stringify(res._json);
    expect(text).not.toMatch(/\d{2,}/);   // 数値らしい断片が無い
  });
});

describe('/api/scalp-plan — full(MONITOR_VARIANT 未設定)は完全に不変', () => {
  const saved = process.env.MONITOR_VARIANT;
  beforeEach(() => {
    delete process.env.MONITOR_VARIANT;
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MONITOR_VARIANT;
    else process.env.MONITOR_VARIANT = saved;
  });

  it("caller:'generator' は従来どおり受理され、予算を1消費する", async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect(res._status).toBe(200);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    expect(generatorGateSnapshot().used).toBe(1);
  });
});
