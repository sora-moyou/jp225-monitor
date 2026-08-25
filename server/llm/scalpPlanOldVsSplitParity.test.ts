import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { NewsItem, Price } from '../types.js';

// ★リーダー指摘(2026-08-22)への対応: A/B 分割の B にニュースが渡っていなかった
//   (誰も決めていない挙動変更)。ここを直した上で、
//   ①ニュースが実際に B の全文に入ること ②A には入らないこと ③旧経路と分割経路の全文を
//   実際に突き合わせ、ニュース以外に同じ形の欠測が無いかを確認する。
//
// ★手法は scalpPlanSplitWiring.test.ts と同じ(buildScalpPlan を実プロセスで走らせ、
//   provider の create だけを差し替えて実際に API へ渡る params を見る)。

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
  buildMonitorContext: () => '■ 直近アラート(60分以内):\nダミー行\n\n■ 本日の日経(Day): 高値 38,500(09:00) / 安値 38,000(09:05) / 現値 38,250',
}));
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  // ★2026-08-25: 目線のモックは **可変** にした。
  //   ユーザー指示で「手動目線 = A を呼ばない」になったため、固定で manual にすると
  //   分割経路が B の1回だけになり、A/B の全文突き合わせができない。
  //   既定は AI委任(=A を呼ぶ)。buildBiasNote を見るテストだけ manual に切り替える。
  resolveScalpBiasDirective: () => biasDir,
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: false }),
  resolveScalpLcHardMax: () => ({ enabled: true, value: 159 }),
  resolveScalpAiTechnicalEnabled: () => true,
}));

/** ★目線のモック(可変)。既定=AI委任(A を呼ぶ)。 */
let biasDir: { mode: 'manual' | 'ai'; value: string } = { mode: 'ai', value: 'none' };

const { buildScalpPlan } = await import('./scalpPlan.js');
const { resetPlanSplitForTest, PLAN_SPLIT_ENV } = await import('./planSplitConfig.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0.42, timestamp: Date.now(), stale: false } as Price,
  { symbol: 'NQ=F', price: 5123.4, changePercent: -0.15, timestamp: Date.now(), stale: false } as Price,
];
// ★実際のニュース見出しを1つ用意(文字列の "現物" が B の全文に現れることを確認する土台)。
const NEWS: NewsItem[] = [
  { id: 'n1', title: '日銀、金融政策据え置き', source: 'テスト通信', publishedAt: Date.now() - 600_000, url: 'https://example.test/1' } as NewsItem,
];
const OLD_JSON = JSON.stringify({
  direction: 'buy', limitEntry: REF - 20, stopEntry: REF + 20,
  lcWidthForLimit: 60, lcWidthForStop: 58, rationale: 'テスト', refPrice: REF,
});
const A_JSON = '{"direction":"buy","why":"高値切り上げ"}';
// ★2026-08-25: B の応答は **自由文**(ユーザーが形式を指定)。A=buy(ブル) → 版は 'buy' なので
//   （上）=逆指値買い /（下）=指値買い。★strategy の欄は形式に無いので b_strategy は NULL になる。
const B_JSON = [
  `逆指値買い${REF + 20}円（LC幅60円）節目手前`,
  `指値買い${REF - 20}円（LC幅58円）押し目`,
].join('\n');

type Msg = { role: string; content: string | Array<{ text?: string }> };
type Params = { messages: Msg[]; tools?: unknown[]; max_tokens?: number };
const paramsOf = (i: number): Params => createMock.mock.calls[i]![0] as Params;
const textOf = (p: Params, role: string): string => {
  const m = p.messages.find(x => x.role === role)!;
  return typeof m.content === 'string' ? m.content : m.content.map(c => c.text ?? '').join('');
};
const fullText = (p: Params): string => p.messages.map(m => textOf(p, m.role)).join('\n---\n');

const ORIGINAL = process.env[PLAN_SPLIT_ENV];
function setSplit(on: boolean | undefined): void {
  if (on === undefined) delete process.env[PLAN_SPLIT_ENV];
  else process.env[PLAN_SPLIT_ENV] = on ? '1' : '0';
  resetPlanSplitForTest();
}
afterAll(() => { setSplit(undefined); if (ORIGINAL !== undefined) process.env[PLAN_SPLIT_ENV] = ORIGINAL; });
beforeEach(() => { createMock.mockReset(); });

const run = (): ReturnType<typeof buildScalpPlan> => buildScalpPlan({
  symbol: 'NIY=F', prices: PRICES, news: NEWS,
  technical: '【B文脈】主要節目 39500', technicalForTrend: '【A文脈】足だけ',
});

