import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// scalpPlanHandler の「逐次オンデマンドゲート(②生成→③確認→④戦略)」を検証する。
// 依存(LLM/キャッシュ/撮影)をモックし、AI 呼び出し(buildScalpPlan)が
//   - vision適用 + 撮影成功 → 呼ばれる(画像添付)
//   - vision適用 + 撮影失敗(buffer=null) → 呼ばれず ok:false 'chart-not-generated'
//   - vision非対応 / SCALP_CHART_VISION 無効 → 撮影せず画像なしで呼ばれる
// を確認する。

const buildScalpPlanMock = vi.fn();
const firstVisionMock = vi.fn<[], { name: string } | null>();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => firstVisionMock(),
}));

vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));

vi.mock('../chatContext.js', () => ({
  buildNikkeiTechnical: () => ({ summary: 'tech' }),
}));

vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
}));

const captureMock = vi.fn<[number], Promise<{ buffer: Buffer | null; reason: string | null; chromePath: string | null; chromeVersion: string | null }>>();
vi.mock('../chart/chartShot.js', () => ({
  captureChartPng: (port: number) => captureMock(port),
}));

import { scalpPlanHandler } from './scalpPlan.js';

function mockRes(): Response & { _json: unknown; _status: number } {
  const r = {
    _json: undefined as unknown,
    _status: 200,
    status(code: number) { r._status = code; return r; },
    json(body: unknown) { r._json = body; return r; },
  };
  return r as unknown as Response & { _json: unknown; _status: number };
}
const req = { body: {} } as Request;

const GOOD_PLAN = { ok: true, plan: { direction: 'buy' } };

describe('scalpPlanHandler — on-demand chart-generation gate', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(GOOD_PLAN);
    firstVisionMock.mockReset();
    captureMock.mockReset();
    delete process.env.SCALP_CHART_VISION;
  });
  afterEach(() => {
    delete process.env.SCALP_CHART_VISION;
  });

  it('vision applies + capture succeeds → attaches image and calls AI', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    const png = Buffer.from('png-bytes');
    captureMock.mockResolvedValue({ buffer: png, reason: null, chromePath: 'c', chromeVersion: 'v1' });
    const res = mockRes();

    await scalpPlanHandler(req, res);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect(res._json).toEqual(GOOD_PLAN);
  });

  it('vision applies + capture fails (buffer=null) → ok:false chart-not-generated, AI NOT called', async () => {
    firstVisionMock.mockReturnValue({ name: 'gemini' });
    captureMock.mockResolvedValue({ buffer: null, reason: 'chart-ready-timeout', chromePath: 'c', chromeVersion: 'v1' });
    const res = mockRes();

    await scalpPlanHandler(req, res);

    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(buildScalpPlanMock).not.toHaveBeenCalled();
    expect(res._json).toEqual({ ok: false, error: 'chart-not-generated' });
  });

  it('no vision-capable provider → no capture, AI called with null image (no gate)', async () => {
    firstVisionMock.mockReturnValue(null);
    const res = mockRes();

    await scalpPlanHandler(req, res);

    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBeNull();
    expect(res._json).toEqual(GOOD_PLAN);
  });

  it('SCALP_CHART_VISION=0 → no capture, no vision lookup, AI called with null image', async () => {
    process.env.SCALP_CHART_VISION = '0';
    firstVisionMock.mockReturnValue({ name: 'gemini' });   // 有効でも参照されないはず
    const res = mockRes();

    await scalpPlanHandler(req, res);

    expect(firstVisionMock).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
    expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
    const arg = buildScalpPlanMock.mock.calls[0][0] as { chartImageDataUrl: string | null };
    expect(arg.chartImageDataUrl).toBeNull();
    expect(res._json).toEqual(GOOD_PLAN);
  });
});
