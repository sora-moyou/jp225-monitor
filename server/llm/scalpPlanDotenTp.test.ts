// ★ドテン(held-eval)の計画に TP(利確の成行決済)の幅が付くこと。
//
// ■ 何が壊れていたか(実データで特定・推測ではない)
//   TP 導入後の約定 223件(A 103 / B 120)のうち **A の35件(34.0%)** に tp_width が無く、
//   35件すべてが「直前の A 取引が exit_reason='doten' で終わり、signal_id がその +1」だった(例外0)。
//   真因: ドテンは resolveSplitBypassReasons が 'heldPosition' を返して **必ず旧経路(1回呼び出し)**
//   へ落ちるのに、旧経路は TP を1文字も尋ねていなかった。
//     → plan に tpWidthFor* が入らない → planToArmed が幅を付けない → 約定時に pos.tpWidth が
//       焼かれない → resolveTpWidth が null。★記録の欠落ではなく **TP が効いていなかった**。
//   ★系統B はドテンしない(maintainsCurrentSignal=false)ので、この不具合は A 専用。
//
// ■ このファイルが固定する契約
//   ① ドテンの回(heldPosition あり)は、旧経路のプロンプトに TP の2フィールドが出て、
//      AI の答えが plan.tpWidthForLimit / tpWidthForStop に入る。
//   ② ★設定が TP無効(scalpTpEnabled=false)/手動(scalpTpWidthSource='manual')なら **尋ねない**。
//      ★尋ねない回は、AI が勝手に返しても plan に入れない(尋ねる/読むが同じ1つの値で決まる)。
//   ③ ★★ドテン **以外** で旧経路に落ちる回(通常の flat 計画・レンジ再評価・分析用(生成器)・候補腕)は
//      プロンプトに TP の語が1文字も出ず、AI が返しても plan に入らない。
//      ★ここが この修正の最大の危険(分析用の質問文を変えると実験の母集団が壊れる)。
//   ④ 検証で落ちたレッグには TP を載せない(残ったレッグにだけ載せる)。

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Price } from '../types.js';

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
// ★TP の2つの設定だけをテストから動かす(他の knob は分割バイパスのテストと同じ固定値)。
let tpEnabled = true;
let tpSource: 'manual' | 'ai' = 'ai';
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
  resolveScalpTpEnabled: () => tpEnabled,
  resolveScalpTpWidthDirective: () => ({ mode: tpSource, value: 80 }),
}));

const { buildScalpPlan } = await import('./scalpPlan.js');
const { resetPlanSplitForTest, PLAN_SPLIT_ENV } = await import('./planSplitConfig.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
/** ドテンの反対プラン(保有 buy に対する sell)。★TP幅を **両レッグとも** 返す応答。 */
const withTp = (extra: Record<string, unknown> = {}): string => JSON.stringify({
  direction: 'sell', limitEntry: REF + 20, stopEntry: REF - 20,
  lcWidthForLimit: 60, lcWidthForStop: 58,
  tpWidthForLimit: 120, tpWidthForStop: 90,
  rationale: '反転', refPrice: REF, ...extra,
});
/** flat 計画用(buy)。★同じく TP幅を返す応答=「尋ねていないのに返ってきた」を作れる。 */
const BUY_WITH_TP = JSON.stringify({
  direction: 'buy', limitEntry: REF - 20, stopEntry: REF + 20,
  lcWidthForLimit: 60, lcWidthForStop: 58,
  tpWidthForLimit: 120, tpWidthForStop: 90,
  rationale: '通常', refPrice: REF,
});

type Msg = { role: string; content: string | Array<{ text?: string }> };
type Params = { messages: Msg[] };
const paramsOf = (i: number): Params => createMock.mock.calls[i]![0] as Params;
const textOf = (p: Params, role: string): string => {
  const m = p.messages.find(x => x.role === role)!;
  return typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('');
};
/** その回に実際に送った system+user の全文(TP の語が1文字でも出たかを見るため連結する)。 */
const sentAll = (): string => textOf(paramsOf(0), 'system') + '\n' + textOf(paramsOf(0), 'user');

const HELD = { dir: 'buy' as const, entry: REF };
const BASE = { symbol: 'NIY=F', prices: PRICES, news: [], technical: 'B文脈', technicalForTrend: 'A文脈' };

const ORIGINAL = process.env[PLAN_SPLIT_ENV];
function setSplit(on: boolean): void {
  process.env[PLAN_SPLIT_ENV] = on ? '1' : '0';
  resetPlanSplitForTest();
}
afterAll(() => {
  delete process.env[PLAN_SPLIT_ENV];
  if (ORIGINAL !== undefined) process.env[PLAN_SPLIT_ENV] = ORIGINAL;
  resetPlanSplitForTest();
});
beforeEach(() => { createMock.mockReset(); tpEnabled = true; tpSource = 'ai'; setSplit(true); });

describe('① ドテン(held-eval)の旧経路でも TP を尋ね、幅が plan に入る', () => {
  it('★TP有効+AI委任: 1回呼び出しのまま、TP の2フィールドを尋ね、幅が両レッグに入る', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: withTp() } }] });
    const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
    expect(createMock.mock.calls.length).toBe(1);              // ★A/B の2回にしない(旧経路のまま)
    const all = sentAll();
    expect(all).toContain('"tpWidthForLimit"');
    expect(all).toContain('"tpWidthForStop"');
    expect(all).toContain('保有中(ドテン評価)');                 // ★ドテンの文脈は従来どおり残る
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.splitBypassReason).toBe('heldPosition');          // ★経路は変えていない
    expect(r.plan.tpWidthForLimit).toBe(120);
    expect(r.plan.tpWidthForStop).toBe(90);
  });

  it('★TP幅の数値(帯・既定値)をプロンプトに1つも印字しない', async () => {
    createMock.mockResolvedValue({ choices: [{ message: { content: withTp() } }] });
    await buildScalpPlan({ ...BASE, heldPosition: HELD });
    const all = sentAll();
    // TP に関する行を抜き出し、その中に数字が1つも無いことを見る(LC の帯 55/65 は従来どおり在る)。
    const tpLines = all.split('\n').filter(l => l.includes('tpWidthFor'));
    expect(tpLines.length).toBe(2);
    for (const l of tpLines) expect(l).not.toMatch(/[0-9０-９]/);
    expect(all).not.toContain('80');   // ★設定の既定値(scalpTpWidthYen=80)は1度も出さない
  });

  it('★AI が TP を返さなくても計画は成立する(TP は対の必須ではない)', async () => {
    const noTp = JSON.stringify({
      direction: 'sell', limitEntry: REF + 20, stopEntry: REF - 20,
      lcWidthForLimit: 60, lcWidthForStop: 58, rationale: '反転', refPrice: REF,
    });
    createMock.mockResolvedValue({ choices: [{ message: { content: noTp } }] });
    const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBe(REF + 20);
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.tpWidthForStop).toBeUndefined();
  });

  it('★検証で落ちたレッグには TP を載せない(残ったレッグにだけ載る)', async () => {
    // lcWidthForLimit を使えない値にして指値レッグだけ落とす(対の整合は保たれる=ok:true のまま)。
    createMock.mockResolvedValue({ choices: [{ message: { content: withTp({ lcWidthForLimit: -5 }) } }] });
    const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.stopEntry).toBe(REF - 20);
    expect(r.plan.tpWidthForStop).toBe(90);
  });

  it('★0/負/非数の TP幅は採らない(TP無しとして扱う)', async () => {
    for (const bad of [0, -30, 'x']) {
      createMock.mockReset().mockResolvedValue({
        choices: [{ message: { content: withTp({ tpWidthForLimit: bad, tpWidthForStop: bad }) } }],
      });
      const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.tpWidthForLimit).toBeUndefined();
      expect(r.plan.tpWidthForStop).toBeUndefined();
    }
  });
});