describe('★ニュースが B の全文に実際に入る(旧と揃える)', () => {
  beforeEach(() => {
    setSplit(true);
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
  });

  it('★B(2回目の呼び出し)の全文にニュース見出しが実際に現れる', async () => {
    await run();
    const bText = fullText(paramsOf(1));
    expect(bText).toContain('■ 関連ニュース');
    expect(bText).toContain('日銀、金融政策据え置き');   // ★見出しの現物
  });

  it('★A(1回目の呼び出し)の全文には現れない(A には渡さない、は維持)', async () => {
    await run();
    const aText = fullText(paramsOf(0));
    expect(aText).not.toContain('関連ニュース');
    expect(aText).not.toContain('日銀、金融政策据え置き');
  });

  it('★ニュースが0件でも(ニュースなし)行は出る(旧経路と同じ挙動)', async () => {
    createMock.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [],
      technical: '【B文脈】主要節目 39500', technicalForTrend: '【A文脈】足だけ',
    });
    expect(fullText(paramsOf(1))).toContain('■ 関連ニュース:\n(ニュースなし)');
  });
});

describe('★旧経路(1回呼び出し)の全文 vs 分割経路(A+B)の全文を実際に突き合わせる', () => {
  /** 旧経路の全文を取る。 */
  async function renderOld(): Promise<string> {
    setSplit(false);
    createMock.mockReset().mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    await run();
    return fullText(paramsOf(0));
  }
  /** 分割経路の A+B 全文を連結して取る。 */
  async function renderSplit(): Promise<{ a: string; b: string }> {
    setSplit(true);
    createMock.mockReset()
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    return { a: fullText(paramsOf(0)), b: fullText(paramsOf(1)) };
  }

  it('★ニュース: 旧にあり→(今回の修正で)B にもある', async () => {
    const old = await renderOld();
    const { a, b } = await renderSplit();
    expect(old).toContain('■ 関連ニュース');
    expect(b).toContain('■ 関連ニュース');
    expect(a).not.toContain('関連ニュース');
  });

  it('★多資産の現在価格board(formatPricesForChat): 旧・B にはあり、A には無い(リーダー指摘で修正済み)', async () => {
    const old = await renderOld();
    const { a, b } = await renderSplit();
    // ★旧経路は「■ 現在価格:」の見出しの下に全銘柄(NIY=F 以外も)を書く。
    expect(old).toContain('■ 現在価格');
    expect(old).toContain('NQ=F');
    // ★修正後: B にも同じ現在価格boardが入る(ニュースと同じ形の欠測だったため戻した)。
    expect(b).toContain('■ 現在価格');
    expect(b).toContain('NQ=F');
    // ★A には入れない(ユーザー指示「A にはトレンド判断に有用なものだけ」に従う)。
    expect(a).not.toContain('NQ=F');
    expect(a).not.toContain('■ 現在価格');
  });

  it('★monitorCtx(直近アラート60分/本日の日経の簡易サマリ): 旧にはあるが分割経路には無い(★リーダー裁定: 既存の節目/ボラブロックと重複が大きいため据え置き=意図的な欠測。追加しない)', async () => {
    const old = await renderOld();
    const { a, b } = await renderSplit();
    expect(old).toContain('■ 本日の日経');
    expect(a).not.toContain('■ 本日の日経');
    expect(b).not.toContain('■ 本日の日経');
  });

  it('★バイアス指示(buildBiasNote): 旧にはあるが B には無い(★仕様書で意図的に削ったと明記済み・新しい発見ではない)', async () => {
    biasDir = { mode: 'manual', value: 'long' };     // ★旧経路にだけ出る文言を見るため
    const old = await renderOld();
    biasDir = { mode: 'ai', value: 'none' };         // ★分割は A を呼ばせる(手動だと A が飛ぶ)
    const { b } = await renderSplit();
    expect(old).toContain('【エントリー方向の制約】買い中心');
    expect(b).not.toContain('【エントリー方向の制約】');
  });

  // ★2026-08-25(ユーザー指示): 「手動」で目線を決めた回は **プロンプトAをAIに渡さない**。
  //   ★実プロセスで「呼び出しが1回だけ」「その1回が B」を確かめる(仕様の文ではなく実測)。
  it('★★手動で目線を決めた回は A を呼ばない(呼び出しは B の1回だけ)', async () => {
    biasDir = { mode: 'manual', value: 'long' };
    setSplit(true);
    createMock.mockReset().mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    await run();
    expect(createMock.mock.calls.length).toBe(1);                     // ★2回 → 1回
    const only = fullText(paramsOf(0));
    expect(only).toContain('を同時に出し、先に約定した方でエントリーし他方はキャンセルします。');   // B の文面
    expect(only).not.toContain('現在の相場の方向を判断し');                                        // A の文面は無い
    biasDir = { mode: 'ai', value: 'none' };
  });

  it('★AI委任に戻せば A は従来どおり呼ばれる(この検査が恒真でない)', async () => {
    biasDir = { mode: 'ai', value: 'none' };
    const { a } = await renderSplit();
    expect(a).toContain('現在の相場の方向を判断し');
  });

  it('★戦略仕様(buildStrategySpec)の全文: 旧にはあるが B には帯の1行だけ残る(★仕様書で意図的に圧縮と明記済み)', async () => {
    const old = await renderOld();
    const { b } = await renderSplit();
    expect(old).toContain('初期LC(損切り)幅');
    // ★B にも損切幅の帯(下限〜上限)は残る(制約として)。
    expect(b).toContain('損切幅は');
    expect(b).toContain('円<=損切幅<');   // ★2026-08-25: 帯は半開区間の表記になった
  });
});
