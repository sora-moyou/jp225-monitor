import { describe, it, expect, vi } from 'vitest';
import {
  parseScalpPlan, parseRangeLeg, runScalpPlan, buildScalpPlan, isLLMEnabled,
  SCALP_QUESTION, SCALP_SYSTEM_PROMPT,
  buildScalpQuestion, buildScalpSystemPrompt, resolveLcRange, scalpJsonInstruction,
  enforcePlanConstraints,
  DEFAULT_LC_FLOOR_YEN, DEFAULT_LC_CEILING_YEN,
  type ToolHandlers, type AiPlan,
} from './openai.js';

// LLM 応答テキスト→AiPlan の検証(refPrice は必ず monitor 側の値で上書きされる)。
const REF = 38250;

const goodPlan: AiPlan = {
  direction: 'buy',
  limitEntry: 38200,
  stopEntry: 38350,
  stopLossForLimit: 38150,
  stopLossForStop: 38300,
  rationale: '押し目買い。直近安値38200が支持。',
  refPrice: 12345,   // LLM 自己申告(無視される想定)
};

describe('parseScalpPlan', () => {
  it('素の JSON を検証して AiPlan を返す(refPrice は引数で上書き)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
      expect(r.plan.rationale).toContain('押し目');
      expect(r.plan.refPrice).toBe(REF);   // 自己申告12345ではなく monitor 値
    }
  });

  it('コードフェンス+前後説明が混じっても最初の JSON を拾う', () => {
    const raw = 'これが計画です:\n```json\n' + JSON.stringify(goodPlan) + '\n```\n以上。';
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
  });

  it('direction 不正→ok:false', () => {
    const bad = { ...goodPlan, direction: 'hold' };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('direction');
  });

  it('価格が数値でない→ok:false', () => {
    const bad = { ...goodPlan, limitEntry: 'x' };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(false);
  });

  it('rationale 欠落→ok:false', () => {
    const { rationale, ...rest } = goodPlan;
    void rationale;
    const r = parseScalpPlan(JSON.stringify(rest), REF);
    expect(r.ok).toBe(false);
  });

  it('JSON でない→ok:false', () => {
    const r = parseScalpPlan('普通の文章です', REF);
    expect(r.ok).toBe(false);
  });

  it('空文字→ok:false', () => {
    const r = parseScalpPlan('', REF);
    expect(r.ok).toBe(false);
  });

  it('direction:"none"(見送り)は ok:true・価格欠落は不正としない', () => {
    // rationale + refPrice のみ(価格フィールドなし)でも見送りとして正当。
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '良い場面なし。様子見。' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.rationale).toContain('様子見');
      expect(r.plan.refPrice).toBe(REF);   // refPrice は monitor 値で上書き
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBeUndefined();
    }
  });

  it('direction:"none" は rationale 欠落なら ok:false(見送り理由は必須)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none' }), REF);
    expect(r.ok).toBe(false);
  });

  it('指値レッグの片側だけ(limitEntry 欠落・stopLossForLimit 残)→ok:false(対の不整合)', () => {
    // レッグは対で出す規約: 片方だけは不正。
    const { limitEntry, ...noLimit } = goodPlan;
    void limitEntry;
    const r = parseScalpPlan(JSON.stringify(noLimit), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('limit leg');
  });

  it('逆指値レッグの片側だけ(stopEntry 欠落・stopLossForStop 残)→ok:false(対の不整合)', () => {
    const { stopEntry, ...noStop } = goodPlan;
    void stopEntry;
    const r = parseScalpPlan(JSON.stringify(noStop), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('stop leg');
  });

  it('指値のみプラン(逆指値レッグ欠落)→ok:true・plan に limit だけ入る', () => {
    // stopEntry / stopLossForStop を省いた「指値のみ」。逆指値レッグの LC が95円超の時の回避策。
    const { stopEntry, stopLossForStop, ...limitOnly } = goodPlan;
    void stopEntry; void stopLossForStop;
    const r = parseScalpPlan(JSON.stringify(limitOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.stopLossForStop).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('逆指値のみプラン(指値レッグ欠落)→ok:true・plan に stop だけ入る', () => {
    const { limitEntry, stopLossForLimit, ...stopOnly } = goodPlan;
    void limitEntry; void stopLossForLimit;
    const r = parseScalpPlan(JSON.stringify(stopOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38300);
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('両レッグありは従来どおり ok:true(全価格が入る)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('buy で両レッグとも欠落(価格皆無)→ok:false', () => {
    // direction≠none なのに価格が1つも無いのは不正。
    const r = parseScalpPlan(JSON.stringify({ direction: 'buy', rationale: '理由' }), REF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least one leg');
  });
});

// runScalpPlan: create を注入して tool ループ+parse+再要求を検証(実 API 非依存)。
function fakeCreate(seq: any[]) {
  let i = 0;
  return vi.fn(async () => seq[i++]);
}
const NO_TOOLS: unknown[] = [];
const NO_HANDLERS: ToolHandlers = {};

describe('runScalpPlan (create 注入)', () => {
  it('一発で有効 JSON→AiPlan を返す', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const plan = await runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF);
    expect(plan.direction).toBe('buy');
    expect(plan.refPrice).toBe(REF);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('1回目が不正→厳格に1回だけ再要求して復帰', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: 'すみません、JSONではない回答' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const plan = await runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF);
    expect(plan.direction).toBe('buy');
    expect(create).toHaveBeenCalledTimes(2);   // 初回 + 再要求1回
  });

  it('再要求しても不正→例外(再要求は1回まで)', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] },
      { choices: [{ message: { content: 'まだ not json' }, finish_reason: 'stop' }] },
    ]);
    await expect(runScalpPlan(create as any, 'sys', 'user', NO_TOOLS, NO_HANDLERS, REF))
      .rejects.toThrow(/parse failed after retry/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('データツールを名前で振り分けてから JSON を返す', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'query_alerts', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: JSON.stringify(goodPlan) }, finish_reason: 'stop' }] },
    ]);
    const data = vi.fn(async () => 'ALERTS');
    const plan = await runScalpPlan(create as any, 'sys', 'user', [{}], { query_alerts: data }, REF);
    expect(plan.direction).toBe('buy');
    expect(data).toHaveBeenCalledTimes(1);
  });
});

