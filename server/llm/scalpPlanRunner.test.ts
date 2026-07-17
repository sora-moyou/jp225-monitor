import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// runScalpPlanWithChart(route と signalTrade エンジンが共有する共通関数)の逐次オンデマンドゲートを検証する。
// 依存(LLM/キャッシュ/技術/撮影/ポート)をモックし:
//   - vision適用 + 撮影成功 → buildScalpPlan が画像添付で呼ばれ、その結果をそのまま返す
//   - vision適用 + 撮影失敗(buffer=null) → buildScalpPlan を呼ばず { ok:false, error:'chart-not-generated' }
//   - vision非対応 / SCALP_CHART_VISION 無効 → 撮影せず画像なしで buildScalpPlan を呼ぶ(ゲート対象外)
//   - LC override を渡さない → buildScalpPlan に lcFloorYen/lcCeilingYen=undefined で渡す(＝config 既定に委ねる)
//   - LC override を渡す → そのまま buildScalpPlan へ透過する
// を確認する。LC 上限/バイアスの実際の強制は buildScalpPlan(enforcePlanConstraints)側でテスト済。

const buildScalpPlanMock = vi.fn();
const firstVisionMock = vi.fn<[], { name: string } | null>();
vi.mock('./openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => firstVisionMock(),
}));

vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));

vi.mock('../chatContext.js', () => ({
  buildNikkeiTechnical: () => '■ テクニカル',
}));

const trendVetoYenMock = vi.fn<[], number>(() => 100);
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => trendVetoYenMock(),
}));

// barsFor(リアルタイム足 {t,close})をテストで差し替え。既定は空(=regime flat)。
const barsForMock = vi.fn<[], { t: number; close: number }[]>(() => []);
vi.mock('../loops/alertLoop.js', () => ({
  barsFor: () => barsForMock(),
}));

const captureMock = vi.fn<[number], Promise<{ buffer: Buffer | null; reason: string | null; chromePath: string | null; chromeVersion: string | null }>>();
vi.mock('../chart/chartShot.js', () => ({
  captureChartPng: (port: number) => captureMock(port),
}));

import { runScalpPlanWithChart } from './scalpPlanRunner.js';

const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

describe('runScalpPlanWithChart — shared on-demand chart-generation gate', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    firstVisionMock.mockReset();
    captureMock.mockReset();
    barsForMock.mockReset().mockReturnValue([]);
    trendVetoYenMock.mockReset().mockReturnValue(100);
    delete process.env.SCALP_CHART_VISION;
  });
  afterEach(() => {
    delete process.env.SCALP_CHART_VISION;
  });

  it('vision applies + capture succeeds → attaches image and returns plan', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    const png = Buffer.from('png-bytes');
    captureMock.mockResolvedValue({ buffer: png, reason: null, chromePath: 'c', chromeVersion: 'v1' });

    const result = await runScalpPlanWithChart();

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(result).toEqual(GOOD_PLAN);
  });

  it('vision applies + capture fails (buffer=null) → chart-not-generated, AI NOT called (見送り)', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: null, reason: 'chart-ready-timeout', chromePath: 'c', chromeVersion: 'v1' });

    const result = await runScalpPlanWithChart();

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, error: 'chart-not-generated' });
  });

  it('no vision-capable provider → no capture, AI called with null image (no gate)', async () => {
    firstVisionMock.mockReturnValue(null);

    const result = await runScalpPlanWithChart();

    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBeNull();
    expect(result).toEqual(GOOD_PLAN);
  });

  it('SCALP_CHART_VISION=0 → no capture, no vision lookup, AI called with null image', async () => {
    process.env.SCALP_CHART_VISION = '0';
    firstVisionMock.mockReturnValue({ name: 'gemini' });   // 有効でも参照されないはず

    const result = await runScalpPlanWithChart();

    expect(firstVisionMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBeNull();
    expect(result).toEqual(GOOD_PLAN);
  });

  it('no LC override → passes lcFloorYen/lcCeilingYen undefined (config 既定に委ねる)', async () => {
    firstVisionMock.mockReturnValue(null);   // ゲート対象外(撮影不要)

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as { lcFloorYen?: number; lcCeilingYen?: number };
    expect(arg.lcFloorYen).toBeUndefined();
    expect(arg.lcCeilingYen).toBeUndefined();
  });

  it('LC override → passed through to buildScalpPlan', async () => {
    firstVisionMock.mockReturnValue(null);

    await runScalpPlanWithChart({ lcFloorYen: 50, lcCeilingYen: 90 });

    const arg = buildScalpPlanMock.mock.calls[0][0] as { lcFloorYen?: number; lcCeilingYen?: number };
    expect(arg.lcFloorYen).toBe(50);
    expect(arg.lcCeilingYen).toBe(90);
  });

  it('勢い注入 + trend スレッド: 強上昇の足で buildScalpPlan に trend{dir:up,strong} と勢い文が渡る', async () => {
    firstVisionMock.mockReturnValue(null);   // ゲート対象外
    const now = Date.now();
    // now−10分 で 38000、now で 38200(+200円 ≥ 閾値100) → 強上昇。
    barsForMock.mockReturnValue([
      { t: now - 10 * 60_000, close: 38000 },
      { t: now - 5 * 60_000, close: 38100 },
      { t: now, close: 38200 },
    ]);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as {
      trend?: { dir: string; strong: boolean }; technical?: string;
    };
    expect(arg.trend).toEqual({ dir: 'up', strong: true });
    expect(arg.technical).toContain('直近の勢い');
    expect(arg.technical).toContain('上昇トレンド(強)');
  });

  it('trendVeto=0(無効) → trend を渡さない(veto なし=現行挙動)が勢い文は注入する', async () => {
    firstVisionMock.mockReturnValue(null);
    trendVetoYenMock.mockReturnValue(0);
    const now = Date.now();
    barsForMock.mockReturnValue([
      { t: now - 10 * 60_000, close: 38000 },
      { t: now, close: 38200 },
    ]);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as {
      trend?: unknown; technical?: string;
    };
    expect(arg.trend).toBeUndefined();
    expect(arg.technical).toContain('直近の勢い');
  });
});
