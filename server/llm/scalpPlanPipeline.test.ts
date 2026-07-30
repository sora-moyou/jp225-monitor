import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Price } from '../types.js';

// ─── buildScalpPlan の「パイプライン全体」テスト(LLM をモックして実経路を通す) ───
// ★このファイルの目的(v0.9.46 のバグ再現):
//   画面の根拠文に機械生成の注記が二重に付いていた
//   （実際の注文: 指値のみ・逆指値レッグなし）（逆指値レッグは条件を満たさず不採用） （実際の注文: 指値のみ・逆指値レッグなし）
//   真因は buildScalpPlan が「runScalpPlan(内部で parseScalpPlan 済)の戻り plan を JSON 化 → もう一度
//   parseScalpPlan」していたこと=注記を付ける段が2回走っていた。
//   純関数の単体テスト(parseScalpPlan 単発)では絶対に捕まらないので、LLM だけをモックして
//   buildScalpPlan の実経路(プロバイダ呼び出し→parse→enforce)を通し、**注記の出現回数**を固定する。
//
// ★テストの弱さ対策: toContain(部分一致)は二重でも通ってしまう。ここは全て「出現回数=1」で固定する。

const createMock = vi.fn();

// LLM プロバイダ: callWithFallback は task を1回だけ呼び、その戻り(文字列)を返す実装に置き換える。
vi.mock('./providers.js', () => ({
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
  callWithFallback: async (task: (p: unknown) => Promise<string>) =>
    task({ client: { chat: { completions: { create: createMock } } }, config: { name: 'test', chatModel: 'test-model' } }),
}));

// Web 検索は無効(キー有無で tools が変わるのを避ける)。
vi.mock('./webSearch.js', () => ({
  isWebSearchEnabled: () => false,
  webSearch: async () => '',
}));

// monitor 文脈は DB を読むのでプロンプト組み立てから外す(プランの検証には無関係)。
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));

// knob は実ユーザー設定に依存させない(bias/LC/レンジ/トレンド veto を固定)。
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 45 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: biasMock() }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: true }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

let biasMock: () => 'long' | 'short' | 'none' = () => 'none';

const { buildScalpPlan } = await import('./scalpPlan.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: 0, stale: false } as Price,
];

/** LLM が raw を返すようにして buildScalpPlan を1回走らせる。 */
async function planFrom(raw: string) {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: raw } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** 部分文字列の出現回数(注記の二重付与を捕まえるための厳密な数え上げ)。 */
function countOf(s: string, sub: string): number {
  return s.split(sub).length - 1;
}

const NOTE_LIMIT_ONLY = '（実際の注文: 指値のみ・逆指値レッグなし）';
const NOTE_STOP_ONLY = '（実際の注文: 逆指値のみ・指値レッグなし）';
const NOTE_BOTH = '（実際の注文: 指値+逆指値）';
const TAG_STOP_DROPPED = '（逆指値レッグは条件を満たさず不採用）';
const TAG_LIMIT_DROPPED = '（指値レッグは条件を満たさず不採用）';

beforeEach(() => {
  biasMock = () => 'none';
});

describe('buildScalpPlan パイプライン: レッグ注記は1回だけ(directional)', () => {
  it('★再現: AI の逆指値レッグが落ちた指値のみプラン→基本文も不採用タグも各1回', async () => {
    // buy: 指値は正。逆指値 entry 38200(現在値38250より下=buy には不正)→ 逆指値レッグを落とす。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目買い。逆指値も置いたつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38200, stopLossForStop: 38150,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBeUndefined();
    expect(countOf(r.plan.rationale, NOTE_LIMIT_ONLY)).toBe(1);
    expect(countOf(r.plan.rationale, TAG_STOP_DROPPED)).toBe(1);
  });

  it('AI が指値レッグを落とされた逆指値のみプラン→基本文も不採用タグも各1回', async () => {
    // buy: 逆指値は正(38350>REF)。指値 entry 38400(現在値より上=buy の指値として不正)→ 指値レッグを落とす。
    const raw = JSON.stringify({
      direction: 'buy', rationale: 'ブレイク追随。指値も置いたつもり', refPrice: 1,
      limitEntry: 38400, stopLossForLimit: 38350,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = await planFrom(raw);
    expect(r.plan.stopEntry).toBe(38350);
    expect(r.plan.limitEntry).toBeUndefined();
    expect(countOf(r.plan.rationale, NOTE_STOP_ONLY)).toBe(1);
    expect(countOf(r.plan.rationale, TAG_LIMIT_DROPPED)).toBe(1);
  });

  it('AI が最初から指値のみ(逆指値を出さない)→基本文1回・不採用タグなし', async () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目買いのみ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
    });
    const r = await planFrom(raw);
    expect(countOf(r.plan.rationale, NOTE_LIMIT_ONLY)).toBe(1);
    expect(r.plan.rationale).not.toContain('不採用');
  });

  it('両レッグ正常→「指値+逆指値」1回のみ(他の基本文は付かない)', async () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '両面で待つ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = await planFrom(raw);
    expect(countOf(r.plan.rationale, NOTE_BOTH)).toBe(1);
    expect(countOf(r.plan.rationale, NOTE_LIMIT_ONLY)).toBe(0);
    expect(countOf(r.plan.rationale, NOTE_STOP_ONLY)).toBe(0);
  });

  it('★混在: parse 段で逆指値・enforce 段で指値が落ちて none→注記(parse 段)は各1回だけ', async () => {
    // 逆指値 entry 38200(現在値より下=buy には不正・parse で脱落) / 指値 LC=|38200-38000|=200>65(enforce で脱落)。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目買い。逆指値も置いたつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38000,
      stopEntry: 38200, stopLossForStop: 38150,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('none');
    expect(countOf(r.plan.rationale, NOTE_LIMIT_ONLY)).toBe(1);
    expect(countOf(r.plan.rationale, TAG_STOP_DROPPED)).toBe(1);
  });

  it('enforce で逆指値レッグが LC 上限超により落ちても、注記は enforce 前の1回だけ(重複しない)', async () => {
    // 指値 LC=50(<=65 で残る) / 逆指値 LC=|38350-38200|=150(>65)→ enforce で落ちる。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '両面で待つ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38200,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.stopEntry).toBeUndefined();
    // parse 段では両レッグ有効だったので注記は「指値+逆指値」のまま1回(enforce は注記を触らない)。
    expect(countOf(r.plan.rationale, NOTE_BOTH)).toBe(1);
    expect(countOf(r.plan.rationale, NOTE_LIMIT_ONLY)).toBe(0);
  });
});

