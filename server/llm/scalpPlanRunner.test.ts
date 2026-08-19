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
// ★v0.9.70: チャート画像の送信モード。既定 'off'(送らない・撮影もしない)。
//   画像ゲートを対象にするテストだけ 'ab' + コイン投げ固定にして「必ず画像あり」を作る。
const chartVisionModeMock = vi.fn<[], 'off' | 'ab'>(() => 'off');
let restoreRng: () => void = () => {};
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => trendVetoYenMock(),
  resolveScalpChartFallbackText: () => chartFallbackMock(),
  resolveScalpChartVisionMode: () => chartVisionModeMock(),
  resolveIndicatorsEnabled: () => true,
  // ★バンドウォーク判定の依存(v0.9.61)。目線 'none' = 判定しない = 従来と同じ文脈になる。
  resolveBandwalkEnabled: () => true,
  resolveEffectiveScalpBias: () => 'none',
  resolveShockParams: () => ({ move1: 45, move2: 55, shock1: 50, shock2: 70, accelTh: 10, avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2, scoreNeed: 5 }),
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

import { runScalpPlanWithChart, setChartVisionRngForTest, decideChartVision } from './scalpPlanRunner.js';
import { feedRealtimePrice, _reset as resetBars } from '../feedBars.js';

const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

/** ★記録専用の出所(contextAt=文脈を組み立てた時刻 / promptFp=プロンプトの指紋 /
 *  chartVision=そのサイクルのチャート画像の群 / trendDir=コードが測ったトレンドの向き)を落とした結果。
 *  これらは **全経路** で additive に載る(凍結再生の突合 / A/B の群の記録)。それ以外のフィールドは
 *  1つも増えないことを、以下の toEqual(GOOD_PLAN) が従来どおり固定し続ける。 */
