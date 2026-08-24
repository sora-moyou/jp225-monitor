import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Price } from '../types.js';

// ★エバリュエーター指摘C(2026-08-22): 旧経路にあって B に届いていなかった delegationNote
//   (「この値はあなたが決める(自由・根拠を述べよ)」)と buildVisionNote(「添付のチャート画像も
//   判断材料にすること」/画像が無い試行では何も言わない)を、当初は両方 B に戻した。
// ★同日中に取り消し(リーダー指摘): delegationNote は B の JSON 契約に無い direction/regime/
//   confidence や、B に存在しない strategySpec 等への参照を含み、分割の芯と衝突すると判明。
//   B からは外し、buildVisionNote だけ残す。実際にレンダリングして両方を確認する。
//
// ★手法は scalpPlanOldVsSplitParity.test.ts と同じ(buildScalpPlan を実プロセスで走らせ、
//   provider の create だけを差し替えて実際に API へ渡る params を見る)。
//   ★このファイルは isVisionCapableProvider/knob モードを **テストごとに差し替える** ため、
//   モックを vi.fn() にして個別に beforeEach で設定し直す(他のテストファイルの固定モックとは別に持つ)。

const createMock = vi.fn();
const visionCapableMock = vi.fn<[string, string], boolean>(() => false);
const ceilingModeMock = vi.fn<[], { mode: 'manual' | 'ai'; value?: number }>(() => ({ mode: 'manual', value: 65 }));