describe('scalp プロンプト文言(レッグ独立・指値のみ回避・LC 幅パラメータ)', () => {
  it('SCALP_QUESTION(既定)にレッグ独立の LC 上限と指値のみ回避が含まれる', () => {
    expect(SCALP_QUESTION).toContain('それぞれ独立');
    expect(SCALP_QUESTION).toContain('指値のみ');
    // ★新既定: 上限65・下限45(旧75/95 は撤去)。
    expect(SCALP_QUESTION).toContain('65');
    expect(SCALP_QUESTION).toContain('45');
    expect(SCALP_QUESTION).not.toContain('95');
    expect(SCALP_QUESTION).not.toContain('75');
  });
  it('SCALP_SYSTEM_PROMPT(既定)にレッグ独立の LC 上限とレッグ省略の指針が含まれる', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('それぞれ独立');
    expect(SCALP_SYSTEM_PROMPT).toContain('指値のみ');
    expect(SCALP_SYSTEM_PROMPT).toContain('逆指値のみ');
    // ★新既定: 上限65(旧95 は撤去)。
    expect(SCALP_SYSTEM_PROMPT).toContain('65');
    expect(SCALP_SYSTEM_PROMPT).not.toContain('95');
    expect(SCALP_SYSTEM_PROMPT).not.toContain('75');
  });
  it('SCALP_SYSTEM_PROMPT にギャップ戦略の検証済み知見(優位性ゼロ・提案しない)が含まれる(v0.7.38 回帰)', () => {
    // 9年バックテストでギャップ起点戦略(フィル/反転/継続)は全否定。AIが寄りでギャップ狙いを提案しないためのガードレール。
    expect(SCALP_SYSTEM_PROMPT).toContain('ギャップ');
    expect(SCALP_SYSTEM_PROMPT).toContain('検証済みの知見');
    expect(SCALP_SYSTEM_PROMPT).toContain('提案しない');
  });

  it('既定(引数なし)は floor=45/ceiling=65 を使う', () => {
    expect(DEFAULT_LC_FLOOR_YEN).toBe(45);
    expect(DEFAULT_LC_CEILING_YEN).toBe(65);
    expect(buildScalpQuestion()).toBe(SCALP_QUESTION);
    expect(buildScalpSystemPrompt()).toBe(SCALP_SYSTEM_PROMPT);
  });

  it('lcCeilingYen=65 でプロンプトに 65 が入り 95 が入らない(明示指定)', () => {
    const q = buildScalpQuestion(45, 65);
    const s = buildScalpSystemPrompt(45, 65);
    expect(q).toContain('65');
    expect(q).not.toContain('95');
    expect(s).toContain('65');
    expect(s).not.toContain('95');
  });

  it('lcFloorYen/lcCeilingYen をプロンプトに反映(例: 50〜120)', () => {
    const q = buildScalpQuestion(50, 120);
    const s = buildScalpSystemPrompt(50, 120);
    expect(q).toContain('50');
    expect(q).toContain('120');
    expect(q).toContain(`50〜120円`);
    expect(s).toContain(`50〜120円`);
    // v0.7.37 のレッグ独立・指値のみ/逆指値のみ回避は上限が変わっても保持。
    expect(q).toContain('それぞれ独立');
    expect(q).toContain('指値のみ');
    expect(s).toContain('逆指値のみ');
    // v0.7.38 のギャップ知見も保持。
    expect(s).toContain('ギャップ');
    expect(s).toContain('検証済みの知見');
  });
});

