import { describe, it, expect, vi } from 'vitest';
import {
  parseScalpPlan, parseRangeLeg, runScalpPlan, buildScalpPlan, isLLMEnabled,
  SCALP_QUESTION, SCALP_SYSTEM_PROMPT,
  buildScalpQuestion, buildScalpSystemPrompt, resolveLcRange, clampRequestedLcFloor, scalpJsonInstruction,
  enforcePlanConstraints, enforcePlanConstraintsReport,
  parseAiRegime, parseAiConfidence, stopSideOk, entrySideOk,
  parseAiStrategy, parseAiStrategyWhy, isKnownScalpStrategy, scalpStrategyContract, parseAiLevelPrice,
  SCALP_STRATEGY_LABELS, SCALP_STRATEGY_OTHER,
  lcLegExceeds, lcLegBelowFloor, lcEffectiveCeiling, buildDelegationNote, buildStrategySpec, buildLegNote,
  pickNoneReason, enforceRangeEnabled,
  buildBiasNote, buildHeldNote, buildArmedNote, buildVisionNote, buildBandwalkNote,
  DEFAULT_LC_FLOOR_YEN, DEFAULT_LC_CEILING_YEN, LC_YEN_MAX,
  resolveLcPresentation, LC_CEIL_MANUAL, LC_BUFFER_NOTE, LC_DERIVATION_ORDER, PLAN_BAD_EXAMPLES,
  type ToolHandlers, type AiPlan, type KnobModes, type LcCeilingPresentation,
} from './openai.js';
import { describeRangeAnomaly } from '../signalTrade/rangeShape.js';
import { formatMomentumLine, type Regime } from '../signalTrade/regime.js';
import type { Bandwalk } from '../bandwalk.js';

// LLM 応答テキスト→AiPlan の検証(refPrice は必ず monitor 側の値で上書きされる)。
const REF = 38250;

/** 部分文字列の出現回数。★機械生成の注記は toContain(部分一致)だと二重に付いていても通ってしまうため、
 *  注記の検証は必ず「出現回数=1」で固定する(v0.9.46 の注記二重付与を見逃した反省)。 */
function countOf(s: string, sub: string): number {
  return s.split(sub).length - 1;
}
/** rationale から ※で始まる注記行だけを取り出す(レンジ脚の脱落理由)。 */
function noteLines(s: string): string[] {
  return s.split('\n').filter(l => l.startsWith('※'));
}

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

// ─── 表示整合: buildLegNote(片レッグが無い理由の注記・純関数) ───
// ★v0.9.59(ユーザー指示で文面刷新): 旧実装は「（実際の注文: 指値+逆指値）」のように **プランを言い直す**
//   だけで、画面のシグナル表示を見れば分かる情報しか無かった(しかも落ちた理由は「条件を満たさず不採用」= 無内容)。
//   新仕様: ①両レッグ揃っているときは何も書かない ②片方が無いときだけ **具体的な理由** を書く
//   ③「AI が提案しなかった(missing)」と「出したが検証で落とした(stopSide/lcFloor/lc/geometry…)」を書き分ける。
//   ★非公開の決済数値(下限/上限の実数)は絶対に書かない=「設定の下限/上限」と呼ぶだけ。
describe('buildLegNote(片レッグ欠落の理由注記・純関数)', () => {
  it('★両レッグ揃い→空文字(シグナル表示を見れば分かるので注記しない)', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: true })).toBe('');
    // 落ちた記録があっても、両レッグ残っているなら書かない。
    expect(buildLegNote({
      hasLimit: true, hasStop: true, drops: [{ name: 'stop', reason: 'lcFloor' }],
    })).toBe('');
  });

  it('★逆指値なし(AI が提案せず=missing)→「AIが提案せず」', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason: 'missing' }] }))
      .toBe('（逆指値なし: AIが提案せず）');
  });

  it('★逆指値なし(損切りが逆側=stopSide)→「不採用」と書き分ける', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason: 'stopSide' }] }))
      .toBe('（逆指値は不採用: 損切りがエントリーの逆側）');
  });

  it('★逆指値なし(LC 下限未満=lcFloor)→「損切り幅が設定の下限より狭い」', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason: 'lcFloor' }] }))
      .toBe('（逆指値は不採用: 損切り幅が設定の下限より狭い）');
  });

  it('★逆指値なし(LC 上限超=lc)→「損切り幅が設定の上限より広い」', () => {
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason: 'lc' }] }))
      .toBe('（逆指値は不採用: 損切り幅が設定の上限より広い）');
  });

  it('指値なし(現在値の逆側=geometry)も同じ形で書ける', () => {
    expect(buildLegNote({ hasLimit: false, hasStop: true, drops: [{ name: 'limit', reason: 'geometry' }] }))
      .toBe('（指値は不採用: エントリーが現在値の逆側、または損切り幅の値が不正）');
  });

  it('レッグ皆無/理由不明→空文字(追記しない)', () => {
    expect(buildLegNote({ hasLimit: false, hasStop: false })).toBe('');
    expect(buildLegNote({ hasLimit: true, hasStop: false })).toBe('');          // 理由が無ければ黙る
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [] })).toBe('');
  });

  it('落ちたレッグの記録は名前で引く(別レッグの理由を流用しない)', () => {
    // 指値の理由しか無い状態で逆指値が欠けていても、指値の理由を逆指値に書かない。
    expect(buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'limit', reason: 'lcFloor' }] })).toBe('');
  });

  it('★非公開の決済数値は文面に出ない(数字を一切含まない)', () => {
    const all = (['missing', 'stopSide', 'geometry', 'lcFloor', 'lc', 'trend', 'bias', 'stale'] as const)
      .map(reason => buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason }] }));
    for (const s of all) {
      expect(s).not.toMatch(/[0-9０-９]/);
      expect(s).not.toContain('条件を満たさず');   // 無内容な旧文言は使わない
    }
  });
});

// ─── 表示整合: parseScalpPlan が rationale 末尾にレッグ注記を追記する ───
describe('parseScalpPlan レッグ注記(表示整合)', () => {
  it('指値のみプラン(AI が逆指値を出さない)→ rationale 末尾が「逆指値なし: AIが提案せず」・元テキストは前置で保持', () => {
    const { stopEntry, stopLossForStop, ...limitOnly } = goodPlan;
    void stopEntry; void stopLossForStop;
    const r = parseScalpPlan(JSON.stringify(limitOnly), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.rationale.startsWith('押し目買い。直近安値38200が支持。')).toBe(true);
      expect(r.plan.rationale.endsWith('（逆指値なし: AIが提案せず）')).toBe(true);
      // ★endsWith だけでは「…A A」の二重でも通ってしまうので出現回数で固定する。
      expect(countOf(r.plan.rationale, '（逆指値なし: AIが提案せず）')).toBe(1);
      // AI は逆指値を出していないので「不採用」ではない(書き分け)。
      expect(r.plan.rationale).not.toContain('不採用');
    }
  });

  it('AI が逆指値レッグを出したが entrySideOk 違反で落ちた→指値レッグ維持+「逆指値は不採用: …」注記', () => {
    // buy: 指値は正。逆指値 entry 38200(現在値38250より下=buy には不正)→ 逆指値レッグを落とす。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目・逆指値も置いたつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38150,   // 正
      stopEntry: 38200, stopLossForStop: 38150,     // entry が現在値より下=buy の逆指値として不正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBeUndefined();
      // ★注記は「1回だけ」(部分一致では二重を捕まえられない)。理由は幾何ではなく損切りの向き(stopSide)。
      //   entry 38200 は現在値より下だが、先に stopSideOk(38150<38200 は buy として正)を通るので geometry。
      expect(countOf(r.plan.rationale, '（逆指値は不採用: エントリーが現在値の逆側、または損切り幅の値が不正）')).toBe(1);
      expect(r.plan.rationale).not.toContain('実際の注文');
    }
  });

  it('★正しい両レッグ→注記なし(rationale は AI の原文のまま=シグナル表示を見れば分かる)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.rationale).toBe(goodPlan.rationale);
      expect(r.plan.rationale).not.toContain('実際の注文');
      expect(r.plan.rationale).not.toContain('不採用');
    }
  });

  it('none の rationale は注記を付けない(不変)', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '様子見。' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.rationale).toBe('様子見。');
  });

  it('range の rationale は注記を付けない(不変)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ・両面。', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.rationale).toBe('レンジ・両面。');
    }
  });
});

// ─── 損切りの向き検証(orientation): 不正プラン発生源を断つ ───
describe('stopSideOk(損切りの向き・純関数)', () => {
  it('買い(long)は損切りが entry の下だけ true(上/等値は false)', () => {
    expect(stopSideOk('buy', 100, 90)).toBe(true);
    expect(stopSideOk('buy', 100, 110)).toBe(false);   // 上=逆側
    expect(stopSideOk('buy', 100, 100)).toBe(false);   // 境界(幅0)=不正
  });
  it('売り(short)は損切りが entry の上だけ true(下/等値は false)', () => {
    expect(stopSideOk('sell', 100, 110)).toBe(true);
    expect(stopSideOk('sell', 100, 90)).toBe(false);   // 下=逆側
    expect(stopSideOk('sell', 100, 100)).toBe(false);  // 境界(幅0)=不正
  });
});

// エントリー位置の向き検証(refPrice=現在値 に対する 指値/逆指値 の幾何)。
describe('entrySideOk(エントリー位置の向き・純関数)', () => {
  const REF_P = 100;
  it('買い: 指値=現在値より下だけ true / 上は false', () => {
    expect(entrySideOk('buy', 'limit', 90, REF_P)).toBe(true);
    expect(entrySideOk('buy', 'limit', 110, REF_P)).toBe(false);
  });
  it('買い: 逆指値=現在値より上だけ true / 下は false', () => {
    expect(entrySideOk('buy', 'stop', 110, REF_P)).toBe(true);
    expect(entrySideOk('buy', 'stop', 90, REF_P)).toBe(false);
  });
  it('売り: 指値=現在値より上だけ true / 下は false', () => {
    expect(entrySideOk('sell', 'limit', 110, REF_P)).toBe(true);
    expect(entrySideOk('sell', 'limit', 90, REF_P)).toBe(false);
  });
  it('売り: 逆指値=現在値より下だけ true / 上は false', () => {
    expect(entrySideOk('sell', 'stop', 90, REF_P)).toBe(true);
    expect(entrySideOk('sell', 'stop', 110, REF_P)).toBe(false);
  });
  it('境界(entry===refPrice=距離0)は不正(false)', () => {
    expect(entrySideOk('buy', 'limit', 100, REF_P)).toBe(false);
    expect(entrySideOk('sell', 'stop', 100, REF_P)).toBe(false);
  });
  it('refPrice 非有限は検証しない(true=従来通り通す)', () => {
    expect(entrySideOk('buy', 'limit', 110, NaN)).toBe(true);
    expect(entrySideOk('sell', 'stop', 110, Infinity)).toBe(true);
  });
});

// エントリー位置の向き検証(parse・directional): 反転プランを見送り化/レッグ落とし。
describe('parseScalpPlan エントリー位置の向き検証(directional)', () => {
  // REF=38250。
  it('反転 SELL(指値=現在値より下・逆指値=現在値より上)→ 両レッグ不正で見送り(none)', () => {
    // sell なのに 指値38200<REF(下=不正)・逆指値38300>REF(上=不正)。SL 向きは各レッグ正しくしておく。
    const raw = JSON.stringify({
      direction: 'sell', rationale: '反転プラン', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,   // SL は entry の上=sell として正
      stopEntry: 38300, stopLossForStop: 38360,     // SL は entry の上=sell として正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBeUndefined();
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('正しい SELL(指値=現在値より上・逆指値=現在値より下)→ 両レッグ維持', () => {
    // sell: 指値38300>REF(戻り売り)・逆指値38200<REF(下抜け追随)。SL 向きも各レッグ正。
    const raw = JSON.stringify({
      direction: 'sell', rationale: '戻り売り+下抜け', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38360,   // 上=正
      stopEntry: 38200, stopLossForStop: 38260,     // 上=正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('sell');
      expect(r.plan.limitEntry).toBe(38300);
      expect(r.plan.stopLossForLimit).toBe(38360);
      expect(r.plan.stopEntry).toBe(38200);
      expect(r.plan.stopLossForStop).toBe(38260);
    }
  });

  it('正しい BUY(指値=現在値より下・逆指値=現在値より上)→ 両レッグ維持(goodPlan)', () => {
    // goodPlan: buy・指値38200<REF・逆指値38350>REF・SL 向きも正。
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
    }
  });

  it('反転 BUY レッグ(指値=現在値より上)→ その指値レッグを落とす(正しい逆指値は残す)', () => {
    // buy なのに 指値38300>REF(上=不正)→落とす。逆指値38350>REF(上=正)・SL 向きも正→残す。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '指値だけ反転', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38250,   // SL は entry の下=buy として正(entry 位置だけ不正)
      stopEntry: 38350, stopLossForStop: 38300,     // 逆指値は完全に正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBeUndefined();     // entry 位置が現在値の上=落とす
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });
});

// ★v0.9.70: LLM から受け取るのは損切りの **幅(正の数)** だけになり、符号はコードが direction から決める。
//   よって「損切りがエントリーの逆側」は **表現できない**。旧形式(価格)で逆側が来た回は、
//   大きさだけを使って正しい向きに置き直す(=落とさない)。旧テスト(逆側→レッグを落とす)はここで置き換えた。
describe('parseScalpPlan 損切りの向き(★v0.9.70: 逆位置は表現不能・旧形式は符号を訂正して採用)', () => {
  it('buy で旧形式の SL がエントリーより上(逆側)→ 幅だけを使い、正しい向き(下)に置き直して採用する', () => {
    // 指値: entry 38200 / 旧 SL 38260(上=逆側)→ 幅60 を採り 38200−60=38140 に置き直す。
    // 逆指値: entry 38350 / 旧 SL 38300(下=正)→ 幅50 → 38300(従来と同じ値=正常系は不変)。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopLossForLimit).toBe(38140);     // 逆側 38260 ではなく、幅60 を下へ
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38300);      // 正しい向きの旧形式は byte 一致
      expect(r.legDrops ?? []).toEqual([]);            // 1本も落ちない
      // ★黙って直さない: フォールバックと符号訂正は台帳(lc_audit_json)に残る。
      const limitRow = r.lcAudit?.find(x => x.leg === 'limit');
      expect(limitRow?.widthSource).toBe('legacy-price');
      expect(limitRow?.signCorrected).toBe(true);
      expect(r.lcAudit?.find(x => x.leg === 'stop')?.signCorrected).toBeUndefined();
    }
  });

  it('sell で旧形式の SL がエントリーより下(逆側)→ 正しい向き(上)に置き直して採用する', () => {
    const raw = JSON.stringify({
      direction: 'sell', rationale: '戻り', refPrice: 1,
      limitEntry: 38300, stopLossForLimit: 38250,   // 下=逆側 → 幅50 → 38350
      stopEntry: 38150, stopLossForStop: 38200,     // 上=正 → 38200(不変)
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('sell');
      expect(r.plan.limitEntry).toBe(38300);
      expect(r.plan.stopLossForLimit).toBe(38350);
      expect(r.plan.stopEntry).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38200);
    }
  });

  it('両レッグとも逆側でも none にならない(2本とも符号を訂正して採用)', () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目のつもり', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38260,   // 上=逆側 → 38140
      stopEntry: 38350, stopLossForStop: 38400,     // 上=逆側 → 38300
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopLossForLimit).toBe(38140);
      expect(r.plan.stopLossForStop).toBe(38300);
      expect(r.plan.rationale).toContain('押し目');
      expect(r.plan.refPrice).toBe(REF);
    }
  });

  it('★新契約: lcWidth が 0以下/非有限 のレッグは落とす(符号付きの値を幅として受け取らない)', () => {
    const raw = JSON.stringify({
      direction: 'buy', rationale: '負の幅', refPrice: 1,
      limitEntry: 38200, lcWidthForLimit: -55,    // 負=無効
      stopEntry: 38350, lcWidthForStop: 55,       // 正常
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForStop).toBe(38295);   // 38350 − 55(コードが下へ置く)
      // ★落ちた理由は 'geometry'(値が不正)。**'missing' にはしない**: AI は提案しているので
      //   「AIが提案せず」と記録するのは虚偽になる。生の値(書いた幅)も残す=後から数えられる。
      expect(r.legDrops).toEqual([{ name: 'limit', reason: 'geometry', entry: 38200, lcWidth: -55 }]);
    }
  });

  it('★新契約: lcWidth が在るときは旧フィールドの価格へ黙って逃げない(両方在れば lcWidth が勝つ)', () => {
    const raw = JSON.stringify({
      direction: 'sell', rationale: '両方在る', refPrice: 1,
      limitEntry: 38300, lcWidthForLimit: 55, stopLossForLimit: 38250,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.stopLossForLimit).toBe(38355);   // 38300 + 55(旧価格 38250 は見ない)
      expect(r.lcAudit?.find(x => x.leg === 'limit')?.widthSource).toBe('lcWidth');
    }
  });

  it('境界(旧形式の SL==entry=幅0)は使える損切りが無い=そのレッグを落とす', () => {
    // 指値: entry 38200 / SL 38200(幅0=不正)→ 落とす。逆指値は正しい→残る。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '押し目', refPrice: 1,
      limitEntry: 38200, stopLossForLimit: 38200,
      stopEntry: 38350, stopLossForStop: 38300,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBeUndefined();
      expect(r.plan.stopEntry).toBe(38350);
    }
  });

  it('正しい向きのプランは不変(向き検証で壊れない)', () => {
    // goodPlan: buy・指値SL38150<38200・逆指値SL38300<38350(いずれも下=正)。
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38150);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('★スモーキングガン: {buy, limitEntry:64565, stopLossForLimit:64610, stopEntry:64665, stopLossForStop:64610} → 逆指値のみ buy(価格は従来と同一)', () => {
    // 実データ由来。指値 64565 は現在値(REF=38250)より上=買いの指値としてありえない位置なので geometry で落ちる
    // (旧実装では先に stopSide が当たっていたが、落ちるという結果と最終価格は同じ)。
    // 逆指値レッグは 64665 − 55 = 64610 で従来と byte 一致。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '実データ再現', refPrice: 1,
      limitEntry: 64565, stopLossForLimit: 64610,
      stopEntry: 64665, stopLossForStop: 64610,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBeUndefined();        // エントリーが現在値の逆側=geometry
      expect(r.plan.stopLossForLimit).toBeUndefined();
      expect(r.plan.stopEntry).toBe(64665);
      expect(r.plan.stopLossForStop).toBe(64610);
      expect(r.legDrops?.map(d => d.reason)).toEqual(['geometry']);
    }
  });

  it('★スモーキングガン変種: 逆指値の損切りも逆側 → none にはならず、幅だけを使って採用される', () => {
    // 旧実装では stopLossForStop 64700 > stopEntry 64665(逆側)で逆指値も落ち、両レッグ落ちて none だった。
    // 新実装では幅35 を採り 64665 − 35 = 64630 に置き直す=取引機会を落とさない。
    const raw = JSON.stringify({
      direction: 'buy', rationale: '実データ再現・両逆側', refPrice: 1,
      limitEntry: 64565, stopLossForLimit: 64610,
      stopEntry: 64665, stopLossForStop: 64700,
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.stopEntry).toBe(64665);
      expect(r.plan.stopLossForStop).toBe(64630);
    }
  });
});

