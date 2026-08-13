import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── POST /api/scalp-plan: 決済仕様の「名前付き変種」(exitVariant) ───────────────
//
// 目的: 生成器②に「候補の決済仕様」を AI へ教えさせる。★数値は HTTP に載せない。
//   リクエストに載るのは **名前だけ**(exitVariant: 'current' | 'candidate-a')で、
//   実数値は monitor プロセス内の非公開定義から解決される。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   - exitVariant は未知フィールドとして無視される → buildScalpPlan へ渡らない(undefined)ので
//     「変種が渡る」「応答に載る」テストが赤。
//   - 不正な変種名でも 400 にならず 200 で AI を呼んでしまう → 「不正は 400」が赤。
//
// ★このファイルは公開リポにも載る。決済の実数値は一切書かない・一切 assert しない。

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,   // 撮影経路を通さない(見たいのは変種の配線)
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
  // ★v0.9.70: チャート画像は既定 off(送らない・撮影もしない)。このテストは画像の有無を対象にしない。
  resolveScalpChartVisionMode: () => 'off' as const,

  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => 100,
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest } from '../llm/generatorGate.js';

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
/** buildScalpPlan に渡された exitVariant。 */
const variantOfCall = (i: number) =>
  (buildScalpPlanMock.mock.calls[i]![0] as { exitVariant?: string }).exitVariant;

describe('/api/scalp-plan — exitVariant(決済仕様の変種)', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('既存挙動の不変(A を1ミリも変えない)', () => {
    it('exitVariant 省略 → 変種は渡らず(undefined)、応答も従来どおり(余計なフィールドを増やさない)', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({}), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual(GOOD_PLAN);            // ★フィールドが増えていない
      expect(variantOfCall(0)).toBeUndefined();        // ★buildScalpPlan は従来の経路(describeExitLogic())
    });

    it('caller だけ指定(従来の分離機能)でも exitVariant は渡らない', async () => {
      await scalpPlanHandler(reqOf({ caller: 'default' }), mockRes());
      expect(variantOfCall(0)).toBeUndefined();
    });

    it('空文字は「省略」と同じ扱い(400 にしない・変種も渡さない)', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ exitVariant: '' }), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual(GOOD_PLAN);
      expect(variantOfCall(0)).toBeUndefined();
    });
  });

  describe('変種の受理', () => {
    it("exitVariant:'current' → 変種が渡り、応答にも載る(生成器が記録できる)", async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ exitVariant: 'current' }), res);

      expect(res._status).toBe(200);
      expect(variantOfCall(0)).toBe('current');
      expect((res._json as { exitVariant?: string }).exitVariant).toBe('current');
      expect((res._json as { plan?: unknown }).plan).toEqual(GOOD_PLAN.plan);
    });

    it("exitVariant:'candidate-a' → 候補が渡り、応答にも載る", async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a', caller: 'generator' }), res);

      expect(res._status).toBe(200);
      expect(variantOfCall(0)).toBe('candidate-a');
      expect((res._json as { exitVariant?: string }).exitVariant).toBe('candidate-a');
    });

    it('query 文字列からも受理する', async () => {
      await scalpPlanHandler(reqOf({}, { exitVariant: 'candidate-a' }), mockRes());
      expect(variantOfCall(0)).toBe('candidate-a');
    });

    it("caller:'generator' で exitVariant を省略しても、応答は既定変種を明示する(記録の穴を作らない)", async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
      expect((res._json as { exitVariant?: string }).exitVariant).toBe('current');
      expect(variantOfCall(0)).toBeUndefined();   // 生成そのものは従来経路(byte 不変)
    });

    it('ok:false の応答にも変種が載る(見送りも実験の1標本として記録できる)', async () => {
      buildScalpPlanMock.mockResolvedValue({ ok: false, error: 'chart-not-generated' });
      const res = mockRes();
      await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a' }), res);
      // ★v0.9.75: 軸が2つになったので、応答は **両方の変種名** を明示する
      //   (片方だけだと台帳から「どの質問文で得た標本か」が読めない)。
      expect(res._json).toEqual({
        ok: false, error: 'chart-not-generated', exitVariant: 'candidate-a', promptVariant: 'v1',
      });
    });
  });

  describe('不正な変種名は 400(黙って現行に倒さない)', () => {
    it.each(['CURRENT', 'candidate_a', 'candidate-b', 'candidateA', 'default', 42, true])(
      '%o は 400 で拒否し、AI を一切呼ばない',
      async (bad) => {
        const res = mockRes();
        await scalpPlanHandler(reqOf({ exitVariant: bad }), res);

        expect(res._status).toBe(400);
        expect(buildScalpPlanMock).not.toHaveBeenCalled();
        expect((res._json as { ok: boolean }).ok).toBe(false);
      },
    );

    it('400 の判定は caller の関門より前でも後でも「AI を呼ばない」ことに変わりはない', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'nope' }), res);
      expect(res._status).toBe(400);
      expect(buildScalpPlanMock).not.toHaveBeenCalled();
    });

    it('400 応答に決済の数値やキーの類を含まない', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ exitVariant: 'nope' }), res);
      const s = JSON.stringify(res._json);
      expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
      expect(s).not.toMatch(/\d{2,}/);   // 数値の羅列(決済ラダー等)が出ていない
    });
  });
});

// ─── ★promptVariant(質問文の変種・v0.9.75)────────────────────────────────────
//
// exitVariant と **同じ作法** で受理する(名前だけ・未知は400・応答にエコー)。
// ★否定対照: promptVariant を知らない版の route では、未知フィールドとして無視されるので
//   「buildScalpPlan へ渡る」「400 で拒否する」「応答に載る」がいずれも赤になる。
describe('/api/scalp-plan — promptVariant(質問文の変種)', () => {
  /** buildScalpPlan に渡された promptVariant。 */
  const promptOfCall = (i: number) =>
    (buildScalpPlanMock.mock.calls[i]![0] as { promptVariant?: string }).promptVariant;

  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('省略 → 渡らず(undefined)、応答も従来どおり(既定経路は byte 不変)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    expect(res._json).toEqual(GOOD_PLAN);
    expect(promptOfCall(0)).toBeUndefined();
  });

  it("promptVariant:'v2' → 質問文の変種が渡り、応答にも両方の軸が載る", async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', promptVariant: 'v2' }), res);
    expect(res._status).toBe(200);
    expect(promptOfCall(0)).toBe('v2');
    const j = res._json as { exitVariant?: string; promptVariant?: string };
    expect(j.promptVariant).toBe('v2');
    expect(j.exitVariant).toBe('current');   // 決済仕様は既定のまま(動かす変数は質問文だけ)
  });

  it('空文字は「省略」と同じ(400 にしない・渡さない)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ promptVariant: '' }), res);
    expect(res._status).toBe(200);
    expect(promptOfCall(0)).toBeUndefined();
  });

  it.each(['V2', 'v3', 'v2 ', 2, true])('不正な名前 %o は 400 で拒否し、AI を一切呼ばない', async (bad) => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', promptVariant: bad }), res);
    expect(res._status).toBe(400);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
  });

  it('query でも受理する(body と同じ扱い)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }, { promptVariant: 'v2' }), res);
    expect(promptOfCall(0)).toBe('v2');
  });
});
