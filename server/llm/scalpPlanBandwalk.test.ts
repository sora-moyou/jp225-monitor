import { describe, it, expect, vi } from 'vitest';
import type { Price } from '../types.js';
import type { Bandwalk } from '../bandwalk.js';

// ─── バンドウォーク成立中のプロンプト緩和(v0.9.61)を **実際に組み立てた文字列** で検証する ───
//
// ★このファイルが守るもの:
//   ①バンドウォークで **ない** ときの systemPrompt は従来と byte 単位で完全に同じ(緩和が漏れない)。
//   ②成立中は「距離50円」と「節目起点」だけが緩む。
//   ③★損切り(LC)の下限/上限/安全上限、価格と損切りの向きの不等式、距離の上限は **一切変わらない**。
//     (LC の規律は今回の変更で絶対に触ってはいけない部分なので、文字列レベルで固定する)
//   純関数の単体テストでは「buildScalpPlan が注記を本当に差し込んでいるか」を捕まえられないため、
//   LLM だけをモックして実経路(buildScalpPlan → callWithFallback → create)を通し、
//   create に渡った system メッセージそのものを取り出して比較する。

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
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: true }),
  resolveScalpLcHardMax: () => ({ enabled: true, value: 159 }),
  resolveScalpAiTechnicalEnabled: () => true,
}));

const { buildScalpPlan, buildBandwalkNote } = await import('./scalpPlan.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];
const PLAN_JSON = JSON.stringify({
  direction: 'buy', limitEntry: REF - 20, stopEntry: REF + 20,
  stopLossForLimit: REF - 80, stopLossForStop: REF - 40,
  rationale: 'テスト', refPrice: REF,
});
const BW: Bandwalk = {
  direction: 'up', ratio: 0.83, bars: 12, sinceT: 1_800_000_000_000, t: 1_800_003_300_000,
  close: 38300, band: 38250, rsi: 62.5,
};

/** buildScalpPlan を1回走らせ、create に渡った system メッセージを返す。 */
async function systemPromptOf(bandwalk?: Bandwalk | null): Promise<string> {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: PLAN_JSON } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [], bandwalk });
  expect(r.ok).toBe(true);
  const params = createMock.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
  return params.messages.find(m => m.role === 'system')!.content;
}

describe('バンドウォーク緩和: 実プロンプト', () => {
  it('★非成立(未指定/null)では systemPrompt にバンドウォークの語が1文字も出ない', async () => {
    for (const bw of [undefined, null] as const) {
      const p = await systemPromptOf(bw);
      expect(p).not.toContain('バンドウォーク');
      // 従来の制約はそのまま出ている。
      expect(p).toContain('最低 50円 離す');
      expect(p).toContain('★【節目への置き方(約定させるため必須)】');
    }
  });

  it('★非成立時のプロンプトは「成立時のプロンプトから注記を除いたもの」と byte 一致(差分は注記だけ)', async () => {
    const off = await systemPromptOf(null);
    const on = await systemPromptOf(BW);
    expect(on).not.toBe(off);
    expect(on.split(buildBandwalkNote(BW)).join('')).toBe(off);
  });

  it('成立中は「距離50円」と「節目起点」の2点だけを緩める文が入る', async () => {
    const p = await systemPromptOf(BW);
    expect(p).toContain('【バンドウォーク成立中(上昇(買い方向))】');
    expect(p).toContain('最低距離は課さない');
    expect(p).toContain('節目(サポート/レジスタンス)から導く要求も課さない');
  });

  it('★LC(損切り)の規律は成立中も一言一句変わらない — 下限/上限/安全上限/向きの不等式/距離上限', async () => {
    const off = await systemPromptOf(null);
    const on = await systemPromptOf(BW);
    const LC_LINES = [
      '下限55円',                                   // LC 下限(強制・委任対象外)
      '65円を超える損切りは出さない',                // LC 上限
      '安全上限 159円(有効=手動でもAIでも絶対に超えない)',   // LC 安全上限
      // ★v0.9.70: 損切りの「向き」ブロックは「幅だけを出す(価格は出力しない)」契約に置き換わった。
      //   バンドウォーク中もこの契約は1文字も緩まない、という不変条件は同じ強さで残る。
      '★【最優先: 損切りは「幅」だけを出す(価格は出力しない)】',
      '★【最優先: 価格の向き(無条件・例外なし)】',     // 価格の向き(不等式)
      '価格差(両者の幅)は400円以内',                 // 距離の上限(両レッグ)
      '現在値から200円以内に収めること',              // 距離の上限(片レッグ)
    ];
    for (const line of LC_LINES) {
      // 出現回数まで一致させる(緩和の注記が LC の文言を増減させていないこと)。
      const n = (s: string): number => s.split(line).length - 1;
      expect(n(on), `LC規律の文言が変化した: ${line}`).toBe(n(off));
      expect(n(on)).toBeGreaterThan(0);
    }
    // 注記自身も「LC は変わらない」と明言している(AI が全部自由になったと読まないように)。
    expect(on).toContain('損切り(LC)幅の下限・上限・安全上限');
    expect(on).toContain('一切変わらない');
  });

  it('注記は「距離50円/節目」を書いているブロック(戦略ロジック仕様)より後ろに置かれる(上書きの読み順)', async () => {
    const on = await systemPromptOf(BW);
    expect(on.indexOf('【バンドウォーク成立中')).toBeGreaterThan(on.indexOf('最低 50円 離す'));
  });
});