// ─── 記録専用(noneReason/noneLegs): 再 parse 廃止で parse 段の実理由がそのまま届く ───
//   ★v0.9.46 まではここが二重 parse の副作用で潰れていた: parse 段で geometry 等の理由が付いても、
//   plan を JSON 化して再 parse すると「AI が direction:"none" を返した」ようにしか見えず noneReason='ai' に
//   化けていた(見送りログの理由が全部 ai)。採否・SSE・決済には無関係な記録のみ。
describe('buildScalpPlan パイプライン: 見送り(none)の記録理由', () => {
  it('両レッグとも幾何不正で none → noneReason は parse 段の実理由(geometry)・落ちた脚も記録される', async () => {
    // buy: 指値 38400(現在値より上=不正) / 逆指値 38100(現在値より下=不正) → 両レッグ落ちて見送り。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '良い形だが位置が悪い', refPrice: 1,
      limitEntry: 38400, stopLossForLimit: 38350,
      stopEntry: 38100, stopLossForStop: 38050,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('geometry');
    expect(r.noneLegs?.legs).toHaveLength(2);
  });

  it('AI 自身の見送り(direction:"none")は従来どおり noneReason="ai"', async () => {
    const r = await planFrom(JSON.stringify({ direction: 'none', rationale: '様子見。' }));
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('ai');
    expect(r.plan.rationale).toBe('様子見。');   // none に注記は付けない
  });
});

describe('buildScalpPlan パイプライン: レンジ脚の脱落注記は1回だけ', () => {
  const okUpper = { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 };  // 上=売り指値 LC=50
  const okLower = { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 };    // 下=買い指値 LC=50
  const RATIONALE = '上下に反応帯があるレンジ。上部に売り指値、下部に買い指値を設定';

  /** ※で始まる注記行だけを取り出す。 */
  const noteLines = (s: string) => s.split('\n').filter(l => l.startsWith('※'));

  it('★parse 段で上部が落ちる(幾何不正)→注記は1行だけ・「AIが提示しなかった」は付かない', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38200 }, lower: okLower },   // upper.entry<REF=幾何不正
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '現在値との上下関係が不正')).toBe(1);
    // 再 parse で「AI が上部を出さなかった」と誤って追記されてはならない。
    expect(r.plan.rationale).not.toContain('AIが提示しなかった');
  });

  it('parse 段で AI が上部を出さない→「AIが提示しなかった」注記は1行だけ', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { lower: okLower },
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, 'AIが提示しなかったため無し')).toBe(1);
  });

  it('enforce 段で下部が落ちる(バイアス)→注記は1行だけ', async () => {
    biasMock = () => 'short';
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: okUpper, lower: okLower },
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.lower).toBeUndefined();
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, 'バイアス(売り優先)')).toBe(1);
  });

  it('★混在: parse 段で上部・enforce 段で下部が落ちて none→残る注記(parse 段の1行)は1回だけ', async () => {
    // upper: 幾何不正(parse で脱落) / lower: LC=|38100-37900|=200>65(enforce で脱落) → 両脚落ちて none。
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38200 }, lower: { ...okLower, stopLoss: 37900 } },
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('none');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '現在値との上下関係が不正')).toBe(1);
  });

  it('脚が落ちない正常 range→注記なし(rationale は AI の原文のまま)', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: okUpper, lower: okLower },
    });
    const r = await planFrom(raw);
    expect(r.plan.rationale).toBe(RATIONALE);
  });
});
