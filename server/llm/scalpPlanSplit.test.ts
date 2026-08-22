import { describe, it, expect } from 'vitest';
import { runSplitPlan, type SplitCallResult, type SplitPlanDeps } from './scalpPlanSplit.js';
import { resolvePlanSplit, PLAN_SPLIT_DEFAULT } from './planSplitConfig.js';
import { TREND_MAX_TOKENS, parseTrendAnswer } from './trendPrompt.js';

// ★段4(v0.9.100): A→B の直列呼び出し。
//
// 何を守っているか:
//   ① ★A→B が **実プロセスで直列に通る**(LLM は呼ばず、応答だけ差し替える)
//   ② ★A が失敗したら **B を1度も呼ばない**・再試行しない・none_reason='aFailed'
//   ③ ★A が range かつ レンジ不許可 なら **B を1度も呼ばない**・'rangeDisabled'・b_variant='none'
//   ④ ★A の自由文(why)が B のプロンプトに1文字も入らない
//   ⑤ ★文脈を取り直さない(A に渡した断面がそのまま B へ)
//   ⑥ ★見送りの4語が別々に出る(ai / aiSilent / aFailed / rangeDisabled)
//   ⑦ ★旧経路に戻せる(スイッチ1箇所)

const REF = 38250;

/** 呼び出しを記録する転送のモック。★LLM は1回も呼ばない。 */
function deps(trend: string | Error, order: string | Error = '{}'): SplitPlanDeps & {
  calls: Array<{ who: 'A' | 'B'; system: string; user: string }>;
} {
  const calls: Array<{ who: 'A' | 'B'; system: string; user: string }> = [];
  const mk = (who: 'A' | 'B', res: string | Error) =>
    async (system: string, user: string): Promise<SplitCallResult> => {
      calls.push({ who, system, user });
      if (res instanceof Error) throw res;
      return { text: res, toolCalls: who === 'A' ? 0 : 2, provider: { name: 'test', model: 'm' } };
    };
  return { calls, callTrend: mk('A', trend), callOrder: mk('B', order) };
}

const OPTS = {
  refPrice: REF,
  trendContext: '【A用の文脈】足とテクニカルと基礎データだけ',
  orderContext: '【B用の文脈】主要節目 / 直近アラート / 長期高安 を含む',
  floorYen: 55, ceilingYen: 160, rangeEnabled: false, squeezeState: null,
} as const;

const A_BULL = '{"direction":"bull","why":"高値切り上げが3本続き、5分足がMA上"}';
const B_BOTH = '{"strategy":"押し目を節目手前で拾う","aPrice":38400,"aLcWidth":80,"aWhy":"節目手前","iPrice":38100,"iLcWidth":70,"iWhy":"押し目"}';

describe('① ★A→B が直列に通る(実プロセス・LLM 無し)', () => {
  it('A で bull → B(buy 版)が呼ばれ、既存の AiPlan が出来る', async () => {
    const d = deps(A_BULL, B_BOTH);
    const r = await runSplitPlan(d, OPTS);
    expect(d.calls.map(c => c.who)).toEqual(['A', 'B']);   // ★順番も回数もこれだけ
    expect(r.parsed.ok).toBe(true);
    expect(r.parsed.plan.direction).toBe('buy');
    expect(r.parsed.plan.stopEntry).toBe(38400);          // あ)=上=逆指値買い
    expect(r.parsed.plan.limitEntry).toBe(38100);         // い)=下=指値買い
    expect(r.parsed.plan.stopLossForStop).toBe(38400 - 80);
    expect(r.parsed.plan.stopLossForLimit).toBe(38100 - 70);
    expect(r.parsed.noneReason).toBeUndefined();
    expect(r.record).toMatchObject({
      aDirection: 'bull', bVariant: 'buy', squeezeState: null,
      bStrategy: '押し目を節目手前で拾う',
    });
    // ★ツールは A=0 / B=2 で合計2(数えて0 と 数えていない を混ぜない)
    expect(r.record.toolCalls).toBe(2);
  });

  it('A で bear → B(sell 版)。あ)=指値売り / い)=逆指値売り に入れ替わる', async () => {
    const d = deps('{"direction":"bear"}', B_BOTH);
    const r = await runSplitPlan(d, OPTS);
    expect(r.parsed.plan.direction).toBe('sell');
    expect(r.parsed.plan.limitEntry).toBe(38400);         // あ)=上=指値売り
    expect(r.parsed.plan.stopEntry).toBe(38100);          // い)=下=逆指値売り
    expect(r.parsed.plan.stopLossForLimit).toBe(38400 + 80);  // ★売りの損切りは必ず上
    expect(r.parsed.plan.stopLossForStop).toBe(38100 + 70);
    expect(r.record.bVariant).toBe('sell');
  });

  it('★range 許可 + スクイーズ → range-breakout / それ以外 → range-fade(コードが選ぶ)', async () => {
    const on = { ...OPTS, rangeEnabled: true };
    const brk = await runSplitPlan(deps('{"direction":"range"}', B_BOTH), { ...on, squeezeState: 'squeeze' });
    expect(brk.record.bVariant).toBe('range-breakout');
    expect(brk.parsed.plan.range?.upper).toMatchObject({ side: 'buy', type: 'stop' });
    const fade = await runSplitPlan(deps('{"direction":"range"}', B_BOTH), { ...on, squeezeState: 'bulge' });
    expect(fade.record.bVariant).toBe('range-fade');
    expect(fade.parsed.plan.range?.upper).toMatchObject({ side: 'sell', type: 'limit' });
  });

  it('⑤ ★文脈を取り直さない(A に渡した断面がそのまま B のプロンプトに入る)', async () => {
    const d = deps(A_BULL, B_BOTH);
    await runSplitPlan(d, OPTS);
    expect(d.calls[0]!.system).toContain(OPTS.trendContext);
    expect(d.calls[1]!.system).toContain(OPTS.orderContext);
    // ★A に節目・アラート・長期高安の文脈は渡っていない
    expect(d.calls[0]!.system).not.toContain('主要節目');
    expect(d.calls[0]!.system).not.toContain('長期高安');
  });

  it('④ ★A の自由文が B に1文字も入らない', async () => {
    const d = deps(A_BULL, B_BOTH);
    await runSplitPlan(d, OPTS);
    const b = d.calls[1]!.system + d.calls[1]!.user;
    expect(b).not.toContain('高値切り上げが3本続き');
    expect(b).not.toContain('5分足がMA上');
  });
});

