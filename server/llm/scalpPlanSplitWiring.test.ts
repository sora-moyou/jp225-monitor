import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Price } from '../types.js';

// ★段4(v0.9.100): **buildScalpPlan を実プロセスで走らせて** 経路の切り替えを確かめる。
//   LLM は呼ばず、provider の create だけを差し替える(= 実際に API へ渡る params を見る)。
//
// 何を守っているか:
//   ① ★分割 OFF(既定)= 旧経路。**1回だけ呼ばれ、ツール3本が付き、旧の全文が出る**
//   ② ★分割 ON = A→B の2回。★**A の呼び出しに tools が1つも付かない**
//   ③ ★A の max_tokens が小さく、B は従来どおり
//   ④ ★スイッチ1箇所(環境変数)を戻すだけで ①に戻る

const createMock = vi.fn();

vi.mock('./providers.js', () => ({
  NoFallbackError: class NoFallbackError extends Error {},
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
  formatErrForLog: (s: string) => s,
  callWithFallback: async (task: (p: unknown) => Promise<string>) =>
    task({ client: { chat: { completions: { create: createMock } } }, config: { name: 'test', chatModel: 'test-model' } }),
}));
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: false }),
  resolveScalpLcHardMax: () => ({ enabled: true, value: 159 }),
  resolveScalpAiTechnicalEnabled: () => true,
}));

const { buildScalpPlan } = await import('./scalpPlan.js');
const { resetPlanSplitForTest, PLAN_SPLIT_ENV } = await import('./planSplitConfig.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
/** 旧経路の契約(幅で答える)。 */
const OLD_JSON = JSON.stringify({
  direction: 'buy', limitEntry: REF - 20, stopEntry: REF + 20,
  lcWidthForLimit: 60, lcWidthForStop: 58, rationale: 'テスト', refPrice: REF,
});
const A_JSON = '{"direction":"bull","why":"高値切り上げ"}';
const B_JSON = JSON.stringify({
  strategy: '押し目', aPrice: REF + 20, aLcWidth: 60, aWhy: '節目手前',
  iPrice: REF - 20, iLcWidth: 58, iWhy: '押し目',
});

type Msg = { role: string; content: string | Array<{ text?: string }> };
type Params = { messages: Msg[]; tools?: unknown[]; max_tokens?: number };
const paramsOf = (i: number): Params => createMock.mock.calls[i]![0] as Params;
const textOf = (p: Params, role: string): string => {
  const m = p.messages.find(x => x.role === role)!;
  return typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('');
};

const ORIGINAL = process.env[PLAN_SPLIT_ENV];
function setSplit(on: boolean | undefined): void {
  if (on === undefined) delete process.env[PLAN_SPLIT_ENV];
  else process.env[PLAN_SPLIT_ENV] = on ? '1' : '0';
  resetPlanSplitForTest();
}
afterAll(() => { setSplit(undefined); if (ORIGINAL !== undefined) process.env[PLAN_SPLIT_ENV] = ORIGINAL; });
beforeEach(() => { createMock.mockReset(); });

const run = (): ReturnType<typeof buildScalpPlan> =>
  buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [], technical: '【B文脈】主要節目 39500', technicalForTrend: '【A文脈】足だけ' });

describe('① ★分割 OFF(既定)= 旧経路がそのまま走る', () => {
  it('LLM は1回だけ・ツール3本つき・旧の全文(【最優先: 価格の向き】)が出る', async () => {
    setSplit(undefined);   // ★環境変数を外す=既定(false)
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await run();
    expect(createMock.mock.calls.length).toBe(1);
    const p = paramsOf(0);
    expect((p.tools ?? []).length).toBe(3);
    expect(p.max_tokens).toBe(8000);
    const sys = textOf(p, 'system');
    // ★旧経路の目印(分割版のプロンプトには存在しない文)
    expect(sys).toContain('【最優先: 価格の向き');
    expect(sys).toContain('利用可能なデータツール');
    expect(sys).not.toContain('いまトレンドがあるか');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.direction).toBe('buy');
  });
});