vi.mock('./providers.js', () => ({
  NoFallbackError: class NoFallbackError extends Error {},
  isLLMEnabled: () => true,
  isVisionCapableProvider: (name: string, model: string) => visionCapableMock(name, model),
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
  resolveScalpLcCeilingDirective: () => ceilingModeMock(),
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
const A_JSON = '{"direction":"buy","why":"高値切り上げ"}';
// ★2026-08-25: B の応答は **自由文**(ユーザーが形式を指定)。A=buy(ブル) → 版は 'buy' なので
//   （上）=逆指値買い /（下）=指値買い。★strategy の欄は形式に無いので b_strategy は NULL になる。
const B_JSON = [
  `逆指値買い${REF + 20}円（LC幅60円）節目手前`,
  `指値買い${REF - 20}円（LC幅58円）押し目`,
].join('\n');
// 1x1 PNG(data URL)。isVisionCapableProvider を true にした試行だけ画像として送られる想定。
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

type Msg = { role: string; content: string | Array<{ text?: string; image_url?: { url: string } }> };
type Params = { messages: Msg[] };
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
beforeEach(() => {
  createMock.mockReset();
  visionCapableMock.mockReset().mockReturnValue(false);
  ceilingModeMock.mockReset().mockReturnValue({ mode: 'manual', value: 65 });
  setSplit(true);
});

const run = (overrides: Record<string, unknown> = {}): ReturnType<typeof buildScalpPlan> => buildScalpPlan({
  symbol: 'NIY=F', prices: PRICES, news: [],
  technical: '【B文脈】主要節目 39500', technicalForTrend: '【A文脈】足だけ',
  ...overrides,
});

// ★2026-08-22 訂正(リーダー指摘): 「delegationNote を B に戻す」は誤りだった。取り消した。
//   理由: buildDelegationNote の文面(cooldown/trendVeto 委任時)は「regime と confidence を自分で
//   下すこと」「direction:"none" で見送りにする」を含むが、B の JSON 契約に direction/regime/confidence
//   は無い(分割の芯=side は AI に返させない、と正面衝突)。同じ文に「上のロジックを踏まえ」
//   (B には存在しない strategySpec への参照)もある。bias='ai' なら「売買方向(buy/sell)」、
//   range='ai' なら「上の2択(fade/breakout)に従い」(★fade/breakout はコードが選ぶ・AI に説明しない
//   のが芯)、lcFloor='ai' なら「上の【戦略ロジック仕様】を参照」——★全部、分割の芯と衝突する。
//   ★実測(本番相当設定 cooldown='ai'・trendVeto='ai'): B が
//   {"direction":"none","regime":"range","confidence":0.3,...} のような契約外 JSON を返し、
//   parseBAnswer が拾えず none_reason='aiSilent'(B の故障)に化けた。正当な見送りが故障に化ける
//   =aiSilent を作った目的の裏返し。★よって delegationNote は B に渡さない(1周目の状態に戻す)。
describe('★delegationNote は B に戻さない(取り消し済み・回帰しないことを固定する)', () => {
  it('★全 knob 手動(既定)では delegationNote は出ない(従来どおり)', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const bSys = textOf(paramsOf(1), 'system');
    expect(bSys).not.toContain('【AI委任');
  });

  it('★LC上限がAI委任でも、B の system プロンプトに委任注記は現れない(取り消し後の正しい挙動)', async () => {
    ceilingModeMock.mockReturnValue({ mode: 'ai' });
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const bSys = textOf(paramsOf(1), 'system');
    expect(bSys).not.toContain('【AI委任');
    expect(bSys).not.toContain('安全上限');
  });

  it('★否定対照: 委任ON(本番相当・全 knob=ai)でも、B の system 全文に direction/regime/confidence が0件', async () => {
    ceilingModeMock.mockReturnValue({ mode: 'ai' });
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const bSys = textOf(paramsOf(1), 'system');
    for (const w of ['direction', 'regime', 'confidence', '上のロジック', '上の2択', '戦略ロジック仕様']) {
      expect(bSys.split(w).length - 1, `"${w}" が B の system に残っている`).toBe(0);
    }
  });

  it('★A の system プロンプトにも delegationNote は入らない(A には元々足さない、という判断どおり)', async () => {
    ceilingModeMock.mockReturnValue({ mode: 'ai' });
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const aSys = textOf(paramsOf(0), 'system');
    expect(aSys).not.toContain('【AI委任');
  });
});

describe('★buildVisionNote が実際に B のプロンプトに現れる(画像を送った試行だけ)', () => {
  it('★画像を実際に送る試行では、B のプロンプトに画像への言及が現れる', async () => {
    visionCapableMock.mockReturnValue(true);
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run({ chartImageDataUrl: PNG_DATA_URL });
    const bUser = textOf(paramsOf(1), 'user');
    expect(bUser).toContain('添付のチャート画像');
  });

  it('★旧実装が揃えた性質を保つ: 画像を送らない試行(ビジョン非対応プロバイダ)では、一言も触れない', async () => {
    visionCapableMock.mockReturnValue(false);   // ★ビジョン非対応=画像は送らない
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run({ chartImageDataUrl: PNG_DATA_URL });   // ★画像は渡すが、この試行では送れない
    const bUser = textOf(paramsOf(1), 'user');
    expect(bUser).not.toContain('添付のチャート画像');
    expect(bUser).not.toContain('チャート画像');
  });

  it('★画像が最初から無い設定(既定)では、当然 visionNote も出ない', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();   // chartImageDataUrl 未指定
    const bUser = textOf(paramsOf(1), 'user');
    expect(bUser).not.toContain('チャート画像');
  });

  it('★A のプロンプトには画像を送っていてもvisionNoteが出ない(Aは画像を受け取らない設計のまま)', async () => {
    visionCapableMock.mockReturnValue(true);
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run({ chartImageDataUrl: PNG_DATA_URL });
    const aUser = textOf(paramsOf(0), 'user');
    expect(aUser).not.toContain('チャート画像');
  });
});

// ★リーダー指摘への回答(2026-08-22): delegationNote を外した代わりに確認を依頼された事実。
//   ★測定結果: LC上限(ceiling)の委任は帯の数値を通じて B に届く(65→159のように変わる)。
//   ★LC下限(floor)の委任は B に一切届かない(委任してもしなくても同じ数字のまま)。
//   ★どちらも「〜のはず」ではなく、実際にレンダリングして数値を比較した実測。
describe('★LC委任の実効が B に届くか(帯の数値を実測)', () => {
  it('★LC上限がAI委任のとき、B に渡る帯の上限が実際に広がる(委任の実効が数値で届く=ノート不要)', async () => {
    // 手動(65円)での基準文言。
    ceilingModeMock.mockReturnValue({ mode: 'manual', value: 65 });
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const manualSys = textOf(paramsOf(1), 'system');
    expect(manualSys).toContain('55円<=損切幅<66円');   // ★半開表記(閉区間の上限65 と同じ集合)

    // AI委任(安全上限=159円・テストのモック設定 resolveScalpLcHardMax の value)。
    ceilingModeMock.mockReturnValue({ mode: 'ai' });
    createMock.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    const aiSys = textOf(paramsOf(1), 'system');
    expect(aiSys).toContain('55円<=損切幅<160円');   // ★実測: 上限の数値が実際に変わって B に届く
    expect(aiSys).not.toContain('66円');              // ★保存値(65)由来の上端はどこにも現れない
  });
});
