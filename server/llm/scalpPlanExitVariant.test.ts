import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Price } from '../types.js';

// ─── buildScalpPlan: exitVariant が「AI へ渡る決済仕様」を切り替える(実経路・LLM だけモック) ───
//
// ★否定対照(実装前のコードでの結果): ScalpPlanInput に exitVariant が無く、決済ブロックは常に
//   describeExitLogic() 固定。よって「candidate-a で決済ブロックが変わる」テストが赤になる
//   (current と candidate-a の system prompt が同一になるため)。
//
// ★このファイルは公開リポにも載る。決済の実数値は書かない・assert しない。
//   検証するのは「省略と 'current' が byte 一致」「'candidate-a' で決済ブロックだけが変わる」という構造。

const createMock = vi.fn();

vi.mock('./providers.js', () => ({
  // ★providers.js の実物が持つエラー型。scalpPlan.ts が import するのでモックにも要る
  //   (無いと `extends undefined` で読み込みに失敗する)。検証の強さには関与しない。
  NoFallbackError: class NoFallbackError extends Error {},
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
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
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 45 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: true }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

const { buildScalpPlan } = await import('./scalpPlan.js');
const { describeExitLogic, describeExitLogicVariant, loadExitImpl } = await import('../signalTrade/exit/index.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
const RAW = JSON.stringify({
  direction: 'buy', limitEntry: REF - 60, stopLossForLimit: REF - 110, rationale: 'test',
});

const EXIT_HEAD = '■ 決済(この建玉の決済逆指値はこう動く=エントリー計画時に前提とすること)\n';
const CTX_HEAD = '\n\n【市場の現状';

/** buildScalpPlan を1回走らせ、LLM に渡された system prompt を返す。 */
async function systemPromptFor(exitVariant?: 'current' | 'candidate-a'): Promise<string> {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: RAW } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [], exitVariant });
  expect(r.ok).toBe(true);
  const params = createMock.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] };
  const sys = params.messages.find(m => m.role === 'system')!.content;
  return String(sys);
}
/** system prompt から「決済ブロック」だけを切り出す(時刻など可変部分を比較から外す)。 */
function exitBlockOf(prompt: string): string {
  const i = prompt.indexOf(EXIT_HEAD);
  expect(i).toBeGreaterThanOrEqual(0);
  const j = prompt.indexOf(CTX_HEAD, i);
  expect(j).toBeGreaterThan(i);
  return prompt.slice(i + EXIT_HEAD.length, j);
}

describe('buildScalpPlan — exitVariant で AI に渡す決済仕様を切り替える', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('exitVariant 省略 → 決済ブロックは describeExitLogic() と byte 一致(既存プロンプト不変)', async () => {
    await loadExitImpl();
    expect(exitBlockOf(await systemPromptFor(undefined))).toBe(describeExitLogic());
  });

  it("exitVariant:'current' は省略時と決済ブロックが byte 一致", async () => {
    const omitted = exitBlockOf(await systemPromptFor(undefined));
    const current = exitBlockOf(await systemPromptFor('current'));
    expect(current).toBe(omitted);
  });

  it("exitVariant:'candidate-a' は決済ブロックが変わる(=AI が別の決済仕様で計画する)", async () => {
    await loadExitImpl();
    const current = exitBlockOf(await systemPromptFor('current'));
    const candidate = exitBlockOf(await systemPromptFor('candidate-a'));
    expect(candidate).not.toBe(current);
    expect(candidate).toBe(describeExitLogicVariant('candidate-a'));
  });

  it('変わるのは決済ブロックだけ(エントリー側の仕様は candidate-a でも不変)', async () => {
    const cur = await systemPromptFor('current');
    const cand = await systemPromptFor('candidate-a');
    // ★indexOf の戻りを必ず検査する(fail-open を作らない)。ここは slice(0, -1) になるだけなので
    //   見出しが消えても「決済ブロックを含んだまま比較」になり普通は赤くなる=いまは fail-closed だが、
    //   両者が偶然一致すれば通ってしまう。同じ形は同じ守り方をする。
    const headOf = (s: string) => {
      const at = s.indexOf(EXIT_HEAD);
      expect(at, '決済ブロックの見出しが system prompt に無い').toBeGreaterThanOrEqual(0);
      return s.slice(0, at);
    };
    expect(headOf(cand)).toBe(headOf(cur));
  });
});