describe('② ★A が失敗したら B を呼ばない', () => {
  it('A が例外 → B は0回・再試行なし・aFailed', async () => {
    const d = deps(new Error('429 rate limited'), B_BOTH);
    const r = await runSplitPlan(d, OPTS);
    expect(d.calls.map(c => c.who)).toEqual(['A']);          // ★B は1度も呼ばれない
    expect(d.calls.filter(c => c.who === 'A').length).toBe(1); // ★再試行もしない
    expect(r.parsed.plan.direction).toBe('none');
    expect(r.parsed.noneReason).toBe('aFailed');
    expect(r.record.bVariant).toBe('none');
    expect(r.record.aDirection).toBeUndefined();
  });

  it('A が3語のどれでもない → B は0回・aFailed', async () => {
    for (const bad of ['{"direction":"buy"}', '{"direction":"none"}', 'すみません分かりません', '']) {
      const d = deps(bad, B_BOTH);
      const r = await runSplitPlan(d, OPTS);
      expect(d.calls.map(c => c.who)).toEqual(['A']);
      expect(r.parsed.noneReason).toBe('aFailed');
      expect(r.record.bVariant).toBe('none');
    }
  });

  it("★aFailed は 'ai'(相場の判断)と別の語で残る", async () => {
    const failed = await runSplitPlan(deps(new Error('x')), OPTS);
    const judged = await runSplitPlan(
      deps(A_BULL, '{"aWhy":"上は空白","iWhy":"下は遠い"}'), OPTS,
    );
    expect(failed.parsed.noneReason).toBe('aFailed');
    expect(judged.parsed.noneReason).toBe('ai');
    expect(judged.record.aiWhy).toBe('あ) 上は空白 / い) 下は遠い');
  });
});

describe('③ ★A が range かつ レンジ不許可 なら B を呼ばない', () => {
  it('B は0回・rangeDisabled・b_variant は明示的に "none"', async () => {
    const d = deps('{"direction":"range","why":"どちらとも言えない"}', B_BOTH);
    const r = await runSplitPlan(d, { ...OPTS, rangeEnabled: false });
    expect(d.calls.map(c => c.who)).toEqual(['A']);
    expect(r.parsed.plan.direction).toBe('none');
    expect(r.parsed.noneReason).toBe('rangeDisabled');
    expect(r.record.bVariant).toBe('none');          // ★NULL ではなく 'none'
    expect(r.record.aDirection).toBe('range');       // ★①「A が range と答えた回」は数えられる
    expect(r.record.aWhy).toBe('どちらとも言えない');
    expect(r.parsed.plan.rationale).toContain('どちらとも言えない');
  });

  it('レンジ許可なら B が呼ばれる(同じ A の答えでも分かれる)', async () => {
    const d = deps('{"direction":"range"}', B_BOTH);
    await runSplitPlan(d, { ...OPTS, rangeEnabled: true });
    expect(d.calls.map(c => c.who)).toEqual(['A', 'B']);
  });
});

