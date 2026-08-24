import { describe, it, expect } from 'vitest';
import { runSplitPlan, type SplitCallResult, type SplitPlanDeps } from './scalpPlanSplit.js';
import { resolvePlanSplit, PLAN_SPLIT_DEFAULT } from './planSplitConfig.js';
import { TREND_MAX_TOKENS, parseTrendAnswer, rawDirectionOf } from './trendPrompt.js';

// ★段4(v0.9.99): A→B の直列呼び出し。
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

const A_BUY = '{"direction":"buy","why":"高値切り上げが3本続き、5分足がMA上"}';
// ★2026-08-25: B の応答は **自由文**(ユーザーが形式を指定)。
//   ★脚は **注文タイプの語** で決まるので、版ごとに文面が違う(上/下では決めない)。
//   ★形式に strategy の欄が無い=b_strategy は NULL になる(旧 JSON 契約との違い)。
const bFree = (upper: string, lower: string): string =>
  `${upper}38400円（LC幅80円）節目手前\n${lower}38100円（LC幅70円）押し目`;
const B_BUY = bFree('逆指値買い', '指値買い');
const B_SELL = bFree('指値売り', '逆指値売り');
const B_BRK = bFree('逆指値買い', '逆指値売り');
const B_FADE = bFree('指値売り', '指値買い');
/** 既定(A=buy(ブル) → 版 buy)。 */
const B_BOTH = B_BUY;
/** ★両脚とも「置けない」と文で言った回(位置の行に理由だけ)。 */
const B_NONE_WITH_WHY = J2('（上）上は空白', '（下）下は遠い');
function J2(...lines: string[]): string { return lines.join('\n'); }