describe('parseScalpPlan 損切りの向き(range・★v0.9.70: 脚の side から符号を導く)', () => {
  it('range buy 脚の旧形式 SL が entry より上 → 幅だけを使い side どおり(下)に置き直す', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },   // sell 上=正 → 不変
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38150 },     // buy だが上=逆側 → 38050 へ
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('range');
      expect(r.plan.range?.lower?.stopLoss).toBe(38050);
      expect(r.plan.range?.upper?.stopLoss).toBe(38450);
      expect(r.legDrops ?? []).toEqual([]);
    }
  });

  it('range sell 脚の旧形式 SL が entry より下 → side どおり(上)に置き直す', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // sell だが下=逆側 → 38450 へ
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // buy 下=正 → 不変
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper?.stopLoss).toBe(38450);
      expect(r.plan.range?.lower?.stopLoss).toBe(38050);
    }
  });

  it('range は新契約 lcWidth を受ける(正の幅・向きは side から)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, lcWidth: 55 },
        lower: { side: 'buy', type: 'limit', entry: 38100, lcWidth: 0 },   // 0 は無効=脚ごと落ちる
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper?.stopLoss).toBe(38455);
      expect(r.plan.range?.lower).toBeUndefined();
      expect(r.legDrops).toEqual([{ name: 'lower', reason: 'geometry', entry: 38100, lcWidth: 0 }]);
    }
  });

  it('正しい向きの range は不変', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.range?.upper).toEqual({ side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 });
      expect(r.plan.range?.lower).toEqual({ side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 });
    }
  });
});

describe('enforcePlanConstraints 向きの二重防御(冪等・正常プラン不変)', () => {
  it('directional: 向き違反レッグを enforce でも落とす(万一 parse をすり抜けても)', () => {
    // 手組みで向き違反を作る(buy・指値SL上=逆側)。enforce が指値レッグを落とし逆指値のみ残す。
    const p: AiPlan = {
      direction: 'buy', rationale: '押し目', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38260,   // 上=逆側
      stopEntry: 38350, stopLossForStop: 38300,     // 下=正
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopEntry).toBe(38350);
  });

  it('directional: 両レッグ向き違反 → none', () => {
    const p: AiPlan = {
      direction: 'buy', rationale: '押し目', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38260,
      stopEntry: 38350, stopLossForStop: 38400,
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('none');
  });

  it('range: 向き違反レッグを enforce でも落とす', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 下=逆側
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // 正
      },
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower?.side).toBe('buy');
  });

  it('向き違反由来の drop は vetoFired を立てない(veto の効き目だけ計測)', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 向き違反で落ちる
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const r = enforcePlanConstraintsReport(p, { ceilingYen: 65, bias: 'none' });
    expect(r.vetoFired).toBe(false);
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
    // ★新既定: 上限65・下限55(旧75/95 は撤去)。
    expect(SCALP_QUESTION).toContain('65');
    expect(SCALP_QUESTION).toContain('55');
    expect(SCALP_QUESTION).not.toContain('95');
    expect(SCALP_QUESTION).not.toContain('75');
  });
  it('SCALP_SYSTEM_PROMPT(既定)にレッグ独立の LC 上限とレッグ省略の指針が含まれる', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('それぞれ独立');
    expect(SCALP_SYSTEM_PROMPT).toContain('指値のみ');
    expect(SCALP_SYSTEM_PROMPT).toContain('ブレイク新規のみ');   // ★v0.9.44: 語彙統一(逆指値のみ→ブレイク新規のみ)
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

  it('既定(引数なし)は floor=55/ceiling=65 を使う', () => {
    expect(DEFAULT_LC_FLOOR_YEN).toBe(55);
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

  it('3つの常時注入ビルダーに現在値ベースの位置ルール(買い=指値下/逆指値上・売り=指値上/逆指値下)が入る', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('指値=現在値より上');   // 売りの指値=現在値より上
      expect(t).toContain('指値=現在値より下');   // 買いの指値=現在値より下
    }
  });

  it('3つの常時注入ビルダーに指値/逆指値の距離ルール(両方=間・片方だけ=200円以内)が入る', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('200円以内');           // 片レッグの距離上限
      expect(t).toContain('片方だけ');            // 片レッグの条件文
      expect(t).toContain('間');                  // 両方=現在値が2価格の間
      expect(t).toContain('400円以内');           // 両レッグの指値↔逆指値の幅上限
    }
  });

  it('3つの常時注入ビルダーのレンジ記述に距離ルール(上下2本=幅400円以内・片面=200円以内)が入る', () => {
    // レンジ(両面ストラドル)にも directional と同じ思想の距離ルールを伝える。
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: true },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    // range を有効にした3ビルダー(question/system は rangeEnabled 既定 true)。
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('レンジの距離');
      expect(t).toContain('400円以内');   // 上下2本の幅上限
      expect(t).toContain('200円以内');   // 片面レンジの距離上限
    }
  });

  it('3つの常時注入ビルダーに「実際に出力したレッグだけ説明」の指示が入る(表示整合・v0.7.41)', () => {
    const spec = buildStrategySpec({
      floor: { mode: 'manual', value: 45 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 150 },
      exitDesc: '【決済ロジック】…',
    });
    for (const t of [buildScalpQuestion(), buildScalpSystemPrompt(), spec]) {
      expect(t).toContain('実際に出力したレッグだけ説明');
    }
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
    expect(s).toContain('ブレイク新規のみ');   // ★v0.9.44: 語彙統一
    // v0.7.38 のギャップ知見も保持。
    expect(s).toContain('ギャップ');
    expect(s).toContain('検証済みの知見');
  });
});

describe('resolveLcRange(サニタイズ/クランプ)', () => {
  it('未指定は既定 55/65', () => {
    expect(resolveLcRange()).toEqual({ floorYen: 55, ceilingYen: 65 });
    expect(resolveLcRange(undefined, undefined)).toEqual({ floorYen: 55, ceilingYen: 65 });
  });
  it('正常値はそのまま', () => {
    expect(resolveLcRange(50, 120)).toEqual({ floorYen: 50, ceilingYen: 120 });
  });
  it('非有限/非数値は既定へフォールバック', () => {
    expect(resolveLcRange(NaN, 80)).toEqual({ floorYen: 55, ceilingYen: 80 });
    expect(resolveLcRange(Infinity, 80)).toEqual({ floorYen: 55, ceilingYen: 80 });
    // @ts-expect-error 実行時の不正入力を想定
    expect(resolveLcRange('x', 'y')).toEqual({ floorYen: 55, ceilingYen: 65 });
  });
  it('範囲外(<20 / >300)は該当側を既定へ', () => {
    expect(resolveLcRange(10, 80)).toEqual({ floorYen: 55, ceilingYen: 80 });
    expect(resolveLcRange(50, 999)).toEqual({ floorYen: 50, ceilingYen: 65 });
  });
  it('floor>ceiling は floor を ceiling まで下げる(締めた上限を尊重・既定へ戻さない)', () => {
    expect(resolveLcRange(120, 50)).toEqual({ floorYen: 50, ceilingYen: 50 });
    // ★フットガン: 呼び出し側 floor 未指定(=既定55)で ceiling をそれより小さく締めても、上限が黙って緩まない。
    expect(resolveLcRange(undefined, 30)).toEqual({ floorYen: 30, ceilingYen: 30 });
  });
});

describe('clampRequestedLcFloor(外部要求の LC 下限は設定値を下回れない)', () => {
  // ★プロンプトの `【強制=委任対象外・コードで必ず適用】` が HTTP 境界で破れていた箇所の純関数版。
  //   POST /api/scalp-plan の body/query は誰でも投げられるので、下限は「下げられない・上げるのは自由」。
  it('設定値より低い要求は設定値まで引き上げる(緩められない)', () => {
    expect(clampRequestedLcFloor(20, 45)).toBe(45);
    expect(clampRequestedLcFloor(44, 45)).toBe(45);
    expect(clampRequestedLcFloor(-1000, 45)).toBe(45);
  });
  it('設定値と同じ/より厳しい要求はそのまま通す(安全側なので許可)', () => {
    expect(clampRequestedLcFloor(45, 45)).toBe(45);
    expect(clampRequestedLcFloor(60, 45)).toBe(60);
  });
  it('要求なし/非有限は設定値', () => {
    expect(clampRequestedLcFloor(undefined, 45)).toBe(45);
    expect(clampRequestedLcFloor(NaN, 45)).toBe(45);
    expect(clampRequestedLcFloor(Infinity, 45)).toBe(45);
  });
  it('設定値そのものが変われば床も動く(設定が唯一の真実)', () => {
    expect(clampRequestedLcFloor(20, 20)).toBe(20);
    expect(clampRequestedLcFloor(20, 80)).toBe(80);
  });
});

describe('scalpJsonInstruction フィールド注記の LC 反映', () => {
  it('既定(引数なし)の JSON 注記に LC幅55〜65 が入り 95/75 が入らない', () => {
    const j = scalpJsonInstruction(38250);
    expect(j).toContain('LC幅55〜65円');
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

  // ★向きの正しい sell(損切りは各エントリーの上)。base を単に direction 反転すると buy 向きの損切りになり
  //   向き検証で落ちるため、sell の pass-through 検証には向きの正しい fixture を使う。
  const validSell: AiPlan = {
    direction: 'sell',
    limitEntry: 38200, stopLossForLimit: 38250,   // 上=正(LC=50)
    stopEntry: 38050, stopLossForStop: 38100,     // 上=正(LC=50)
    rationale: '戻り売り', refPrice: REF,
  };

  it("bias='long' かつ buy は素通し / bias='short' かつ sell は素通し", () => {
    const rLong = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'long' });
    expect(rLong.direction).toBe('buy');
    const rShort = enforcePlanConstraints(validSell, { ceilingYen: 65, bias: 'short' });
    expect(rShort.direction).toBe('sell');
  });

  it("bias='none' は方向を素通し(buy/sell とも)", () => {
    expect(enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' }).direction).toBe('buy');
    expect(enforcePlanConstraints(validSell, { ceilingYen: 65, bias: 'none' }).direction).toBe('sell');
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

// ─── レンジ脚 drop 理由の rationale 明記(表示専用テキスト) ───
describe('enforcePlanConstraints range 脚 drop 理由を rationale に明記', () => {
  // REF=38250。upper=売り指値(上)/lower=買い指値(下)。
  const upper = { side: 'sell' as const, type: 'limit' as const, entry: 38400, stopLoss: 38450 };  // LC=50
  const lower = { side: 'buy' as const, type: 'limit' as const, entry: 38100, stopLoss: 38050 };    // LC=50
  const basePlan: AiPlan = {
    direction: 'range', rationale: '上部に売り指値、下部に買い指値を設定', refPrice: REF,
    range: { upper: { ...upper }, lower: { ...lower } },
  };

  it("bias='short' で下部(買い指値)が落ちる→上部だけ残り rationale にバイアス除外を明記", () => {
    const r = enforcePlanConstraints(basePlan, { ceilingYen: 65, bias: 'short' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper?.side).toBe('sell');   // 上部(売り)残存
    expect(r.range?.lower).toBeUndefined();       // 下部(買い)脱落
    // rationale は元文 + 下部(買い指値)+バイアス を含む注記
    expect(r.rationale).toContain('上部に売り指値、下部に買い指値を設定');
    expect(r.rationale).toContain('下部');
    expect(r.rationale).toContain('買い指値');
    expect(r.rationale).toContain('バイアス');
    // ★v0.9.66: 理由の日本語は方向レッグと同一(LEG_DROP_REASON_TEXT)。バイアスの向き(売り優先)は
    //   方向レッグ側が出していないので、レンジ脚でも出さない(同じ reason が2つの言葉に見えるのを止めた)。
    expect(r.rationale).toContain('バイアス設定と逆');
    // ★注記行は落ちた下部の1本だけ(同じ注記が二重に付いていないこと=出現回数で固定)
    expect(noteLines(r.rationale)).toHaveLength(1);
    expect(countOf(r.rationale, '※下部(買い指値)は不採用: バイアス設定と逆')).toBe(1);
    // 残った上部については注記しない
    expect(r.rationale).not.toContain('上部(売り指値)');
  });

  it('LC上限超で上部(売り指値)が落ちる→rationale に「損切り幅が設定の上限より広い」を明記', () => {
    // upper=売り(SLはentry上=正)だが LC=|38400-38550|=150(上限65超)→上部落ち。lower.LC=50 残る。
    const p: AiPlan = {
      ...basePlan,
      range: { upper: { ...upper, entry: 38400, stopLoss: 38550 }, lower: { ...lower } },
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();       // 上部脱落
    expect(r.range?.lower?.side).toBe('buy');      // 下部残存
    expect(r.rationale).toContain('上部');
    expect(r.rationale).toContain('売り指値');
    expect(r.rationale).toContain('損切り幅が設定の上限より広い');
    expect(noteLines(r.rationale)).toHaveLength(1);
    expect(countOf(r.rationale, '※上部(売り指値)は不採用: 損切り幅が設定の上限より広い')).toBe(1);
  });

  it('★enforce を2回適用しても注記は増えない(冪等)', () => {
    // 1回目で下部(買い指値)が落ちる。落ちた後の plan を再度 enforce しても、既に脚が無いので
    // 注記は追加されない=注記の連結は enforce 側では冪等(parse 側と違い再適用しても増えない)。
    const once = enforcePlanConstraints(basePlan, { ceilingYen: 65, bias: 'short' });
    const twice = enforcePlanConstraints(once, { ceilingYen: 65, bias: 'short' });
    expect(noteLines(twice.rationale)).toHaveLength(1);
    expect(twice.rationale).toBe(once.rationale);
  });

  it('脚が落ちない正常 range は rationale を改変しない', () => {
    const r = enforcePlanConstraints(basePlan, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('range');
    expect(r.rationale).toBe('上部に売り指値、下部に買い指値を設定');
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

// ─── parse 段階のレンジ脚 drop 理由も rationale に明記(片面の「理由なし」を無くす) ───
//   ユーザー報告「レンジのシグナルが買いだけで、売りが出ない理由が表示されていない」の真因対策。
//   enforce(トレンド/バイアス/LC/SL向き)は注記していたが、parse(幾何・SL向き・AI未提示)は完全に無言だった。
describe('parseScalpPlan range 脚 drop 理由を rationale に明記', () => {
  const okUpper = { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 };  // 上=売り指値 LC=50
  const okLower = { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 };    // 下=買い指値 LC=50
  const RATIONALE = '上下に反応帯があるレンジ。上部に売り指値、下部に買い指値を設定';

  it('★幾何不正(upper.entry が現在値以下)で上部が落ちる→rationale に幾何の理由を明記', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38200 }, lower: okLower },   // upper.entry<REF=幾何不正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.range?.lower?.side).toBe('buy');
    expect(r.plan.rationale).toContain(RATIONALE);   // 元文は保つ
    expect(r.plan.rationale).toContain('上部');
    expect(r.plan.rationale).toContain('売り指値');
    expect(r.plan.rationale).toContain('エントリーが現在値の逆側');
    expect(r.plan.rationale).toContain('\n');        // enforce と同じ \n 連結
    // 注記行は落ちた上部の1本だけ(残った下部については注記しない)。
    const notes = noteLines(r.plan.rationale);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('上部');
    expect(countOf(r.plan.rationale, 'エントリーが現在値の逆側')).toBe(1);
  });

  it('★幾何不正(lower.entry が現在値以上)で下部が落ちる→rationale に幾何の理由を明記', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: okUpper, lower: { ...okLower, entry: 38300 } },   // lower.entry>REF=幾何不正
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.range?.lower).toBeUndefined();
    expect(r.plan.rationale).toContain('下部');
    expect(r.plan.rationale).toContain('買い指値');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, 'エントリーが現在値の逆側')).toBe(1);
  });

  // ★v0.9.70: 「損切りが脚の side と逆側」は表現不能になったので、この入力は脚を落とさない
  //   (幅だけを採って side どおりに置き直す)= 注記も出ない。落ちる形は『幅が無い/0以下』に移った。
  it('★幅が使えない脚(旧形式の SL がエントリーと同値=幅0)は「不採用」で注記される(「提案せず」にしない)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, stopLoss: 38400 }, lower: okLower },   // entry と同値=幅0
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.rationale).toContain('上部');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '※上部(売り指値)は不採用: エントリーが現在値の逆側、または損切り幅の値が不正')).toBe(1);
  });

  it('★AI が片側しか出さなかった(upper 欠落)→「AIが提案せず」を明記', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { lower: okLower },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.lower?.side).toBe('buy');
    expect(r.plan.rationale).toContain(RATIONALE);
    expect(r.plan.rationale).toContain('上部');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '※上部のレッグなし: AIが提案せず')).toBe(1);
  });

  it('★AI のレッグが壊れた形(side 不正)も「AIが提案せず」扱いで明記', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, side: 'hold' }, lower: okLower },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.rationale).toContain('上部');
    expect(noteLines(r.plan.rationale)).toHaveLength(1);
    expect(countOf(r.plan.rationale, '※上部のレッグなし: AIが提案せず')).toBe(1);
  });

  it('両脚とも落ちて none になる場合は rationale を改変しない(既存挙動を維持)', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38000 }, lower: { ...okLower, entry: 38500 } },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('none');
    expect(r.plan.rationale).toBe(RATIONALE);
  });

  it('両脚とも正常な range は rationale を改変しない', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: okUpper, lower: okLower },
    });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.rationale).toBe(RATIONALE);
  });

  it('★parse の注記は enforce を通しても残り、二重に付かない', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: { ...okUpper, entry: 38200 }, lower: okLower },   // upper=幾何不正(parse で落ちる)
    });
    const parsed = parseScalpPlan(raw, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const out = enforcePlanConstraints(parsed.plan, { ceilingYen: 65, bias: 'none' });
    expect(out.direction).toBe('range');
    expect(out.range?.lower?.side).toBe('buy');
    expect(out.rationale).toContain(RATIONALE);
    // enforce は既に消えた脚を再度注記しない=同じ注記は1回だけ。
    expect(out.rationale.split('エントリーが現在値の逆側').length - 1).toBe(1);
  });

  it('★parse の注記 + enforce の注記が両方載る(下部=parse幾何 / 上部=enforce LC上限)', () => {
    // 下部: AI が現在値超の lower を出す=幾何不正で parse が落とす(注記①)。
    // 上部: 幾何/SL向きは正しいが LC=150 で上限65超=enforce が落とす(注記②)。両脚落ちなので最終は none だが、
    //       none 化しても rationale は据え置き(既存挙動)なので、両方の注記が読める。
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38550 },   // LC=150(上限超)
        lower: { ...okLower, entry: 38300 },                                      // 現在値超=幾何不正
      },
    });
    const parsed = parseScalpPlan(raw, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.plan.rationale).toContain('エントリーが現在値の逆側');   // 注記①(parse)
    const out = enforcePlanConstraints(parsed.plan, { ceilingYen: 65, bias: 'none' });
    expect(out.direction).toBe('none');
    expect(out.rationale).toContain(RATIONALE);
    expect(out.rationale).toContain('エントリーが現在値の逆側');            // 注記①が残る
  });

  it('★片脚が残る合成: 下部=parse幾何 / 上部=enforce バイアス → 両方の注記が載る', () => {
    // 3脚は作れないため「parse で下部落ち → enforce の後に上部だけ残る」構図で、片面表示時に
    // parse 注記と enforce 注記が併記されることを確認する(手組み plan で enforce 側の脚を足す)。
    const raw = JSON.stringify({
      direction: 'range', rationale: RATIONALE, refPrice: 1,
      range: { upper: okUpper, lower: { ...okLower, entry: 38300 } },   // lower=幾何不正(parse 注記)
    });
    const parsed = parseScalpPlan(raw, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // parse 注記付きの plan に、enforce が LC 上限で落とす lower を手で足す。
    const p: AiPlan = {
      ...parsed.plan,
      range: { upper: parsed.plan.range!.upper, lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 37950 } },
    };
    const out = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none' });
    expect(out.direction).toBe('range');
    expect(out.range?.upper?.side).toBe('sell');
    expect(out.range?.lower).toBeUndefined();
    expect(out.rationale).toContain('エントリーが現在値の逆側');   // parse 由来
    expect(out.rationale).toContain('損切り幅が設定の上限より広い');   // enforce 由来
    expect(out.rationale).toContain(RATIONALE);
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

// ─── トレンド veto(生きた強トレンドに逆行するフェード新規を落とす) ───
describe('enforcePlanConstraints トレンド veto(directional)', () => {
  const buyPlan: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,   // LC=50
    stopEntry: 38350, stopLossForStop: 38300,     // LC=50
    rationale: '押し目買い', refPrice: REF,
  };
  const sellPlan: AiPlan = {
    direction: 'sell',
    limitEntry: 38300, stopLossForLimit: 38340,   // LC=40
    stopEntry: 38150, stopLossForStop: 38190,     // LC=40
    rationale: '戻り売り', refPrice: REF,
  };

  it('強上昇 + directional sell → none(逆行=見送り)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
    expect(r.rationale).toBe('戻り売り');
    expect(r.refPrice).toBe(REF);
  });

  it('強上昇 + directional buy は維持(順行)', () => {
    const r = enforcePlanConstraints(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38350);
  });

  it('強下降 + directional buy → none(逆行)', () => {
    const r = enforcePlanConstraints(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('none');
  });

  it('強下降 + directional sell は維持(順行)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('sell');
  });

  it('trend.strong=false(flat)は現行と完全一致(素通し)', () => {
    const withFlat = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } });
    const noTrend = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none' });
    expect(withFlat).toEqual(noTrend);
    expect(withFlat.direction).toBe('sell');
  });

  it('trend 未指定は現行と完全一致(素通し)', () => {
    const r = enforcePlanConstraints(sellPlan, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('sell');
    expect(r.limitEntry).toBe(38300);
  });

  it('合成順: 順行 buy は トレンド veto を通過し、その後 LC 上限で片レッグ落ちる', () => {
    // 強上昇 + buy(順行)。逆指値LC=|38450-38300|=150 は上限65超で落ち、指値LC=50 は残る。
    const p: AiPlan = { ...buyPlan, stopEntry: 38450, stopLossForStop: 38300 };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();
  });
});

