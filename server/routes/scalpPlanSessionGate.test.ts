import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

// ─── POST /api/scalp-plan: 場外の生成器要求を **撮影より前に** 弾く ──────────────
//
// 何を守っているか:
//   runScalpPlanWithChart は refPrice の鮮度判定より **先に** チャートを撮る。つまり場外の
//   無意味な要求でも毎回 Chrome が起動し(1撮影あたりイベントループが約 286ms 停止)、その後
//   refPrice が古くて捨てられる。さらに generatorGate の roll() は場外でも直前のセッションキーを
//   保持するので、15:45〜17:00 の 75 分や週末の要求が **その取引日の予算をそのまま食う**。
//
// ★否定対照(修正前の routes/scalpPlan.ts / server/index.ts での結果):
//   generatorSessionGate も isGeneratorRequestOutOfSession も存在せず import 解決に失敗 → 全部赤。
//   route には時間ゲートが1つも無く、場外の生成器要求がそのまま撮影と予算計上へ抜けていた。
//   (実証手順: git show HEAD:server/routes/scalpPlan.ts で旧版に差し替えて実行)

const buildScalpPlanMock = vi.fn();
const visionMock = vi.fn<[], { name: string } | null>();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => visionMock(),
  resolveEffectiveRangeEnabled: () => false,
}));
vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));
vi.mock('../chatContext.js', () => ({ buildNikkeiTechnical: () => 'tech' }));
const captureMock = vi.fn();
vi.mock('../chart/chartShot.js', () => ({
  captureChartPngCached: (...a: unknown[]) => captureMock(...a),
}));
vi.mock('../feedBars.js', () => ({ getRealtimeOHLCBars: () => [] }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 100,
  resolveScalpChartFallbackText: () => true,
  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => 1000,
}));

import { generatorSessionGate, isGeneratorRequestOutOfSession, scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest, generatorGateSnapshot } from '../llm/generatorGate.js';

// JST の実時刻 → epoch。
const jst = (y: number, mo: number, d: number, hh: number, mm = 0) => Date.UTC(y, mo - 1, d, hh - 9, mm);
const IN_DAY = jst(2026, 6, 1, 10, 0);       // 月曜 Day セッション
const IN_NIGHT = jst(2026, 6, 1, 18, 0);     // 同日 Night セッション
const GAP = jst(2026, 6, 1, 16, 30);         // ★15:45〜17:00 の空白帯(場外)
const WEEKEND = jst(2026, 6, 6, 12, 0);      // 土曜(場外)

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

describe('isGeneratorRequestOutOfSession(純関数)', () => {
  it('★場外の生成器要求だけ true(空白帯・週末)', () => {
    expect(isGeneratorRequestOutOfSession({ caller: 'generator' }, {}, GAP)).toBe(true);
    expect(isGeneratorRequestOutOfSession({ caller: 'generator' }, {}, WEEKEND)).toBe(true);
  });

  it('場中の生成器要求は通す(Day / Night とも)', () => {
    expect(isGeneratorRequestOutOfSession({ caller: 'generator' }, {}, IN_DAY)).toBe(false);
    expect(isGeneratorRequestOutOfSession({ caller: 'generator' }, {}, IN_NIGHT)).toBe(false);
  });

  it('★実弾につながる経路(caller 省略 / default)は場外でも一切弾かない', () => {
    expect(isGeneratorRequestOutOfSession({}, {}, WEEKEND)).toBe(false);
    expect(isGeneratorRequestOutOfSession({ caller: 'default' }, {}, WEEKEND)).toBe(false);
    expect(isGeneratorRequestOutOfSession({}, {}, GAP)).toBe(false);
  });

  it('query 文字列の caller も見る(body と同じ扱い)', () => {
    expect(isGeneratorRequestOutOfSession({}, { caller: 'generator' }, GAP)).toBe(true);
  });

  it('不正な caller はここでは弾かない(ハンドラが 400 で理由付きに落とす)', () => {
    expect(isGeneratorRequestOutOfSession({ caller: 'GENERATOR' }, {}, GAP)).toBe(false);
  });

  it('body / query が無くても落ちない', () => {
    expect(isGeneratorRequestOutOfSession(undefined, undefined, GAP)).toBe(false);
  });
});

describe('generatorSessionGate(ミドルウェア)', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue({ ok: true, plan: { direction: 'buy' } });
    captureMock.mockReset().mockResolvedValue({ buffer: Buffer.from('png'), reason: null });
    visionMock.mockReset().mockReturnValue({ name: 'gemini' });   // ★撮影が起きうる条件を作る
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  /** ミドルウェア → (通れば)ハンドラ、という本番の並びを再現する。 */
  async function post(body: Record<string, unknown>, now: number): Promise<MockRes> {
    vi.setSystemTime(now);
    const res = mockRes();
    let passed = false;
    const next: NextFunction = () => { passed = true; };
    generatorSessionGate(reqOf(body), res, next);
    if (passed) await scalpPlanHandler(reqOf(body), res);
    return res;
  }

  it('★場外の生成器要求は 429 closed。**撮影も LLM も予算計上も起きない**', async () => {
    const res = await post({ caller: 'generator' }, GAP);

    expect(res._status).toBe(429);
    expect((res._json as { error: string }).error).toBe('closed');
    expect(captureMock).not.toHaveBeenCalled();        // ★Chrome を起動していない
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
    expect(generatorGateSnapshot(GAP).used).toBe(0);   // ★予算を1回も食っていない
  });

  it('★週末の生成器要求も同じく弾く', async () => {
    const res = await post({ caller: 'generator', exitVariant: 'current' }, WEEKEND);
    expect(res._status).toBe(429);
    expect(captureMock).not.toHaveBeenCalled();
  });

  it('場中の生成器要求は通す(撮影と AI に到達する)', async () => {
    const res = await post({ caller: 'generator' }, IN_DAY);
    expect(res._status).toBe(200);
    expect(captureMock).toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
  });

  it('★レガシー経路は場外でも従来どおり通る(実弾側の挙動を1ミリも変えない)', async () => {
    const res = await post({}, WEEKEND);
    expect(res._status).toBe(200);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(res._json)).toBe('{"ok":true,"plan":{"direction":"buy"}}');
  });

  it('429 応答にキーの類も決済の数値も含まれない', async () => {
    const res = await post({ caller: 'generator' }, GAP);
    const s = JSON.stringify(res._json);
    expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
    expect(s).not.toMatch(/\d{2,}/);
  });
});
