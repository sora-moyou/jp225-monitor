import { describe, it, expect, vi } from 'vitest';
import type { Price } from '../types.js';

// ─── ★promptVariant: 実際に送られる user プロンプトで検証する(v0.9.75) ─────────────
//
// 何を守っているか:
//   ①未指定 と 'v1' の user プロンプトが **byte 一致**(既定経路=実弾につながる経路は1ミリも動かない)
//   ②'v2' のとき user プロンプトが v2 の本文になり、v1 の JSON 指示文が **付かない**
//     (2つ並べると「短くした」はずの質問文が v1 の分量に戻り、何も測っていないことになる)
//   ③system プロンプトは v1/v2 で **byte 一致** = 動かした変数は「質問文」の1つだけ
//   ④v2 の応答でも parse が通る(フィールド名の契約 lcWidthForLimit/lcWidthForStop が壊れていない)
//   ⑤台帳に落ちる3つ(regime / confidence / refPrice)が v2 でも返る=候補の腕だけ列が空にならない
//
// ★否定対照(実証手順):
//   git show HEAD:server/llm/scalpPlan.ts の版に差し替えると ②③④⑤ が赤になる
//   (旧版は promptVariant を知らないので、v2 を渡しても v1 の質問文が出る)。

const createMock = vi.fn();

vi.mock('./providers.js', () => ({
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
const { DEFAULT_PROMPT_VARIANT, generatorArmKey, normalizePromptVariant } = await import('./promptVariant.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
/** ★v2 の契約(幅で答える)そのままの応答。向き(符号)はコードが付ける。 */
const PLAN_JSON = JSON.stringify({
  regime: 'trend_up', confidence: 75,
  direction: 'buy', limitEntry: REF - 20, stopEntry: REF + 20,
  lcWidthForLimit: 60, lcWidthForStop: 58,
  rationale: 'テスト', refPrice: REF,
});

type Msg = { role: string; content: string | Array<{ type: string; text?: string }> };

/** buildScalpPlan を1回走らせ、create に渡った messages を返す。 */
async function promptsOf(promptVariant?: 'v1' | 'v2'): Promise<{ system: string; user: string; ok: boolean; plan: unknown }> {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: PLAN_JSON } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [], promptVariant });
  const params = createMock.mock.calls[0]![0] as { messages: Msg[] };
  const text = (m: Msg): string => typeof m.content === 'string'
    ? m.content
    : m.content.map(c => c.text ?? '').join('');
  return {
    system: text(params.messages.find(m => m.role === 'system')!),
    user: text(params.messages.find(m => m.role === 'user')!),
    ok: r.ok,
    plan: r.ok ? r.plan : null,
  };
}

describe('promptVariant — 実際に送る user プロンプト', () => {
  it('★未指定 と v1 は byte 一致(既定経路は1ミリも動かない)', async () => {
    const none = await promptsOf(undefined);
    const v1 = await promptsOf('v1');
    expect(v1.user).toBe(none.user);
    expect(v1.system).toBe(none.system);
    expect(DEFAULT_PROMPT_VARIANT).toBe('v1');
  });

  it('★v2 は質問文が入れ替わり、v1 の JSON 指示文は付かない', async () => {
    const v1 = await promptsOf('v1');
    const v2 = await promptsOf('v2');
    expect(v2.user).not.toBe(v1.user);
    // v2 の本文(分担の明示)が出ている
    expect(v2.user).toContain('システムが自動で行うこと');
    expect(v2.user).toContain('あなたが出すのは幅(正の数)だけ');
    // v1 の JSON 指示文(先頭の一文)は付いていない=契約が二重にならない
    expect(v1.user).toContain('最終的な回答は、次のスキーマに厳密に一致する JSON');
    expect(v2.user).not.toContain('最終的な回答は、次のスキーマに厳密に一致する JSON');
    // 「短くした」が実物で言える(半分以下)
    expect(v2.user.length).toBeLessThan(v1.user.length / 2);
  });

  it('★system プロンプトは v1/v2 で byte 一致(動かした変数は質問文の1つだけ)', async () => {
    const v1 = await promptsOf('v1');
    const v2 = await promptsOf('v2');
    expect(v2.system).toBe(v1.system);
  });

  it('★v2 の応答でも計画が成立する(幅の契約が壊れていない・向きはコードが付ける)', async () => {
    const v2 = await promptsOf('v2');
    expect(v2.ok).toBe(true);
    const p = v2.plan as {
      direction: string; limitEntry: number; stopLossForLimit: number;
      stopEntry: number; stopLossForStop: number; regime: string; confidence: number; refPrice: number;
    };
    expect(p.direction).toBe('buy');
    // 買いなので損切りは建値の **下**。符号はコードが付ける(AI は幅しか出していない)。
    expect(p.limitEntry - p.stopLossForLimit).toBe(60);
    expect(p.stopEntry - p.stopLossForStop).toBe(58);
    // ★台帳の3列が候補の腕だけ空にならない
    expect(p.regime).toBe('trend_up');
    expect(p.confidence).toBe(75);
    expect(p.refPrice).toBe(REF);
  });

  it('★2つのレッグの幅が別々に通る(同幅へ潰す処理は入っていない)', async () => {
    const v2 = await promptsOf('v2');
    const p = v2.plan as { limitEntry: number; stopLossForLimit: number; stopEntry: number; stopLossForStop: number };
    expect(Math.abs(p.limitEntry - p.stopLossForLimit)).not.toBe(Math.abs(p.stopEntry - p.stopLossForStop));
  });
});

describe('promptVariant — 正規化と予算の帳簿', () => {
  it('未指定/空は v1・未知の名前は 400 用のエラー(黙って v1 に倒さない)', () => {
    for (const v of [undefined, null, '']) expect(normalizePromptVariant(v)).toEqual({ ok: true, variant: 'v1' });
    expect(normalizePromptVariant('v2')).toEqual({ ok: true, variant: 'v2' });
    const bad = normalizePromptVariant('v3');
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('promptVariant');
  });

  it('★帳簿の鍵: v1 は従来と同じ文字列・v2 は別の財布(先着が食い切らない)', () => {
    expect(generatorArmKey('current', 'v1')).toBe('current');
    expect(generatorArmKey('current')).toBe('current');
    expect(generatorArmKey('current', 'v2')).toBe('current+v2');
    expect(generatorArmKey('current', 'v2')).not.toBe(generatorArmKey('current', 'v1'));
  });
});
