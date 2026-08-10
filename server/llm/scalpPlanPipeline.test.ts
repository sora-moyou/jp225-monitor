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
  resolveScalpLcFloorDirective: () => floorMock(),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: biasMock() }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: true }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

let biasMock: () => 'long' | 'short' | 'none' = () => 'none';
// ★初期LC下限の設定(mode/value)。ここはテスト固定値(手動・45円)であって、設定の既定値(55円)とは独立。
//   目的は「設定した値がそのまま床として効くか」なので、既定が動いてもこのファイルの検証は変えない。
//   'ai'(AI委任)に倒したケースでも下限が効くこと(=強制が委任に勝つ)を同じ経路で確かめる。
let floorMock: () => { mode: 'manual' | 'ai'; value: number } = () => ({ mode: 'manual', value: 45 });

const { buildScalpPlan } = await import('./scalpPlan.js');

const REF = 38250;
const PRICES: Price[] = [
  // ★timestamp は「今」でなければならない: buildScalpPlan は refPrice の鮮度(stale フラグ + 取得からの経過)を
  //   検証するようになったため、epoch(0)のままだと「古すぎる現在値」として計画自体が作られない。
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
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

// ★v0.9.59(ユーザー指示): 注記は「プランの言い直し」を止め、**片方が無い理由だけ** を書く形に変わった。
//   両レッグ揃っている回は注記そのものが出ない(=旧 NOTE_BOTH は存在しない)。
const NOTE_STOP_MISSING = '（逆指値なし: AIが提案せず）';
const NOTE_STOP_GEOMETRY = '（逆指値は不採用: エントリーが現在値の逆側、または損切り幅の値が不正）';
const NOTE_LIMIT_GEOMETRY = '（指値は不採用: エントリーが現在値の逆側、または損切り幅の値が不正）';
const NOTE_STOP_LC = '（逆指値は不採用: 損切り幅が設定の上限より広い）';
const NOTE_STOP_LC_FLOOR = '（逆指値は不採用: 損切り幅が設定の下限より狭い）';

beforeEach(() => {
  biasMock = () => 'none';
  floorMock = () => ({ mode: 'manual', value: 45 });
});

describe('buildScalpPlan パイプライン: レッグ注記は1回だけ(directional)', () => {
  it('★再現: AI の逆指値レッグが落ちた指値のみプラン→理由注記は1回だけ', async () => {
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
    expect(countOf(r.plan.rationale, NOTE_STOP_GEOMETRY)).toBe(1);
    expect(r.plan.rationale).not.toContain('実際の注文');
  });

  it('AI が指値レッグを落とされた逆指値のみプラン→理由注記は1回だけ', async () => {
    // buy: 逆指値は正(38350>REF)。指値 entry 38400(現在値より上=buy の指値として不正)→ 指値レッグを落とす。
    const raw = JSON.stringify({
      direction: 'buy', rationale: 'ブレイク追随。指値も置いたつもり', refPrice: 1,
      limitEntry: 38400, stopLossForLimit: 38350,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = await planFrom(raw);
    expect(r.plan.stopEntry).toBe(38350);
    expect(r.plan.limitEntry).toBeUndefined();
    expect(countOf(r.plan.rationale, NOTE_LIMIT_GEOMETRY)).toBe(1);
    expect(r.plan.rationale).not.toContain('実際の注文');
  });

  it('AI が最初から指値のみ(逆指値を出さない)→「AIが提案せず」1回・「不採用」とは書かない', async () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目買いのみ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
    });
    const r = await planFrom(raw);
    expect(countOf(r.plan.rationale, NOTE_STOP_MISSING)).toBe(1);
    expect(r.plan.rationale).not.toContain('不採用');
  });

  it('★両レッグ正常→注記なし(rationale は AI の原文のまま=シグナル表示で分かる)', async () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '両面で待つ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = await planFrom(raw);
    expect(r.plan.rationale).toBe('両面で待つ');
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
    // none 化した回の rationale は parse 段の注記(逆指値が落ちた理由)を据え置く(既存挙動)。
    expect(countOf(r.plan.rationale, NOTE_STOP_GEOMETRY)).toBe(1);
  });

  // ★v0.9.59 で直した表示バグ: enforce 段(LC 上限超/下限未満)で片レッグが消えた回、
  //   旧実装は parse 段で付けた「（実際の注文: 指値+逆指値）」をそのまま残していた=
  //   **実プランは指値だけなのに画面は両レッグと言う** 矛盾。しかも最多の脱落理由(下限未満)は無説明だった。
  it('★enforce で逆指値が LC 上限超により落ちた→その理由が1回だけ付く(「指値+逆指値」とは言わない)', async () => {
    // 指値 LC=50(<=65 で残る) / 逆指値 LC=|38350-38200|=150(>65)→ enforce で落ちる。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '両面で待つ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38200,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.stopEntry).toBeUndefined();
    expect(countOf(r.plan.rationale, NOTE_STOP_LC)).toBe(1);
    expect(r.plan.rationale).not.toContain('実際の注文');
  });

  it('★enforce で逆指値が LC 下限未満により落ちた→「設定の下限より狭い」が1回だけ(実データ最多の経路)', async () => {
    // 指値 LC=50(下限45以上で残る) / 逆指値 LC=|38350-38345|=5(<45)→ enforce で落ちる。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '両面で待つ', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38345,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.stopEntry).toBeUndefined();
    expect(countOf(r.plan.rationale, NOTE_STOP_LC_FLOOR)).toBe(1);
    // ★非公開の決済数値(下限の実数)を書かない。
    expect(r.plan.rationale).not.toContain('45');
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

  it('★parse 段で上部が落ちる(幾何不正)→注記は1行だけ・「AIが提案せず」は付かない', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38200 }, lower: okLower },   // upper.entry<REF=幾何不正
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, 'エントリーが現在値の逆側')).toBe(1);
    // 再 parse で「AI が上部を出さなかった」と誤って追記されてはならない。
    expect(r.plan.rationale).not.toContain('AIが提案せず');
  });

  it('parse 段で AI が上部を出さない→「AIが提案せず」注記は1行だけ', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { lower: okLower },
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '※上部のレッグなし: AIが提案せず')).toBe(1);
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
    expect(countOf(r.plan.rationale, '※下部(買い指値)は不採用: バイアス設定と逆')).toBe(1);
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
    expect(countOf(r.plan.rationale, 'エントリーが現在値の逆側')).toBe(1);
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