describe('enforcePlanConstraints トレンド veto(range 片面化)', () => {
  const base: AiPlan = {
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },  // LC=50
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },    // LC=50
    },
  };

  it('強上昇 → 上=売り指値を落とし 下=買いが残る(片面 range)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower?.side).toBe('buy');
  });

  it('強下降 → 下=買いを落とし 上=売りが残る(片面 range)', () => {
    const r = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(r.direction).toBe('range');
    expect(r.range?.lower).toBeUndefined();
    expect(r.range?.upper?.side).toBe('sell');
  });

  it('両レッグとも逆行 side → none(強上昇で両レッグ sell)', () => {
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
  });

  it('flat(strong=false)は range を現行どおり素通し(両レッグ残る)', () => {
    const withFlat = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } });
    const noTrend = enforcePlanConstraints(base, { ceilingYen: 65, bias: 'none' });
    expect(withFlat).toEqual(noTrend);
    expect(withFlat.range?.upper).toBeDefined();
    expect(withFlat.range?.lower).toBeDefined();
  });

  it('合成: 強上昇 + トレンドで上落ち → 残る下(buy)を LC 上限で更に落とすと none', () => {
    // 上=sell(トレンドで落ち)・下=buy だが LC=|38100-37980|=120 上限65超 → 下も落ち → none。
    const p: AiPlan = { ...base, range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 37980 },
    } };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.direction).toBe('none');
  });
});

// ─── AI 自己レジーム/確信度(v0.7.54・記録のみ・寛容パース) ───
describe('parseAiRegime / parseAiConfidence(寛容)', () => {
  it('regime は enum のみ受理・それ以外は undefined', () => {
    expect(parseAiRegime('trend_up')).toBe('trend_up');
    expect(parseAiRegime('range')).toBe('range');
    expect(parseAiRegime('unclear')).toBe('unclear');
    expect(parseAiRegime('bogus')).toBeUndefined();
    expect(parseAiRegime(123)).toBeUndefined();
    expect(parseAiRegime(undefined)).toBeUndefined();
  });
  it('confidence は有限数を 0-100 にクランプ・非数値は undefined', () => {
    expect(parseAiConfidence(70)).toBe(70);
    expect(parseAiConfidence(0)).toBe(0);
    expect(parseAiConfidence(120)).toBe(100);
    expect(parseAiConfidence(-5)).toBe(0);
    expect(parseAiConfidence(NaN)).toBeUndefined();
    expect(parseAiConfidence('80')).toBeUndefined();
    expect(parseAiConfidence(undefined)).toBeUndefined();
  });
});

describe('parseScalpPlan regime/confidence 寛容パース(後方互換)', () => {
  it('directional plan に regime/confidence を載せる', () => {
    const raw = JSON.stringify({ ...goodPlan, regime: 'trend_up', confidence: 72 });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.regime).toBe('trend_up');
      expect(r.plan.confidence).toBe(72);
    }
  });
  it('none plan にも regime/confidence を載せる', () => {
    const raw = JSON.stringify({ direction: 'none', rationale: '見送り', regime: 'range', confidence: 40 });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.plan.regime).toBe('range');
      expect(r.plan.confidence).toBe(40);
    }
  });
  it('欠落/不正な regime・confidence は undefined(既存挙動は不変)', () => {
    const raw = JSON.stringify({ ...goodPlan, regime: 'bogus', confidence: 'high' });
    const r = parseScalpPlan(raw, REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.regime).toBeUndefined();
      expect(r.plan.confidence).toBeUndefined();
      // 他フィールドは従来どおり。
      expect(r.plan.limitEntry).toBe(38200);
    }
  });
  it('regime/confidence が無い応答も従来どおり成立(後方互換)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.regime).toBeUndefined();
      expect(r.plan.confidence).toBeUndefined();
    }
  });
});

// ─── enforcePlanConstraintsReport vetoFired surface(挙動は不変・発火だけ計測) ───
describe('enforcePlanConstraintsReport vetoFired(挙動不変で発火を surface)', () => {
  const buyPlan: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };
  const sellPlan: AiPlan = {
    direction: 'sell',
    limitEntry: 38300, stopLossForLimit: 38340,
    stopEntry: 38150, stopLossForStop: 38190,
    rationale: '戻り売り', refPrice: REF,
  };

  it('返る plan は enforcePlanConstraints と完全一致(byte 不変)', () => {
    const opts = { ceilingYen: 65, bias: 'none' as const, trend: { dir: 'up' as const, strong: true } };
    expect(enforcePlanConstraintsReport(sellPlan, opts).plan).toEqual(enforcePlanConstraints(sellPlan, opts));
    const opts2 = { ceilingYen: 49, bias: 'none' as const };
    expect(enforcePlanConstraintsReport(buyPlan, opts2).plan).toEqual(enforcePlanConstraints(buyPlan, opts2));
  });

  it('directional 逆行(強上昇 sell)→ none 化 & vetoFired=true', () => {
    const r = enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('none');
    expect(r.vetoFired).toBe(true);
  });

  it('directional 順行(強上昇 buy)→ 維持 & vetoFired=false', () => {
    const r = enforcePlanConstraintsReport(buyPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('buy');
    expect(r.vetoFired).toBe(false);
  });

  it('trend 未指定/flat は vetoFired=false(veto 無効)', () => {
    expect(enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none' }).vetoFired).toBe(false);
    expect(enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'none', trend: { dir: 'flat', strong: false } }).vetoFired).toBe(false);
  });

  it('LC 上限や bias 由来の none 化は vetoFired=false(veto の効き目だけ計測)', () => {
    // bias veto で none 化するが、これはトレンド veto ではない。
    const r = enforcePlanConstraintsReport(sellPlan, { ceilingYen: 65, bias: 'long' });
    expect(r.plan.direction).toBe('none');
    expect(r.vetoFired).toBe(false);
  });

  it('range 片面化(強上昇で上=売り脚を落とす)→ vetoFired=true・下は残る', () => {
    const base: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const r = enforcePlanConstraintsReport(base, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.range?.lower?.side).toBe('buy');
    expect(r.vetoFired).toBe(true);
  });
});

describe('scalpJsonInstruction / SYSTEM に regime/confidence 指示', () => {
  it('JSON スキーマに regime と confidence フィールドが入る', () => {
    const j = scalpJsonInstruction(38250);
    expect(j).toContain('"regime"');
    expect(j).toContain('"confidence"');
    expect(j).toContain('trend_up');
  });
  it('system prompt が「まず regime/confidence を出す」旨を含む', () => {
    expect(SCALP_SYSTEM_PROMPT).toContain('regime');
    expect(SCALP_SYSTEM_PROMPT).toContain('confidence');
  });
});

describe('scalp プロンプト trendVeto 文言', () => {
  it('既定(veto=100)で SCALP_QUESTION/SYSTEM に勢い/レンジの指針が入る', () => {
    expect(SCALP_QUESTION).toContain('直近の勢い');
    expect(SCALP_QUESTION).toContain('横ばい');
    expect(SCALP_SYSTEM_PROMPT).toContain('直近の勢い');
    // 既定は 100(旧LC上限の 95/75 とは無関係=回帰保護)。
    expect(SCALP_QUESTION).toContain('100');
  });

  it('trendVetoYen を渡すと閾値がプロンプトに反映される', () => {
    expect(buildScalpQuestion(45, 65, true, 150)).toContain('±150円未満');
    expect(buildScalpSystemPrompt(45, 65, true, 150)).toContain('±150円未満');
  });

  it('trendVetoYen=0(無効)は勢い/レンジ指針を注入しない', () => {
    const q = buildScalpQuestion(45, 65, true, 0);
    const s = buildScalpSystemPrompt(45, 65, true, 0);
    expect(q).not.toContain('直近の勢い');
    expect(s).not.toContain('直近の勢い');
  });
});

// ─── 変更A(2026-08-18): トレンドveto が委任(=数値veto無効)のとき、「コード側の自動見送り」という
//   存在しない安全網の説明をAIに告げない。実測: veto_fired は全12,043プランで0(一度も発火していない)。
describe('★存在しない安全網を告げない(委任時)', () => {
  it('トレンドveto が委任(閾値0)のとき、質問文に「自動見送り」が出ない', () => {
    // buildScalpPlan は trendVeto directive が ai のとき trendVetoYen=0 を渡す(既存実装・scalpPlan.ts:2228)。
    const q = buildScalpQuestion(45, 65, true, 0);
    const s = buildScalpSystemPrompt(45, 65, true, 0);
    expect(q).not.toContain('自動見送り');
    expect(s).not.toContain('自動見送り');
  });
  it('手動(閾値>0)のときは従来どおり出る(否定対照)', () => {
    const q = buildScalpQuestion(45, 65, true, 100);
    const s = buildScalpSystemPrompt(45, 65, true, 100);
    expect(q).toContain('自動見送り');
    expect(s).toContain('自動見送り');
  });

  const trendVetoSpecBase = {
    floor: { mode: 'manual' as const, value: 45 },
    ceiling: { mode: 'manual' as const, value: 65 },
    trendVeto: { mode: 'manual' as const, value: 100 },
    cooldown: { mode: 'manual' as const, value: 90 },
    bias: { mode: 'manual' as const, value: 'none' as const },
    range: { mode: 'manual' as const, value: true },
    hardMax: { enabled: true, value: 150 },
    exitDesc: '【決済ロジック】…',
  };
  it('buildStrategySpec: トレンドveto が委任(mode=ai)のとき「自動見送り」が出ない', () => {
    const s = buildStrategySpec({ ...trendVetoSpecBase, trendVeto: { mode: 'ai', value: 100 } });
    expect(s).not.toContain('自動見送り');
    expect(s).toContain('【AI委任=あなたが決めてよい】');   // 委任タグ自体は残る(表示は別の役割)
  });
  it('buildStrategySpec: 手動(mode=manual・値>0)のときは従来どおり出る(否定対照)', () => {
    const s = buildStrategySpec(trendVetoSpecBase);
    expect(s).toContain('自動見送り');
    expect(s).toContain('【手動=固定・厳守】');
  });
  it('buildStrategySpec: 手動だが値=0のときも出さない(閾値0=veto無効という理由は共通)', () => {
    const s = buildStrategySpec({ ...trendVetoSpecBase, trendVeto: { mode: 'manual', value: 0 } });
    expect(s).not.toContain('自動見送り');
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
    // JSON スキーマの direction enum に range が入らない(regime 値の "range" とは別物なので、
    // direction enum 語順と range 両面オブジェクトの不在で判定する。v0.7.54 で regime 値に "range" が入るため)。
    expect(scalpJsonInstruction(38250, 45, 65, false)).not.toContain('"none" | "range"');
    expect(scalpJsonInstruction(38250, 45, 65, false)).not.toContain('"range": {');
  });
});