describe('resolveLcRange(サニタイズ/クランプ)', () => {
  it('未指定は既定 45/65', () => {
    expect(resolveLcRange()).toEqual({ floorYen: 45, ceilingYen: 65 });
    expect(resolveLcRange(undefined, undefined)).toEqual({ floorYen: 45, ceilingYen: 65 });
  });
  it('正常値はそのまま', () => {
    expect(resolveLcRange(50, 120)).toEqual({ floorYen: 50, ceilingYen: 120 });
  });
  it('非有限/非数値は既定へフォールバック', () => {
    expect(resolveLcRange(NaN, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    expect(resolveLcRange(Infinity, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    // @ts-expect-error 実行時の不正入力を想定
    expect(resolveLcRange('x', 'y')).toEqual({ floorYen: 45, ceilingYen: 65 });
  });
  it('範囲外(<20 / >300)は該当側を既定へ', () => {
    expect(resolveLcRange(10, 80)).toEqual({ floorYen: 45, ceilingYen: 80 });
    expect(resolveLcRange(50, 999)).toEqual({ floorYen: 50, ceilingYen: 65 });
  });
  it('floor>ceiling は floor を ceiling まで下げる(締めた上限を尊重・既定へ戻さない)', () => {
    expect(resolveLcRange(120, 50)).toEqual({ floorYen: 50, ceilingYen: 50 });
    // ★フットガン: 呼び出し側 floor 未指定(=既定45)で ceiling を 20〜44 に締めても、上限が黙って緩まない。
    expect(resolveLcRange(undefined, 30)).toEqual({ floorYen: 30, ceilingYen: 30 });
  });
});

describe('scalpJsonInstruction フィールド注記の LC 反映', () => {
  it('既定(引数なし)の JSON 注記に LC幅45〜65 が入り 95/75 が入らない', () => {
    const j = scalpJsonInstruction(38250);
    expect(j).toContain('LC幅45〜65円');
    expect(j).toContain('65円超は出さない');
    expect(j).not.toContain('95');
    expect(j).not.toContain('75');
    // refPrice は反映される。
    expect(j).toContain('38250');
  });
  it('明示 ceiling(120)を JSON 注記に反映', () => {
    const j = scalpJsonInstruction(38250, 50, 120);
    expect(j).toContain('LC幅50〜120円');
    expect(j).toContain('120円超は出さない');
    expect(j).not.toContain('95');
  });
});

describe('enforcePlanConstraints(LC上限・バイアスのハード適用)', () => {
  // buy: 指値LC=|38200-38150|=50 / 逆指値LC=|38350-38300|=50。
  const base: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };

  it('両レッグとも上限以内(50≤65)→素通し', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('境界(ちょうど上限=50)は許可', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 50, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('上限超のレッグだけ落とす(逆指値LC=50が上限49超→逆指値のみ落ち、指値も同50なので両落ち→none)', () => {
    // ceiling=49 だと両レッグ(各50)が超える→両落ち→none。
    const r = enforcePlanConstraints(base, { ceilingYen: 49, bias: 'none' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBeUndefined();
  });

  it('片レッグだけ上限超→そのレッグを落とし他レッグは残る', () => {
    // 逆指値LC=|38400-38300|=100(上限65超)→逆指値落ち。指値LC=50は残る。
    const p: AiPlan = { ...base, stopEntry: 38400, stopLossForStop: 38300 };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopLossForLimit).toBe(38150);
    expect(r.stopEntry).toBeUndefined();
    expect(r.stopLossForStop).toBeUndefined();
  });

  it('両レッグとも上限超→direction:none(価格なし)', () => {
    const p: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38400,   // LC=100
      stopEntry: 38200, stopLossForStop: 38320,     // LC=120
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBeUndefined();
    expect(r.rationale).toBe('戻り売り');
    expect(r.refPrice).toBe(REF);
  });

  it("bias='long' かつ sell → none(素通し前に方向veto)", () => {
    const sell: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38340,   // LC=40(上限内)
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(sell, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
  });

  it("bias='short' かつ buy → none", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('none');
  });

  it("bias='long' かつ buy は素通し / bias='short' かつ sell は素通し", () => {
    const rLong = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'long' });
    expect(rLong.direction).toBe('buy');
    const sell: AiPlan = { ...base, direction: 'sell' };
    const rShort = enforcePlanConstraints(sell, { ceilingYen: 65, bias: 'short' });
    expect(rShort.direction).toBe('sell');
  });

  it("bias='none' は方向を素通し(buy/sell とも)", () => {
    expect(enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' }).direction).toBe('buy');
    const sell: AiPlan = { ...base, direction: 'sell' };
    expect(enforcePlanConstraints(sell, { ceilingYen: 65, bias: 'none' }).direction).toBe('sell');
  });

  it('direction:none は何もしない(素通し)', () => {
    const none: AiPlan = { direction: 'none', rationale: '見送り', refPrice: REF };
    const r = enforcePlanConstraints(none, { ceilingYen: 65, bias: 'long' });
    expect(r).toEqual(none);
  });

  it('LC上限で片レッグ残存後にバイアス違反なら none(LC→bias の順で最終none)', () => {
    // sell・逆指値LC=100(落ち)・指値LC=40(残る)だが bias=long でvetoされ none。
    const p: AiPlan = {
      direction: 'sell',
      limitEntry: 38300, stopLossForLimit: 38340,  // LC=40 残る
      stopEntry: 38200, stopLossForStop: 38320,    // LC=120 落ち
      rationale: '戻り売り', refPrice: REF,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
    expect(r.limitEntry).toBeUndefined();
  });
});

// ─── レンジ両面ストラドル(range): parse ───
describe('parseScalpPlan range(レンジ両面ストラドル)', () => {
  // REF=38250。upper.entry は現在値超・lower.entry は現在値未満。
  const upper = { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 };  // 上=売り指値 LC=50
  const lower = { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 };    // 下=買い指値 LC=50
  const rangePlan = { direction: 'range', rationale: 'レンジ・上下に反応帯', range: { upper, lower }, refPrice: 1 };

  it('有効な両レッグ range→ok:true・range.upper/lower が入る(refPrice は上書き)', () => {
    const r = parseScalpPlan(JSON.stringify(rangePlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.refPrice).toBe(REF);
      expect(r.plan.range?.upper).toEqual({ side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 });
      expect(r.plan.range?.lower).toEqual({ side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 });
    }
  });

  it('抜け追随(逆指値)形も通る: 上=買い逆指値 / 下=売り逆指値', () => {
    const p = { direction: 'range', rationale: 'ブレイク追随', refPrice: 1, range: {
      upper: { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = parseScalpPlan(JSON.stringify(p), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper?.type).toBe('stop');
      expect(r.plan.range?.lower?.side).toBe('sell');
    }
  });

  it('片レッグが幾何違反(upper.entry が現在値未満)→そのレッグを落とし片面 range で通す', () => {
    const bad = { ...rangePlan, range: { upper: { ...upper, entry: 38200 }, lower } };  // upper.entry<REF
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.range?.upper).toBeUndefined();   // 幾何違反で落ちる
      expect(r.plan.range?.lower).toBeDefined();
    }
  });

  it('片レッグが壊れている(side 不正)→そのレッグを落とし片面 range', () => {
    const bad = { ...rangePlan, range: { upper: { ...upper, side: 'hold' }, lower } };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper).toBeUndefined();
      expect(r.plan.range?.lower?.side).toBe('buy');
    }
  });

  it('両レッグとも無効(幾何違反)→ok:true の見送り(none)', () => {
    const bad = { ...rangePlan, range: {
      upper: { ...upper, entry: 38000 },   // 現在値未満=違反
      lower: { ...lower, entry: 38500 },   // 現在値超=違反
    } };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.range).toBeUndefined();
      expect(r.plan.rationale).toContain('レンジ');
    }
  });

  it('range フィールド欠落→none(見送り)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'range', rationale: '理由' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.direction).toBe('none');
  });

  it('既存の buy/sell/none パースは不変(range 追加で壊れない)', () => {
    expect(parseScalpPlan(JSON.stringify(goodPlan), REF).ok).toBe(true);
    expect(parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '様子見' }), REF).ok).toBe(true);
  });
});