// ─── ★初期LC「下限」の実強制(設定が実測で効いていなかった問題) ───────────────────
//   実測(signal_trades 598件・2026-07-24〜07-31): lcFloor.mode=manual(設定値45/55)の 269 件のうち
//   60 件(22.3%)が下限未満の初期LCで武装・約定していた。原因は下限を見る判定がコードに存在せず、
//   プロンプト文字列にしか到達していなかったこと(UI/ガイドは「必ず守らせます」と表示していた)。
//   ここは「文言が正しいか」ではなく「**設定した制約が実際にプランへ効くか**」を実経路で固定する。
//   ※これは壊れたプランを止めるだけの修正であり、収益改善を保証するものではない。
describe('★初期LC下限の実強制(手動でも AI委任でも効く)', () => {
  const RAT = '押し目買い';

  it('手動 下限45: 下限未満(LC=20)のレッグは落ちる/下限ちょうど(LC=45)は通る', async () => {
    // 指値 LC=|38200-38180|=20(<45=下限未満→落ちる) / 逆指値 LC=|38350-38305|=45(=下限ちょうど→通る)。
    const raw = JSON.stringify({
      direction: 'buy', rationale: RAT, refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38180,
      stopEntry: 38350, stopLossForStop: 38305,
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBeUndefined();      // 下限未満=落とす(クランプして広げない)
    expect(r.plan.stopLossForLimit).toBeUndefined();
    expect(r.plan.stopEntry).toBe(38350);            // 境界=許可
    expect(r.plan.stopLossForStop).toBe(38305);
  });

  it('手動 下限45: 両レッグとも下限未満なら見送り(none)・理由は lcFloor で記録される', async () => {
    // 実測で最も多かった壊れ方(LC=5 が 97件)を再現する。
    const raw = JSON.stringify({
      direction: 'buy', rationale: RAT, refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38195,   // LC=5
      stopEntry: 38350, stopLossForStop: 38345,     // LC=5
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('none');
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.noneReason).toBe('lcFloor');
    expect(r.noneLegs?.legs).toHaveLength(2);       // 落とした生数値は記録に残る
  });

  it('手動 下限55(既定より厳しい設定): 45〜54 のレッグも落ちる=設定値がそのまま効く', async () => {
    floorMock = () => ({ mode: 'manual', value: 55 });
    const raw = JSON.stringify({
      direction: 'buy', rationale: RAT, refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,   // LC=50(旧既定45なら通るが、設定55では下限未満)
      stopEntry: 38350, stopLossForStop: 38290,     // LC=60(通る)
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.stopEntry).toBe(38350);
  });

  it('★AI委任(mode=ai)でも下限は効く=強制が委任に勝つ(下限は決済ロジックの前提条件)', async () => {
    floorMock = () => ({ mode: 'ai', value: 45 });
    const raw = JSON.stringify({
      direction: 'buy', rationale: RAT, refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38195,   // LC=5
      stopEntry: 38350, stopLossForStop: 38345,     // LC=5
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
  });

  it('range 各脚にも下限が効き、落ちた理由が根拠文に明記される', async () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: '上下に反応帯があるレンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38410 },   // LC=10 → 下限未満
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // LC=50 → 残る
      },
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.range?.lower?.side).toBe('buy');
    expect(countOf(r.plan.rationale, '※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い')).toBe(1);
  });

  it('回帰: 下限以上・上限以下の正常プランは素通し(この修正で通る玉が減らない)', async () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: RAT, refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,   // LC=50
      stopEntry: 38350, stopLossForStop: 38300,     // LC=50
    });
    const r = await planFrom(raw);
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBe(38350);
  });
});

