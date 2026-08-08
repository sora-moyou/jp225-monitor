import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── POST /api/scalp-plan: 見送り(none)の経路を応答に載せる ────────────────────
//
// 何を守っているか:
//   direction:'none' のとき、外の記録側(別プロセスの提案生成器)は
//     'ai'(AI が見送った) / 'lc'(LC上限で落ちた) / 'lcFloor'(下限未満で落ちた) / 'trend'(トレンド veto)
//   を **区別できなければならない**。区別できないと、2本の生成器の見送り率の差が
//   「AI の適応」なのか「enforce の副作用」なのか判別不能になり、実験の主要比較が成立しない。
//   monitor 自身のシグナルエンジンは engine.ts でこれをログに出しているが、HTTP 越しには届かない。
//
// ★否定対照(修正前の routes/scalpPlan.ts での結果):
//   応答は `{ ok:true, plan }` だけを返し、vetoFired / noneReason / noneLegs / rangeAnomaly を
//   **捨てていた** → 本ファイルの「見送り理由が応答に載る」系のテストが全て赤。
//   (実証手順: git show HEAD:server/routes/scalpPlan.ts で旧版に差し替えて実行)
//
// ★同時に守る不変条件: **レガシー経路(caller 省略 かつ exitVariant 省略)の応答はバイト一致**。

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,   // 撮影経路を通さない(見たいのは応答の中身)
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
const reqOf = (body: Record<string, unknown> = {}) => ({ body, query: {} }) as unknown as Request;

/** 見送り(none)の生の結果。engine.ts が受け取っているのと同じ形。 */
const NONE_RESULT = {
  ok: true,
  plan: { direction: 'none', rationale: '見送り', refPrice: 38250 },
  vetoFired: true,
  noneReason: 'lcFloor',
  noneLegs: [{ name: 'limit', entry: 38200, stopLoss: 38180, ok: false }],
};

describe('/api/scalp-plan — 見送り理由(決定台帳)の返却', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(NONE_RESULT);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it("★caller:'generator' の応答は noneReason / noneLegs / vetoFired を載せる", async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);

    const body = res._json as Record<string, unknown>;
    expect(res._status).toBe(200);
    expect(body.noneReason).toBe('lcFloor');
    expect(body.vetoFired).toBe(true);
    expect(body.noneLegs).toEqual(NONE_RESULT.noneLegs);
    expect(body.plan).toEqual(NONE_RESULT.plan);
    expect(body.exitVariant).toBe('current');
  });

  it('★4つの見送り理由が別々の値として届く(AI / LC上限 / LC下限 / トレンド veto を取り違えない)', async () => {
    for (const r of ['ai', 'lc', 'lcFloor', 'trend'] as const) {
      buildScalpPlanMock.mockResolvedValue({ ...NONE_RESULT, noneReason: r });
      const res = mockRes();
      await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
      expect((res._json as { noneReason?: string }).noneReason).toBe(r);
    }
  });

  it('rangeAnomaly も載る(レンジ規約違反の観測が HTTP 越しでも失われない)', async () => {
    buildScalpPlanMock.mockResolvedValue({
      ok: true, plan: { direction: 'range' }, rangeAnomaly: { kind: 'inverted' },
    });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect((res._json as { rangeAnomaly?: unknown }).rangeAnomaly).toEqual({ kind: 'inverted' });
  });

  it('exitVariant だけ指定した呼び出しでも載る(生成器は caller か exitVariant を必ず指定する)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ exitVariant: 'current' }), res);
    expect((res._json as { noneReason?: string }).noneReason).toBe('lcFloor');
  });

  it('付随情報が **無い** 結果では、そのフィールドを付けない(値が無いことと実装に無いことを混同させない)', async () => {
    buildScalpPlanMock.mockResolvedValue({ ok: true, plan: { direction: 'buy' } });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const body = res._json as Record<string, unknown>;
    expect('noneReason' in body).toBe(false);
    expect('noneLegs' in body).toBe(false);
    expect('vetoFired' in body).toBe(false);
    expect('rangeAnomaly' in body).toBe(false);
  });

  it('vetoFired:false も **false として** 載る(未指定と区別できる)', async () => {
    buildScalpPlanMock.mockResolvedValue({ ok: true, plan: { direction: 'buy' }, vetoFired: false });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const body = res._json as Record<string, unknown>;
    expect('vetoFired' in body).toBe(true);
    expect(body.vetoFired).toBe(false);
  });

  describe('★レガシー経路(caller 省略 かつ exitVariant 省略)は応答バイト一致', () => {
    it('付随情報を持つ結果でも、レガシー応答は従来の2フィールドのまま(バイト列を固定)', async () => {
      const res = mockRes();
      await scalpPlanHandler(reqOf({}), res);

      // ★キーの順序まで含めた **バイト列** を固定する(フィールドが1つでも増えれば落ちる)。
      expect(JSON.stringify(res._json)).toBe(
        '{"ok":true,"plan":{"direction":"none","rationale":"見送り","refPrice":38250}}',
      );
    });

    it("caller:'default' を明示しても同じバイト列", async () => {
      const a = mockRes(); await scalpPlanHandler(reqOf({}), a);
      const b = mockRes(); await scalpPlanHandler(reqOf({ caller: 'default' }), b);
      expect(JSON.stringify(b._json)).toBe(JSON.stringify(a._json));
    });

    it('ok:false のレガシー応答もバイト一致', async () => {
      buildScalpPlanMock.mockResolvedValue({ ok: false, error: 'chart-not-generated' });
      const res = mockRes();
      await scalpPlanHandler(reqOf({}), res);
      expect(JSON.stringify(res._json)).toBe('{"ok":false,"error":"chart-not-generated"}');
    });
  });

  it('応答に決済ラダーの実数値やキーは混ざらない(載るのは AI が出したレッグ価格と理由だけ)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'current' }), res);
    // ★記録専用の出所2列は数値の走査から外し、**形だけ** を固定する。
    //   contextAt=monitor の時計の読み(決済仕様からは導かれない)/ promptFp=一方向ハッシュ(hex)。
    //   hex の中の数字列がたまたま実数値と一致しても意味は無く、混ぜるとこの検査は
    //   「混ざったか」ではなく偶然を測ることになる。混入の検査は残りの本体に対して従来どおり効く。
    const { contextAt, promptFp, ...rest } = res._json as Record<string, unknown>;
    expect(typeof contextAt).toBe('number');
    expect(promptFp === undefined || /^sp1:[0-9a-f]{16}$/.test(String(promptFp))).toBe(true);
    const s = JSON.stringify(rest);
    expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
    // 応答に現れる数値は buildScalpPlan が返したもの(=モックが与えた値)だけ。
    const nums = (s.match(/\d+/g) ?? []).map(Number);
    expect(nums.every(n => [38250, 38200, 38180].includes(n))).toBe(true);
  });
});