// ─── v0.7.56: 項目別 手動/AI 委任 + LC安全上限 ───
describe('lcLegExceeds(LC上限 mode 分岐 + 安全網)', () => {
  it('既定(mode/hardMax 省略)は w>ceiling のみ=従来と一致', () => {
    expect(lcLegExceeds(50, { ceilingYen: 65 })).toBe(false);
    expect(lcLegExceeds(66, { ceilingYen: 65 })).toBe(true);
    expect(lcLegExceeds(65, { ceilingYen: 65 })).toBe(false);   // 境界=許可
  });
  it('ceilingMode=ai は ceiling では落とさない', () => {
    expect(lcLegExceeds(200, { ceilingYen: 65, ceilingMode: 'ai' })).toBe(false);
  });
  it('lcHardMax 有効時は mode 無関係に value 超を落とす(ai でも)', () => {
    expect(lcLegExceeds(200, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } })).toBe(true);
    expect(lcLegExceeds(120, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } })).toBe(false);
  });
  // ★変更(上限の穴塞ぎ): 旧テストは「ai + hardMax 無効 = 上限が完全消滅(LC500 も通る)」を固定していた。
  //   委任は「設定した上限(65)を外す」意味であって「どんな幅でも通す」意味ではないので、
  //   安全網が無効なときは LC_YEN_MAX(=設定として受理しうる LC 幅の絶対上限)を背骨として残す。
  it('lcHardMax 無効 + ai: 設定上限(65)は外れるが LC_YEN_MAX が背骨として残る(上限は完全消滅しない)', () => {
    expect(lcLegExceeds(200, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(false);
    expect(lcLegExceeds(LC_YEN_MAX, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(false);  // 境界=許可
    expect(lcLegExceeds(LC_YEN_MAX + 1, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(true);
    expect(lcLegExceeds(500, { ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(true);
  });
  it('lcEffectiveCeiling: 手動=設定上限と背骨の厳しい方 / 委任=背骨', () => {
    expect(lcEffectiveCeiling({ ceilingYen: 65 })).toBe(65);
    expect(lcEffectiveCeiling({ ceilingYen: 65, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(65);
    expect(lcEffectiveCeiling({ ceilingYen: 200, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(150);
    expect(lcEffectiveCeiling({ ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } })).toBe(150);
    expect(lcEffectiveCeiling({ ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } })).toBe(LC_YEN_MAX);
  });
  it('★既定 hardMax(enabled150)+manual65 は 65 超のみ=ceiling が支配(回帰なし)', () => {
    // 150 有効でも 65<150 なので、ceiling で既に落ちる=hardMax は追加ドロップしない=従来挙動と一致。
    expect(lcLegExceeds(66, { ceilingYen: 65, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(true);
    expect(lcLegExceeds(50, { ceilingYen: 65, ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } })).toBe(false);
  });
});

// ─── ★初期LC「下限」の実強制(純関数) ───
//   これまで下限はプロンプト文字列にしか到達しておらず、コードの判定が存在しなかった。
//   下限は「AI に委任できる好み」ではなく、決済ロジック(含み益が一定に達して初めて利益ロックの床が
//   発動する)が成立するための前提条件なので、委任モードの分岐を持たない=常に強制する。
describe('lcLegBelowFloor(LC下限・委任の分岐を持たない)', () => {
  it('floorYen 省略なら常に false(=旧挙動・直呼びの既存経路は不変)', () => {
    expect(lcLegBelowFloor(5, {})).toBe(false);
    expect(lcLegBelowFloor(5, { floorYen: undefined })).toBe(false);
  });
  it('下限未満は true / 境界(ちょうど下限)と超過は false', () => {
    expect(lcLegBelowFloor(44, { floorYen: 45 })).toBe(true);
    expect(lcLegBelowFloor(5, { floorYen: 45 })).toBe(true);
    expect(lcLegBelowFloor(45, { floorYen: 45 })).toBe(false);   // 境界=許可
    expect(lcLegBelowFloor(60, { floorYen: 45 })).toBe(false);
  });
  it('非有限/0以下の floorYen は無効扱い(誤設定で全レッグが消えない)', () => {
    expect(lcLegBelowFloor(5, { floorYen: NaN })).toBe(false);
    expect(lcLegBelowFloor(5, { floorYen: Infinity })).toBe(false);
    expect(lcLegBelowFloor(5, { floorYen: 0 })).toBe(false);
    expect(lcLegBelowFloor(5, { floorYen: -10 })).toBe(false);
  });
});

describe('enforcePlanConstraints floorYen(下限未満のレッグを落とす)', () => {
  // buy: 指値LC=|38200-38195|=5(下限未満) / 逆指値LC=|38350-38300|=50(下限以上)。
  const narrow: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38195,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };

  it('floorYen 省略=下限判定なし(既存の呼び出し/テストは不変)', () => {
    const r = enforcePlanConstraints(narrow, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);   // LC=5 でも落ちない=旧挙動
  });

  it('floorYen=45: 下限未満のレッグだけ落ちる(クランプせず落とす=上限側と同じ扱い)', () => {
    const r = enforcePlanConstraints(narrow, { ceilingYen: 65, bias: 'none', floorYen: 45 });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBeUndefined();
    expect(r.stopLossForLimit).toBeUndefined();
    // ★クランプ(損切りを下限まで広げる)はしない=価格は書き換えられない。
    expect(r.stopEntry).toBe(38350);
    expect(r.stopLossForStop).toBe(38300);
  });

  it('両レッグとも下限未満 → none・noneReason=lcFloor・落とした生数値は記録される', () => {
    const p: AiPlan = { ...narrow, stopEntry: 38350, stopLossForStop: 38345 };   // 両方 LC=5
    const r = enforcePlanConstraintsReport(p, { ceilingYen: 65, bias: 'none', floorYen: 45 });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
    expect(r.noneLegs?.legs).toHaveLength(2);
    expect(r.plan.rationale).toBe('押し目買い');
  });

  it('★委任(ceilingMode=ai)でも下限は効く=強制が委任に勝つ', () => {
    const r = enforcePlanConstraints(narrow, {
      ceilingYen: 65, bias: 'none', floorYen: 45, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 },
    });
    expect(r.limitEntry).toBeUndefined();   // 上限を委任しても下限は残る
    expect(r.stopEntry).toBe(38350);
  });

  it('range: 下限未満の脚だけ落ち、rationale に「損切り幅が設定の下限より狭い」を明記(1回だけ)', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38410 },   // LC=10
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },     // LC=50
      },
    };
    const r = enforcePlanConstraints(p, { ceilingYen: 65, bias: 'none', floorYen: 45 });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();
    expect(r.range?.lower?.side).toBe('buy');
    expect(countOf(r.rationale, '※上部(売り指値)は不採用: 損切り幅が設定の下限より狭い')).toBe(1);
  });

  it('上限超と下限未満は別々の理由として記録される(混同しない)', () => {
    const p: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38410 },   // LC=10 → 下限未満
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 37900 },     // LC=200 → 上限超
      },
    };
    const r = enforcePlanConstraintsReport(p, { ceilingYen: 65, bias: 'none', floorYen: 45 });
    expect(r.plan.direction).toBe('none');
    // 代表理由は優先順位で 'lc'(上限超)が先だが、両方が観測されていること自体は noneLegs で担保。
    expect(r.noneReason).toBe('lc');
    expect(r.noneLegs?.legs).toHaveLength(2);
  });
});

describe('enforcePlanConstraints ceilingMode/lcHardMax 分岐', () => {
  // buy: 指値LC=|38200-38150|=50 / 逆指値LC=|38500-38300|=200(=上限65超・150超)。
  const wide: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,   // LC=50
    stopEntry: 38500, stopLossForStop: 38300,     // LC=200
    rationale: '押し目買い', refPrice: 38250,
  };

  it('manual(既定): LC200 の逆指値は落ち・指値のみ残る(従来)', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none' });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();
  });
  it('ai-ceiling + hardMax 無効: LC200 でも両レッグ残る(上限で落とさない)', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: false, value: 150 } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBe(38500);   // ai=ceilingで落とさない
  });
  it('ai-ceiling + hardMax 有効(150): LC200 は安全網で落ちる・LC50 は残る', () => {
    const r = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } });
    expect(r.direction).toBe('buy');
    expect(r.limitEntry).toBe(38200);
    expect(r.stopEntry).toBeUndefined();   // 200>150 安全網で落ちる
  });
  it('ai-ceiling range: hardMax 有効で上限超レッグだけ落とす', () => {
    const rng: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: 38250,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38650 },   // LC=250>150
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },      // LC=50
      },
    };
    const r = enforcePlanConstraints(rng, { ceilingYen: 65, bias: 'none', ceilingMode: 'ai', lcHardMax: { enabled: true, value: 150 } });
    expect(r.direction).toBe('range');
    expect(r.range?.upper).toBeUndefined();   // 安全網
    expect(r.range?.lower?.side).toBe('buy');
  });
  it('★回帰: manual + 既定 hardMax(150) は ceilingMode/hardMax 省略と同一結果', () => {
    const withDefaults = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none', ceilingMode: 'manual', lcHardMax: { enabled: true, value: 150 } });
    const legacy = enforcePlanConstraints(wide, { ceilingYen: 65, bias: 'none' });
    expect(withDefaults).toEqual(legacy);
  });
});

describe('buildDelegationNote(委任ノート)', () => {
  const allManual: KnobModes = { lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'manual', cooldown: 'manual', bias: 'manual', range: 'manual' };
  const ctx = { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 } };

  it('全 knob 手動 → 空文字(プロンプト不変=回帰なし)', () => {
    expect(buildDelegationNote(allManual, ctx)).toBe('');
  });
  it('lcCeiling=ai → LC をAIに委任する旨 + ロジック(コツコツドカン回避) + 安全上限を明記', () => {
    const n = buildDelegationNote({ ...allManual, lcCeiling: 'ai' }, ctx);
    expect(n).toContain('最大初期LC');
    expect(n).toContain('あなたが決める');
    expect(n).toContain('コツコツドカン');   // ★ロジックが転写されている
    expect(n).toContain('安全上限 150円');
  });
  it('trendVeto=ai → 判断ロジックと根拠(勢いデータ・フェードは負ける)を転写', () => {
    const n = buildDelegationNote({ ...allManual, trendVeto: 'ai' }, ctx);
    expect(n).toContain('直近の勢い');          // 使うべきデータを明示
    expect(n).toContain('フェード');            // 逆張りの基準
    expect(n).toContain('regime');             // 自己レジームを下す
  });
  it('lcCeiling=ai + hardMax 無効 → 安全上限の文言なし', () => {
    const n = buildDelegationNote({ ...allManual, lcCeiling: 'ai' }, { ...ctx, hardMax: { enabled: false, value: 150 } });
    expect(n).toContain('最大初期LC');
    expect(n).not.toContain('安全上限');
  });
  it('trendVeto/bias/range=ai → 各委任行が入る', () => {
    const n = buildDelegationNote({ ...allManual, trendVeto: 'ai', bias: 'ai', range: 'ai' }, ctx);
    expect(n).toContain('トレンド');
    expect(n).toContain('方向');
    expect(n).toContain('レンジ両面');
  });
  it('range=ai → 連敗時にレンジ両面へ切替を検討する指示が入る', () => {
    const n = buildDelegationNote({ ...allManual, range: 'ai' }, ctx);
    expect(n).toContain('連敗');
    expect(n).toContain('range(両面)へ切り替え');
  });
});

// ─── 変更B(2026-08-18): rangeEnabled=false(range 自体を禁止)のとき、range 専用の規則を
//   ①無条件で語らない(距離規則)②宛先の無い代名詞にしない(「上の2択」= range 有効時にしか定義されない)。
describe('★レンジ無効時に死んだ条項を出さない', () => {
  const specBase = {
    floor: { mode: 'manual' as const, value: 45 },
    ceiling: { mode: 'manual' as const, value: 65 },
    trendVeto: { mode: 'manual' as const, value: 100 },
    cooldown: { mode: 'manual' as const, value: 90 },
    bias: { mode: 'manual' as const, value: 'none' as const },
    range: { mode: 'manual' as const, value: false },
    hardMax: { enabled: true, value: 150 },
    exitDesc: '【決済ロジック】…',
  };

  it('buildScalpQuestion: rangeEnabled=false なら「レンジの距離」が出ない(range 自体を出さない旨のみ)', () => {
    const q = buildScalpQuestion(45, 65, false);
    expect(q).not.toContain('レンジの距離');
    expect(q).toContain('出さないこと');
  });
  it('buildScalpQuestion: rangeEnabled=true なら従来どおり出る(否定対照)', () => {
    const q = buildScalpQuestion(45, 65, true);
    expect(q).toContain('レンジの距離');
  });

  it('buildScalpSystemPrompt: rangeEnabled=false なら「レンジの距離」が出ない(range 自体を出さない旨のみ)', () => {
    const s = buildScalpSystemPrompt(45, 65, false);
    expect(s).not.toContain('レンジの距離');
    expect(s).toContain('出さないこと');
  });
  it('buildScalpSystemPrompt: rangeEnabled=true なら従来どおり出る(否定対照)', () => {
    const s = buildScalpSystemPrompt(45, 65, true);
    expect(s).toContain('レンジの距離');
  });

  it('buildStrategySpec: range.value=false なら「レンジの距離」が出ない', () => {
    const s = buildStrategySpec(specBase);
    expect(s).not.toContain('レンジの距離');
  });
  it('buildStrategySpec: range.value=true なら従来どおり出る(否定対照)', () => {
    const s = buildStrategySpec({ ...specBase, range: { mode: 'manual', value: true } });
    expect(s).toContain('レンジの距離');
  });

  it('buildDelegationNote: trendVeto=ai だが rangeEnabled=false なら「上の2択」への言及(宛先の無い代名詞)が出ない', () => {
    const modes: KnobModes = { lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'ai', cooldown: 'manual', bias: 'manual', range: 'manual' };
    const n = buildDelegationNote(modes, { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 }, rangeEnabled: false });
    expect(n).not.toContain('上の2択');
    // トレンド委任ノート自体は残る(この行だけが死んだ条項)。
    expect(n).toContain('トレンド/レンジの見極め');
  });
  it('buildDelegationNote: trendVeto=ai かつ rangeEnabled=true(既定)なら従来どおり出る(否定対照)', () => {
    const modes: KnobModes = { lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'ai', cooldown: 'manual', bias: 'manual', range: 'manual' };
    const n = buildDelegationNote(modes, { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 }, rangeEnabled: true });
    expect(n).toContain('上の2択');
  });
});

describe('buildStrategySpec(戦略仕様・完全版=全定数+委任状態+決済ロジック)', () => {
  const base = {
    floor: { mode: 'manual' as const, value: 45 },
    ceiling: { mode: 'manual' as const, value: 65 },
    trendVeto: { mode: 'manual' as const, value: 100 },
    cooldown: { mode: 'manual' as const, value: 90 },
    bias: { mode: 'manual' as const, value: 'none' as const },
    range: { mode: 'manual' as const, value: false },
    hardMax: { enabled: true, value: 150 },
    exitDesc: '【決済ロジック(phase-exit)】…利益ロックのラチェット床…',
  };
  it('エントリー全定数と決済説明を1ブロックに含む', () => {
    const s = buildStrategySpec(base);
    expect(s).toContain('下限45円');
    expect(s).toContain('上限65円');
    expect(s).toContain('±100円');            // トレンド閾値(定数)
    expect(s).toContain('90秒');               // クールダウン(定数)
    // ★v0.9.64: 緩衝の注記から数値「+5円」を撤去した(実測 2026-08-07: 損切りが 建値±5 に汚染。
    //   この「+5円」は v0.9.60 以降 参照先を失ったまま、損切りに足し引きする量を名指しする唯一の数値だった)。
    //   規則(「節目からわずかに離すだけ・幅を作る量ではない」)は残っているので、そちらを固定する。
    expect(s).toContain('この緩衝は LC幅を作る量ではない');  // ストップ緩衝(量を持たない表現)
    expect(s).not.toContain('★この「+5円」は');
    expect(s).toContain('50円');               // 最低距離
    expect(s).toContain('安全上限 150円');
    expect(s).toContain('ラチェット');          // 決済ロジックが注入される
  });
  it('委任状態を各項目に明示(AI=あなたが決める / 手動=固定・厳守)', () => {
    const s = buildStrategySpec({ ...base, trendVeto: { mode: 'ai', value: 100 } });
    expect(s).toContain('【AI委任=あなたが決めてよい】');   // trendVeto=ai
    expect(s).toContain('【手動=固定・厳守】');             // 他は手動
  });
  it('LC安全上限 無効なら「安全上限 無効」', () => {
    const s = buildStrategySpec({ ...base, hardMax: { enabled: false, value: 150 } });
    expect(s).toContain('安全上限 無効');
  });
  // ★v0.9.64: ブレイク新規のずらし量「0〜5円」を撤去(実測 2026-08-07: ≤10円 の損切り43件が
  //   ほぼ逆指値レッグに集中。stopEntry の隣にある小さい数値が損切りの代入に流用されていた)。
  //   指値側の「5〜10円」は健全なので残す=片側だけ量を持たない表現にする。
  it('節目への置き方(指値=5〜10円内側 / 逆指値=すぐ外側・量は決めない)を含む', () => {
    const s = buildStrategySpec(base);
    expect(s).toContain('節目への置き方');
    expect(s).toContain('5〜10円');
    expect(s).toContain('すぐ外側(抜ける方向・量は決めない)');
    expect(s).not.toContain('0〜5円');
    expect(s).toContain('内側');
    expect(s).toContain('外側');
  });
});

