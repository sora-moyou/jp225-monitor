import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── POST /api/scalp-plan: caller による3つの分離(プール / backpressure / 予算) ───
//
// 実際の呼び出し元(2026-08-02 実確認): trade2 はこの route を叩いていない(コメントのヒットのみ)。
// monitor 自身のシグナルエンジンは共通関数 runScalpPlanWithChart を直呼びする。
// よってこの route の呼び出し元は「手動診断」と「これから追加する分析用(caller='generator')」。
//
// ★このテストは **route → 共通 runner → ゲート** を実物で通す(runner はモックしない)。
//   進行中カウンタは runner が上下させるので、モックすると backpressure の配線が検証できないため。
//
// ★否定対照(修正前のコードでの結果):
//   - caller は解釈されず(未知フィールドとして無視)、'generator' でも 429 は返らない
//     → 「生成中に generator が429で弾かれる」「予算超過で429」「従属停止で429」の3本が全て赤。
//   - 不正 caller の 400 も返らない(200 で AI を呼んでしまう)→ 赤。

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  // vision 無効(撮影経路を通さない)。ここで見たいのは caller の分岐なので最短経路にする。
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

const h = vi.hoisted(() => ({ budget: 100 }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 100,
  resolveScalpChartFallbackText: () => true,
  // ★v0.9.70: チャート画像は既定 off(送らない・撮影もしない)。このテストは画像の有無を対象にしない。
  resolveScalpChartVisionMode: () => 'off' as const,

  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => h.budget,
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest, notifyDefaultQuota, generatorGateSnapshot } from '../llm/generatorGate.js';

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
/** buildScalpPlan に渡された caller。 */
const callerOfCall = (i: number) => (buildScalpPlanMock.mock.calls[i]![0] as { caller?: string }).caller;

describe('/api/scalp-plan — caller による分離', () => {
  beforeEach(() => {
    h.budget = 100;
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  describe('既存挙動の不変', () => {
    it('caller 省略 → 従来どおり 200 + プラン。default プールが使われる', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({}), res);

      expect(res._status).toBe(200);
      expect(res._json).toEqual(GOOD_PLAN);
      expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
      expect(callerOfCall(0)).toBe('default');
    });

    it('caller 省略の呼び出しは **分析用の予算を1回も消費しない**', async () => {
      for (let i = 0; i < 5; i++) await scalpPlanHandler(reqOf({}), mockRes());
      expect(generatorGateSnapshot().used).toBe(0);
      expect(buildScalpPlanMock).toHaveBeenCalledTimes(5);
    });

    it('caller 省略の呼び出しは予算切れでも従属停止中でも通る(実取引経路は実験系の都合で止まらない)', async () => {
      h.budget = 0;                        // 分析用は無効
      notifyDefaultQuota('gemini');        // 従属停止も発火済み
      const res = mockRes();
      await scalpPlanHandler(reqOf({}), res);
      expect(res._status).toBe(200);
      expect(res._json).toEqual(GOOD_PLAN);
    });

    it('caller:\'default\' を明示しても省略時と完全に同じ', async () => {
      const a = mockRes(); await scalpPlanHandler(reqOf({}), a);
      const b = mockRes(); await scalpPlanHandler(reqOf({ caller: 'default' }), b);
      expect(b._status).toBe(a._status);
      expect(b._json).toEqual(a._json);
      expect(callerOfCall(1)).toBe(callerOfCall(0));
    });

    it('lcFloorYen/lcCeilingYen の受理は従来どおり(caller 追加で壊れていない)', async () => {
      await scalpPlanHandler(reqOf({ lcFloorYen: 50, lcCeilingYen: '70' }), mockRes());
      const arg = buildScalpPlanMock.mock.calls[0]![0] as { lcFloorYen?: number; lcCeilingYen?: number };
      expect(arg.lcFloorYen).toBe(50);
      expect(arg.lcCeilingYen).toBe(70);
    });
  });

  describe('caller の解釈', () => {
    it('caller:\'generator\' → generator プールで実行され、予算を1消費する', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);

      expect(res._status).toBe(200);
      expect(callerOfCall(0)).toBe('generator');
      expect(generatorGateSnapshot().used).toBe(1);
    });

    it('未知の caller は 400 で拒否する(黙って default に倒さない)', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'GENERATOR' }), res);

      expect(res._status).toBe(400);
      expect(buildScalpPlanMock).not.toHaveBeenCalled();
      expect(generatorGateSnapshot().used).toBe(0);
    });

    it('query 文字列からも caller を受理する', async () => {
      const req = { body: {}, query: { caller: 'generator' } } as unknown as Request;
      await scalpPlanHandler(req, mockRes());
      expect(callerOfCall(0)).toBe('generator');
    });
  });

  describe('★作業3: backpressure(生成中の generator を 429 で弾く)', () => {
    it('default の生成中に generator が叩くと 429 busy / default 自身は弾かれない', async () => {
      // buildScalpPlan を止めて「A のプラン生成中」を作る
      let release!: (v: unknown) => void;
      buildScalpPlanMock.mockImplementationOnce(() => new Promise(r => { release = r; }));

      const resA = mockRes();
      const pA = scalpPlanHandler(reqOf({}), resA);      // ← await しない(進行中のまま)

      // 分析用は弾かれる
      const resGen = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), resGen);
      expect(resGen._status).toBe(429);
      expect((resGen._json as { error: string }).error).toBe('busy');

      // ★既存の呼び出し元(caller 省略)は同時実行でも一切弾かれない
      const resB = mockRes();
      await scalpPlanHandler(reqOf({}), resB);
      expect(resB._status).toBe(200);
      expect(resB._json).toEqual(GOOD_PLAN);

      release(GOOD_PLAN);
      await pA;
      expect(resA._json).toEqual(GOOD_PLAN);

      // 弾かれた分析用は予算を消費していない
      expect(generatorGateSnapshot().used).toBe(0);
    });

    it('生成が終われば generator は再び通る', async () => {
      let release!: (v: unknown) => void;
      buildScalpPlanMock.mockImplementationOnce(() => new Promise(r => { release = r; }));
      const pA = scalpPlanHandler(reqOf({}), mockRes());

      const blocked = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), blocked);
      expect(blocked._status).toBe(429);

      release(GOOD_PLAN);
      await pA;

      const okRes = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), okRes);
      expect(okRes._status).toBe(200);
    });

    it('generator 同士の同時実行も弾く(2本目が 429 busy)', async () => {
      let release!: (v: unknown) => void;
      buildScalpPlanMock.mockImplementationOnce(() => new Promise(r => { release = r; }));
      const p1 = scalpPlanHandler(reqOf({ caller: 'generator' }), mockRes());

      const res2 = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res2);
      expect(res2._status).toBe(429);
      expect((res2._json as { error: string }).error).toBe('busy');

      release(GOOD_PLAN);
      await p1;
    });
  });

  describe('★作業4: 予算と従属規則', () => {
    it('予算を使い切ると 429 budget で停止し、AI を呼ばない', async () => {
      h.budget = 2;
      await scalpPlanHandler(reqOf({ caller: 'generator' }), mockRes());
      await scalpPlanHandler(reqOf({ caller: 'generator' }), mockRes());
      expect(buildScalpPlanMock).toHaveBeenCalledTimes(2);

      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
      expect(res._status).toBe(429);
      expect((res._json as { error: string }).error).toBe('budget');
      expect(buildScalpPlanMock).toHaveBeenCalledTimes(2);   // ★増えない=止まった
    });

    it('★従属規則: default が quota を踏んだ状態では generator が停止する', async () => {
      notifyDefaultQuota('gemini');

      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);

      expect(res._status).toBe(429);
      expect((res._json as { error: string }).error).toBe('default-quota');
      expect(buildScalpPlanMock).not.toHaveBeenCalled();
    });

    it('予算 0(無効)は 429 disabled', async () => {
      h.budget = 0;
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
      expect(res._status).toBe(429);
      expect((res._json as { error: string }).error).toBe('disabled');
      expect(buildScalpPlanMock).not.toHaveBeenCalled();
    });

    it('429 応答に API キーの類は含まれない', async () => {
      h.budget = 0;
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
      expect(JSON.stringify(res._json)).not.toMatch(/key|sk-|api[-_]?key/i);
    });
  });
});
