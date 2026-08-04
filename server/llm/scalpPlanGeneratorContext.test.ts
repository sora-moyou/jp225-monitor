import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ★生成器のプロンプトから「A の紙成績」を外す(母集団の独立性) ─────────────────
//
// 何を守っているか(サブリーダー指摘 D1):
//   紙成績の履歴は **A の建玉列** = A の決済設定の関数。これを生成器に見せると、
//   ②(候補の決済仕様を教えた腕)は「候補で建てろ」と言われながら **現行決済で決済された成績表**
//   を読むことになり、①vs② の対比が汚染される(しかも②の適応を弱める=帰無側へ倒す)。
//   → **両腕から等しく** 外す。外した事実は応答(contextOmitted)に載せて台帳へ記録する。
//
// ★A/B(caller 省略/'default'=実弾につながる経路)は1ミリも変えない:
//   紙成績は従来どおり読む(getSignalTrades を呼ぶ)し、結果のフィールドも増えない。
//
// ★否定対照(実証手順):
//   git show HEAD:server/llm/scalpPlanRunner.ts > /tmp/old.ts && copy → 実行すると
//   「generator では紙成績を読まない」「contextOmitted が載る」が赤になる(旧版は必ず読む)。

const buildScalpPlanMock = vi.fn();
vi.mock('./openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,          // 撮影経路は通らない(text-only)
  resolveEffectiveRangeEnabled: () => false,
}));
vi.mock('../cache.js', () => ({ getPrices: () => [{ symbol: 'NIY=F', price: 38250 }], getNews: () => [] }));
vi.mock('../chatContext.js', () => ({ buildNikkeiTechnical: () => 'tech' }));
vi.mock('../feedBars.js', () => ({ getRealtimeOHLCBars: () => [] }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 0,
  resolveScalpChartFallbackText: () => true,
  resolveIndicatorsEnabled: () => true,
  // ★バンドウォーク判定の依存(v0.9.61)。目線 'none' = 判定しない = 従来と同じ文脈になる。
  resolveBandwalkEnabled: () => true,
  resolveEffectiveScalpBias: () => 'none',
  resolveShockParams: () => ({ move1: 45, move2: 55, shock1: 50, shock2: 70, accelTh: 10, avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2, scoreNeed: 5 }),
}));

// ★紙成績の取得そのものを観測する(呼ばれたかどうかが論点)。
const getSignalTradesMock = vi.fn(() => [{ id: 1 }]);
vi.mock('../db/store.js', () => ({
  openDb: () => ({ close: () => { /* noop */ } }),
  resolveDbPath: () => ':memory:',
  getRecentAlerts: () => [],
  getSessionOHLC: () => [],
  getSignalTrades: (...a: unknown[]) => getSignalTradesMock(...(a as [])),
}));
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: () => null }));
vi.mock('../barsSource.js', () => ({ collectRecentBars: () => [] }));

// 紙成績ブロックは「呼ばれたら必ず本文に出る」ようにして、プロンプトからも消えたことを見る。
const tradeHistoryMock = vi.fn(() => '■ 紙成績(A の履歴)');
vi.mock('./scalpContext.js', () => ({
  buildScalpMarketData: () => '■ 市場データ',
  buildScalpTradeHistory: (...a: unknown[]) => tradeHistoryMock(...(a as [])),
}));

import { runScalpPlanWithChart, GENERATOR_OMITTED_CONTEXT } from './scalpPlanRunner.js';

const PLAN_RESULT = { ok: true, plan: { direction: 'none' } };
const technicalOf = (call: number): string =>
  (buildScalpPlanMock.mock.calls[call]![0] as { technical: string }).technical;

describe('生成器のプロンプト: A の紙成績を外す(両腕とも)', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(PLAN_RESULT);
    getSignalTradesMock.mockClear();
    tradeHistoryMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  });

  it("★caller:'generator' は紙成績を **DB からも読まない**(履歴ブロックがプロンプトに出ない)", async () => {
    await runScalpPlanWithChart({ caller: 'generator' });
    expect(getSignalTradesMock).not.toHaveBeenCalled();
    expect(tradeHistoryMock).not.toHaveBeenCalled();
    expect(technicalOf(0)).toContain('■ 市場データ');
    expect(technicalOf(0)).not.toContain('紙成績');
  });

  it('★候補の腕(exitVariant 指定)でも同じ=両腕から等しく外れている', async () => {
    await runScalpPlanWithChart({ caller: 'generator', exitVariant: 'current' });
    await runScalpPlanWithChart({ caller: 'generator', exitVariant: 'candidate-a' });
    expect(getSignalTradesMock).not.toHaveBeenCalled();
    expect(technicalOf(0)).toBe(technicalOf(1));   // 同じ文脈(決済ブロックの差は buildScalpPlan 側)
  });

  it('★外したことが結果に記録される(contextOmitted → 応答 → 台帳)', async () => {
    const r = await runScalpPlanWithChart({ caller: 'generator' }) as Record<string, unknown>;
    expect(r.contextOmitted).toEqual(GENERATOR_OMITTED_CONTEXT);
    expect(GENERATOR_OMITTED_CONTEXT).toContain('paper-trade-history');
  });

  it('★A/B(caller 省略)は従来どおり紙成績を読む(1ミリも変えない)', async () => {
    await runScalpPlanWithChart({});
    expect(getSignalTradesMock).toHaveBeenCalledTimes(1);
    expect(getSignalTradesMock).toHaveBeenCalledWith(expect.anything(), 30, 'A');
    expect(technicalOf(0)).toContain('紙成績');
  });

  it("★A/B(caller:'default' 明示 / profile B)も従来どおり読む・結果のフィールドも増えない", async () => {
    const r = await runScalpPlanWithChart({ caller: 'default', profile: 'B' });
    expect(getSignalTradesMock).toHaveBeenCalledWith(expect.anything(), 30, 'B');
    expect(r).toBe(PLAN_RESULT);                      // 同一参照=コピーすらしていない
    expect(Object.keys(r)).toEqual(['ok', 'plan']);
  });
});
