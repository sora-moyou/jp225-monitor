import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── ★①と②が同じ画像を見たことを、仮定でなく記録にする(HTTP まで通す)────────────
//
// 何を守っているか:
//   生成器は1サイクルで ①現行仕様 → ②候補仕様 を直列に問う。「撮影キャッシュが60秒だから
//   同じ画像のはず」という **仮定** に依存していると、1サイクルが60秒を超えたときに
//   ②が別の画像を見たことを **誰にも分からない**。撮影の識別子と齢を応答に additive に載せ、
//   台帳に残せるようにする。
//
// ★同時に守る不変条件: **レガシー経路(caller 省略 かつ exitVariant 省略)の応答はバイト一致**。
//
// ★否定対照(修正前の routes/scalpPlan.ts / llm/scalpPlanRunner.ts):
//   応答に chartShot が一切載らない → 下の「識別子が応答に載る」「①と②の同一性が判定できる」が赤。
//   逆に planDiagnostics のゲート(diagnosticsOn)を外すと、レガシー経路のバイト一致が赤になる。
//   実証手順: git show HEAD:server/routes/scalpPlan.ts > /tmp/old.ts で差し替えて実行。

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
const shotOf = (shotId: string, ageMs: number, origin: string) => ({
  ok: true, plan: PLAN, chartShot: { shotId, ageMs, origin },
});

describe('/api/scalp-plan — 撮影の同一性を応答に載せる', () => {
  beforeEach(() => {
    runMock.mockReset();
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  });

  it('★レガシー経路(caller 省略 かつ exitVariant 省略)の応答は **バイト一致**', async () => {
    runMock.mockResolvedValue(shotOf('aa-1', 0, 'fresh'));
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    // 従来の応答は `{ ok:true, plan }` のみ。chartShot が漏れていないことを **キー集合** で固定する。
    expect(res._json).toEqual({ ok: true, plan: PLAN });
    expect(Object.keys(res._json as object)).toEqual(['ok', 'plan']);
  });

  it("caller:'generator' の応答は chartShot(識別子・齢・由来)を載せる", async () => {
    runMock.mockResolvedValue(shotOf('aa-1', 12_000, 'cache'));
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const b = res._json as Record<string, unknown>;
    expect(b.chartShot).toEqual({ shotId: 'aa-1', ageMs: 12_000, origin: 'cache' });
  });

  it('exitVariant を明示しただけ(caller 省略)でも載る=生成器から見て記録に穴が空かない', async () => {
    runMock.mockResolvedValue(shotOf('aa-2', 5_000, 'cache'));
    const res = mockRes();
    await scalpPlanHandler(reqOf({ exitVariant: 'candidate-a' }), res);
    expect((res._json as Record<string, unknown>).chartShot).toBeDefined();
  });

  it('★①と② が同じ画像を見たかを、応答だけで判定できる(仮定でなく記録)', async () => {
    // 1サイクル 30秒 = キャッシュ TTL 内 → 同じ shotId
    runMock.mockResolvedValueOnce(shotOf('same-1', 0, 'fresh'));
    const r1 = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'current' }), r1);
    runMock.mockResolvedValueOnce(shotOf('same-1', 30_000, 'cache'));
    const r2 = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), r2);
    const s1 = (r1._json as { chartShot: { shotId: string } }).chartShot;
    const s2 = (r2._json as { chartShot: { shotId: string } }).chartShot;
    expect(s2.shotId).toBe(s1.shotId);
  });

  it('★1サイクルが60秒を超えると「別の画像を見た」と記録される', async () => {
    runMock.mockResolvedValueOnce(shotOf('old-1', 0, 'fresh'));
    const r1 = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'current' }), r1);
    // TTL 超過 → monitor 側が撮り直す → 別の識別子・origin=fresh
    runMock.mockResolvedValueOnce(shotOf('new-1', 0, 'fresh'));
    const r2 = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'candidate-a' }), r2);
    const s1 = (r1._json as { chartShot: { shotId: string } }).chartShot;
    const s2 = (r2._json as { chartShot: { shotId: string } }).chartShot;
    expect(s2.shotId).not.toBe(s1.shotId);
  });

  it('画像を見ていない要求(chartShot 無し)ではフィールドを作らない(値が無いことを捏造しない)', async () => {
    runMock.mockResolvedValue({ ok: true, plan: PLAN });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect(Object.prototype.hasOwnProperty.call(res._json, 'chartShot')).toBe(false);
  });
});