describe('節目への指値/逆指値プレースメント規則(約定重視)', () => {
  it('system prompt と question にも同じ規則(節目オフセット)を注入する', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion()]) {
      expect(t).toContain('節目');
      expect(t).toContain('5〜10円');    // 指値=内側オフセット(数量は維持=健全な側)
      // ★v0.9.64: 逆指値=外側オフセットの数量(0〜5円)は撤去。規則(すぐ外側=抜ける方向)は残す。
      expect(t).toContain('すぐ外側');
      expect(t).not.toContain('0〜5円');
      expect(t).toContain('内側');
      expect(t).toContain('外側');
    }
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

// ─── ★AIテクニカル: system prompt のテクニカル許可行(エントリーのタイミング判断のみ) ───

describe('buildScalpSystemPrompt テクニカル許可行(aiTechnicalEnabled)', () => {
  it('既定(false)は従来の system prompt と byte 一致=テクニカル行なし', () => {
    const off = buildScalpSystemPrompt(45, 65, true, 100);
    expect(off).toBe(buildScalpSystemPrompt(45, 65, true, 100, false));
    expect(off).not.toContain('テクニカル指標(RSI/BB)の活用');
  });
  it('true でテクニカル許可行を末尾に追記(エントリーの"タイミング"判断のみ・決済は既定ロジック)', () => {
    const on = buildScalpSystemPrompt(45, 65, true, 100, true);
    expect(on.startsWith(buildScalpSystemPrompt(45, 65, true, 100, false))).toBe(true);   // 既存部分は不変
    expect(on).toContain('テクニカル指標(RSI/BB)の活用');
    expect(on).toContain('生きたトレンドはフェードしない');   // テクニカル単独の逆張りを戒める文言
    // ★決済(手仕舞い)は AI に委ねない=強制決済の指示は入れない。
    expect(on).toContain('決済(手仕舞い)は既定のロジックが担当する');
    expect(on).not.toContain('heldAction');
  });
});

// ─── ★v0.9.44: プロンプトの構造化(1行詰め込みを解除し、無条件の不等式を最上位に置く) ───
//   実データで「売りプランの指値/逆指値が買い側の幾何で出て両レッグ落ち→見送り(none)」が多発したため、
//   ①不等式を最初に単独行で置く ②stopEntry(ブレイク新規)と stopLoss*(損切り)の語を分離する
//   ③売りのブレイク新規はサポート側だと明示する ④節目基準はその後 ⑤出力前の自己検算 ⑥レンジは2択(組)、を固定する。

describe('scalp プロンプト 向きの構造化(v0.9.44)', () => {
  const targets = () => [buildScalpSystemPrompt(), buildScalpQuestion()];

  it('無条件の不等式が売り/買いとも単独行で入る', () => {
    for (const t of targets()) {
      expect(t).toContain('売り: stopEntry < refPrice < limitEntry');
      expect(t).toContain('買い: limitEntry < refPrice < stopEntry');
      expect(t).toContain('この不等式を満たさない数値は出力しないこと');
    }
  });

  it('不等式は節目の説明より前に置かれる(節目基準が主語にならない)', () => {
    for (const t of targets()) {
      const ineq = t.indexOf('売り: stopEntry < refPrice < limitEntry');
      const level = t.indexOf('節目への置き方');
      expect(ineq).toBeGreaterThanOrEqual(0);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(ineq).toBeLessThan(level);
    }
  });

  // ★v0.9.70: 損切りは価格でなく **幅** を出す契約になったので、分離される語も lcWidthForStop になる。
  it('「逆指値」の語を分離する(stopEntry=ブレイク新規 / lcWidthForStop=損切りの幅)', () => {
    for (const t of targets()) {
      expect(t).toContain('stopEntry = ブレイク新規');
      expect(t).toContain('lcWidthForStop = 損切りの **幅**');
      expect(t).toContain('rationale');
      // ★損切りの **価格** を出すフィールドは、もうどこにも書かれていない(表現不能の担保)。
      expect(t).not.toContain('stopLossForStop');
      expect(t).not.toContain('stopLossForLimit');
    }
  });

  it('売り/買いのブレイク新規の置き場所を明示する(サポート/レジスタンス)', () => {
    for (const t of targets()) {
      expect(t).toContain('売り(sell)のブレイク新規は サポート(現在値より下) を抜ける価格に置く');
      expect(t).toContain('買い(buy)のブレイク新規は レジスタンス(現在値より上) を抜ける価格に置く');
      expect(t).toContain('売りプランでは絶対に出さない');
      expect(t).toContain('買いプランでは絶対に出さない');
    }
  });

  it('JSON 出力前の自己検算を要求する', () => {
    for (const t of targets()) {
      expect(t).toContain('出力前に limitEntry と stopEntry を refPrice と比較し');
      // ★自己検算は「省く」を言い切らない: 出力直前という最も直近性の高い位置で②の「選び直す」を打ち消さないため。
      expect(t).toContain('省く前に、まず上の『節目を選び直す』を試すこと');
    }
  });

  it('レンジは2択(組を混ぜない)で、幅130円の使い分け基準は維持', () => {
    for (const t of targets()) {
      expect(t).toContain('fade(両側指値)の組');
      expect(t).toContain('breakout(両側ブレイク新規');
      expect(t).toContain('組を混ぜない');
      expect(t).toContain('130円');
      // 混在(片方 limit・片方 stop)は指示しない=プロンプト上は2択。
      expect(t).not.toContain('混在も可');
    }
  });

  it('既存の重要制約は1つも落ちていない(回帰)', () => {
    for (const t of targets()) {
      expect(t).toContain('それぞれ独立');        // LC上限のレッグ独立
      expect(t).toContain('指値のみ');
      expect(t).toContain('ブレイク新規のみ');
      expect(t).toContain('55〜65円');            // LC 幅
      expect(t).toContain('5〜10円');             // 節目の内側オフセット(指値=数量維持)
      expect(t).toContain('すぐ外側');            // ★v0.9.64: 節目の外側オフセットは量を持たない表現へ
      expect(t).not.toContain('0〜5円');
      expect(t).toContain('400円以内');           // 両レッグの幅上限 / レンジ上下幅
      expect(t).toContain('200円以内');           // 片レッグの距離上限
      expect(t).toContain('レンジの距離');
      expect(t).toContain('直近の勢い');          // トレンド判断
      expect(t).toContain('実際に出力したレッグだけ説明');
    }
    // ギャップ知見は system prompt 側・現在値からの最低距離(50円)は question 側の担当(従来どおりの分担)。
    expect(buildScalpSystemPrompt()).toContain('検証済みの知見');
    expect(buildScalpSystemPrompt()).toContain('ギャップ');
    expect(buildScalpQuestion()).toContain('50円以上離す');
  });
});

// ─── ★v0.9.44: 見送り(none)の経路計測(記録専用・挙動不変) ───

describe('pickNoneReason(理由の優先順位・純関数)', () => {
  it('両脚とも理由なしは undefined', () => {
    expect(pickNoneReason(null, null)).toBeUndefined();
  });
  it('片方だけならその理由', () => {
    expect(pickNoneReason('geometry', null)).toBe('geometry');
    expect(pickNoneReason(null, 'lc')).toBe('lc');
  });
  it('異なるときは上流ステージ(trend>bias>lc>geometry>stopSide>missing)を優先', () => {
    expect(pickNoneReason('trend', 'bias')).toBe('trend');
    expect(pickNoneReason('missing', 'geometry')).toBe('geometry');
    expect(pickNoneReason('stopSide', 'lc')).toBe('lc');
  });
});

describe('parseScalpPlan noneReason/noneLegs(記録専用)', () => {
  it('AI 自身の見送り→ noneReason="ai"・noneLegs なし', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '好機なし' }), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.noneReason).toBe('ai');
      expect(r.noneLegs).toBeUndefined();
    }
  });

  it('成立した plan には noneReason を付けない(挙動不変)', () => {
    const r = parseScalpPlan(JSON.stringify(goodPlan), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.noneReason).toBeUndefined();
      expect(r.noneLegs).toBeUndefined();
    }
  });

  it('売りが買い側の幾何(指値<現在値<逆指値)→ noneReason="geometry" と生数値', () => {
    // ★本番で多発した形: 売りなのに 指値<逆指値。両レッグとも entrySideOk で落ちる。
    const bad = {
      direction: 'sell', rationale: '戻り売り', refPrice: 0,
      limitEntry: 38200, stopLossForLimit: 38250,
      stopEntry: 38300, stopLossForStop: 38350,
    };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.noneReason).toBe('geometry');
      expect(r.noneLegs).toEqual({
        dir: 'sell',
        legs: [
          { name: 'limit', entry: 38200, stopLoss: 38250, ok: false },
          { name: 'stop', entry: 38300, stopLoss: 38350, ok: false },
        ],
      });
    }
  });

  // ★v0.9.70: 「損切りが逆側」は表現不能になったので、この入力はもう none にならない
  //   (幅だけを採って正しい向きに置き直す)。noneReason='stopSide' は **発火しないことが正常**。
  it('★旧「損切りの向きが両レッグとも不正」の入力は none にならず、noneReason に stopSide が出ない', () => {
    const bad = {
      direction: 'buy', rationale: '押し目買い', refPrice: 0,
      limitEntry: 38200, stopLossForLimit: 38240,   // 旧形式で上(逆側)= 幅40
      stopEntry: 38350, stopLossForStop: 38400,     // 旧形式で上(逆側)= 幅50
    };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('buy');
      expect(r.noneReason).toBeUndefined();
      expect(r.plan.stopLossForLimit).toBe(38160);
      expect(r.plan.stopLossForStop).toBe(38300);
    }
  });

  it('range で両脚ともAIが出さない→ noneReason="missing"・noneLegs なし', () => {
    const bad = { direction: 'range', rationale: 'レンジ', range: {} };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.noneReason).toBe('missing');
      expect(r.noneLegs).toBeUndefined();
    }
  });

  it('range で上下が逆(upper<現在値<lower)→ noneReason="geometry"・生数値あり', () => {
    const bad = {
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38100, stopLoss: 38150 },
        lower: { side: 'buy', type: 'limit', entry: 38400, stopLoss: 38350 },
      },
    };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.direction).toBe('none');
      expect(r.noneReason).toBe('geometry');
      expect(r.noneLegs).toEqual({
        dir: 'range',
        legs: [
          { name: 'upper', entry: 38100, stopLoss: 38150, ok: false },
          { name: 'lower', entry: 38400, stopLoss: 38350, ok: false },
        ],
      });
    }
  });
});

describe('enforcePlanConstraintsReport noneReason/noneLegs(記録専用)', () => {
  const buyPlan2: AiPlan = {
    direction: 'buy',
    limitEntry: 38200, stopLossForLimit: 38150,
    stopEntry: 38350, stopLossForStop: 38300,
    rationale: '押し目買い', refPrice: REF,
  };
  const sellPlan2: AiPlan = {
    direction: 'sell',
    limitEntry: 38300, stopLossForLimit: 38340,
    stopEntry: 38150, stopLossForStop: 38190,
    rationale: '戻り売り', refPrice: REF,
  };

  it('トレンド veto(強上昇 sell)→ noneReason="trend"', () => {
    const r = enforcePlanConstraintsReport(sellPlan2, { ceilingYen: 65, bias: 'none', trend: { dir: 'up', strong: true } });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('trend');
    expect(r.noneLegs?.dir).toBe('sell');
    expect(r.noneLegs?.legs.map(l => l.entry)).toEqual([38300, 38150]);
  });

  it('LC 上限で両レッグ落ち→ noneReason="lc"', () => {
    const r = enforcePlanConstraintsReport(buyPlan2, { ceilingYen: 10, bias: 'none' });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lc');
    expect(r.noneLegs?.legs.length).toBe(2);
  });

  it('バイアス veto→ noneReason="bias"(レッグ自体は妥当なので ok:true)', () => {
    const r = enforcePlanConstraintsReport(sellPlan2, { ceilingYen: 65, bias: 'long' });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('bias');
    expect(r.noneLegs?.legs.every(l => l.ok)).toBe(true);
  });

  it('損切り向きの二重防御で両レッグ落ち→ noneReason="stopSide"', () => {
    const bad: AiPlan = {
      direction: 'buy',
      limitEntry: 38200, stopLossForLimit: 38240,
      stopEntry: 38350, stopLossForStop: 38390,
      rationale: 'x', refPrice: REF,
    };
    const r = enforcePlanConstraintsReport(bad, { ceilingYen: 65, bias: 'none' });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('stopSide');
  });

  it('range 両脚が LC 上限超→ noneReason="lc"・生数値あり', () => {
    const base: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38600 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 37900 },
      },
    };
    const r = enforcePlanConstraintsReport(base, { ceilingYen: 65, bias: 'none' });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lc');
    expect(r.noneLegs?.dir).toBe('range');
    expect(r.noneLegs?.legs.map(l => l.name)).toEqual(['upper', 'lower']);
  });

  it('range 両脚がバイアス veto(long で両脚 sell)→ noneReason="bias"', () => {
    const base: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
      },
    };
    const r = enforcePlanConstraintsReport(base, { ceilingYen: 65, bias: 'long' });
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('bias');
  });

  it('none 入力/成立 plan には noneReason を付けない(挙動不変)', () => {
    expect(enforcePlanConstraintsReport({ direction: 'none', rationale: 'x', refPrice: REF }, { ceilingYen: 65, bias: 'none' }).noneReason).toBeUndefined();
    expect(enforcePlanConstraintsReport(buyPlan2, { ceilingYen: 65, bias: 'none' }).noneReason).toBeUndefined();
  });
});

describe('enforceRangeEnabled(レンジ無効設定の防御多重化)', () => {
  const rangePlan: AiPlan = {
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    },
  };
  it('rangeEnabled=true は素通し(挙動不変)', () => {
    const r = enforceRangeEnabled(rangePlan, true);
    expect(r.plan).toBe(rangePlan);
    expect(r.noneReason).toBeUndefined();
  });
  it('rangeEnabled=false かつ range → none 化 & noneReason="rangeDisabled"', () => {
    const r = enforceRangeEnabled(rangePlan, false);
    expect(r.plan.direction).toBe('none');
    expect(r.plan.rationale).toBe('レンジ');
    expect(r.noneReason).toBe('rangeDisabled');
    expect(r.noneLegs?.legs.map(l => l.name)).toEqual(['upper', 'lower']);
  });
  it('rangeEnabled=false でも directional は素通し', () => {
    const p: AiPlan = { direction: 'buy', rationale: 'x', refPrice: REF };
    expect(enforceRangeEnabled(p, false).plan).toBe(p);
  });
});

// ─── ★v0.9.44: レンジ規約違反(2択に反する形)の観測(記録専用・弾かない) ───
//   プロンプトでは「両側指値(fade) / 両側逆指値(breakout) の2択・組を混ぜない」と指示するが、
//   コード側の受理は現状のまま(混在も通す)。弾かない方がバグを発見できる、というユーザー判断。
//   AI が指示に反した形を出したら「プロンプトが効いていない証拠」なので、ログ1行で観測できるようにする。

describe('describeRangeAnomaly(レンジ規約違反の観測・純関数)', () => {
  const mk = (
    us: 'buy' | 'sell', ut: 'limit' | 'stop', ls: 'buy' | 'sell', lt: 'limit' | 'stop',
  ): AiPlan => ({
    direction: 'range', rationale: 'レンジ', refPrice: REF,
    range: {
      upper: { side: us, type: ut, entry: 38400, stopLoss: us === 'buy' ? 38350 : 38450 },
      lower: { side: ls, type: lt, entry: 38100, stopLoss: ls === 'buy' ? 38050 : 38150 },
    },
  });

  it('規約どおりの fade(上=売り指値/下=買い指値)は null', () => {
    expect(describeRangeAnomaly(mk('sell', 'limit', 'buy', 'limit'))).toBeNull();
  });
  it('規約どおりの breakout(上=買い逆指値/下=売り逆指値)は null', () => {
    expect(describeRangeAnomaly(mk('buy', 'stop', 'sell', 'stop'))).toBeNull();
  });
  it('混在(片方 limit・片方 stop)→ plan-range-mixed と生数値', () => {
    const a = describeRangeAnomaly(mk('buy', 'stop', 'buy', 'limit'));
    expect(a?.tag).toBe('plan-range-mixed');
    expect(a?.legs).toBe('upper=buy/stop@38400 lower=buy/limit@38100');
  });
  it('両側逆指値だが向きが逆(上=売り/下=買い)→ plan-range-sides', () => {
    const a = describeRangeAnomaly(mk('sell', 'stop', 'buy', 'stop'));
    expect(a?.tag).toBe('plan-range-sides');
    expect(a?.legs).toBe('upper=sell/stop@38400 lower=buy/stop@38100');
  });
  it('両指値だが向きが逆(上=買い/下=売り)→ plan-range-sides', () => {
    expect(describeRangeAnomaly(mk('buy', 'limit', 'sell', 'limit'))?.tag).toBe('plan-range-sides');
  });
  it('片脚だけ/range 以外は判定しない(null)', () => {
    const oneLeg: AiPlan = {
      direction: 'range', rationale: 'x', refPrice: REF,
      range: { lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } },
    };
    expect(describeRangeAnomaly(oneLeg)).toBeNull();
    const directional: AiPlan = { direction: 'buy', rationale: 'x', refPrice: REF };
    expect(describeRangeAnomaly(directional)).toBeNull();
  });
});

// ─── ★v0.9.44: 常時注入される3ビルダーの語彙/規約パリティ ───
//   AI は system prompt・question・戦略仕様(buildStrategySpec)を同時に読む。片方で「stopEntry=ブレイク新規/
//   stopLossFor*=損切り、語を分けて書け」と指示しながら、もう片方で旧来の曖昧な「逆指値」を使っていると
//   どちらの規約に従うかで揺れる。3つとも同じ語彙・同じ順序であることを固定する。

const SPEC_BASE = {
  floor: { mode: 'manual' as const, value: 45 },
  ceiling: { mode: 'manual' as const, value: 65 },
  trendVeto: { mode: 'manual' as const, value: 100 },
  cooldown: { mode: 'manual' as const, value: 90 },
  bias: { mode: 'manual' as const, value: 'none' as const },
  range: { mode: 'manual' as const, value: true },
  hardMax: { enabled: true, value: 150 },
  exitDesc: '【決済ロジック(phase-exit)】…利益ロックのラチェット床…',
};

describe('3ビルダーの語彙/規約パリティ(v0.9.44)', () => {
  const all = () => [buildScalpSystemPrompt(), buildScalpQuestion(), buildStrategySpec(SPEC_BASE)];

  it('無条件の不等式が3つとも同じ表記で入る', () => {
    for (const t of all()) {
      expect(t).toContain('売り: stopEntry < refPrice < limitEntry');
      expect(t).toContain('買い: limitEntry < refPrice < stopEntry');
      expect(t).toContain('この不等式を満たさない数値は出力しないこと');
    }
  });

  // ★規則の全文は system prompt と question の2箇所に置き、strategySpec には重複させない
  //   (spec の役割は「設定値＋委任タグ」。トークン膨張が後半の指示の遵守率を下げるため)。
  //   spec に残すのは不等式だけ=【手動=固定・厳守】タグを持つ最高権威のブロックで規約が競合しないようにする。
  it('用語の分離(stopEntry=ブレイク新規 / lcWidthForStop=損切りの幅)が system/question に入る', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion()]) {
      expect(t).toContain('stopEntry = ブレイク新規');
      expect(t).toContain('lcWidthForStop = 損切りの **幅**');
    }
    // spec は重複させない代わりに、旧来の曖昧な「逆指値」も使わない(語彙の競合が起きない)。
    expect(buildStrategySpec(SPEC_BASE)).not.toContain('stopEntry = ブレイク新規');
  });

  it('ブレイク新規の置き場所(売り=サポート/買い=レジスタンス)が system/question に入る', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion()]) {
      expect(t).toContain('売り(sell)のブレイク新規は サポート(現在値より下) を抜ける価格に置く');
      expect(t).toContain('買い(buy)のブレイク新規は レジスタンス(現在値より上) を抜ける価格に置く');
      expect(t).toContain('売りプランでは絶対に出さない');
      expect(t).toContain('買いプランでは絶対に出さない');
    }
  });

  it('出力前の自己検算が system/question に入る', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion()]) {
      expect(t).toContain('出力前に limitEntry と stopEntry を refPrice と比較し');
    }
  });

  it('buildStrategySpec の既存の定数/委任状態/決済注入は不変(回帰)', () => {
    const s = buildStrategySpec({ ...SPEC_BASE, range: { mode: 'manual', value: false } });
    expect(s).toContain('下限45円');
    expect(s).toContain('上限65円');
    expect(s).toContain('±100円');
    expect(s).toContain('90秒');
    // ★v0.9.64: 緩衝の注記は「+5円」という数値を持たない表現へ(規則は不変)。
    expect(s).toContain('この緩衝は LC幅を作る量ではない');
    expect(s).toContain('50円');
    expect(s).toContain('安全上限 150円');
    expect(s).toContain('ラチェット');
    expect(s).toContain('【手動=固定・厳守】');
    expect(s).toContain('節目への置き方');
    // ★変更B(2026-08-18): range: false(=range 無効)なので、range 専用の距離規則(禁止した機能の規則)は
    //   出ない(旧仕様=無条件に出ていたのが死んだ条項のバグ)。range 有効時に出ることは別テストで固定する。
    expect(s).not.toContain('レンジの距離');
  });
});