function withoutProvenance(r: unknown): Record<string, unknown> {
  // ★v0.9.88: trendDir をここへ追加した理由(リーダーへ報告済み)。
  //   このヘルパは「**全経路で additive に載る記録**」を落とすためのもので、
  //   trendDir はまさにその類(分析用だけの記録ではない)。it の目的=「それ以外の
  //   フィールドが1つも増えない」は一ビットも緩めていない。
  const { contextAt: _c, promptFp: _p, chartVision: _v, trendDir: _t, ...rest } = r as Record<string, unknown>;
  return rest;
}

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
    // ★v0.9.70: チャート画像は既定 off。画像ゲートを対象にするテストは 'ab' + コイン投げ固定で
    //   「必ず画像あり」の群を作る(既定の off では撮影自体が走らないため)。
    chartVisionModeMock.mockReset().mockReturnValue('ab');
    restoreRng = setChartVisionRngForTest(() => 0);   // 0 < 0.5 = 常に画像あり群
    delete process.env.SCALP_CHART_VISION;
  });
  afterEach(() => {
    restoreRng();
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
    expect(withoutProvenance(result)).toEqual(GOOD_PLAN);
  });

  // ★撮影キャッシュの呼び出し元分離: runner は自分の caller を撮影側へ渡す。
  //   渡さないと分析用の撮影が A のキャッシュを温め、A が「毎サイクル撮り直す」不変条件が壊れる。
  it('★caller を撮影キャッシュへ渡す(既定=default / 分析用=generator)', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: Buffer.from('png'), reason: null, chromePath: 'c', chromeVersion: 'v1' });

    await runScalpPlanWithChart();                              // 既存の呼び出し元(A/B エンジン・既存 route)
    expect(captureMock.mock.calls[0]![3]).toBe('default');      // 第4引数=caller

    await runScalpPlanWithChart({ caller: 'generator' });       // 分析用
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
    expect(withoutProvenance(result)).toEqual(GOOD_PLAN);
  });

  it('★fallback OFF: capture 2回失敗 → 見送り(chart-not-generated・AI呼ばない)', async () => {
    chartFallbackMock.mockReturnValue(false);
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: null, reason: 'chart-ready-timeout', chromePath: 'c', chromeVersion: 'v1' });

    const result = await runScalpPlanWithChart();

    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
    expect(withoutProvenance(result)).toEqual({ ok: false, error: 'chart-not-generated' });
    // ★この回も群は残る(撮ろうとしたが送れなかった=requested:true / sent:false)。
    expect((result as { chartVision?: unknown }).chartVision).toEqual({ mode: 'ab', requested: true, sent: false });
  });

  it('no vision-capable provider → no capture, AI called with null image (no gate)', async () => {
    firstVisionMock.mockReturnValue(null);

    const result = await runScalpPlanWithChart();

    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBeNull();
    expect(withoutProvenance(result)).toEqual(GOOD_PLAN);
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
    expect(withoutProvenance(result)).toEqual(GOOD_PLAN);
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

// ─── ★v0.9.70: チャート画像の A/B(既定 off = 送らない・撮影もしない) ──────────────────
//
//  ★背景(稼働機のログの実測): 画像つきの呼び出しが1日約1,600回。1280x760・detail 未指定(=高精細)で、
//   無料枠(gemini)がレート制限で休むと groq は 413・kimi は 404 で必ず落ち、**OpenAI が全部かぶる**。
//   gpt-4o-mini は画像のトークン換算率が極端に高く、1枚で約36,800トークン → 1日5.5ドル(月165ドル)。
//   そして「画像が効いているか」は一度も測っていない(画像が事実上100%に付き、対照群が存在しない)。
describe('★チャート画像の A/B(既定 off)', () => {
  // ★この describe は上の describe の兄弟なので、上の beforeEach は走らない。
  //   モックは **ここで自分で初期化する**(共有モックの呼び出し回数が前の describe から持ち越されると、
  //   「撮影を呼んでいない」の検証が前のテストの呼び出しで落ちる=実際にそれで一度落とした)。
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    firstVisionMock.mockReset().mockReturnValue({ name: 'gemini' });
    captureMock.mockReset().mockResolvedValue({ buffer: Buffer.from('png'), reason: null, chromePath: 'c', chromeVersion: 'v1' });
    trendVetoYenMock.mockReset().mockReturnValue(100);
    rangeEnabledMock.mockReset().mockReturnValue(false);
    chartFallbackMock.mockReset().mockReturnValue(true);
    chartVisionModeMock.mockReset().mockReturnValue('off');
    openDbMock.mockReset().mockImplementation(() => ({ close: () => {} }));
    marketDataMock.mockReset().mockReturnValue('');
    resetBars();
    delete process.env.SCALP_CHART_VISION;
  });

  it('★off(既定): 撮影を1回も呼ばず、画像なしで AI を呼ぶ', async () => {
    chartVisionModeMock.mockReturnValue('off');
    await runScalpPlanWithChart();
    expect(captureMock).not.toHaveBeenCalled();                       // ★ヘッドレスChrome を起動しない
    expect(firstVisionMock).not.toHaveBeenCalled();                   // ★プロバイダの照会すらしない
    expect(buildScalpPlanMock.mock.calls[0]![0]).toMatchObject({ chartImageDataUrl: null });
  });

  it('★off: 群の記録は mode=off / requested=false / sent=false', async () => {
    chartVisionModeMock.mockReturnValue('off');
    const r = await runScalpPlanWithChart() as Record<string, unknown>;
    expect(r.chartVision).toEqual({ mode: 'off', requested: false, sent: false });
  });

  it('★ab: コイン投げが表なら撮って添付し、裏なら撮らない', async () => {
    chartVisionModeMock.mockReturnValue('ab');
    const restore = setChartVisionRngForTest(() => 0.99);   // 裏=画像なし
    await runScalpPlanWithChart();
    restore();
    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock.mock.calls[0]![0]).toMatchObject({ chartImageDataUrl: null });

    buildScalpPlanMock.mockClear();
    const restore2 = setChartVisionRngForTest(() => 0.0);   // 表=画像あり
    await runScalpPlanWithChart();
    restore2();
    expect(captureMock).toHaveBeenCalled();
    expect(String(buildScalpPlanMock.mock.calls[0]![0].chartImageDataUrl)).toContain('data:image/png;base64,');
  });

  it('★ab は概ね半分(十分な回数で偏りを見る)', () => {
    // 純関数で確かめる(runner 全体を1万回回すのではなく、割り当ての公平さだけを見る)。
    let n = 0;
    const N = 20000;
    let seed = 12345;
    const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < N; i++) if (decideChartVision('ab', false, rng).wantImage) n++;
    expect(n / N).toBeGreaterThan(0.47);
    expect(n / N).toBeLessThan(0.53);
  });

  it('★env(SCALP_CHART_VISION=0)は ab でも強制オフ(オンには倒せない)', () => {
    expect(decideChartVision('ab', true, () => 0).wantImage).toBe(false);
    expect(decideChartVision('off', false, () => 0).wantImage).toBe(false);
    // 逆向き(env でオンに倒す)は存在しない=課金の効く方向へ倒す入口を増やさない。
    expect(decideChartVision('off', false, () => 0).mode).toBe('off');
  });

  it('★sent は「実際に送ったか」: buildScalpPlan が imageSent:false を返せば requested:true でも sent:false', async () => {
    // = ビジョン非対応プロバイダへフォールバックして画像が外れた回の再現。
    chartVisionModeMock.mockReturnValue('ab');
    const restore = setChartVisionRngForTest(() => 0);
    buildScalpPlanMock.mockResolvedValue({ ...GOOD_PLAN, imageSent: false });
    const r = await runScalpPlanWithChart() as Record<string, unknown>;
    restore();
    expect(r.chartVision).toEqual({ mode: 'ab', requested: true, sent: false });
  });

  it('★sent=true になるのは buildScalpPlan が imageSent:true を返した時だけ', async () => {
    chartVisionModeMock.mockReturnValue('ab');
    const restore = setChartVisionRngForTest(() => 0);
    buildScalpPlanMock.mockResolvedValue({ ...GOOD_PLAN, imageSent: true });
    const r = await runScalpPlanWithChart() as Record<string, unknown>;
    restore();
    expect(r.chartVision).toEqual({ mode: 'ab', requested: true, sent: true });
  });
});
