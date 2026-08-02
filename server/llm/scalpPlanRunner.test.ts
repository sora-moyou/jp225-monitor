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
// ★レンジ両面の実効許可値。buildScalpPlan の rangeLine と同じ SSOT を runner も呼ぶ(勢い1行の文言に使う)。
const rangeEnabledMock = vi.fn<[unknown?], boolean>(() => false);
vi.mock('./openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => firstVisionMock(),
  resolveEffectiveRangeEnabled: (...a: unknown[]) => rangeEnabledMock(...a),
}));

vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));

vi.mock('../chatContext.js', () => ({
  buildNikkeiTechnical: () => '■ テクニカル',
}));

const trendVetoYenMock = vi.fn<[], number>(() => 100);
const chartFallbackMock = vi.fn<[], boolean>();
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => trendVetoYenMock(),
  resolveScalpChartFallbackText: () => chartFallbackMock(),
  resolveIndicatorsEnabled: () => true,
}));

// ★v0.9.38: レジームの入力はリアルタイム足(feedBars・分内高安つき)を直接使う。
//   モックせず本物へ feedRealtimePrice で投入する(既定は空=regime flat)。

// ★引数を全部そのまま記録する(port だけでなく caller も)。撮影キャッシュは caller ごとに
//   隔離されるので、runner が自分の caller を撮影側へ渡していることを固定する。
const captureMock = vi.fn<unknown[], Promise<{ buffer: Buffer | null; reason: string | null; chromePath: string | null; chromeVersion: string | null }>>();
vi.mock('../chart/chartShot.js', () => ({
  captureChartPngCached: (...a: unknown[]) => captureMock(...a),
}));

// v0.7.54: 構造化データ(rich context)の DB 読みは本テストの対象外。DB/levels/scalpContext をモックして
// 実 DB を触らせず、technical への追記が既存の勢い1行を壊さないことだけ担保する(rich は '' でオフ)。
const openDbMock = vi.fn<[], { close: () => void }>(() => ({ close: () => {} }));
vi.mock('../db/store.js', () => ({
  openDb: () => openDbMock(),
  resolveDbPath: () => ':memory:',
  getRecentBars: () => [],
  getRecentAlerts: () => [],
  getSessionOHLC: () => [],
  getSignalTrades: () => [],
}));
vi.mock('../loops/levelsLoop.js', () => ({
  getLevelsSnapshot: () => ({ current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 }),
}));
// 既定は '' (rich context オフ)。DB オープン失敗時に「メモリ足で文脈を組めるか」を見るため入力を記録する。
const marketDataMock = vi.fn<[{ bars: { t: number }[] }], string>(() => '');
vi.mock('./scalpContext.js', () => ({
  buildScalpMarketData: (i: { bars: { t: number }[] }) => marketDataMock(i),
  buildScalpTradeHistory: () => '',
}));

import { runScalpPlanWithChart } from './scalpPlanRunner.js';
import { feedRealtimePrice, _reset as resetBars } from '../feedBars.js';

const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