describe('「逆指値」が新規(エントリー)の意味で残っていない(v0.9.44)', () => {
  // 許容するのは (a)用語の区別で曖昧語として引用している「逆指値」 (b)決済(exit)の意味の「決済逆指値」のみ。
  // それ以外の裸の「逆指値」は新規の意味なので、ブレイク新規(stopEntry)へ置き換える。
  const ALLOWED = ['「逆指値」', '決済逆指値'];
  const strip = (s: string) => ALLOWED.reduce((acc, w) => acc.split(w).join(''), s);

  const CASES: [string, string][] = [
    ['system(range ON)', buildScalpSystemPrompt()],
    ['system(range OFF)', buildScalpSystemPrompt(45, 65, false)],
    ['system(テクニカルON)', buildScalpSystemPrompt(45, 65, true, 100, true)],
    ['question(range ON)', buildScalpQuestion()],
    ['question(range OFF)', buildScalpQuestion(45, 65, false)],
    ['strategySpec(range ON)', buildStrategySpec(SPEC_BASE)],
    ['strategySpec(range OFF)', buildStrategySpec({ ...SPEC_BASE, range: { mode: 'manual', value: false } })],
    ['jsonInstruction(range ON)', scalpJsonInstruction(38250)],
    ['jsonInstruction(range OFF)', scalpJsonInstruction(38250, 45, 65, false)],
    ['delegationNote(全AI委任)', buildDelegationNote(
      { lcFloor: 'ai', lcCeiling: 'ai', trendVeto: 'ai', cooldown: 'ai', bias: 'ai', range: 'ai' },
      { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 } },
    )],
  ];

  for (const [name, text] of CASES) {
    it(`${name} に新規の意味の「逆指値」が無い`, () => {
      expect(strip(text)).not.toContain('逆指値');
    });
  }
});

// ─── ★v0.9.44: 評価で出た指摘の回帰固定(①②⑥⑦⑧) ───

describe('レビュー指摘の修正(v0.9.44)', () => {
  it('① strategySpec のレンジ両面行が「組」に踏み込まない(禁止した混在形を宣言しない)', () => {
    const s = buildStrategySpec(SPEC_BASE);
    expect(s).toContain('レンジ両面(direction:"range"=現在値の上下に1レッグずつ置く両面ストラドル)');
    // 「指値/ブレイク新規を1本ずつ」は fade と breakout を1つずつ混ぜた形=新ルールが禁止した形。
    expect(s).not.toContain('上下に指値/ブレイク新規を1本ずつ');
    expect(s).not.toContain('上下に指値/逆指値を1本ずつ');
    // 委任タグ・設定値の意味は不変。
    expect(s).toContain('レンジ両面(direction:"range"=現在値の上下に1レッグずつ置く両面ストラドル): 有効【手動=固定・厳守】');
  });

  it('② 節目が不等式に反するときは「省く」の前に「選び直す」(3ビルダーとも)', () => {
    for (const t of [buildScalpSystemPrompt(), buildScalpQuestion(), buildStrategySpec(SPEC_BASE)]) {
      expect(t).toContain('まず不等式を満たす側の節目を選び直すこと');
      expect(t).toContain('選び直しても適切な節目が無いときに限り、そのレッグを省く');
      // 「省く」しか逃げ道が無かった旧文言は残っていない(見送りを増やす向きの指示)。
      expect(t).not.toContain('節目ではなく不等式を優先し、そのレッグを省く');
    }
  });

  it('⑥ direction の enum は1箇所だけで、range 有効/無効と矛盾しない', () => {
    const on = buildScalpSystemPrompt(45, 65, true);
    const off = buildScalpSystemPrompt(45, 65, false);
    expect(on).toContain('- direction は buy / sell / none / range のいずれか。');
    expect(off).toContain('- direction は buy / sell / none のいずれか。');
    expect(off).not.toContain('- direction は buy / sell / none / range のいずれか。');
    // enum を宣言する行は必ず1回だけ(range ON で「none のみ」と「none / range」が並ぶ矛盾を防ぐ)。
    expect(on.split('- direction は buy / sell / none').length - 1).toBe(1);
    expect(off.split('- direction は buy / sell / none').length - 1).toBe(1);
  });

  it('⑦ 最低50円距離が range に掛からないことを明記(question / spec)', () => {
    for (const t of [buildScalpQuestion(), buildStrategySpec(SPEC_BASE)]) {
      expect(t).toContain('50円');
      expect(t).toContain('range の各レッグには適用しない');
    }
  });

  it('⑧ question のレンジ LC 上限に数値が入る(system と揃う)', () => {
    expect(buildScalpQuestion(45, 65)).toContain('各レッグの初期LCも上限(≤65円)内に収めること');
    expect(buildScalpQuestion(50, 120)).toContain('各レッグの初期LCも上限(≤120円)内に収めること');
    expect(buildScalpSystemPrompt(45, 65)).toContain('上限(≤65円)内に収める');
  });
});

// ─── ★③ レンジ規約違反は「AI の生出力(parse 直後)」で観測する ───
//   enforce(トレンド veto / バイアス / LC上限)の後だと片脚が落ちて upper/lower が揃わず null になり、
//   いちばん知りたい母集団(プロンプトが効いていない回)で盲目になる。

describe('③ レンジ規約違反は parse 直後の plan で観測する', () => {
  it('トレンド veto で両脚が落ちる回でも、parse 直後なら混在を観測できる', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 },    // breakout の上脚
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },   // fade の下脚 = 組の混在
      },
    });
    const parsed = parseScalpPlan(raw, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(describeRangeAnomaly(parsed.plan)?.tag).toBe('plan-range-mixed');
    expect(describeRangeAnomaly(parsed.plan)?.legs).toBe('upper=buy/stop@38400 lower=buy/limit@38100');
    // 強下降トレンドの veto で buy 脚が両方落ちる → enforce 後は観測できない(=旧実装が盲目だった経路)。
    const enforced = enforcePlanConstraintsReport(parsed.plan, { ceilingYen: 65, bias: 'none', trend: { dir: 'down', strong: true } });
    expect(enforced.plan.direction).toBe('none');
    expect(describeRangeAnomaly(enforced.plan)).toBeNull();
  });

  it('バイアスで片脚が落ちる回でも、parse 直後なら向き逆を観測できる', () => {
    const raw = JSON.stringify({
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'sell', type: 'stop', entry: 38400, stopLoss: 38450 },   // breakout なのに上が売り
        lower: { side: 'buy', type: 'stop', entry: 38100, stopLoss: 38050 },    // breakout なのに下が買い
      },
    });
    const parsed = parseScalpPlan(raw, REF);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(describeRangeAnomaly(parsed.plan)?.tag).toBe('plan-range-sides');
    const enforced = enforcePlanConstraintsReport(parsed.plan, { ceilingYen: 65, bias: 'long' });
    expect(enforced.plan.range?.upper).toBeUndefined();      // sell 脚が bias で落ちて片面化
    expect(describeRangeAnomaly(enforced.plan)).toBeNull();  // 片脚では判定対象外=観測できない
  });
});

// ─── ★v0.9.44: 「AI に届く文字列」の全生成箇所・全分岐を1箇所に集めた CASES ─────────────
//   前回、①(混在形の宣言)を buildStrategySpec だけ直して buildDelegationNote を取り残した。
//   原因は「用語のテストは全生成箇所を見ていたのに、意味のテストは1ビルダーしか見ていなかった」こと。
//   ここで CASES を1つに統一し、用語ルールも意味ルールも同じ母集団に掛けることで取り残しを自動検出する。
//   ★新しいプロンプト生成箇所を足したら、必ずこの CASES にも足すこと。

const SPEC_ARGS = (rangeOn: boolean, mode: 'manual' | 'ai' = 'manual') => ({
  floor: { mode, value: 45 }, ceiling: { mode, value: 65 },
  trendVeto: { mode, value: 100 }, cooldown: { mode, value: 90 },
  bias: { mode, value: 'none' as const }, range: { mode, value: rangeOn },
  hardMax: { enabled: true, value: 150 },
  exitDesc: '【決済ロジック(phase-exit)】…利益ロックのラチェット床…',
});
const ALL_AI: KnobModes = { lcFloor: 'ai', lcCeiling: 'ai', trendVeto: 'ai', cooldown: 'ai', bias: 'ai', range: 'ai' };
const DELEG_CTX = { floorYen: 45, ceilingYen: 65, hardMax: { enabled: true, value: 150 } };
const one = (k: keyof KnobModes): KnobModes =>
  ({ lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'manual', cooldown: 'manual', bias: 'manual', range: 'manual', [k]: 'ai' });
const regimeOf = (over: Partial<Regime>): Regime => ({
  ret10: 0, ret30: 0, ma20Slope: 0, swingHigh: 38100, swingLow: 38000, posPct: 50,
  dir: 'flat', strong: false, trendDir: 'flat', longDir: 'flat', trendStrong: false, ret10StaleMin: null, ...over,
});

/** ★v0.9.61: バンドウォーク成立中のサンプル(注記の生成に使う)。 */
const BANDWALK_UP: Bandwalk = {
  direction: 'up', ratio: 0.83, bars: 12, sinceT: 1_800_000_000_000, t: 1_800_003_300_000,
  close: 38300, band: 38250, rsi: 62.5,
};

/** AI に届く文字列の生成箇所(全分岐)。[名前, 文字列] */
const PROMPT_CASES: [string, string][] = [
  // ① system prompt 本体(rangeLine / techLine / trendGuidance を内包)
  ['systemPrompt(range ON)', buildScalpSystemPrompt()],
  ['systemPrompt(range OFF)', buildScalpSystemPrompt(45, 65, false)],
  ['systemPrompt(テクニカルON)', buildScalpSystemPrompt(45, 65, true, 100, true)],
  ['systemPrompt(trendVeto=0)', buildScalpSystemPrompt(45, 65, true, 0)],
  // ② 固定質問(rangeNote / trendGuidance を内包)
  ['question(range ON)', buildScalpQuestion()],
  ['question(range OFF)', buildScalpQuestion(45, 65, false)],
  ['question(trendVeto=0)', buildScalpQuestion(45, 65, true, 0)],
  // ③ 戦略ロジック仕様(knobTag / exitDesc を内包)
  ['strategySpec(range ON)', buildStrategySpec(SPEC_ARGS(true))],
  ['strategySpec(range OFF)', buildStrategySpec(SPEC_ARGS(false))],
  ['strategySpec(全AI委任)', buildStrategySpec(SPEC_ARGS(true, 'ai'))],
  // ④ AI委任ノート(6分岐すべて + 全部盛り)
  ['delegationNote(lcFloor)', buildDelegationNote(one('lcFloor'), DELEG_CTX)],
  ['delegationNote(lcCeiling)', buildDelegationNote(one('lcCeiling'), DELEG_CTX)],
  ['delegationNote(trendVeto)', buildDelegationNote(one('trendVeto'), DELEG_CTX)],
  ['delegationNote(cooldown)', buildDelegationNote(one('cooldown'), DELEG_CTX)],
  ['delegationNote(bias)', buildDelegationNote(one('bias'), DELEG_CTX)],
  ['delegationNote(range)', buildDelegationNote(one('range'), DELEG_CTX)],
  ['delegationNote(全AI委任)', buildDelegationNote(ALL_AI, DELEG_CTX)],
  ['delegationNote(hardMax無効)', buildDelegationNote(ALL_AI, { ...DELEG_CTX, hardMax: { enabled: false, value: 150 } })],
  // ⑤ バイアス注記
  ['biasNote(long)', buildBiasNote('long')],
  ['biasNote(short)', buildBiasNote('short')],
  ['biasNote(none)', buildBiasNote('none')],
  // ⑥ ドテン注記 / ⑦ レンジ再評価注記 / ⑧ 画像注記
  ['heldNote(buy)', buildHeldNote({ dir: 'buy', entry: 38200 })],
  ['heldNote(sell)', buildHeldNote({ dir: 'sell', entry: 38200 })],
  ['armedNote', buildArmedNote({ mode: 'range-fade', ageMs: 900_000, avgMs: 600_000 })],
  ['visionNote', buildVisionNote(true)],
  // ⑧' ★v0.9.61: バンドウォーク成立中の緩和注記(距離と節目だけを緩める)
  ['bandwalkNote(up)', buildBandwalkNote(BANDWALK_UP)],
  ['bandwalkNote(down)', buildBandwalkNote({ ...BANDWALK_UP, direction: 'down', band: 38100 })],
  // ⑨ JSON 出力指示
  ['jsonInstruction(range ON)', scalpJsonInstruction(38250)],
  ['jsonInstruction(range OFF)', scalpJsonInstruction(38250, 45, 65, false)],
  // ⑨' ★v0.9.56: LC上限=AI委任 の提示(保存値ではなく実効上限を範囲で提示する分岐)
  ['systemPrompt(LC上限=AI委任)', buildScalpSystemPrompt(55, 159, true, 100, true, { delegated: true, capLabel: '安全上限' })],
  ['question(LC上限=AI委任)', buildScalpQuestion(55, 159, true, 100, { delegated: true, capLabel: '安全上限' })],
  ['jsonInstruction(LC上限=AI委任)', scalpJsonInstruction(38250, 55, 159, true, { delegated: true, capLabel: '安全上限' })],
  // ⑩ 勢い1行(technical に載る・レンジ許可/競合/ギャップの各注記)
  ['momentum(横ばい+range ON)', formatMomentumLine(regimeOf({ trendDir: 'flat' }), true)],
  ['momentum(横ばい+range OFF)', formatMomentumLine(regimeOf({ trendDir: 'flat' }), false)],
  ['momentum(トレンド)', formatMomentumLine(regimeOf({ dir: 'up', trendDir: 'up', trendStrong: true }), true)],
  ['momentum(競合)', formatMomentumLine(regimeOf({ dir: 'up', trendDir: 'conflict', longDir: 'down' }), true)],
  ['momentum(ギャップ)', formatMomentumLine(regimeOf({ trendDir: 'stale', ret10StaleMin: 900 }), true)],
];

describe('全生成箇所: 語彙ルール(「逆指値」が新規の意味で残っていない)', () => {
  // 許容は (a)用語の区別で曖昧語として引用している「逆指値」 (b)決済(exit)の意味の「決済逆指値」のみ。
  const ALLOWED = ['「逆指値」', '決済逆指値'];
  const strip = (s: string) => ALLOWED.reduce((acc, w) => acc.split(w).join(''), s);
  for (const [name, text] of PROMPT_CASES) {
    it(`${name}`, () => { expect(strip(text)).not.toContain('逆指値'); });
  }
});

describe('全生成箇所: 意味ルール(混在形の示唆・狭いレンジの fade 断定・旧表現)', () => {
  // ★①の取り残しの真因対策: 意味レベルのルールも語彙ルールと同じ CASES に掛ける。
  const FORBIDDEN: [string, string][] = [
    ['指値/ブレイク新規を1本ずつ', '混在形(fade と breakout を1つずつ)の示唆'],
    ['指値/逆指値を1本ずつ', '混在形の示唆(旧表現)'],
    ['指値/ブレイク新規を1レッグずつ', '混在形の示唆'],
    ['フェード指値)してよい', '狭いレンジでも fade を断定する記述(130円ルールと矛盾)'],
    ['横ばいのときだけ「レンジ」とみなし逆張り', '狭いレンジでも fade を断定する記述'],
    ['両側逆指値', '旧表現(→ breakout=両側ブレイク新規)'],
    ['ブレイク追随', '旧表現(→ ブレイク新規(stopEntry))'],
    ['混在も可', '組の混在を許可する記述'],
  ];
  for (const [name, text] of PROMPT_CASES) {
    it(`${name}`, () => {
      for (const [phrase, why] of FORBIDDEN) {
        expect(text, `${name} に「${phrase}」(${why})が残っている`).not.toContain(phrase);
      }
    });
  }

  it('fade / breakout に言及する生成箇所は必ず「組」(2択)の枠組みで語る', () => {
    for (const [name, text] of PROMPT_CASES) {
      if (text.includes('fade') || text.includes('breakout')) {
        expect(text, `${name} が fade/breakout に触れているのに「組」の枠組みが無い`).toContain('組');
      }
    }
  });
});

