// ★片レッグだけ落ちたときの理由(legDrops)の検証 — 記録専用・採否は1ミリも変えない。
//
// ■ 何を守っているか(なぜ要るか)
//   従来、レッグの脱落理由が構造的に残るのは **両レッグとも落ちて見送り(none)になった回** だけだった
//   (parseScalpPlan の `if (!limitLegOk && !stopLegOk)` / enforce の両脚落ち)。
//   片レッグだけ落ちた回は buildLegNote が根拠文に「（逆指値レッグは条件を満たさず不採用）」と
//   **日本語の文字列で** 書くだけで、台帳では
//       「AI が逆指値レッグを提案しなかった」 ←→ 「向き違反で落とされた」
//   がどちらも stopEntry:null に潰れて区別できなかった。実際にこれで誤った測定が起きている
//   (見送り行だけに根拠文が出るため分母が偏り「79%で逆指値が落ちている」という誤った数字が出た。
//    正しくは分析用の台帳で「逆指値が最終プランに無い」率が 5.9%)。
//   これから A系統(初期LC上限=AI委任)/B系統(65手動)の実験を回すので、
//   「向き違反が減ったか」「逆指値の採用率が上がったか」を測れる記録が要る。
//
// ■ ★否定対照(この修正前のコードでの結果)
//   git show HEAD:server/llm/scalpPlan.ts > <tmp>.ts で旧版に差し替えると、
//   旧版には legDrops フィールドそのものが無いため
//   「片レッグだけ落ちた」系のテスト(missing / stopSide / geometry / lc)は全て赤になる。
//   一方「両レッグ落ちの noneReason/noneLegs」と「採否(plan の中身)」は旧版でも緑
//   = この変更が **記録だけ** を足していることの対照になっている。
//   (git checkout は使わない=作業ツリーの未コミット差分を壊さないため)

import { describe, it, expect } from 'vitest';
import {
  parseScalpPlan, enforcePlanConstraintsReport, legDropReasonText, type AiPlan, type LegDrop,
} from './scalpPlan.js';

const REF = 38250;

/** 片方向プランの JSON を組む小道具(未指定のレッグは載せない=AI が出さなかった形)。 */
function planJson(o: Record<string, unknown>): string {
  return JSON.stringify({ rationale: 'テスト用の根拠', refPrice: 0, ...o });
}
/** legDrops を name→reason の対で読みやすくする。 */
function drops(v: readonly LegDrop[] | undefined): Array<[string, string]> {
  return (v ?? []).map(d => [d.name, d.reason]);
}

