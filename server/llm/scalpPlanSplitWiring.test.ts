import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { Price } from '../types.js';
import { A_ANSWER_HEADING } from './trendPrompt.js';


/** ★A(目線)のプロンプトの目印。★**SSOT(server/llm/trendPrompt.ts)から import する。**
 *  ここに literal を書くと、本文が変わったときにこのファイルだけが古い文字列を指したまま赤くなる
 *  (2026-08-24 に実際に起きた: 問いの文面を目印にしていた3箇所が、問いの反転で赤くなった)。 */
const A_PROMPT_MARK = A_ANSWER_HEADING;
// ★段4(v0.9.99): **buildScalpPlan を実プロセスで走らせて** 経路の切り替えを確かめる。
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

describe('① ★分割 OFF(env=0)= 旧経路がそのまま走る', () => {
  // ★v0.9.96 で既定が true に反転した。以前この it は setSplit(undefined) で「既定=OFF」を
  //   前提にしていたが、それは **既定値に寄りかかったテスト** だった。
  //   反転で落ちたので、env を明示する形に直した(=既定が今後どちらに動いても、この it は
  //   「旧経路そのもの」を測り続ける)。既定の値そのものは下の ⑤ が測る。
  it('LLM は1回だけ・ツール3本つき・旧の全文(【最優先: 価格の向き】)が出る', async () => {
    setSplit(false);   // ★明示的に無効化(既定に依存しない)
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
    expect(sys).not.toContain(A_PROMPT_MARK);
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
    expect(textOf(paramsOf(0), 'system')).toContain(A_PROMPT_MARK);
    // ★2026-08-25: B の1行目はユーザー指定文面で A と共通。B だけに在る行で判別する。
    expect(textOf(paramsOf(1), 'system')).toContain('を同時に出し、先に約定した方でエントリーし他方はキャンセルします。');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopEntry).toBe(REF + 20);
      expect(r.plan.limitEntry).toBe(REF - 20);
      // ★2026-08-25: 自由文の形式に strategy の欄が無いので plan.strategy は付かない(捏造しない)。
      expect(r.plan.strategy).toBeUndefined();
      // ★脚ごとの理由は入る(価格と同じ脚に対応)。
      expect(r.plan.entryWhyForStop).toBe('節目手前');
      expect(r.plan.entryWhyForLimit).toBe('押し目');
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
    expect(paramsOf(0).max_tokens).toBe(384);   // ★2026-08-25: a_why の実測(最大172字)を見て 256→384
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
      aDirection: 'buy', bVariant: 'buy', squeezeState: null,
      squeezeUnavailable: 'closed', toolCalls: 0,
    });
    // ★2026-08-25: 自由文の形式に strategy の欄が無いので b_strategy は入らない(捏造しない)。
    expect((rec as { bStrategy?: string } | null)?.bStrategy).toBeUndefined();
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
    // ★基準は「このプロセスで一度も ON にしていない旧経路」。v0.9.96 で既定が true に
    //   なったので undefined では基準にならない(分割側になる)。明示的に false を置く。
    setSplit(false);
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

// ★v0.9.96: 既定が true に反転したことを、**配線の側から**固定する。
//   planSplitConfig.test 側は純関数(resolvePlanSplit)を測るが、ここは
//   「env を何も置かずにアプリを動かすと、実際に A/B の2回呼び出しになるか」を測る。
//   ★この it が赤くなったら、既定の反転が実際の呼び出しに届いていない。
describe('⑤ ★既定(env 未設定)= 分割 ON', () => {
  it('環境変数を置かないと A→B の2回になる(v0.9.96 の反転が配線に届いている)', async () => {
    setSplit(undefined);   // ★何も置かない=既定
    createMock.mockReset();
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: '{"direction":"buy","why":"高値切り上げ"}' } }] })
      .mockResolvedValue({ choices: [{ message: { content: OLD_JSON } }] });
    await run();
    expect(createMock.mock.calls.length).toBe(2);
    // A には注文の話もツールも無い(分割の芯)
    expect(textOf(paramsOf(0), 'system')).toContain(A_PROMPT_MARK);
    expect((paramsOf(0).tools ?? []).length).toBe(0);
  });
});

