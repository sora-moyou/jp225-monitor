import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Price } from '../types.js';

// ─── buildScalpPlan: プロンプトの指紋を **実際に送った本文** から取る(記録専用) ───────
//
// ■ 何を実証するか(この2点が無いと凍結再生の突合が原理的にできない)
//   ① 指紋は「実際に LLM へ渡した system+user」そのものから取られている(組み立て直しでも推測でもない)
//   ② 同じ入力なら同じ指紋 / 設定を1つ変えれば違う指紋
//   ③ ★指紋を取っても **プロンプト本文も採否も1バイトも変わらない**
//      (コールバックを渡した回と渡さない回で、送られた本文も plan/noneReason/legDrops も完全一致)
//
// ■ 時計を固定する理由
//   プロンプト先頭の【市場の現状 …】は **秒まで** 印字される。固定しないと「同じ入力」を2回作れず、
//   ②を実測できない(秒をまたいだだけで指紋が変わるのは正しい挙動なので、テストで殺してはいけない)。
//
// ★否定対照: scalpPlan.ts の onPromptFingerprint 呼び出しを消すと ①②が赤。
//   指紋の対象から userPrompt を外すと「設定違いで別の指紋」が(上限は question 側にも出るため)脆くなる。

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
const { promptFingerprint } = await import('./promptFingerprint.js');

const NOW = Date.UTC(2026, 6, 29, 4, 30, 15);
const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: NOW, stale: false } as Price,
];
// 逆指値レッグは現在値より下=buy には不正 → enforce で落ちる(legDrops が必ず1本入る回)。
const RAW = JSON.stringify({
  direction: 'buy', rationale: '押し目買い', refPrice: 1,
  limitEntry: 38200, stopLossForLimit: 38150,
  stopEntry: 38200, stopLossForStop: 38150,
});

interface SentPrompts { system: string; user: string; }

/** ★実測値を人間が目で確かめるための出力(PROMPT_FP_SHOW=1 のときだけ)。
 *  既定では黙る=通常のテスト出力を汚さない。出すのは指紋(一方向ハッシュ)と文字数だけで、本文は出さない。 */
function say(msg: string): void {
  if (process.env.PROMPT_FP_SHOW === '1') console.info(`[実測] ${msg}`);
}

/** LLM が RAW を返すようにして buildScalpPlan を1回走らせ、**実際に送られた本文** も取り出す。 */
async function run(opts: { withCallback: boolean; lcCeilingYen?: number }): Promise<{
  fp: string | null; sent: SentPrompts; result: Awaited<ReturnType<typeof buildScalpPlan>>;
}> {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: RAW } }] });
  let fp: string | null = null;
  const result = await buildScalpPlan({
    symbol: 'NIY=F', prices: PRICES, news: [], lcCeilingYen: opts.lcCeilingYen,
    ...(opts.withCallback ? { onPromptFingerprint: (v: string) => { fp = v; } } : {}),
  });
  const msgs = (createMock.mock.calls[0]![0] as { messages: { role: string; content: unknown }[] }).messages;
  const system = msgs.find(m => m.role === 'system')!.content as string;
  const user = msgs.find(m => m.role === 'user')!.content as string;
  return { fp, sent: { system, user }, result };
}

describe('buildScalpPlan — プロンプトの指紋(記録専用)', () => {
  beforeEach(() => {
    // Date だけを固定する(タイマーは本物のまま=await が止まらない)。
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('★指紋は「実際に LLM へ送った system+user」そのものから取られている', async () => {
    const { fp, sent } = await run({ withCallback: true });
    expect(fp).not.toBeNull();
    expect(fp).toBe(promptFingerprint(sent.system, sent.user));
    say(`送信本文から取り直した指紋=${promptFingerprint(sent.system, sent.user)} / 記録された指紋=${fp}`
      + ` (system ${sent.system.length}字 / user ${sent.user.length}字)`);
  });

  it('同じ入力(同じ時刻・同じ設定)→ 同じ指紋', async () => {
    const a = await run({ withCallback: true });
    const b = await run({ withCallback: true });
    expect(b.sent.system).toBe(a.sent.system);   // 前提: 本文も同一
    expect(b.fp).toBe(a.fp);
    say(`同一入力2回: ${a.fp} / ${b.fp}`);
  });

  it('★設定を1つ変える(LC 上限)→ 指紋が変わる', async () => {
    const a = await run({ withCallback: true });
    const b = await run({ withCallback: true, lcCeilingYen: 60 });
    expect(b.sent.system).not.toBe(a.sent.system);   // 前提: 本文が実際に変わっている
    expect(b.fp).not.toBe(a.fp);
    say(`設定を1つ変えた: ${a.fp} → ${b.fp}`);
  });

  it('★指紋を取っても本番の挙動は不変(本文も plan も legDrops も noneReason も一致)', async () => {
    const off = await run({ withCallback: false });
    const on = await run({ withCallback: true });
    // 送った本文が byte 一致(コールバックはプロンプトに一切触っていない)
    expect(on.sent.system).toBe(off.sent.system);
    expect(on.sent.user).toBe(off.sent.user);
    // 結果も一致(指紋のフィールドは buildScalpPlan の戻りには載らない=runner が載せる)
    expect(on.result).toEqual(off.result);
    expect(off.result.ok && off.result.legDrops?.length).toBeTruthy();   // 空の比較でないことの担保
    say(`指紋なし/あり: system ${off.sent.system.length}字 byte一致=${on.sent.system === off.sent.system}`
      + ` / user ${off.sent.user.length}字 byte一致=${on.sent.user === off.sent.user}`
      + ` / plan+legDrops+noneReason 一致=${JSON.stringify(on.result) === JSON.stringify(off.result)}`
      + ` / legDrops=${JSON.stringify(off.result.ok ? off.result.legDrops : null)}`);
  });

  it('★記録側が例外を投げても計画は止まらない(握りつぶすが、握りつぶした事実は1行残す)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: RAW } }] });
    const r = await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [],
      onPromptFingerprint: () => { throw new Error('記録側の故障'); },
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.plan.limitEntry).toBe(38200);   // 採否も価格も普段どおり
    expect(warn.mock.calls.flat().join(' ')).toContain('プロンプト指紋の記録に失敗');
    warn.mockRestore();
  });

  it('★戻り値そのものに本文は載らない(DB へ流れるのは指紋だけ)', async () => {
    const { fp, result } = await run({ withCallback: true });
    const s = JSON.stringify(result);
    expect(s).not.toContain('【市場の現状');
    expect(s).not.toContain(String(fp));   // 指紋すら buildScalpPlan の戻りには載らない
  });
});