describe('②③ ★分割 ON = A→B の2回。A にツールが1つも付かない', () => {
  beforeEach(() => {
    setSplit(true);
    createMock.mockReset();
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
  });

  it('★呼び出しは2回。1回目=A・2回目=B', async () => {
    const r = await run();
    expect(createMock.mock.calls.length).toBe(2);
    expect(textOf(paramsOf(0), 'system')).toContain('いまトレンドがあるか');
    expect(textOf(paramsOf(1), 'system')).toContain('スキャルピングを行うトレーダー');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopEntry).toBe(REF + 20);
      expect(r.plan.limitEntry).toBe(REF - 20);
      expect(r.plan.strategy).toBe('押し目');
    }
  });

  it('★A に渡す配列に tools が1つも無い(実際に渡す params を見る)', async () => {
    await run();
    const a = paramsOf(0);
    expect(a.tools).toBeUndefined();     // ★キーごと存在しない
    expect(JSON.stringify(a)).not.toContain('explain_move');
    expect(JSON.stringify(a)).not.toContain('query_alerts');
    expect(JSON.stringify(a)).not.toContain('price_history');
  });

  it('★B には従来どおり3本のツールが付く', async () => {
    await run();
    const b = paramsOf(1);
    expect((b.tools ?? []).length).toBe(3);
    expect(JSON.stringify(b.tools)).toContain('explain_move');
  });

  it('③ ★A の max_tokens は小さく、B は従来どおり 8000', async () => {
    await run();
    expect(paramsOf(0).max_tokens).toBe(256);
    expect(paramsOf(1).max_tokens).toBe(8000);
  });

  it('★A には B 用の文脈(節目)が入らず、B には入る', async () => {
    await run();
    expect(textOf(paramsOf(0), 'system')).toContain('【A文脈】足だけ');
    expect(textOf(paramsOf(0), 'system')).not.toContain('主要節目');
    expect(textOf(paramsOf(1), 'system')).toContain('主要節目 39500');
  });

  it('★A が失敗したら B を呼ばない(実プロセスでも)', async () => {
    createMock.mockReset();
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: 'わかりません' } }] });
    const r = await run();
    expect(createMock.mock.calls.length).toBe(1);   // ★2回目が無い
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.noneReason).toBe('aFailed');
    }
  });

  it('★A が range・レンジ不許可なら B を呼ばない(実プロセスでも)', async () => {
    createMock.mockReset();
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: '{"direction":"range","why":"不明瞭"}' } }] });
    const r = await run();
    expect(createMock.mock.calls.length).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.noneReason).toBe('rangeDisabled');
  });

  it('★測定材料(SplitRecord)が呼び出し側へ渡る', async () => {
    let rec: unknown = null;
    await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B', technicalForTrend: 'A',
      squeezeState: null, squeezeUnavailable: 'closed',
      onSplitRecord: (r) => { rec = r; },
    });
    expect(rec).toMatchObject({
      aDirection: 'bull', bVariant: 'buy', squeezeState: null,
      squeezeUnavailable: 'closed', bStrategy: '押し目', toolCalls: 0,
    });
  });
});

describe('④ ★スイッチ1箇所で旧経路に戻る', () => {
  it('JP225_PLAN_SPLIT=0 にすると、また1回呼び出し・旧の全文になる', async () => {
    setSplit(false);
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    await run();
    expect(createMock.mock.calls.length).toBe(1);
    expect(textOf(paramsOf(0), 'system')).toContain('【最優先: 価格の向き');
    expect((paramsOf(0).tools ?? []).length).toBe(3);
  });

  it('★戻したあとの全文が、分割を一度も有効にしなかった場合と同じ(残留しない)', async () => {
    setSplit(undefined);
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    await run();
    const never = textOf(paramsOf(0), 'system');
    setSplit(true); setSplit(false);   // ★一度 ON にしてから戻す
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    await run();
    const afterToggle = textOf(paramsOf(0), 'system');
    // 壁時計(秒)だけは動きうるので、その行を除いて比較する
    const strip = (s: string): string => s.replace(/【市場の現状 [^】]*】/, '【市場の現状 —】');
    expect(strip(afterToggle)).toBe(strip(never));
  });
});
