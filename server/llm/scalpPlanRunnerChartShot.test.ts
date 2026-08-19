import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── runScalpPlanWithChart: 撮影の同一性を **分析用の結果にだけ** additive で載せる ──────
//
// 何を守っているか:
//   ・分析用(caller='generator')の提案には「どの1枚を見たか」が付く(①②の対応比較の土台)
//   ・★実取引(A)につながる既存の全経路(caller 省略/'default')の結果オブジェクトは **不変**
//     (engine.ts はこの結果を読んで発注につながる判断をするので、形を1ミリも変えない)
//
// ★否定対照: attachChartShot の caller ガードを外すと「default では増えない」が赤。
//   attachChartShot 自体を消すと「generator では付く」が赤。
//   実証手順: git show HEAD:server/llm/scalpPlanRunner.ts で旧版に差し替えて実行(両方赤)。

const buildScalpPlanMock = vi.fn();
vi.mock('./openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => ({ name: 'gemini', chatModel: 'g' }),
  resolveEffectiveRangeEnabled: () => false,
}));
vi.mock('../cache.js', () => ({ getPrices: () => [{ symbol: 'NIY=F', price: 38250 }], getNews: () => [] }));
vi.mock('../chatContext.js', () => ({ buildNikkeiTechnical: () => 'tech' }));
vi.mock('../feedBars.js', () => ({ getRealtimeOHLCBars: () => [] }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 0,
  resolveScalpChartFallbackText: () => true,
  // ★このテストは「どの1枚を見たか」を対象にするので、必ず画像あり(ab + コイン投げ固定)にする。
  resolveScalpChartVisionMode: () => 'ab' as const,
  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => 1000,
}));
vi.mock('../db/store.js', () => ({
  openDb: () => { throw new Error('no db'); },
  resolveDbPath: () => ':memory:',
  getRecentAlerts: () => [], getSessionOHLC: () => [], getSignalTrades: () => [],
}));
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: () => null }));
vi.mock('../barsSource.js', () => ({ collectRecentBars: () => [] }));

const captureMock = vi.fn();
vi.mock('../chart/chartShot.js', () => ({
  captureChartPngCached: (...a: unknown[]) => captureMock(...a),
}));

import { runScalpPlanWithChart, setChartVisionRngForTest } from './scalpPlanRunner.js';

const SHOT = {
  buffer: Buffer.from('png'), chromePath: 'c', chromeVersion: 'v', reason: null,
  identity: { shotId: 'aa-1', ageMs: 30_000, origin: 'cache' },
};
const PLAN_RESULT = { ok: true, plan: { direction: 'none', rationale: 'x', refPrice: 38250 } };

let restoreRng: () => void = () => {};

describe('提案に「どの1枚を見たか」を載せる', () => {
  beforeEach(() => {
    // ★v0.9.70: mode='ab' はコイン投げなので、テストでは必ず画像あり側に固定する(でないと 50% で落ちる)。
    restoreRng = setChartVisionRngForTest(() => 0);
    captureMock.mockReset().mockResolvedValue(SHOT);
    buildScalpPlanMock.mockReset().mockResolvedValue(PLAN_RESULT);
    vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
    vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
  });
  afterEach(() => { restoreRng(); });

  it("caller:'generator' の結果に chartShot が付く", async () => {
    const r = await runScalpPlanWithChart({ caller: 'generator' }) as Record<string, unknown>;
    expect(r.chartShot).toEqual({ shotId: 'aa-1', ageMs: 30_000, origin: 'cache' });
  });

  // ★記録専用の出所2列(contextAt/promptFp)は **全経路** で載る(凍結再生の突合用)。
  //   ここで守り続けているのは「分析用だけの記録(chartShot / contextOmitted)が A の結果に混ざらない」こと。
  //   plan は参照ごと素通し=engine が読む中身は1ミリも変わらない。
  const generatorOnlyKeys = (r: object): string[] =>
    // ★v0.9.88: trendDir を除外に追加(全経路で載る記録であって、分析用だけの記録ではない)。
    // ★v0.9.93: appVersion / promptBuild を除外に追加。理由は同じで、これらは **全経路で載る**
    //   記録(この行を書いた版とプロンプトの型)であり、分析用だけの記録ではない。むしろ
    //   **A(実取引につながる経路)の台帳にこそ必要**(版が記録に無いと解析が間接推定に落ちる)。
    Object.keys(r).filter(k => k !== 'ok' && k !== 'plan' && k !== 'contextAt' && k !== 'promptFp'
      && k !== 'chartVision' && k !== 'trendDir' && k !== 'appVersion' && k !== 'promptBuild');

  it('★caller 省略(実取引 A の経路)の結果に **分析用だけの記録は1つも付かない**', async () => {
    const r = await runScalpPlanWithChart({});
    expect(generatorOnlyKeys(r)).toEqual([]);
    expect((r as { plan: unknown }).plan).toBe(PLAN_RESULT.plan);   // plan は同一参照=コピーすらしていない
  });

  it("caller:'default' を明示しても付かない", async () => {
    const r = await runScalpPlanWithChart({ caller: 'default' });
    expect(generatorOnlyKeys(r)).toEqual([]);
    expect((r as { plan: unknown }).plan).toBe(PLAN_RESULT.plan);
  });

  it('撮影側が identity を返さない場合は付けない(画像の同一性は不明として記録側に NULL を渡す)', async () => {
    captureMock.mockResolvedValue({ buffer: Buffer.from('png'), chromePath: 'c', chromeVersion: 'v', reason: null });
    const r = await runScalpPlanWithChart({ caller: 'generator' });
    expect(Object.prototype.hasOwnProperty.call(r, 'chartShot')).toBe(false);
  });

  it('撮影が2回とも失敗して見送りになった結果には付けない(ok:false)', async () => {
    captureMock.mockResolvedValue({ buffer: null, chromePath: 'c', chromeVersion: 'v', reason: 'ws-error', identity: null });
    const r = await runScalpPlanWithChart({ caller: 'generator' });
    expect(r.ok).toBe(true);   // 既定はテキスト縮退(resolveScalpChartFallbackText=true)なので継続
    expect(Object.prototype.hasOwnProperty.call(r, 'chartShot')).toBe(false);
  });

  it('★撮影は自分の caller のプールで行う(A のキャッシュを温めない)', async () => {
    await runScalpPlanWithChart({ caller: 'generator' });
    expect(captureMock).toHaveBeenCalledWith(3000, undefined, undefined, 'generator');
  });
});