describe('parseRangeLeg', () => {
  it('正常レッグを返す', () => {
    expect(parseRangeLeg({ side: 'buy', type: 'stop', entry: 100, stopLoss: 90 }))
      .toEqual({ side: 'buy', type: 'stop', entry: 100, stopLoss: 90 });
  });
  it('side/type enum 違反・非有限・非オブジェクトは null', () => {
    expect(parseRangeLeg({ side: 'x', type: 'limit', entry: 1, stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'y', entry: 1, stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'limit', entry: 'a', stopLoss: 2 })).toBeNull();
    expect(parseRangeLeg({ side: 'buy', type: 'limit', entry: 1 })).toBeNull();   // stopLoss 欠落
    expect(parseRangeLeg(null)).toBeNull();
    expect(parseRangeLeg('nope')).toBeNull();
  });
});

// ─── レンジ両面ストラドル(range): enforce ───
describe('enforcePlanConstraints range(LC上限/バイアス per レッグ)', () => {
  const base: AiPlan = {
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },  // LC=50
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },    // LC=50
    },
  };

  it('両レッグ上限以内(50≤65)→素通し(両レッグ残る)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeDefined();
    expect(r.range?.lower).toBeDefined();
  });

  it('片レッグだけ LC 上限超→そのレッグを落とし片面 range', () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38520 },   // LC=120 超
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // LC=50 残る
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower).toBeDefined();
  });

  it('両レッグとも LC 上限超→none', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 49, bias: 'none' });  // 各50>49
    expect(r.direction).toBe('none');
    expect(r.range).toBeUndefined();
    expect(r.rationale).toBe('レンジ');
  });

  it("bias='long' は sell レッグを落とす(upper=sell を drop・lower=buy 残る)", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();   // sell 落ち
    expect(r.range?.lower?.side).toBe('buy');
  });

  it("bias='short' は buy レッグを落とす(lower=buy を drop・upper=sell 残る)", () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('range');
    expect(r.range?.lower).toBeUndefined();
    expect(r.range?.upper?.side).toBe('sell');
  });

  it("bias が両レッグを落とすと none(long で両レッグ sell)", () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'long' });
    expect(r.direction).toBe('none');
  });
});

