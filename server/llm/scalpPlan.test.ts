import { describe, it, expect, vi } from 'vitest';
import {
  parseScalpPlan, runScalpPlan, buildScalpPlan, isLLMEnabled,
  SCALP_QUESTION, SCALP_SYSTEM_PROMPT,
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

describe('scalp プロンプト文言(レッグ独立95円・指値のみ回避)', () => {
  it('SCALP_QUESTION にレッグ独立の LC 上限と指値のみ回避が含まれる', () => {
    expect(SCALP_QUESTION).toContain('それぞれ独立');
    expect(SCALP_QUESTION).toContain('95');
    expect(SCALP_QUESTION).toContain('指値のみ');
  });
  it('SCALP_SYSTEM_PROMPT にレッグ独立の LC 上限とレッグ省略の指針が含まれる', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('それぞれ独立');
    expect(SCALP_SYSTEM_PROMPT).toContain('指値のみ');
    expect(SCALP_SYSTEM_PROMPT).toContain('逆指値のみ');
  });
  it('SCALP_SYSTEM_PROMPT にギャップ戦略の検証済み知見(優位性ゼロ・提案しない)が含まれる', () => {
    // 9年バックテストでギャップ起点戦略(フィル/反転/継続)は全否定。AIが寄りでギャップ狙いを提案しないためのガードレール。
    expect(SCALP_SYSTEM_PROMPT).toContain('ギャップ');
    expect(SCALP_SYSTEM_PROMPT).toContain('検証済みの知見');
    expect(SCALP_SYSTEM_PROMPT).toContain('提案しない');
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