describe('② TP が無効/手動の設定では、ドテンでも尋ねない(返ってきても使わない)', () => {
  it('★scalpTpEnabled=false: TP の語がプロンプトに1文字も出ず、返しても plan に入らない', async () => {
    tpEnabled = false;
    createMock.mockResolvedValue({ choices: [{ message: { content: withTp() } }] });
    const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
    expect(sentAll()).not.toContain('tpWidthFor');
    expect(sentAll()).not.toContain('TP');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.tpWidthForStop).toBeUndefined();
  });

  it('★scalpTpWidthSource=manual: 同じく尋ねず、返しても plan に入らない', async () => {
    tpSource = 'manual';
    createMock.mockResolvedValue({ choices: [{ message: { content: withTp() } }] });
    const r = await buildScalpPlan({ ...BASE, heldPosition: HELD });
    expect(sentAll()).not.toContain('tpWidthFor');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.tpWidthForLimit).toBeUndefined();
    expect(r.plan.tpWidthForStop).toBeUndefined();
  });
});

describe('③ ★ドテン以外で旧経路に落ちる回は、TP を1文字も尋ねない(母集団を壊さない)', () => {
  /** ドテン以外で旧経路に落ちる入力(resolveSplitBypassReasons の残り + 分割OFF)。 */
  const OTHERS: Array<{ name: string; split: boolean; input: Record<string, unknown> }> = [
    { name: '通常の flat 計画(分割OFF)', split: false, input: {} },
    { name: 'レンジ再評価(armedContext)', split: true, input: { armedContext: { mode: 'range-fade', ageMs: 900_000, avgMs: 600_000 } } },
    { name: '★分析用(caller=generator)', split: true, input: { caller: 'generator' } },
    { name: '★分析用の候補腕(caller=generator + promptVariant=v2)', split: true, input: { caller: 'generator', promptVariant: 'v2' } },
    { name: '候補腕(promptVariant=v1f)', split: true, input: { promptVariant: 'v1f' } },
    { name: '空文脈(emptyTrendContext)', split: true, input: { technicalForTrend: '' } },
  ];
  for (const c of OTHERS) {
    it(`${c.name}: プロンプトに TP が出ず、AI が返しても plan に入らない`, async () => {
      setSplit(c.split);
      createMock.mockResolvedValue({ choices: [{ message: { content: BUY_WITH_TP } }] });
      const r = await buildScalpPlan({ ...BASE, ...c.input });
      expect(createMock.mock.calls.length).toBe(1);     // 旧経路(1回呼び出し)であることの確認
      expect(sentAll()).not.toContain('tpWidthFor');
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.plan.limitEntry).toBe(REF - 20);        // 計画そのものは従来どおり成立する
      expect(r.plan.tpWidthForLimit).toBeUndefined();
      expect(r.plan.tpWidthForStop).toBeUndefined();
    });
  }
});