// ─── ★v0.9.56: LC 上限の「提示」を実効値に揃える(保存値のアンカー化を止める) ─────────────
//   実測(同じ相場・同じ節目データで提示だけを変えた 6+3 サンプル):
//     「下限55 / 上限65【AI委任】/ 安全上限159」→ LC幅 60,60,60,60,60,58(6レッグ全部 58〜60・幅が固着)
//     「55〜159 の範囲」               → LC幅 65,75,110,125,80,70,90,100(節目起点でレッグごとに変わる)
//   A系統(上限=AI委任)と B系統(上限=手動65)の実験では、**プロンプトの改善は完全に同一** で、
//   差は「上限の設定値とモード」だけから生じなければならない。ここではそれを機械的に固定する。
describe('v0.9.56: LC上限の提示(委任=実効上限の範囲 / 手動=従来どおり保存値)', () => {
  const HARD = { enabled: true, value: 159 };
  const CEIL_STORED = 65, FLOOR = 55, VETO = 100;
  const specOf = (mode: 'manual' | 'ai', hard = HARD) => buildStrategySpec({
    floor: { mode: 'manual', value: FLOOR }, ceiling: { mode, value: CEIL_STORED },
    trendVeto: { mode: 'manual', value: VETO }, cooldown: { mode: 'manual', value: 90 },
    bias: { mode: 'manual', value: 'none' }, range: { mode: 'manual', value: true },
    hardMax: hard, exitDesc: '【決済】(固定文言)',
  });
  const delegOf = (mode: 'manual' | 'ai', hard = HARD) => buildDelegationNote(
    { lcFloor: 'manual', lcCeiling: mode, trendVeto: 'manual', cooldown: 'manual', bias: 'manual', range: 'manual' },
    { floorYen: FLOOR, ceilingYen: CEIL_STORED, hardMax: hard },
  );
  /** buildScalpPlan と同じ組み立て(市況データは A/B 同一なので除く)。 */
  const compose = (mode: 'manual' | 'ai', hard = HARD): string => {
    const p = resolveLcPresentation({ floorYen: FLOOR, ceilingYen: CEIL_STORED, ceilingMode: mode, lcHardMax: hard });
    return [
      buildScalpSystemPrompt(p.floorYen, p.ceilingYen, true, VETO, true, p.ceil),
      specOf(mode, hard), delegOf(mode, hard),
      buildScalpQuestion(p.floorYen, p.ceilingYen, true, VETO, p.ceil),
      scalpJsonInstruction(38250, p.floorYen, p.ceilingYen, true, p.ceil),
    ].join('\n');
  };

  it('resolveLcPresentation: 手動=保存値そのまま / 委任=実効上限(安全上限 有効=その値・無効=背骨)', () => {
    expect(resolveLcPresentation({ floorYen: 55, ceilingYen: 65, ceilingMode: 'manual', lcHardMax: HARD }))
      .toEqual({ floorYen: 55, ceilingYen: 65, ceil: LC_CEIL_MANUAL });
    expect(resolveLcPresentation({ floorYen: 55, ceilingYen: 65, ceilingMode: 'ai', lcHardMax: HARD }))
      .toEqual({ floorYen: 55, ceilingYen: 159, ceil: { delegated: true, capLabel: '安全上限' } });
    expect(resolveLcPresentation({ floorYen: 55, ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: false, value: 159 } }))
      .toEqual({ floorYen: 55, ceilingYen: LC_YEN_MAX, ceil: { delegated: true, capLabel: 'コード上限' } });
    // mode 省略(既存の直呼び)は手動扱い=従来と一致。
    expect(resolveLcPresentation({ floorYen: 55, ceilingYen: 65 }).ceilingYen).toBe(65);
  });

  it('★委任(A系統): 保存値 65 がプロンプトのどこにも現れない(全文走査)', () => {
    expect(compose('ai')).not.toContain('65');
    expect(compose('ai', { enabled: false, value: 159 })).not.toContain('65');
  });

  it('★委任(A系統): 実効上限が「下限〜上限の範囲」として提示される(8箇所すべて実効値)', () => {
    const a = compose('ai');
    expect(a).toContain('下限55円〜安全上限159円');          // 提示の要(system 本文 / question / 仕様ブロック / 委任ノート)
    expect(a).toContain('上限=あなたが決める');                // 仕様ブロックの LC 行
    expect(a).toContain('LC幅は55〜159円の範囲');             // JSON スキーマ注記
    expect(a).toContain('そのレンジで置く損切り幅の2倍');       // レンジ2択の閾値(保存値の2倍を印字しない)
    expect(countOf(a, '159')).toBeGreaterThan(8);            // 実効上限が全箇所に行き渡っている
  });

  it('★手動(B系統): 上限の提示は従来どおり「下限55 / 上限65」(保存値を印字する)', () => {
    const b = compose('manual');
    expect(b).toContain('上限65円【手動=固定・厳守】');
    expect(b).toContain('初期の損切り(LC)幅は55〜65円に収め');
    expect(b).toContain('LC幅55〜65円');
    expect(b).toContain('上下の反応帯の幅が130円より広ければ');
    expect(b).not.toContain('あなたが決める');                 // 委任の文言は混入しない
  });

  it('★A と B の差は「上限の提示」だけ: ②緩衝・③導出順序は byte 単位で同一・同回数', () => {
    const a = compose('ai'), b = compose('manual');
    expect(countOf(a, LC_BUFFER_NOTE)).toBe(countOf(b, LC_BUFFER_NOTE));
    expect(countOf(a, LC_DERIVATION_ORDER)).toBe(countOf(b, LC_DERIVATION_ORDER));
    expect(countOf(a, LC_BUFFER_NOTE)).toBeGreaterThanOrEqual(3);
    expect(countOf(a, LC_DERIVATION_ORDER)).toBeGreaterThanOrEqual(3);
    // JSON 注記の +5円 表現も A/B 同一。
    expect(countOf(a, '本来のストップ位置から+5円外側')).toBe(countOf(b, '本来のストップ位置から+5円外側'));
  });

  it('★②: +5円 が「下限」ではなく「本来のストップ位置」に加わると読める(旧文言が残っていない)', () => {
    for (const t of [compose('ai'), compose('manual')]) {
      expect(t).not.toContain('ストップ幅に5円加える');
      expect(t).not.toContain('本来のストップ幅に5円を加えた');
      expect(t).not.toContain('損切りは本来のストップ幅に +5円 加える');
      expect(t).not.toContain('ストップ幅+5円');
      // ★v0.9.63: 否定の散文「LC幅の下限に5円を足す/エントリー価格に5円を足し引きする という意味ではない」は、
      //   同じ誤読が **実際に起きた形**(✗①: 買い stopEntry=R1+5 に stopLossForStop=R1)へ置き換えた。
      //   規則は失われていないので、検証も「+5円は緩衝であって幅ではない」を残しつつ、置き換え先の例を固定する。
      // ★v0.9.64: 主語だった数値「+5円」を撤去(参照先を失ったまま、損切りに足し引きする量を
      //   名指しする唯一の数値になっていた)。規則そのもの=「節目からわずかに離すだけ・幅を作る量ではない」を固定する。
      expect(t).toContain('わずかに離すだけ(買いは下へ・売りは上へ)。この緩衝は LC幅を作る量ではない');
      expect(t).toContain('緩衝を、損切りの幅そのものと読んだ形');
      expect(t).not.toContain('節目の緩衝(5円)');
    }
  });

  it('★③: 節目 → ストップ位置 → 幅 の順序が明示され、幅を先に決めるのは誤りと書いてある', () => {
    for (const t of [compose('ai'), compose('manual')]) {
      expect(t).toContain('導出の順序(必ずこの順)');
      expect(t).toContain('先に幅(下限や上限の数値)を決めてから節目に当てはめるのは誤り');
    }
  });

  it('既存の指示(節目の引きつけ・不等式・レッグ独立)は A/B とも維持されている', () => {
    for (const t of [compose('ai'), compose('manual')]) {
      expect(t).toContain('もう一つ先の');            // 一段先の強い節目まで引きつける
      expect(t).toContain('stopEntry < refPrice < limitEntry');
      expect(t).toContain('それぞれ独立');
    }
  });
});

// ★バイアスを AI委任にしたのに、戦略仕様ブロックが保存値(買い中心/売り中心)を印字していた。
//   同じ本文の委任ノートは「売買方向: あなたが自由に決めてよい」と言うので、正面から矛盾していた
//   (最大初期LC で先に直した resolveLcPresentation と同じ形の不具合)。委任時は保存値を印字しない。
describe('★バイアスの委任(保存値を印字しない)', () => {
  const specWithBias = (mode: 'manual' | 'ai', value: 'long' | 'short' | 'none'): string =>
    buildStrategySpec({
      floor: { mode: 'manual', value: 55 }, ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 }, cooldown: { mode: 'manual', value: 90 },
      bias: { mode, value }, range: { mode: 'manual', value: false },
      hardMax: { enabled: true, value: 159 }, exitDesc: '【決済】(固定文言)',
    });
  const biasLine = (s: string): string => s.split('\n').find(l => l.startsWith('- バイアス:'))!;

  it('手動: 保存値をそのまま印字する(従来どおり)', () => {
    expect(biasLine(specWithBias('manual', 'long'))).toBe('- バイアス: 買い中心(売り新規は見送り)【手動=固定・厳守】');
    expect(biasLine(specWithBias('manual', 'short'))).toBe('- バイアス: 売り中心(買い新規は見送り)【手動=固定・厳守】');
    expect(biasLine(specWithBias('manual', 'none'))).toBe('- バイアス: 両方向【手動=固定・厳守】');
  });

  it('★委任: 保存値(買い中心/売り中心)を印字せず「あなたが決める」だけを出す', () => {
    for (const v of ['long', 'short', 'none'] as const) {
      const spec = specWithBias('ai', v);
      expect(biasLine(spec)).toBe('- バイアス: あなたが決める(買い/売り/両方向のどれでもよい)【AI委任=あなたが決めてよい】');
      // 仕様ブロック全体を走査しても、保存値に由来する語が残っていないこと。
      expect(spec).not.toContain('買い中心');
      expect(spec).not.toContain('売り中心');
    }
  });
});

// ─── v0.9.63: 「だめな例」ブロック(規則の散文 → 実際に起きた失敗の形) ─────────────
// ★このブロックの存在意義は「例が新しいアンカーにならないこと」なので、そこを回帰で固定する。
//   過去2回、目立つ数値(上限65 / 下限)がそのまま LC 幅として選ばれる固着が起きている。
describe('PLAN_BAD_EXAMPLES(実出力に在った誤りの例示・アンカー対策)', () => {
  it('★アンカー対策: 例の本文に LC の下限/上限の設定値が1つも現れない(印字回数を増やさない)', () => {
    // 実運用値(55/65/159)・テストで使う別値(45/50/120)のいずれも例の中には出さない。
    for (const v of ['45', '50', '55', '65', '75', '95', '120', '159']) {
      expect(PLAN_BAD_EXAMPLES).not.toContain(v);
    }
  });

  it('★アンカー対策: 例の本文に実価格(4桁以上の数値)が1つも現れない=記号(P/R1/R2/S1/S2)で書く', () => {
    expect(PLAN_BAD_EXAMPLES).not.toMatch(/\d{3,}/);
    expect(PLAN_BAD_EXAMPLES).toContain('P=現在値');
    expect(PLAN_BAD_EXAMPLES).toContain('R1');
    expect(PLAN_BAD_EXAMPLES).toContain('S2');
  });

  it('★アンカー対策: 「下限ちょうどは禁止」とは書かない(『下限+一定』という別の固着を作らないため)', () => {
    expect(PLAN_BAD_EXAMPLES).toContain('たまたま下限ちょうどの場面はある');
    expect(PLAN_BAD_EXAMPLES).toContain('誤りは毎回そうなること');
  });

  it('検証ラベルは実装(LegDrop.reason)の語彙をそのまま使う', () => {
    // 台帳(leg_drops)と画面注記に出る語と、プロンプトの語を1本にする。
    expect(PLAN_BAD_EXAMPLES).toContain('[lcFloor=損切り幅が設定の下限より狭い]');
    // ★v0.9.70: [stopSide] の例(逆位置)は **表現不能になった** ので例から外した。
    //   画面/台帳の語彙そのものは残す(発火したらコードのバグ=その時に語が要る)。
    expect(PLAN_BAD_EXAMPLES).not.toContain('stopSide');
    // 画面注記(buildLegNote)と同じ日本語であること=語彙の一致を実測で固定する。
    const noteFloor = buildLegNote({ hasLimit: false, hasStop: true, drops: [{ name: 'limit', reason: 'lcFloor' }] });
    const noteSide = buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason: 'stopSide' }] });
    expect(noteFloor).toContain('損切り幅が設定の下限より狭い');
    expect(noteSide).toContain('損切りがエントリーの逆側');
  });

  it('③④(固着・両レッグ同幅)はコードが落とさないと明示する(免責の逆=自分で防ぐ)', () => {
    expect(PLAN_BAD_EXAMPLES).toContain('どの検証にも掛からない');
    expect(PLAN_BAD_EXAMPLES).toContain('防げるのはあなただけ');
  });

  it('良い例は1つだけ・幅は数値でなく「揃わないこと」で示す', () => {
    expect(PLAN_BAD_EXAMPLES).toContain('2つの幅が揃わないこと');
    expect(PLAN_BAD_EXAMPLES).toContain('2つの幅は違う数値になる');
    expect((PLAN_BAD_EXAMPLES.match(/○/g) ?? []).length).toBe(1);
    // ★v0.9.70: 逆位置(旧✗②)は表現不能になったので削除=7→6。残りは新契約でも起こりうる形だけ。
    expect((PLAN_BAD_EXAMPLES.match(/✗/g) ?? []).length).toBe(6);
  });

  it('注入は質問文(user message)の1箇所だけ=散文の複写を増やさない', () => {
    expect(buildScalpQuestion()).toContain(PLAN_BAD_EXAMPLES);
    expect(buildScalpSystemPrompt()).not.toContain('過去の実出力に在った誤り');
    expect(buildStrategySpec({
      floor: { mode: 'manual', value: 55 },
      ceiling: { mode: 'manual', value: 65 },
      trendVeto: { mode: 'manual', value: 100 },
      cooldown: { mode: 'manual', value: 90 },
      bias: { mode: 'manual', value: 'none' },
      range: { mode: 'manual', value: true },
      hardMax: { enabled: true, value: 159 },
      exitDesc: '【決済ロジック】…',
    })).not.toContain('過去の実出力に在った誤り');
  });

  it('★自己検算の直前に置かれる(検算の各項目が「見たことのある形」と結びつく)', () => {
    const q = buildScalpQuestion();
    expect(q.indexOf(PLAN_BAD_EXAMPLES)).toBeLessThan(q.indexOf('出力前に limitEntry と stopEntry を refPrice と比較し'));
  });
});