describe('⑥ ★見送りの4語が別々に出る', () => {
  it('ai(理由あり) / aiSilent(無言) / aiSilent(契約に無い形)', async () => {
    const withWhy = await runSplitPlan(deps(A_BULL, '{"aWhy":"上は空白","iWhy":"下は遠い"}'), OPTS);
    expect(withWhy.parsed.noneReason).toBe('ai');
    expect(withWhy.record.aiWhy).toBeDefined();

    const silent = await runSplitPlan(deps(A_BULL, '{}'), OPTS);
    expect(silent.parsed.noneReason).toBe('aiSilent');
    expect(silent.record.aiWhy).toBeUndefined();

    const junk = await runSplitPlan(deps(A_BULL, 'すみません'), OPTS);
    expect(junk.parsed.noneReason).toBe('aiSilent');
    expect(junk.record.bVariant).toBe('buy');   // ★B は呼んだ(呼ばなかった 'none' と区別できる)
  });

  it('★片方だけ置けた回は見送りにならない(理由は記録に残る)', async () => {
    const r = await runSplitPlan(deps(A_BULL, '{"aPrice":38400,"aLcWidth":80,"iWhy":"下は遠い"}'), OPTS);
    expect(r.parsed.plan.direction).toBe('buy');
    expect(r.parsed.noneReason).toBeUndefined();
    expect(r.record.aiWhy).toBe('い) 下は遠い');
  });

  it('★スクイーズ判定が使えなかった理由は記録に残る(state=null と混ぜない)', async () => {
    const r = await runSplitPlan(deps('{"direction":"range"}', B_BOTH), {
      ...OPTS, rangeEnabled: true, squeezeState: null, squeezeUnavailable: 'closed',
    });
    expect(r.record.bVariant).toBe('range-fade');
    expect(r.record.squeezeState).toBeNull();
    expect(r.record.squeezeUnavailable).toBe('closed');
  });
});

describe('★段5: A/B それぞれのプロバイダが別々に記録へ残る', () => {
  it('A と B が別プロバイダで答えても、両方が record に残る(混ざらない)', async () => {
    const calls: Array<{ who: 'A' | 'B'; system: string; user: string }> = [];
    const d: SplitPlanDeps = {
      callTrend: async (system, user) => {
        calls.push({ who: 'A', system, user });
        return { text: A_BULL, toolCalls: 0, provider: { name: 'gemini', model: 'gemini-flash' } };
      },
      callOrder: async (system, user) => {
        calls.push({ who: 'B', system, user });
        return { text: B_BOTH, toolCalls: 3, provider: { name: 'groq', model: 'llama' } };
      },
    };
    const r = await runSplitPlan(d, OPTS);
    // ★これが設計の芯: 1つの provider に混ぜていれば「groq」しか残らず「A は gemini だった」が消える。
    expect(r.record.aProvider).toEqual({ name: 'gemini', model: 'gemini-flash' });
    expect(r.record.bProvider).toEqual({ name: 'groq', model: 'llama' });
  });

  it('B を呼ばなかった回(rangeDisabled)は bProvider が無い(aProvider だけ残る)', async () => {
    const d: SplitPlanDeps = {
      callTrend: async () => ({ text: '{"direction":"range"}', toolCalls: 0, provider: { name: 'gemini', model: 'm' } }),
      callOrder: async () => { throw new Error('B を呼んではいけない'); },
    };
    const r = await runSplitPlan(d, { ...OPTS, rangeEnabled: false });
    expect(r.record.aProvider).toEqual({ name: 'gemini', model: 'm' });
    expect(r.record.bProvider).toBeUndefined();
  });

  it('A が失敗(例外)した回は aProvider も無い(誰も答えていない)', async () => {
    const r = await runSplitPlan(deps(new Error('x')), OPTS);
    expect(r.record.aProvider).toBeUndefined();
    expect(r.record.bProvider).toBeUndefined();
  });
});

describe('⑦ ★旧経路に戻せる(スイッチ1箇所)', () => {
  it('既定は false = 旧経路(1回呼び出し)', () => {
    expect(PLAN_SPLIT_DEFAULT).toBe(false);
    expect(resolvePlanSplit(undefined)).toBe(false);
  });

  it('環境変数で切り替わる / 読めない値では黙って有効化しない', () => {
    for (const v of ['1', 'true', 'on', 'YES']) expect(resolvePlanSplit(v)).toBe(true);
    for (const v of ['0', 'false', 'off', 'no']) expect(resolvePlanSplit(v)).toBe(false);
    for (const v of ['', 'maybe', 'ON!', '2']) expect(resolvePlanSplit(v)).toBe(PLAN_SPLIT_DEFAULT);
  });
});

describe('★A の max_tokens', () => {
  it('旧経路(8000)よりずっと小さいが、JSON の骨格が入る大きさ', () => {
    expect(TREND_MAX_TOKENS).toBeLessThan(8000);
    expect(TREND_MAX_TOKENS).toBeGreaterThanOrEqual(64);   // ★16 では direction を書き終える前に切れる
  });

  it('★切り詰められた応答からでも目線だけは拾える(目線を丸ごと失わない)', () => {
    // max_tokens で why の途中が切れた形(閉じ括弧も引用符も無い)
    expect(parseTrendAnswer('{"direction":"bull","why":"高値切り上げが続いて')).toEqual({ direction: 'bull' });
    expect(parseTrendAnswer('{"direction":"range"')).toEqual({ direction: 'range' });
    // 閉じ引用符まで揃っていれば理由も採る
    expect(parseTrendAnswer('{"direction":"bear","why":"戻り売り優勢"')).toEqual({ direction: 'bear', why: '戻り売り優勢' });
  });
});