// ═══ ⑥ ★★2026-08-25: 読み取れなかったことが **台帳の枠組み** まで届く ══════════
//
// ■ なぜここで測るか(単体テストでは足りない)
//   parseBFreeText / buildPlanFromBAnswer の単体テストは「LegDrop が作られる」までしか見ない。
//   ★知りたいのは「それが buildScalpPlan の戻り値の legDrops に載るか」=
//   台帳(signal_plans.leg_drops_json)へ流れる経路が実際に繋がっているか。
//   ★ここが切れていると「読めなかった率」を **後から一件も数えられない**(無言の失敗)。
describe('⑥ ★読み取り失敗が legDrops(→ leg_drops_json)まで届く', () => {
  beforeEach(() => { setSplit(true); createMock.mockReset(); });

  it('★B が形式を外した(旧 JSON をそのまま返した)回: 両脚が落ち、理由が legDrops に残る', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ aPrice: 1, aLcWidth: 2 }) } }] });
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('aiSilent');          // ★AI の判断ではなく B の故障として残る
    expect(r.legDrops?.map(d => `${d.name}:${d.reason}:${d.parseIssue ?? ''}`)).toEqual([
      'stop:missing:「逆指値買い」の行が無い',
      'limit:missing:「指値買い」の行が無い',
    ]);
  });

  it('★片脚だけ読めなかった回: 立った脚は残り、落ちた脚だけが理由つきで残る', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: {
        content: `逆指値買い${REF + 20}円（LC幅60円）節目手前\n指値買い${REF - 20}円 押し目`,
      } }] });
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.stopEntry).toBe(REF + 20);
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.legDrops).toContainEqual({
      name: 'limit', reason: 'missing', entry: REF - 20, parseIssue: '「指値買い」のLC幅を読めなかった',
    });
  });

  it('★★否定対照: 期待外の注文タイプで返された回は、その脚に入らず捨てられる', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: {
        content: `指値売り${REF + 20}円（LC幅60円）戻り売り\n逆指値売り${REF - 20}円（LC幅58円）下抜け`,
      } }] });
    const r = await run();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★売りの価格が買いの脚へ紛れ込んでいない(=即約定する不正注文が作られない)
    expect(r.plan.direction).toBe('none');
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.legDrops?.every(d => d.reason === 'missing')).toBe(true);
  });

  it('★両脚とも読めた回は legDrops が付かない(この検査が恒真でない)', async () => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: B_JSON } }] });
    const r = await run();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.legDrops).toBeUndefined();
  });
});

// ═══ ★2026-08-26: ピボットの5円ずらしが **buildScalpPlan の配線を通って** 効く ═══════
//
// ■ ★なぜこの検査が要るか(単体テストではすり抜けた)
//   core/pivotNudge.test.ts と server/llm/pivotNudgeApply.test.ts は
//   **関数を直接呼んでいる** ので、buildScalpPlan の中で呼ばれているかを1本も見ていない。
//   実際、配線を外す変異を当てても両方とも緑のままだった。
//   ★「側の検査が分割経路を通っていなかった」のと同じ型の穴なので、ここで配線そのものを固定する。
describe('★ピボットの5円ずらしが buildScalpPlan を通って効く(配線の実証)', () => {
  const LEVELS = [
    { price: REF + 100, kinds: ['sessHL'] },      // ピボット
    { price: REF - 100, kinds: ['grid500'] },     // 計算値
  ];
  const runWith = (levels?: readonly { price: number; kinds?: string[] }[]) =>
    buildScalpPlan({
      symbol: 'NIY=F', prices: PRICES, news: [],
      technical: '【B文脈】主要節目', technicalForTrend: '【A文脈】足だけ',
      ...(levels ? { levels } : {}),
    });

  beforeEach(() => { setSplit(true); createMock.mockReset(); });

  /** A=bull → B(buy)。★逆指値をピボットちょうど・指値は計算値ちょうどに置かせる。 */
  const feedPlan = (): void => {
    createMock
      .mockResolvedValueOnce({ choices: [{ message: { content: A_JSON } }] })
      .mockResolvedValueOnce({ choices: [{ message: {
        content: `逆指値買い${REF + 100}円（LC幅60円）節目抜け\n指値買い${REF - 100}円（LC幅60円）押し目`,
      } }] });
  };

  it('★★ピボットちょうどの脚は5円ずれ、計算値ちょうどの脚は動かない', async () => {
    feedPlan();
    const r = await runWith(LEVELS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 逆指値(上のピボット) → 遠ざかる側=上へ5円
    expect(r.plan.stopEntry).toBe(REF + 105);
    // 指値(下・キリ番=計算値) → 動かさない
    expect(r.plan.limitEntry).toBe(REF - 100);
    // ★損切りは動かさない(ユーザー確定 2026-08-26)= ずらした脚の幅だけ5円広がる。
    //   ★帯(55〜159)の中なので落ちない。外に出た脚は enforce が 'lc' で落とす
    //   (server/llm/pivotNudgeApply.test.ts の「帯の検査」で固定)。
    expect(r.plan.stopEntry! - r.plan.stopLossForStop!).toBe(65);    // ずれた脚: 60 → 65
    expect(r.plan.limitEntry! - r.plan.stopLossForLimit!).toBe(60);  // ずれない脚: 60 のまま
  });

  it('★★否定対照: 節目を渡さない回は1円も動かない(=この検査が配線を見ている)', async () => {
    feedPlan();
    const r = await runWith(undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stopEntry).toBe(REF + 100);     // ★ずれない
    expect(r.plan.limitEntry).toBe(REF - 100);
  });
});