// ─── 初期LC下限は「外部からの要求」で緩められない(HTTP 境界の不変条件) ───────────────────
//
// ★事故の形(v0.9.48 まで): プロンプトには下限を `【強制=委任対象外・コードで必ず適用】` と書いてあるのに、
//   POST /api/scalp-plan は body/query の lcFloorYen をそのまま buildScalpPlan へ渡し、
//   resolveLcRange は LC_YEN_MIN(=20)まで受理していた。つまり **呼び出し側が 20 を送れば床が 20 になり**、
//   設定画面の 45 もプロンプトの「必ず適用」も嘘になっていた(委任対象外のはずの唯一の制約が外部から緩む)。
//   ここは LLM だけをモックした実経路(プロンプト生成 → parse → enforce)で、床が設定値のまま効くことを見る。
describe('初期LC下限: 外部要求で緩められない / 厳しくするのは許す', () => {
  const RAT_NARROW = '押し目買い(初期LC 25円=設定の下限45円未満)';
  // LC = |38200 − 38175| = 25円。設定の下限(45円)未満なので落ちるべきレッグ。
  const NARROW_BUY = JSON.stringify({
    direction: 'buy', rationale: RAT_NARROW, refPrice: 1,
    limitEntry: 38200, stopLossForLimit: 38175,
  });
  // LC = |38200 − 38150| = 50円。設定の下限(45円)は満たすが、要求で 60円 に引き上げると落ちる。
  const MID_BUY = JSON.stringify({
    direction: 'buy', rationale: '押し目買い(初期LC 50円)', refPrice: 1,
    limitEntry: 38200, stopLossForLimit: 38150,
  });

  /** LC override 付きで buildScalpPlan を1回走らせる。 */
  async function planWith(raw: string, over: { lcFloorYen?: number; lcCeilingYen?: number }) {
    createMock.mockReset();
    createMock.mockResolvedValue({ choices: [{ message: { content: raw } }] });
    const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [], ...over });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  /** LLM へ実際に送られたプロンプト全文(system + user)。 */
  function sentPrompt(): string {
    return JSON.stringify(createMock.mock.calls[0]?.[0] ?? {});
  }

  it('★HTTP 越しに lcFloorYen=20 を要求されても、設定値 45円 の床が効いて 25円 のレッグは落ちる', async () => {
    const r = await planWith(NARROW_BUY, { lcFloorYen: 20 });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
  });

  it('★プロンプトにも要求値(20)ではなく設定値(45)が載る(「必ず適用」の文言と実強制が一致)', async () => {
    await planWith(NARROW_BUY, { lcFloorYen: 20 });
    const p = sentPrompt();
    // ★v0.9.61: タグ文言を変更(旧 '【強制=委任対象外・コードで必ず適用】')。「コードで必ず適用」は
    //   「あなたが守らなくてもシステムが適用する」と読め、下限だけ責任の所在が AI の外に置かれていた。
    //   このテストが見ているのは「要求値(20)ではなく設定値(45)が載ること」なので、意図は不変。
    expect(p).toContain('下限45円【最優先・厳守=あなたが必ず満たす(AI委任にしても外れない)】');
    expect(p).not.toContain('下限20円');
  });

  it('設定どおりの 45 を要求するのは当然通る(挙動不変の確認)', async () => {
    const r = await planWith(NARROW_BUY, { lcFloorYen: 45 });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
  });

  it('厳しくする方向(60円)は受理する — より広い初期LCは決済ロジックの前提を壊さず安全側', async () => {
    const loose = await planWith(MID_BUY, {});                    // 50円 は設定下限 45 を満たす
    expect(loose.plan.direction).toBe('buy');
    const strict = await planWith(MID_BUY, { lcFloorYen: 60 });   // 要求 60 まで引き上げ → 落ちる
    expect(strict.plan.direction).toBe('none');
    expect(strict.noneReason).toBe('lcFloor');
  });

  it('設定側が 20 なら 20 が床(外部要求ではなく設定が真の源であることの対照)', async () => {
    floorMock = () => ({ mode: 'manual', value: 20 });
    const r = await planWith(NARROW_BUY, { lcFloorYen: 20 });
    expect(r.plan.direction).toBe('buy');   // 25円 > 設定下限 20円 → 通る
    expect(r.plan.limitEntry).toBe(38200);
  });
});