describe('① ★A→B が直列に通る(実プロセス・LLM 無し)', () => {
  it('A で buy(ブル)→ B(buy 版)が呼ばれ、既存の AiPlan が出来る', async () => {
    const d = deps(A_BUY, B_BOTH);
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
      aDirection: 'buy', bVariant: 'buy', squeezeState: null,
    });
    // ★2026-08-25: 自由文の形式に strategy の欄が無いので b_strategy は入らない(捏造しない)。
    expect(r.record.bStrategy).toBeUndefined();
    // ★ツールは A=0 / B=2 で合計2(数えて0 と 数えていない を混ぜない)
    expect(r.record.toolCalls).toBe(2);
  });

  it('A で sell(ベア)→ B(sell 版)。あ)=指値売り / い)=逆指値売り に入れ替わる', async () => {
    const d = deps('{"direction":"sell"}', B_SELL);
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
    const brk = await runSplitPlan(deps('{"direction":"range"}', B_BRK), { ...on, squeezeState: 'squeeze' });
    expect(brk.record.bVariant).toBe('range-breakout');
    expect(brk.parsed.plan.range?.upper).toMatchObject({ side: 'buy', type: 'stop' });
    const fade = await runSplitPlan(deps('{"direction":"range"}', B_FADE), { ...on, squeezeState: 'bulge' });
    expect(fade.record.bVariant).toBe('range-fade');
    expect(fade.parsed.plan.range?.upper).toMatchObject({ side: 'sell', type: 'limit' });
  });

  it('⑤ ★文脈を取り直さない(A に渡した断面がそのまま B のプロンプトに入る)', async () => {
    const d = deps(A_BUY, B_BOTH);
    await runSplitPlan(d, OPTS);
    expect(d.calls[0]!.system).toContain(OPTS.trendContext);
    expect(d.calls[1]!.system).toContain(OPTS.orderContext);
    // ★A に節目・アラート・長期高安の文脈は渡っていない
    expect(d.calls[0]!.system).not.toContain('主要節目');
    expect(d.calls[0]!.system).not.toContain('長期高安');
  });

  it('④ ★A の自由文が B に1文字も入らない', async () => {
    const d = deps(A_BUY, B_BOTH);
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
    // ★2026-08-25: A の語彙が buy/sell/range になったので 'buy' は正解。
    //   ★代わりに **旧の語 'bull'**(v0.9.98 まで)を入れる=先祖返りが aFailed で捕まることの固定。
    for (const bad of ['{"direction":"bull"}', '{"direction":"none"}', 'すみません分かりません', '']) {
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
      deps(A_BUY, B_NONE_WITH_WHY), OPTS,
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
    const withWhy = await runSplitPlan(deps(A_BUY, B_NONE_WITH_WHY), OPTS);
    expect(withWhy.parsed.noneReason).toBe('ai');
    expect(withWhy.record.aiWhy).toBeDefined();

    const silent = await runSplitPlan(deps(A_BUY, '{}'), OPTS);
    expect(silent.parsed.noneReason).toBe('aiSilent');
    expect(silent.record.aiWhy).toBeUndefined();

    const junk = await runSplitPlan(deps(A_BUY, 'すみません'), OPTS);
    expect(junk.parsed.noneReason).toBe('aiSilent');
    expect(junk.record.bVariant).toBe('buy');   // ★B は呼んだ(呼ばなかった 'none' と区別できる)
  });

  it('★片方だけ置けた回は見送りにならない(理由は記録に残る)', async () => {
    const r = await runSplitPlan(deps(A_BUY, J2('逆指値買い38400円（LC幅80円）', '（下）下は遠い')), OPTS);
    expect(r.parsed.plan.direction).toBe('buy');
    expect(r.parsed.noneReason).toBeUndefined();
    expect(r.record.aiWhy).toBe('い) 下は遠い');
  });

  it('★スクイーズ判定が使えなかった理由は記録に残る(state=null と混ぜない)', async () => {
    const r = await runSplitPlan(deps('{"direction":"range"}', B_FADE), {
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
        return { text: A_BUY, toolCalls: 0, provider: { name: 'gemini', model: 'gemini-flash' } };
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
  // ★v0.9.96 で既定を false → true に反転した(ユーザーの判断)。
  //   このテストは「通すため」に書き換えたのではなく、**既定が変わったことの表明**である。
  //   ★反転で失われる安全は1つだけ: 「出荷しても既定の挙動は変わらない」が使えなくなった。
  //   代わりに守っているのは **戻し口が1箇所であること**(下の it)。ここが壊れたら反転は成立しない。
  it('★既定は true = A/B 分割(2回呼び出し)。v0.9.96 で反転', () => {
    expect(PLAN_SPLIT_DEFAULT).toBe(true);
    expect(resolvePlanSplit(undefined)).toBe(true);
  });

  // ★戻し口の実証。既定が true になった今、**これが唯一の退避路**なので、
  //   綴りの揺れ('0'/'false'/'off'/'no')を全部通ることまで固定する。
  it('★env=0 で旧経路に戻る / 読めない値は既定に落ちる(=黙って無効化もしない)', () => {
    for (const v of ['0', 'false', 'off', 'no']) expect(resolvePlanSplit(v)).toBe(false);
    for (const v of ['1', 'true', 'on', 'YES']) expect(resolvePlanSplit(v)).toBe(true);
    // ★読めない値は既定(true)。★戻したいときは必ず 0/false/off/no を書くこと(綴り違いは戻らない)。
    for (const v of ['', 'maybe', 'ON!', '2']) expect(resolvePlanSplit(v)).toBe(true);
  });
});

describe('★A の max_tokens', () => {
  it('旧経路(8000)よりずっと小さいが、JSON の骨格が入る大きさ', () => {
    expect(TREND_MAX_TOKENS).toBeLessThan(8000);
    expect(TREND_MAX_TOKENS).toBeGreaterThanOrEqual(64);   // ★16 では direction を書き終える前に切れる
  });

  it('★切り詰められた応答からでも目線だけは拾える(目線を丸ごと失わない)', () => {
    // max_tokens で why の途中が切れた形(閉じ括弧も引用符も無い)
    expect(parseTrendAnswer('{"direction":"buy","why":"高値切り上げが続いて')).toEqual({ direction: 'buy' });
    expect(parseTrendAnswer('{"direction":"range"')).toEqual({ direction: 'range' });
    // 閉じ引用符まで揃っていれば理由も採る
    expect(parseTrendAnswer('{"direction":"sell","why":"戻り売り優勢"')).toEqual({ direction: 'sell', why: '戻り売り優勢' });
  });
});

// ─── ★v0.9.96(リーダー裁定): A と B の理由を **画面の5つの箱** へ繋ぐ ────────────
// 依頼(逐語)「分割ONのとき、A と B の理由を画面の箱へ繋ぐ」。
//   ★繋ぐ前は 6つの箱(directionWhy / strategyWhy / entryWhyFor* / lcWhyFor*)が **全部空** で、
//     画面は rationale(連結文字列)を目線の欄に出していた=「なぜこの目線か」が読めなかった。
//     ★実際に HEAD の実装を取り出して走らせ、6箱すべてが undefined であることを確認した
//       (scratchpad の否定対照。ここでは新しい契約だけを固定する)。
describe('★v0.9.96: 分割ON で A/B の理由が箱に入る', () => {
  it('★A の理由が directionWhy へ / B の脚の理由が entryWhyFor* へ(表が決めた脚に対応)', async () => {
    const r = await runSplitPlan(deps(A_BUY, B_BOTH), OPTS);
    const plan = r.parsed.plan;
    // A(目線)の理由 = 「なぜこの目線か」
    expect(plan.directionWhy).toBe('高値切り上げが3本続き、5分足がMA上');
    // ★buy 版は あ)=上=逆指値 / い)=下=指値。理由も **価格と同じ脚** に入る。
    expect(plan.stopEntry).toBe(38400);
    expect(plan.entryWhyForStop).toBe('節目手前');
    expect(plan.limitEntry).toBe(38100);
    expect(plan.entryWhyForLimit).toBe('押し目');
    // ★A の理由は台帳の a_why にも従来どおり残る(二重に持つ=生値と配った先の両方が要る)。
    expect(r.record.aWhy).toBe('高値切り上げが3本続き、5分足がMA上');
  });

  it('★sell 版は あ)=指値 / い)=逆指値 に入れ替わる(理由も一緒に入れ替わる)', async () => {
    const A_SELL = '{"direction":"sell","why":"戻り売りが続き高値を切り下げ"}';
    const r = await runSplitPlan(deps(A_SELL, B_SELL), OPTS);
    const plan = r.parsed.plan;
    expect(plan.direction).toBe('sell');
    expect(plan.limitEntry).toBe(38400);            // あ)=上=売りの指値
    expect(plan.entryWhyForLimit).toBe('節目手前');
    expect(plan.stopEntry).toBe(38100);             // い)=下=売りの逆指値
    expect(plan.entryWhyForStop).toBe('押し目');
  });

  it('★B が返していない箱は埋めない(lcWhyFor* / strategyWhy は空のまま)', async () => {
    const r = await runSplitPlan(deps(A_BUY, B_BOTH), OPTS);
    const plan = r.parsed.plan as unknown as Record<string, unknown>;
    // ★B の契約(BAnswer)に「損切り幅だけの理由」の欄が無い(aWhy/iWhy は脚1本ぶんの提案理由)。
    //   AI が書いていない理由を画面が名乗らないよう、複写しない。
    expect(plan.lcWhyForLimit).toBeUndefined();
    expect(plan.lcWhyForStop).toBeUndefined();
    // ★strategyWhy も B に対応する欄が無い(strategy 1本に寄せた既存の決定)=**意図して空**。
    expect(plan.strategyWhy).toBeUndefined();
  });

  it('★立たなかった脚には理由を入れない(価格の無い箱に理由だけ在る形を作らない)', async () => {
    const B_ONLY_A = J2('逆指値買い38400円（LC幅80円）節目手前', '（下）下は節目が遠い');
    const r = await runSplitPlan(deps(A_BUY, B_ONLY_A), OPTS);
    const plan = r.parsed.plan as unknown as Record<string, unknown>;
    expect(plan.stopEntry).toBe(38400);
    expect(plan.entryWhyForStop).toBe('節目手前');
    expect(plan.limitEntry).toBeUndefined();
    expect(plan.entryWhyForLimit).toBeUndefined();   // ★理由だけ残さない
    // 落ちた脚の理由は従来どおり ai_why 側に残る(消えていない)。
    expect(r.record.aiWhy).toContain('下は節目が遠い');
  });

  it('★A の理由が無い回は directionWhy を作らない(空文字を入れない)', async () => {
    const r = await runSplitPlan(deps('{"direction":"buy"}', B_BOTH), OPTS);
    expect(Object.prototype.hasOwnProperty.call(r.parsed.plan, 'directionWhy')).toBe(false);
  });

  it('★rationale は1バイトも変えない(旧経路との互換・監査が生文字列を読む)', async () => {
    const r = await runSplitPlan(deps(A_BUY, B_BOTH), OPTS);
    expect(r.parsed.plan.rationale)
      .toBe('逆指値買い注文: 節目手前 / 指値買い注文: 押し目');
  });

  it('★A の理由を B へ渡す経路は増えていない(分割の芯を壊さない)', async () => {
    const d = deps(A_BUY, B_BOTH);
    await runSplitPlan(d, OPTS);
    const b = d.calls.find(c => c.who === 'B')!;
    expect(b.system + b.user).not.toContain('高値切り上げ');
  });
});

// ═══ ★(h) A が契約に無い語を返したとき、**何と答えたか** を残す(2026-08-25) ═══════
//
// ■ 何が問題だったか(エバリュエーター指摘(h))
//   parseTrendAnswer が null を返す経路は aFailed の早期 return で、そこは aRecord を作る前。
//   ★a_direction も a_why も NULL になり、「A が何と答えたのか」がどこにも残らない
//   = **aFailed の件数が増えることでしか気づけない**。
//   ★語彙を bull/bear → buy/sell に切り替えた直後は、「旧語への先祖返り」と「別の壊れ方」を
//     区別できる必要がある。
// ■ ★列は増やさない: 既に台帳へ落ちている rationale に **direction の値だけ** を足す
//   (自由文は持ち出さない=モデルの生出力を台帳へ運ばない既存の方針)。
describe('★(h) 契約に無い語で落ちた回でも「何と答えたか」が残る', () => {
  it('★rawDirectionOf は direction の値だけを取り出す(自由文は持ち出さない)', () => {
    expect(rawDirectionOf('{"direction":"bull","why":"高値切り上げが続き…"}')).toBe('bull');
    expect(rawDirectionOf('{"direction": "BEARISH"}')).toBe('BEARISH');
    expect(rawDirectionOf('direction："up_trend"')).toBe('up_trend');
    expect(rawDirectionOf('{"why":"理由だけ"}')).toBeUndefined();
    expect(rawDirectionOf('こんにちは')).toBeUndefined();
  });

  it('★24字で切る/英数と記号だけ(長い自由文が台帳へ流れ込まない)', () => {
    const long = `{"direction":"${'x'.repeat(80)}"}`;
    expect(rawDirectionOf(long)!.length).toBe(24);
    // ★日本語は拾わない(値が日本語なら「何も残らない」ほうを選ぶ=生出力を運ばない)
    expect(rawDirectionOf('{"direction":"上昇トレンドです"}')).toBeUndefined();
  });

  it('★★旧語 bull が返った回: aFailed のまま、rationale に "bull" が残る', async () => {
    const r = await runSplitPlan(deps('{"direction":"bull","why":"高値切り上げ"}', B_BOTH), OPTS);
    expect(r.parsed.noneReason).toBe('aFailed');
    expect(r.record.aDirection).toBeUndefined();          // ★救済しない(契約の語ではない)
    expect(r.parsed.plan.rationale).toContain('"bull"');  // ★でも何と答えたかは残る
    expect(r.parsed.plan.rationale).not.toContain('高値切り上げ');   // ★自由文は運ばない
  });

  it('★読み取れない形(direction が無い)では嘘を書かない', async () => {
    const r = await runSplitPlan(deps('すみません分かりません', B_BOTH), OPTS);
    expect(r.parsed.noneReason).toBe('aFailed');
    expect(r.parsed.plan.rationale).toBe('目線の判断が得られませんでした(答えが規定の3語でない)。');
  });
});