describe('★片レッグだけ落ちた回の理由が構造的に残る(parse 段)', () => {
  it('不在: AI が逆指値レッグを出さなかった → stop=missing(価格は持たない)', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy', limitEntry: 38200, stopLossForLimit: 38150,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ★採否は不変: 指値レッグはそのまま採用され、逆指値は無い。
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBeUndefined();
    // ★記録: 「AI が出さなかった」ことが missing として1件残る。
    expect(drops(r.legDrops)).toEqual([['stop', 'missing']]);
    expect(r.legDrops?.[0]?.entry).toBeUndefined();
  });

  // ★v0.9.70: 「SL向き違反」は表現不能になった(LLM は幅しか出さず、符号はコードが付ける)。
  //   旧形式で逆側の価格が来ても幅だけを採って正しい向きに置き直すので、レッグは落ちない=注記も出ない。
  //   落ちる形は「使える幅が無い(非有限・0以下)」に移り、既存語彙の missing で記録される。
  it('★旧形式で逆側の損切り価格が来ても落ちない(幅だけ採用・stopSide は記録されない)', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy',
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38400,   // 旧形式で上(逆側)= 幅50
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBe(38350);
    expect(r.plan.stopLossForStop).toBe(38300);   // 38350 − 50(コードが下へ置く)
    expect(drops(r.legDrops)).toEqual([]);
    expect(r.plan.rationale).not.toContain('損切りがエントリーの逆側');
  });

  // ★v0.9.70: 「AI が幅を書いたが値が使えない」は **提案せず(missing)ではない**。
  //   'missing' にすると台帳と画面が「AIが提案せず」と虚偽を語り、書いた値も残らず件数も数えられなかった。
  // ★v0.9.95: 「幅の値が不正」は geometry から lcWidthInvalid へ分離(ユーザー指摘「『または』でなく特定して」)。
  it('幅が使えないレッグ(lcWidth<=0)は lcWidthInvalid で記録され、書いた値が残る', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy',
      limitEntry: 38200, lcWidthForLimit: 50,
      stopEntry: 38350, lcWidthForStop: 0,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stopEntry).toBeUndefined();
    expect(drops(r.legDrops)).toEqual([['stop', 'lcWidthInvalid']]);
    expect(r.legDrops?.[0]).toEqual({ name: 'stop', reason: 'lcWidthInvalid', entry: 38350, lcWidth: 0 });
    expect(r.plan.rationale).toContain('（逆指値は不採用: ');
    expect(r.plan.rationale).not.toContain('AIが提案せず');
  });

  it('★負の幅も同じ経路(reason=lcWidthInvalid・AI が書いた −55 が台帳に残る)', () => {
    const r = parseScalpPlan(planJson({
      direction: 'sell',
      limitEntry: 38300, lcWidthForLimit: -55,
      stopEntry: 38150, lcWidthForStop: 55,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legDrops).toEqual([{ name: 'limit', reason: 'lcWidthInvalid', entry: 38300, lcWidth: -55 }]);
    expect(r.plan.rationale).not.toContain('AIが提案せず');
  });

  it('向き違反(現在値との上下): 買いの逆指値が現在値より下 → stop=geometry', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy',
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38100, stopLossForStop: 38050,   // buy の逆指値は現在値より上でなければならない
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBeUndefined();
    expect(drops(r.legDrops)).toEqual([['stop', 'geometry']]);
  });

  it('指値側が落ちた回も同じ形で残る(逆指値だけの片レッグ)', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy',
      limitEntry: 38400, stopLossForLimit: 38350,   // buy の指値は現在値より下でなければならない
      stopEntry: 38350, stopLossForStop: 38300,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.stopEntry).toBe(38350);
    expect(drops(r.legDrops)).toEqual([['limit', 'geometry']]);
  });

  it('1本も落ちない健全なプランでは legDrops を付けない(値が無いことと実装に無いことを混同させない)', () => {
    const r = parseScalpPlan(planJson({
      direction: 'buy',
      limitEntry: 38200, stopLossForLimit: 38150,
      stopEntry: 38350, stopLossForStop: 38300,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legDrops).toBeUndefined();
  });

  it('レンジで片脚だけ落ちた回も残る(上部をAIが出さない → upper=missing)', () => {
    const r = parseScalpPlan(JSON.stringify({
      direction: 'range', rationale: 'レンジ',
      range: { lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } },
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('range');          // 採否は不変(片脚で通す)
    expect(r.plan.range?.lower?.entry).toBe(38100);
    expect(drops(r.legDrops)).toEqual([['upper', 'missing']]);
  });
});

describe('★両レッグ落ちのときの既存の記録は1ミリも変わらない', () => {
  it('geometry の両レッグ落ち: noneReason/noneLegs は従来と同一(legDrops が additive に増えるだけ)', () => {
    const bad = {
      direction: 'sell', rationale: '戻り売り', refPrice: 0,
      limitEntry: 38200, stopLossForLimit: 38250,
      stopEntry: 38300, stopLossForStop: 38350,
    };
    const r = parseScalpPlan(JSON.stringify(bad), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('geometry');
    // ★形も意味も従来どおり(ok:false の2レッグ・キー構成も同じ)。
    expect(r.noneLegs).toEqual({
      dir: 'sell',
      legs: [
        { name: 'limit', entry: 38200, stopLoss: 38250, ok: false },
        { name: 'stop', entry: 38300, stopLoss: 38350, ok: false },
      ],
    });
    expect(drops(r.legDrops)).toEqual([['limit', 'geometry'], ['stop', 'geometry']]);
  });

  it('AI 自身の見送り(direction:none)は従来どおり legDrops も付かない', () => {
    const r = parseScalpPlan(JSON.stringify({ direction: 'none', rationale: '好機なし' }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.noneReason).toBe('ai');
    expect(r.noneLegs).toBeUndefined();
    expect(r.legDrops).toBeUndefined();
  });
});

describe('★enforce 段(LC 幅)でも片レッグ脱落が残る — A/B 実験が測りたいのはここ', () => {
  const twoLegs: AiPlan = {
    direction: 'buy', rationale: '押し目買い', refPrice: REF,
    limitEntry: 38200, stopLossForLimit: 38100,   // LC 幅 100(上限 65 超)
    stopEntry: 38350, stopLossForStop: 38290,     // LC 幅 60(範囲内)
  };

  it('上限超の指値だけ落ちる → limit=lc(採否は従来どおり逆指値だけ残る)', () => {
    const r = enforcePlanConstraintsReport(twoLegs, { ceilingYen: 65, floorYen: 55, bias: 'none' });
    expect(r.plan.direction).toBe('buy');
    expect(r.plan.limitEntry).toBeUndefined();
    expect(r.plan.stopEntry).toBe(38350);
    expect(drops(r.legDrops)).toEqual([['limit', 'lc']]);
    expect(r.legDrops?.[0]?.entry).toBe(38200);
  });

  it('下限未満の逆指値だけ落ちる → stop=lcFloor', () => {
    const narrow: AiPlan = { ...twoLegs, limitEntry: 38200, stopLossForLimit: 38140, stopEntry: 38350, stopLossForStop: 38340 };
    const r = enforcePlanConstraintsReport(narrow, { ceilingYen: 65, floorYen: 55, bias: 'none' });
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBeUndefined();
    expect(drops(r.legDrops)).toEqual([['stop', 'lcFloor']]);
  });

  it('★enforce が受け取っていないレッグを missing として二重に数えない(parse 段が持っている)', () => {
    const oneLeg: AiPlan = {
      direction: 'buy', rationale: '押し目買い', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38100,   // 上限超で落ちる
    };
    const r = enforcePlanConstraintsReport(oneLeg, { ceilingYen: 65, floorYen: 55, bias: 'none' });
    // 両レッグ無し=見送り。既存の noneReason/noneLegs は従来どおり。
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lc');
    expect(r.noneLegs).toEqual({ dir: 'buy', legs: [{ name: 'limit', entry: 38200, stopLoss: 38100, ok: false }] });
    // legDrops は enforce が実際に落とした1本だけ('stop' の missing は parse 段の記録)。
    expect(drops(r.legDrops)).toEqual([['limit', 'lc']]);
  });

  it('制約に触れないプランでは legDrops を付けない(挙動不変)', () => {
    const okPlan: AiPlan = { ...twoLegs, limitEntry: 38200, stopLossForLimit: 38140 };
    const r = enforcePlanConstraintsReport(okPlan, { ceilingYen: 65, floorYen: 55, bias: 'none' });
    expect(r.plan.limitEntry).toBe(38200);
    expect(r.plan.stopEntry).toBe(38350);
    expect(r.legDrops).toBeUndefined();
  });

  it('レンジで片脚だけバイアス veto → 脚1本の理由が残る(採否は従来どおり片脚で通す)', () => {
    const rangePlan: AiPlan = {
      direction: 'range', rationale: 'レンジ', refPrice: REF,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38460 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38040 },
      },
    };
    const r = enforcePlanConstraintsReport(rangePlan, { ceilingYen: 65, floorYen: 55, bias: 'long' });
    expect(r.plan.direction).toBe('range');
    expect(r.plan.range?.upper).toBeUndefined();
    expect(r.plan.range?.lower?.entry).toBe(38100);
    expect(drops(r.legDrops)).toEqual([['upper', 'bias']]);
  });
});

describe('★語彙は既存のものだけを使う(新しい語彙を作らない)', () => {
  it('現れる reason は NoneReason の値のいずれか', () => {
    const known = ['ai', 'geometry', 'lcWidthInvalid', 'stopSide', 'lc', 'lcFloor', 'bias', 'trend', 'rangeDisabled', 'missing', 'stale'];
    const cases: LegDrop[][] = [];
    const r1 = parseScalpPlan(planJson({ direction: 'buy', limitEntry: 38200, stopLossForLimit: 38150 }), REF);
    if (r1.ok && r1.legDrops) cases.push([...r1.legDrops]);
    const r2 = enforcePlanConstraintsReport({
      direction: 'buy', rationale: 'x', refPrice: REF,
      limitEntry: 38200, stopLossForLimit: 38100, stopEntry: 38350, stopLossForStop: 38290,
    }, { ceilingYen: 65, floorYen: 55, bias: 'none' });
    if (r2.legDrops) cases.push([...r2.legDrops]);
    expect(cases.length).toBeGreaterThan(0);
    for (const legs of cases) for (const d of legs) expect(known).toContain(d.reason);
  });
});

// ─── ★v0.9.95: 'geometry' を2つに分ける(ユーザー指摘「『または』でなく、不採用の理由を特定して」) ───
//
// ■ 分離前の問題
//   `geometry: 'エントリーが現在値の逆側、または損切り幅の値が不正'` — 1つの理由コードが2つの失敗を束ね、
//   画面も台帳も **どちらか を特定できなかった**。
// ■ 分離の根拠(推定ではなく構造)
//   parse 段では、対の整合チェック(entry だけ在る/幅だけ在るは ok:false)を通った後なので:
//     ・脚が組めなかった(!hasLeg)かつ 提案あり ⟺ **幅の値が使えなかった** → 'lcWidthInvalid'
//     ・脚は組めたが entryPositionOk 違反      ⟺ **エントリーが現在値の逆側** → 'geometry'
// ■ ★このテストが守るもの: 2つが同じコードに戻らないこと / 画面の文言に「または」が復活しないこと。
describe("★v0.9.95: geometry(逆側) と lcWidthInvalid(幅の値が不正) を取り違えない", () => {
  it('幅の値が不正 → lcWidthInvalid(geometry ではない)', () => {
    const r = parseScalpPlan(JSON.stringify({
      direction: 'buy', limitEntry: 38200, lcWidthForLimit: -55,
      stopEntry: 38350, lcWidthForStop: 60, rationale: 'x', refPrice: REF,
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legDrops?.map(d => d.reason)).toEqual(['lcWidthInvalid']);
  });

  it('エントリーが現在値の逆側 → geometry(lcWidthInvalid ではない)', () => {
    const r = parseScalpPlan(JSON.stringify({
      direction: 'buy', limitEntry: 38200, lcWidthForLimit: 60,
      stopEntry: 38100, lcWidthForStop: 60, rationale: 'x', refPrice: REF,   // 買いの逆指値が現在値より下
    }), REF);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.legDrops?.map(d => d.reason)).toEqual(['geometry']);
  });

  it('★画面の文言が別々で、「または」で束ねていない', () => {
    expect(legDropReasonText('geometry')).toBe('エントリーが現在値の逆側');
    expect(legDropReasonText('lcWidthInvalid')).toBe('損切り幅の値が不正');
    for (const r of ['geometry', 'lcWidthInvalid'] as const) {
      expect(legDropReasonText(r), '理由が「または」で束ねられている').not.toContain('または');
    }
  });

  it('★旧記録を遡って分ける判別式が構造的に成立する(幅不正の脚は stopLoss を持たない)', () => {
    const bad = parseScalpPlan(JSON.stringify({
      direction: 'buy', limitEntry: 38200, lcWidthForLimit: 0,
      stopEntry: 38350, lcWidthForStop: 60, rationale: 'x', refPrice: REF,
    }), REF);
    const side = parseScalpPlan(JSON.stringify({
      direction: 'buy', limitEntry: 38200, lcWidthForLimit: 60,
      stopEntry: 38100, lcWidthForStop: 60, rationale: 'x', refPrice: REF,
    }), REF);
    expect(bad.ok && bad.legDrops?.[0]?.stopLoss, '幅不正の脚は stopLoss を持たない').toBeUndefined();
    expect(side.ok && side.legDrops?.[0]?.stopLoss, '逆側の脚は stopLoss を持つ').toEqual(expect.any(Number));
  });
});
