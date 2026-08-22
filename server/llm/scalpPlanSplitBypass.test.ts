import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Price } from '../types.js';

// ★段6続き(2026-08-22・リーダー指摘への対応): 「分割ONでも黙って無視される」を構造で塞ぐ。
//
// 何を守っているか:
//   ① resolveSplitBypassReasons(純関数)が heldPosition/armedContext/promptVariant(v1以外)を検出する
//   ② ★分割ONでも、これらが1つでもあれば実プロセスで「旧経路(1回呼び出し)」に落ちる
//   ③ ★フォールバックした事実が結果に残る(splitBypassReason)
//   ④ ★該当しない回(通常の split ON)には一切影響しない(既存動作を壊さない)

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

const { buildScalpPlan, resolveSplitBypassReasons } = await import('./scalpPlan.js');
const { resetPlanSplitForTest, PLAN_SPLIT_ENV } = await import('./planSplitConfig.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
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

describe('① resolveSplitBypassReasons(純関数)', () => {
  // ★baseline: technicalForTrend を非空にして emptyTrendContext(⑥)を無効化し、他の項目だけを見る。
  const OK_CTX = { technicalForTrend: '【A文脈】ダミー' };

  it('何も無ければ空配列(文脈は非空とする)', () => {
    expect(resolveSplitBypassReasons(OK_CTX)).toEqual([]);
  });
  it('heldPosition があれば検出', () => {
    expect(resolveSplitBypassReasons({ ...OK_CTX, heldPosition: { dir: 'buy', entry: 38250 } })).toEqual(['heldPosition']);
  });
  it('armedContext があれば検出', () => {
    expect(resolveSplitBypassReasons({ ...OK_CTX, armedContext: { mode: 'range-fade', ageMs: 1, avgMs: 1 } })).toEqual(['armedContext']);
  });
  it('promptVariant が v1 以外なら検出(v1 は既定=検出しない)', () => {
    expect(resolveSplitBypassReasons({ ...OK_CTX, promptVariant: 'v1' })).toEqual([]);
    expect(resolveSplitBypassReasons({ ...OK_CTX, promptVariant: 'v2' })).toEqual(['promptVariant']);
    expect(resolveSplitBypassReasons({ ...OK_CTX, promptVariant: 'v1f' })).toEqual(['promptVariant']);
  });
  // ★エバリュエーター指摘(4つ目): exitVariant も B に届かない(戦略仕様が既に圧縮済みで宛先が無い)。
  //   分析用が exitVariant を腕として使う実験がある以上、記録・ガード対象に含める。
  it('exitVariant があれば検出(いずれの値でも・既定は undefined)', () => {
    expect(resolveSplitBypassReasons({ ...OK_CTX, exitVariant: 'current' })).toEqual(['exitVariant']);
    expect(resolveSplitBypassReasons({ ...OK_CTX, exitVariant: 'candidate-a' })).toEqual(['exitVariant']);
  });
  // ★エバリュエーター指摘(最重要): caller が 'default' 以外(=分析用)なら、値に関わらずバイパス。
  //   ★LlmCaller の実際の値は 'default' | 'generator' の2つだけ(caller.ts で列挙・
  //   server/generator/cycle.ts が唯一の非 default 呼び出し元であることをコードで確認済み)。
  it('callerが generator(分析用)なら検出。default/未指定は検出しない', () => {
    expect(resolveSplitBypassReasons({ ...OK_CTX, caller: 'default' })).toEqual([]);
    expect(resolveSplitBypassReasons({ ...OK_CTX, caller: 'generator' })).toEqual(['caller']);
  });
  // ★エバリュエーター指摘B: 文脈構築が失敗(technicalForTrend が undefined/空)した回は emptyTrendContext。
  it('technicalForTrend が undefined/空/空白のみなら emptyTrendContext を検出', () => {
    expect(resolveSplitBypassReasons({})).toEqual(['emptyTrendContext']);
    expect(resolveSplitBypassReasons({ technicalForTrend: null })).toEqual(['emptyTrendContext']);
    expect(resolveSplitBypassReasons({ technicalForTrend: '' })).toEqual(['emptyTrendContext']);
    expect(resolveSplitBypassReasons({ technicalForTrend: '   ' })).toEqual(['emptyTrendContext']);
    expect(resolveSplitBypassReasons({ technicalForTrend: '中身あり' })).toEqual([]);
  });
  it('複数該当すれば配列に全部残る(結合は呼び出し側の責務)', () => {
    expect(resolveSplitBypassReasons({
      ...OK_CTX,
      heldPosition: { dir: 'sell', entry: 1 }, armedContext: { mode: 'range-fade', ageMs: 1, avgMs: 1 },
      promptVariant: 'v2', exitVariant: 'candidate-a', caller: 'generator',
    })).toEqual(['heldPosition', 'armedContext', 'promptVariant', 'exitVariant', 'caller']);
  });
});

describe('② ★分割ONでも heldPosition/armedContext/promptVariant があれば実際に旧経路へ落ちる', () => {
  beforeEach(() => { setSplit(true); });

  it('heldPosition ありは1回呼び出し・旧の全文になる(A/B の2回にならない)', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      heldPosition: { dir: 'buy', entry: REF },
    });
    expect(createMock.mock.calls.length).toBe(1);   // ★A→B の2回にならない
    const sys = textOf(paramsOf(0), 'system');
    expect(sys).toContain('【最優先: 価格の向き');   // ★旧経路の目印
    expect(sys).toContain('保有中(ドテン評価)');     // ★heldNote が実際に効いている
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBe('heldPosition');
  });

  it('armedContext ありも同様に旧経路へ落ちる', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      armedContext: { mode: 'range-fade', ageMs: 900_000, avgMs: 600_000 },
    });
    expect(createMock.mock.calls.length).toBe(1);
    expect(textOf(paramsOf(0), 'system')).toContain('レンジ未約定(ブレイク再評価)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBe('armedContext');
  });

  it('promptVariant=v2 も同様に旧経路へ落ちる', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      promptVariant: 'v2',
    });
    expect(createMock.mock.calls.length).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBe('promptVariant');
  });

  it('該当しない通常の split ON は従来どおり A→B の2回のまま(splitBypassReason は付かない)', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
    });
    expect(createMock.mock.calls.length).toBe(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBeUndefined();
  });

  // ★エバリュエーター指摘④: exitVariant も B に届かないので、指定時は旧経路へ落とす。
  it('exitVariant 指定ありは1回呼び出し・旧経路へ落ちる', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      exitVariant: 'candidate-a',
    });
    expect(createMock.mock.calls.length).toBe(1);
    expect(textOf(paramsOf(0), 'system')).toContain('【最優先: 価格の向き');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBe('exitVariant');
  });

  // ★エバリュエーター指摘(最重要): 分析用(caller='generator')は promptVariant の値に関わらず
  //   必ず旧経路へ落ちる(=対照腕と候補腕が同じ経路を通る=分割の有無が実験に紛れ込まない)。
  it('caller=generator は promptVariant=v1(対照腕)でも v2(候補腕)でも同じく旧経路へ落ちる(実験を汚染しない)', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const control = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      caller: 'generator', promptVariant: 'v1',
    });
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const candidate = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      caller: 'generator', promptVariant: 'v2',
    });
    // ★どちらも1回呼び出し(旧経路)。分割 vs 旧経路という別軸が紛れ込んでいない。
    expect(createMock.mock.calls.length).toBe(1);
    expect(control.ok).toBe(true);
    expect(candidate.ok).toBe(true);
    if (control.ok) expect(control.splitBypassReason).toBe('caller');
    // ★候補腕(v2)は promptVariant のチェックにも同時に該当する(caller チェックと独立に検出)。
    //   どちらの機構が捉えても『分割経路に入らない』結果は同じで、これが目的そのもの。
    if (candidate.ok) expect(candidate.splitBypassReason).toBe('promptVariant,caller');
  });

  it("caller='default'(実取引 A)は従来どおり分割経路(2回)のまま", async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈',
      caller: 'default',
    });
    expect(createMock.mock.calls.length).toBe(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBeUndefined();
  });

  // ★エバリュエーター指摘B: 文脈構築が失敗(technicalForTrend が空)した回も旧経路へ落ちる
  //   (旧経路なら基礎テクニカル・現在価格・ニュースで計画を出し続けられる=無言の全見送りを防ぐ)。
  it('technicalForTrend が空(文脈構築の失敗を模す)なら旧経路へ落ちる(全サイクル見送りにならない)', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈',
      // technicalForTrend を渡さない = buildRichScalpContextResult が失敗した/currentPrice 未確定の状態を模す。
    });
    expect(createMock.mock.calls.length).toBe(1);   // ★A(range と答えて即終了)にならず、旧経路の1回だけ
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');   // ★旧経路が実際に計画を出している(全見送りではない)
      expect(r.splitBypassReason).toBe('emptyTrendContext');
    }
  });

  it('technicalForTrend が空白のみでも同様に旧経路へ落ちる', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: '   ',
    });
    expect(createMock.mock.calls.length).toBe(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBe('emptyTrendContext');
  });
});

describe('③ ★分割OFFのときは splitBypassReason が付かない(そもそも該当しない)', () => {
  it('分割OFF + heldPosition ありでも splitBypassReason は undefined(意味が無いので記録しない)', async () => {
    setSplit(false);
    createMock.mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈',
      heldPosition: { dir: 'buy', entry: REF },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.splitBypassReason).toBeUndefined();
  });
});