describe('scalp プロンプト range トグル(rangeEnabled)', () => {
  it('rangeEnabled=true(既定)でプロンプト/JSON に range 指示が入る', () => {
    expect(buildScalpQuestion()).toContain('range');
    expect(buildScalpSystemPrompt()).toContain('range');
    expect(scalpJsonInstruction(38250)).toContain('range');
    // 既定は range ON=SCALP_QUESTION/SCALP_SYSTEM_PROMPT にも range 文言。
    expect(SCALP_QUESTION).toContain('range');
    expect(SCALP_SYSTEM_PROMPT).toContain('range');
  });
  it('rangeEnabled=false で range を明示禁止(「range は出さない」)', () => {
    expect(buildScalpQuestion(45, 65, false)).toContain('range');   // 「range は出さない」を含む
    expect(buildScalpQuestion(45, 65, false)).toContain('出さない');
    expect(buildScalpSystemPrompt(45, 65, false)).toContain('出さない');
    // JSON スキーマの direction enum に range が入らない。
    expect(scalpJsonInstruction(38250, 45, 65, false)).not.toContain('"range"');
  });
});

describe('buildScalpPlan (no-key path)', () => {
  it('LLM キー未設定→{ ok:false, error:"LLM未設定" }', async () => {
    // テスト環境では API キー未設定を前提(isLLMEnabled=false)。念のため確認してから検証する。
    if (isLLMEnabled()) {
      // キーが設定されている環境ではこのケースは検証対象外。
      return;
    }
    const r = await buildScalpPlan({ symbol: 'NIY=F' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('LLM未設定');
  });
});