// ─── ★v0.9.70: 「損切りがエントリーの逆側」が **表現不能** であることの網羅的な固定 ──────────────
//
//  ★背景(実データ 2026-08-04〜10・signal_plans.leg_drops_json): stopSide で落ちたレッグ171件が
//    171件ともブレイク新規レッグ(指値レッグは0件)。プロンプトを6版強めても、名指しした側だけが直り
//    名指ししなかった側へ移った。よって規則の遵守を求めるのをやめ、**符号を LLM から取り上げた**。
//
//  ★この describe が固定するのは2つ:
//    ① どんな入力を食わせても、最終プランに残るレッグの損切りは必ず正しい向きにある。
//    ② それゆえ stopSide は **1件も記録されない**。もし記録されたらそれはコードのバグ
//       (検証は残してある=消すと将来の回帰が無言で通る)。
describe('★逆位置は表現不能(stopSide は構造上発火しない)', () => {
  /** その plan の全レッグの損切りが正しい向きにあるか。 */
  const everyStopOnCorrectSide = (p: AiPlan): boolean => {
    if (p.direction === 'buy' || p.direction === 'sell') {
      if (p.limitEntry != null && p.stopLossForLimit != null && !stopSideOk(p.direction, p.limitEntry, p.stopLossForLimit)) return false;
      if (p.stopEntry != null && p.stopLossForStop != null && !stopSideOk(p.direction, p.stopEntry, p.stopLossForStop)) return false;
    }
    for (const leg of [p.range?.upper, p.range?.lower]) {
      if (leg && !stopSideOk(leg.side, leg.entry, leg.stopLoss)) return false;
    }
    return true;
  };

  it('directional: 旧形式の逆側価格 × 負の幅 × 0 × 非数 の総当たりで、逆位置も stopSide も1件も出ない', () => {
    const cases: unknown[] = [];
    for (const direction of ['buy', 'sell'] as const) {
      // エントリーは refPrice の正しい側/逆側の両方を試す(geometry と混ざっても逆位置は出ないこと)。
      for (const limitEntry of [REF - 50, REF + 50]) {
        for (const stopEntry of [REF + 50, REF - 50]) {
          // 旧形式(価格): 正しい側/逆側/同値、および新契約(幅): 正/負/0/非数値。
          for (const slOff of [-55, 55, 0]) {
            cases.push({
              direction, rationale: 'legacy', refPrice: 1,
              limitEntry, stopLossForLimit: limitEntry + slOff,
              stopEntry, stopLossForStop: stopEntry + slOff,
            });
          }
          // ★桁落ちの穴(1e-12 / 1e20)も必ず含める。幅55 だけの格子では
          //   「entry ∓ 幅 === entry」になる組み合わせを1つも踏めず、stopSide の発火を見逃す。
          for (const w of [55, -55, 0, 1e-12, 'x', null, Number.NaN, Number.POSITIVE_INFINITY]) {
            cases.push({
              direction, rationale: 'width', refPrice: 1,
              limitEntry, lcWidthForLimit: w,
              stopEntry, lcWidthForStop: w,
            });
          }
        }
      }
    }
    expect(cases.length).toBeGreaterThan(50);
    let planned = 0;
    for (const c of cases) {
      const r = parseScalpPlan(JSON.stringify(c), REF);
      // 使える幅が1本も無い応答は従来どおり ok:false(対の不整合 / レッグ皆無)。逆位置とは無関係。
      if (!r.ok) { expect(r.error).not.toContain('stopSide'); continue; }
      planned++;
      expect(everyStopOnCorrectSide(r.plan), `逆位置が出た: ${JSON.stringify(c)}`).toBe(true);
      expect(r.legDrops?.some(d => d.reason === 'stopSide'), `stopSide が発火した(=コードのバグ): ${JSON.stringify(c)}`).toBeFalsy();
      expect(r.noneReason).not.toBe('stopSide');
    }
    // 24 = 8(方向×エントリー位置の組) × 3(旧形式の逆側/正側 + 新契約の正の幅)。
    // 残りは「両レッグとも使える幅が無い」= ok:false で、プランになる前に弾かれる。
    expect(planned).toBe(24);
  });

  // ★v0.9.70: 「構造上発火しない」を **桁落ちまで含めて** 事実にする。
  //   幅が正でも `entry ∓ 幅 === entry` になる組み合わせは実在し(幅 1e-12 / エントリー 1e20)、
  //   そのまま通すと stopSide が発火して、台帳を読んだ人が存在しない符号バグを追うことになる。
  it('★桁落ち(1e-12 / 1e20)でも stopSide は出ない — 幅として無効にして落とす', () => {
    const cases: Array<{ raw: unknown; label: string }> = [
      { label: '極小の幅', raw: { direction: 'buy', rationale: 'x', refPrice: 1, limitEntry: 38200, lcWidthForLimit: 1e-12 } },
      { label: '巨大なエントリー', raw: { direction: 'buy', rationale: 'x', refPrice: 1, limitEntry: 1e20, lcWidthForLimit: 95 } },
      { label: '極小の幅(売り)', raw: { direction: 'sell', rationale: 'x', refPrice: 1, limitEntry: 38300, lcWidthForLimit: 1e-12 } },
      { label: '旧形式の極小差', raw: { direction: 'buy', rationale: 'x', refPrice: 1, limitEntry: 1e20, stopLossForLimit: 1e20 - 95 } },
    ];
    for (const c of cases) {
      const r = parseScalpPlan(JSON.stringify(c.raw), REF);
      if (r.ok) {
        expect(everyStopOnCorrectSide(r.plan), c.label).toBe(true);
        expect(r.legDrops?.some(d => d.reason === 'stopSide'), c.label).toBeFalsy();
        expect(r.noneReason, c.label).not.toBe('stopSide');
      } else {
        expect(r.error, c.label).not.toContain('stopSide');
      }
    }
  });

  it('★1e-12 の幅は geometry(値が不正)で落ち、書いた値が台帳に残る', () => {
    const r = parseScalpPlan(JSON.stringify({
      direction: 'buy', rationale: 'x', refPrice: 1,
      limitEntry: 38200, lcWidthForLimit: 1e-12,
      stopEntry: 38350, lcWidthForStop: 55,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.legDrops).toEqual([{ name: 'limit', reason: 'geometry', entry: 38200, lcWidth: 1e-12 }]);
  });

  it('range: 脚の side と逆向きの価格/負の幅を食わせても、逆位置も stopSide も出ない', () => {
    const legs = (side: 'buy' | 'sell', entry: number) => ([
      { side, type: 'limit', entry, stopLoss: entry + 55 },
      { side, type: 'limit', entry, stopLoss: entry - 55 },
      { side, type: 'stop', entry, lcWidth: 55 },
      { side, type: 'stop', entry, lcWidth: -55 },
      { side, type: 'stop', entry, lcWidth: 0 },
    ]);
    let planned = 0;
    for (const upper of legs('sell', REF + 100)) {
      for (const lower of legs('buy', REF - 100)) {
        const r = parseScalpPlan(JSON.stringify({ direction: 'range', rationale: 'r', refPrice: 1, range: { upper, lower } }), REF);
        expect(r.ok).toBe(true);
        if (!r.ok) continue;
        planned++;
        expect(everyStopOnCorrectSide(r.plan)).toBe(true);
        expect(r.legDrops?.some(d => d.reason === 'stopSide')).toBeFalsy();
        expect(r.noneReason).not.toBe('stopSide');
      }
    }
    expect(planned).toBe(25);
  });

  it('★stopSideOk 自体は残す(消さない): 逆位置を渡せば今も false を返す=発火したらバグだと分かる', () => {
    expect(stopSideOk('buy', 100, 110)).toBe(false);
    expect(stopSideOk('sell', 100, 90)).toBe(false);
  });
});

// ─── ★v0.9.84: 戦略ラベル(記録専用) ─────────────────────────────────────────
//   目的は ④AI が理由と共に提示 →⑤結果を記録 →⑥AI に返す のループで
//   「何を狙って外したのか」を集計できるようにすること。ここで固定するのは3点:
//     (a) 欠落・不正・未知のラベルでも **計画が落ちない**(記録専用の実証)
//     (b) v1 と v1e の **両方** の user プロンプトに入っている(片腕だけに入れない)
//     (c) 提示の仕方が固着対策(番号を振らない・順番に意味を持たせない・例示は「その他」だけ)
describe('v0.9.84: 戦略ラベル(strategy / strategyWhy)= 記録専用', () => {
  const base = {
    direction: 'buy', limitEntry: 38200, stopEntry: 38350,
    lcWidthForLimit: 55, lcWidthForStop: 55,
    rationale: '押し目。指値レッグ: 38200-38145=55円。ブレイク新規レッグ: 38350-38295=55円。', refPrice: REF,
  };
  /** 採否・価格・脚落ちの観測点をまとめて1つの形にする(比較の母集団を揃えるため)。 */
  const shapeOf = (r: ReturnType<typeof parseScalpPlan>) => {
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    const { strategy, strategyWhy, ...rest } = r.plan;
    return { plan: rest, noneReason: r.noneReason, legDrops: r.legDrops };
  };

  it('正常: ラベルと理由がそのまま plan に載る', () => {
    const r = parseScalpPlan(JSON.stringify({ ...base, strategy: 'トレンド押し目・戻り', strategyWhy: '上昇トレンド中、S1まで引きつけて反発を取る' }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.strategy).toBe('トレンド押し目・戻り');
    expect(r.plan.strategyWhy).toBe('上昇トレンド中、S1まで引きつけて反発を取る');
    expect(isKnownScalpStrategy(r.plan.strategy)).toBe(true);
  });

  it('★未知のラベルは「その他」に丸めず 生値のまま残す(リストが現実と合っていない証拠を消さない)', () => {
    const r = parseScalpPlan(JSON.stringify({ ...base, strategy: '寄り天の売り' }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.strategy).toBe('寄り天の売り');
    expect(r.plan.strategy).not.toBe(SCALP_STRATEGY_OTHER);
    // 「未知だった」ことは 値 × ラベル一覧 でいつでも数え直せる(台帳に判定は書かない)。
    expect(isKnownScalpStrategy(r.plan.strategy)).toBe(false);
  });

  it('★欠落・不正・空文字でも計画は落ちない(undefined にして先へ進む=regime/confidence と同じ形)', () => {
    const cases: unknown[] = [undefined, null, 123, {}, [], '', '   '];
    for (const v of cases) {
      const r = parseScalpPlan(JSON.stringify({ ...base, strategy: v, strategyWhy: v }), REF);
      expect(r.ok, `strategy=${JSON.stringify(v)} で計画が落ちた`).toBe(true);
      if (!r.ok) continue;
      expect(r.plan.strategy).toBeUndefined();
      expect(r.plan.strategyWhy).toBeUndefined();
      // ★採否・価格・脚落ちは1バイトも変わらない。
      expect(r.plan.direction).toBe('buy');
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
    }
  });

  it('★記録専用の実証: ラベルの有無/未知/不正で 採否・価格・脚落ち・noneReason が完全に一致する', () => {
    const withoutLabel = shapeOf(parseScalpPlan(JSON.stringify(base), REF));
    for (const v of ['トレンド押し目・戻り', 'その他', '寄り天の売り', '', 42, null]) {
      const withLabel = shapeOf(parseScalpPlan(JSON.stringify({ ...base, strategy: v, strategyWhy: v }), REF));
      expect(withLabel, `strategy=${JSON.stringify(v)} で採否/価格が動いた`).toEqual(withoutLabel);
    }
  });

  it('見送り(none)・レンジでもラベルは載る(全 plan 形で記録できる)', () => {
    const none = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '見送り', refPrice: REF, strategy: 'その他', strategyWhy: '節目まで遠い' }), REF);
    expect(none.ok && none.plan.strategy).toBe('その他');
    expect(none.ok && none.noneReason).toBe('ai');
    const range = parseScalpPlan(JSON.stringify({
      direction: 'range', rationale: 'レンジ', refPrice: REF, strategy: 'レンジ内', strategyWhy: '横這い',
      range: { upper: { side: 'sell', type: 'limit', entry: REF + 100, lcWidth: 55 }, lower: { side: 'buy', type: 'limit', entry: REF - 100, lcWidth: 55 } },
    }), REF);
    expect(range.ok && range.plan.strategy).toBe('レンジ内');
  });

  it('parseAiStrategy / parseAiStrategyWhy は寛容(trim する・空は undefined)', () => {
    expect(parseAiStrategy('  ドテン  ')).toBe('ドテン');
    expect(parseAiStrategy(undefined)).toBeUndefined();
    expect(parseAiStrategy(0)).toBeUndefined();
    expect(parseAiStrategyWhy(' 反転を狙う ')).toBe('反転を狙う');
    expect(parseAiStrategyWhy(null)).toBeUndefined();
  });

  // ─── (b) v1 と v1e の両方に入っていること ───
  //   buildScalpPlan の非 v2 分岐と同じ組み立て(質問文 + JSON 出力指示)を再現する。
  //   v1e は buildScalpQuestion(omitMaxDistance=true) だけが違い、JSON 出力指示は共通の土台。
  const userPromptFor = (variant: 'v1' | 'v1d' | 'v1e'): string =>
    buildScalpQuestion(55, 65, true, 100, LC_CEIL_MANUAL, variant === 'v1d', variant === 'v1e')
    + '\n\n' + scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);

  for (const variant of ['v1', 'v1d', 'v1e'] as const) {
    it(`★${variant} の user プロンプトに strategy 契約と全ラベルが入る(片腕だけに入れない)`, () => {
      const p = userPromptFor(variant);
      expect(p).toContain('"strategy"');
      expect(p).toContain('"strategyWhy"');
      expect(p).toContain('【この計画の読み(strategy / strategyWhy)】');
      for (const label of SCALP_STRATEGY_LABELS) expect(p, `${variant} に「${label}」が無い`).toContain(label);
    });
  }

  it('★v1 と v1e で strategy 契約部分は完全に同一(距離の上限の A/B を汚さない)', () => {
    expect(scalpStrategyContract()).toBe(scalpStrategyContract());
    const contract = scalpStrategyContract();
    expect(userPromptFor('v1')).toContain(contract);
    expect(userPromptFor('v1e')).toContain(contract);
  });

  // ─── (c) 固着対策: 提示の仕方 ───
  it('★ラベルに番号を振らない/順番に意味を持たせない/例示は「その他」だけ', () => {
    const c = scalpStrategyContract();
    // 番号(丸数字・①②…/ 1. 2. …)をラベル行に付けない=番号もアンカーになる。
    for (const n of ['①', '②', '③', '④', '⑤', '⑥', '⑦']) expect(c).not.toContain(n);
    expect(c).not.toMatch(/^\s*\d[.)]\s/m);
    // 順序を意味づける語を使わない。
    for (const w of ['まず', '優先順', '順に']) expect(c).not.toContain(w);
    // 例示に使ってよいのは偏りを生まない「その他」だけ(他のラベルは一覧の1回のみ)。
    for (const label of SCALP_STRATEGY_LABELS) {
      if (label === SCALP_STRATEGY_OTHER) continue;
      expect(countOf(c, label), `「${label}」が一覧以外にも書かれている(例示に使うとそこへ固着する)`).toBe(1);
    }
    // 「その他」を選んだときは狙いを書かせる。
    expect(c).toContain('strategyWhy に **何を狙ったのか** を必ず書くこと');
    // ラベルは「脚の機械的な種類」ではなく相場の読みだと明記する。
    expect(c).toContain('脚の機械的な種類から strategy を決めることはできない');
  });

  it('★ラベル①の語釈と同じ語を、毎回必ず現れる脚の説明に使わない(語の共有=アンカー)', () => {
    const c = scalpStrategyContract();
    // 「引きつけて入る」はラベル「トレンド押し目・戻り」の語釈にだけ現れる語。
    // 脚の説明(毎回必ず現れる)に同じ語を使うと、そのラベルへ寄る。
    expect(countOf(c, '引きつけて入る')).toBe(1);
    expect(c).toContain('「指値の脚(limitEntry)」と「ブレイク新規の脚(stopEntry)」');
  });

  it('★「常に2本で組まれる」とは書かない(片レッグを許す既存の規則と矛盾させない)', () => {
    const c = scalpStrategyContract();
    expect(c).not.toContain('常に');
    expect(c).not.toContain('2本で組まれる');
    expect(c).toContain('2本で組みうる');
    // 同じプロンプトの本文(system prompt)は片方だけを明示的に許している
    // = 契約文がそれと矛盾していないことを一緒に固定する(★以前は「常に2本」と書いて矛盾していた)。
    expect(SCALP_SYSTEM_PROMPT).toContain('片方だけ(指値のみ/ブレイク新規のみ)でもよい');
  });

  it('★契約文は user プロンプトの最末尾に置かない(最強の recency 位置を記録専用が占めない)', () => {
    const j = scalpJsonInstruction(38250, 55, 65, true, LC_CEIL_MANUAL);
    // 従来どおり最後の1文は refPrice の指示のまま。
    expect(j.trimEnd().endsWith('refPrice は 38250 を使うこと。数値はすべて円単位の実数(引用符なし)。')).toBe(true);
    // 契約文はその手前にある。
    expect(j.indexOf('【この計画の読み')).toBeLessThan(j.indexOf('refPrice は 38250 を使うこと'));
  });

  it('★量を印字しない(LC 幅・距離のアンカーを増やさない)', () => {
    const c = scalpStrategyContract();
    // 2桁以上の数(55/65/50/200/400 など、これまで実測で固着を起こしてきた種類の数)を1つも持ち込まない。
    expect(c).not.toMatch(/[0-9０-９]{2,}/);
    // 残ってよい1桁は「1つだけ/1行/2本」= 個数の語だけ。円/pt などの単位が付いた量は書かない。
    expect(c).not.toMatch(/[0-9０-９]\s*(円|pt|ティック|%)/);
  });
});

// ─── ★v0.9.87: 「なぜこの価格なのか」= どの節目に基づいて置いたか(limitLevel / stopLevel) ───
//
// ■ なぜ数値のフィールドなのか(★文章にしない理由が本体)
//   根拠文(rationale)は実測で LC検算に埋め尽くされる(根拠文76字のうち検算76字・理由0字)。
//   文章の枠を増やしても既存の指示に押し出されるので、**数値のフィールド** で受け取る。
//   数値は他の指示と枠を奪い合わない。内側/外側と距離は画面側が計算する(AI には書かせない)。
// ■ プロンプトの追加は最小限(★規則を増やさない)
//   節目への置き方は既に決まっているので、新しい規則ではなく「**使った節目の価格を書け**」だけを求める。
describe('v0.9.87: 価格の根拠にした節目(limitLevel / stopLevel)= 記録+表示', () => {
  const base = {
    direction: 'buy', limitEntry: 38200, stopEntry: 38350,
    lcWidthForLimit: 55, lcWidthForStop: 55,
    rationale: '押し目。指値レッグ: 38200-38145=55円。ブレイク新規レッグ: 38350-38295=55円。', refPrice: REF,
  };

  it('JSON 契約に2つの数値フィールドが在る(名前と役割だけ)', () => {
    const j = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    expect(j).toContain('"limitLevel": number');
    expect(j).toContain('"stopLevel": number');
    // 「使った節目の価格を書け」だけ=置き方の規則を **もう一度** 書かない。
    expect(j).toContain('指値を置くときに使った節目の価格');
    expect(j).toContain('ブレイク新規を置くときに使った節目の価格');
  });

  it('★新しい規則を足していない(内側/外側・距離の数値をここで印字しない)', () => {
    const j = scalpJsonInstruction(REF, 55, 65, true, LC_CEIL_MANUAL);
    // 節目フィールドの2行だけを取り出して、そこに規則(内側/外側/円)が持ち込まれていないことを見る。
    const lines = j.split('\n').filter(l => l.includes('limitLevel') || l.includes('stopLevel'));
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l).not.toContain('内側');
      expect(l).not.toContain('外側');
      expect(l).not.toMatch(/[0-9０-９]\s*円/);
    }
  });

  it('★契約文の嘘を直した(画面にも出ることを書く。注文に使わないのは事実なので残す)', () => {
    const c = scalpStrategyContract();
    expect(c).toContain('画面に表示され');
    expect(c).toContain('注文の採否・価格・損切り幅には使わない');
    // 以前の文言(「返すための記録である」で終わり=表示に触れない)は残っていない。
    expect(c).not.toContain('返すための記録である。');
  });

  it('正常: 申告された節目がそのまま plan に載る', () => {
    const r = parseScalpPlan(JSON.stringify({ ...base, limitLevel: 38175, stopLevel: 38345 }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitLevel).toBe(38175);
    expect(r.plan.stopLevel).toBe(38345);
  });

  it('★欠落・不正・非数値でも計画は落ちない(strategy と同じ後方互換)', () => {
    const cases: unknown[] = [undefined, null, 'S1', '38175', {}, [], NaN, Infinity, 0, -5];
    for (const v of cases) {
      const r = parseScalpPlan(JSON.stringify({ ...base, limitLevel: v, stopLevel: v }), REF);
      expect(r.ok, `limitLevel=${JSON.stringify(v)} で計画が落ちた`).toBe(true);
      if (!r.ok) continue;
      expect(r.plan.limitLevel).toBeUndefined();
      expect('limitLevel' in r.plan).toBe(false);
      // ★採否・価格・脚は1バイトも動かない。
      expect(r.plan.limitEntry).toBe(38200);
      expect(r.plan.stopEntry).toBe(38350);
      expect(r.plan.stopLossForLimit).toBe(38145);
      expect(r.plan.stopLossForStop).toBe(38295);
    }
  });

  it('parseAiLevelPrice 単体: 有限で正の数だけを通し、丸めない', () => {
    expect(parseAiLevelPrice(38175)).toBe(38175);
    expect(parseAiLevelPrice(38175.5)).toBe(38175.5);   // 丸めない(節目でない値を書いた証拠を消さない)
    expect(parseAiLevelPrice('38175')).toBeUndefined();
    expect(parseAiLevelPrice(NaN)).toBeUndefined();
    expect(parseAiLevelPrice(Infinity)).toBeUndefined();
    expect(parseAiLevelPrice(0)).toBeUndefined();
    expect(parseAiLevelPrice(-1)).toBeUndefined();
    expect(parseAiLevelPrice(undefined)).toBeUndefined();
  });

  it('★否定対照: 申告が無い応答の plan は従来と byte 一致(フィールドが生えない)', () => {
    const bare = parseScalpPlan(JSON.stringify(base), REF);
    const withL = parseScalpPlan(JSON.stringify({ ...base, limitLevel: 38175, stopLevel: 38345 }), REF);
    expect(bare.ok && withL.ok).toBe(true);
    if (!bare.ok || !withL.ok) return;
    expect(JSON.stringify(bare.plan).includes('Level')).toBe(false);
    const { limitLevel, stopLevel, ...rest } = withL.plan;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(bare.plan));
  });
});