describe('runScalpPlanWithChart — shared on-demand chart-generation gate', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    firstVisionMock.mockReset();
    captureMock.mockReset();
    trendVetoYenMock.mockReset().mockReturnValue(100);
    rangeEnabledMock.mockReset().mockReturnValue(false);   // 既定 OFF=レンジへ誘導しない
    chartFallbackMock.mockReset().mockReturnValue(true);   // 既定=テキスト縮退ON
    openDbMock.mockReset().mockImplementation(() => ({ close: () => {} }));
    marketDataMock.mockReset().mockReturnValue('');
    resetBars();
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

  // ★撮影キャッシュの呼び出し元分離: runner は自分の caller を撮影側へ渡す。
  //   渡さないと生成器の撮影が A のキャッシュを温め、A が「毎サイクル撮り直す」不変条件が壊れる。
  it('★caller を撮影キャッシュへ渡す(既定=default / 生成器=generator)', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: Buffer.from('png'), reason: null, chromePath: 'c', chromeVersion: 'v1' });

    await runScalpPlanWithChart();                              // 既存の呼び出し元(A/B エンジン・既存 route)
    expect(captureMock.mock.calls[0]![3]).toBe('default');      // 第4引数=caller

    await runScalpPlanWithChart({ caller: 'generator' });       // 提案生成器
    expect(captureMock.mock.calls[1]![3]).toBe('generator');
  });

  // DB が開けない環境(破損/権限/ロック)でも、メモリ内ライブ足があるなら AI 文脈を組む。
  // indicatorsLoop(DB無しでも継続)と挙動を揃える=DB 一発で文脈ゼロにしない。
  it('★openDb 失敗でもメモリ内ライブ足で構造化データ文脈を組む', async () => {
    firstVisionMock.mockReturnValue(null);
    openDbMock.mockImplementation(() => { throw new Error('database is locked'); });
    const now = Date.now();
    const start = Math.floor((now - 30 * 60_000) / 60_000) * 60_000;
    for (let i = 0; i < 30; i++) feedRealtimePrice('NIY=F', 38200 + i, start + i * 60_000);

    await runScalpPlanWithChart();

    expect(marketDataMock).toHaveBeenCalledTimes(1);
    const input = marketDataMock.mock.calls[0]![0];
    expect(input.bars.length).toBeGreaterThan(0);   // DB 無しでも足が渡る
  });

  it('★fallback ON(既定): capture 2回失敗 → リトライ後テキストのみで AI 継続(画像なし)', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: null, reason: 'chart-ready-timeout', chromePath: 'c', chromeVersion: 'v1' });

    const result = await runScalpPlanWithChart();

    expect(captureMock).toHaveBeenCalledTimes(2);   // ★1回リトライ
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);   // ★テキストのみでも呼ぶ
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl == null).toBe(true);
    expect(result).toEqual(GOOD_PLAN);
  });

  it('★fallback OFF: capture 2回失敗 → 見送り(chart-not-generated・AI呼ばない)', async () => {
    chartFallbackMock.mockReturnValue(false);
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: null, reason: 'chart-ready-timeout', chromePath: 'c', chromeVersion: 'v1' });

    const result = await runScalpPlanWithChart();

    expect(captureMock).toHaveBeenCalledTimes(2);
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

  it('armedContext override → passed through to buildScalpPlan(レンジ再評価)', async () => {
    firstVisionMock.mockReturnValue(null);

    await runScalpPlanWithChart({ armedContext: { mode: 'range-fade', ageMs: 600_000, avgMs: 180_000 } });

    const arg = buildScalpPlanMock.mock.calls[0][0] as { armedContext?: { mode: string; ageMs: number; avgMs: number } };
    expect(arg.armedContext).toEqual({ mode: 'range-fade', ageMs: 600_000, avgMs: 180_000 });
  });

  it('armedContext 未指定 → buildScalpPlan に armedContext を渡さない(byte 一致)', async () => {
    firstVisionMock.mockReturnValue(null);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as { armedContext?: unknown };
    expect(arg.armedContext).toBeUndefined();
  });

  it('勢い注入 + trend スレッド: 強上昇の足で buildScalpPlan に trend{dir:up,strong} と勢い文が渡る', async () => {
    firstVisionMock.mockReturnValue(null);   // ゲート対象外
    const now = Date.now();
    // now−10分 で 38000、now で 38200(+200円 ≥ 閾値100) → 強上昇。
    feedRealtimePrice('NIY=F', 38000, now - 10 * 60_000);
    feedRealtimePrice('NIY=F', 38100, now - 5 * 60_000);
    feedRealtimePrice('NIY=F', 38200, now);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as {
      trend?: { dir: string; strong: boolean }; technical?: string;
    };
    expect(arg.trend).toEqual({ dir: 'up', strong: true });
    expect(arg.technical).toContain('直近の勢い');
    expect(arg.technical).toContain('上昇トレンド(強)');
  });

  // ★v0.9.38: レジームの高安は分内の実レンジで出す(終値で潰さない)。
  //   dir/strong は ret10(終値差)だけで決まるので、レンジが広がっても veto 判断は変わらない。
  it('★勢い行の「直近30分高安」は分内の実レンジ(終値ベースで潰さない)・dir/strong は不変', async () => {
    firstVisionMock.mockReturnValue(null);
    // 分内サンプルが分を跨がないよう分境界に揃える(足の区切りは floor(t/60秒))。
    const base = Math.floor(Date.now() / 60_000) * 60_000;
    // 終値は全て 38000(ret10=0=flat)だが、分内では 38300 まで上げて 37800 まで下げている。
    feedRealtimePrice('NIY=F', 38000, base - 10 * 60_000);
    feedRealtimePrice('NIY=F', 38300, base - 10 * 60_000 + 20_000);   // 分内高値
    feedRealtimePrice('NIY=F', 38000, base - 10 * 60_000 + 40_000);
    feedRealtimePrice('NIY=F', 37800, base - 5 * 60_000);             // 分内安値
    feedRealtimePrice('NIY=F', 38000, base - 5 * 60_000 + 30_000);
    feedRealtimePrice('NIY=F', 38000, base);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0]![0] as {
      trend?: { dir: string; strong: boolean }; technical?: string;
    };
    // 高安は終値の範囲(38000-38000)ではなく実レンジ(37800-38300)になる。
    expect(arg.technical).toContain('直近30分高安[37800-38300]');
    // 終値差(ret10=0)は変わらないので dir/strong=veto 判断は不変。
    expect(arg.trend).toEqual({ dir: 'flat', strong: false });
  });

  it('trendVeto=0(無効) → trend を渡さない(veto なし=現行挙動)が勢い文は注入する', async () => {
    firstVisionMock.mockReturnValue(null);
    trendVetoYenMock.mockReturnValue(0);
    const now = Date.now();
    feedRealtimePrice('NIY=F', 38000, now - 10 * 60_000);
    feedRealtimePrice('NIY=F', 38200, now);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0][0] as {
      trend?: unknown; technical?: string;
    };
    expect(arg.trend).toBeUndefined();
    expect(arg.technical).toContain('直近の勢い');
  });

  // ★勢い1行のレンジ文言は設定連動(system prompt の rangeLine と同じ SSOT を使う)。
  it('レンジ両面OFF(既定)の横ばい局面 → 勢い行はレンジへ誘導しない', async () => {
    firstVisionMock.mockReturnValue(null);
    rangeEnabledMock.mockReturnValue(false);
    const now = Date.now();
    feedRealtimePrice('NIY=F', 38000, now - 10 * 60_000);
    feedRealtimePrice('NIY=F', 38000, now);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0]![0] as { technical?: string };
    expect(arg.technical).toContain('横ばい');
    expect(arg.technical).not.toContain('direction:"range"');
  });

  it('レンジ両面ONの横ばい局面 → 勢い行が range(fade/breakout の2択)を出してよいと伝える', async () => {
    firstVisionMock.mockReturnValue(null);
    rangeEnabledMock.mockReturnValue(true);
    const now = Date.now();
    feedRealtimePrice('NIY=F', 38000, now - 10 * 60_000);
    feedRealtimePrice('NIY=F', 38000, now);

    await runScalpPlanWithChart();

    const arg = buildScalpPlanMock.mock.calls[0]![0] as { technical?: string };
    expect(arg.technical).toContain('direction:"range"');
    // ★v0.9.44: 語彙は system prompt の rangeLine と揃える(SSOT)=2択の組で表現する。
    expect(arg.technical).toContain('breakout=両側ブレイク新規の組');
  });

  it('レンジ設定の解決にプロファイル(A/B)を引き継ぐ', async () => {
    firstVisionMock.mockReturnValue(null);

    await runScalpPlanWithChart({ profile: 'B' });

    expect(rangeEnabledMock).toHaveBeenCalledWith('B');
  });
});
