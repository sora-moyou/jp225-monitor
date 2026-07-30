import { describe, it, expect } from 'vitest';
import { parseScalpPlan, enforcePlanConstraints, type AiPlan, type RangeLeg } from '../llm/openai.js';
import { checkSanity } from './sanity.js';
import { planToArmed, detectRangeFill, LIMIT_FILL_MARGIN_YEN, SLIPPAGE_YEN } from './decisions.js';

// ★レンジ両面(direction:"range")の3形態が、パイプライン全段(parse → enforce → sanity → arm)を
//   落とされずに通ることを固定する。
//   - 両指値(fade): 上=売り指値 / 下=買い指値。幅の広いレンジ向き。
//   - 両側逆指値(breakout): 上=買い逆指値 / 下=売り逆指値。狭い横這い向き(ユーザー指定で明示許可)。
//   - 混在: 片方 limit・片方 stop。
//     ★v0.9.44: プロンプト上は「2択(fade / breakout の組)・組を混ぜない」を指示するので混在は指示しない。
//       ただしコード側の受理は現状のまま=混在も通す(弾かない方がバグを発見できる、というユーザー判断)。
//       AI が混在を出したら engine が plan-range-mixed を1行ログするので、次セッションで観測できる。
//   ここが通らないと AI が正しく出しても黙って落ちるため、回帰で気づけるようにテストで固定する。

const PRICE = 38000;
const CEILING = 65;   // 初期LC上限[円]。各レッグの |entry−stopLoss| はこの範囲に収める。

/** LLM 応答想定の JSON 文字列。 */
function rangeJson(upper: RangeLeg, lower: RangeLeg): string {
  return JSON.stringify({
    regime: 'range', confidence: 60, direction: 'range',
    rationale: 'レンジと判断', range: { upper, lower },
  });
}

// 両指値(fade): 幅400円の広いレンジを上下から逆張り。
const FADE_UPPER: RangeLeg = { side: 'sell', type: 'limit', entry: 38200, stopLoss: 38260 };
const FADE_LOWER: RangeLeg = { side: 'buy', type: 'limit', entry: 37800, stopLoss: 37740 };
// 両側逆指値(breakout): 幅120円の狭い横這いを上下の抜けに追随。
const BREAK_UPPER: RangeLeg = { side: 'buy', type: 'stop', entry: 38060, stopLoss: 38000 };
const BREAK_LOWER: RangeLeg = { side: 'sell', type: 'stop', entry: 37940, stopLoss: 38000 };

const CASES: { name: string; upper: RangeLeg; lower: RangeLeg }[] = [
  { name: '両指値(fade)', upper: FADE_UPPER, lower: FADE_LOWER },
  { name: '両側逆指値(breakout)', upper: BREAK_UPPER, lower: BREAK_LOWER },
  { name: '混在(上=逆指値/下=指値)', upper: BREAK_UPPER, lower: FADE_LOWER },
];

describe('レンジ両面プランがパイプライン全段を通る(両指値/両側逆指値/混在)', () => {
  for (const { name, upper, lower } of CASES) {
    it(`${name}: parse → enforce → sanity → arm がすべて通り 両レッグ残る`, () => {
      // ① parse: 幾何(upper>現値>lower)と SL 向きの検証。type は問わない。
      const parsed = parseScalpPlan(rangeJson(upper, lower), PRICE);
      expect(parsed.ok).toBe(true);
      const plan = (parsed as { ok: true; plan: AiPlan }).plan;
      expect(plan.direction).toBe('range');
      expect(plan.range?.upper).toEqual(upper);
      expect(plan.range?.lower).toEqual(lower);

      // ② enforce: トレンド veto なし・bias none・LC 上限内 → 両レッグ据え置き。
      const enforced = enforcePlanConstraints(plan, { ceilingYen: CEILING, bias: 'none' });
      expect(enforced.direction).toBe('range');
      expect(enforced.range?.upper).toEqual(upper);
      expect(enforced.range?.lower).toEqual(lower);

      // ③ sanity(発注前ゲート): 現在値を挟む位置・SL 向き・幅上限。
      expect(checkSanity(enforced, PRICE)).toEqual({ ok: true });

      // ④ arm: range ブラケットに両レッグが載る。
      const armed = planToArmed(enforced, 1_000);
      expect(armed).not.toBeNull();
      expect(armed!.mode).toBe('range');
      expect(armed!.range?.upper).toEqual(upper);
      expect(armed!.range?.lower).toEqual(lower);
    });
  }

  it('両側逆指値は上抜けで buy・下抜けで sell として約定する(紙エンジンの約定判定)', () => {
    const armed = planToArmed(
      { direction: 'range', rationale: 'r', range: { upper: BREAK_UPPER, lower: BREAK_LOWER } }, 1_000,
    )!;
    // ★逆指値(type:'stop')はタッチで約定(実弾 trade2 の逆指値はタッチ発火→成行)。建値だけ不利方向へ 1tick スリップ。
    expect(detectRangeFill(armed, BREAK_UPPER.entry)).toEqual({
      side: 'buy', entryPrice: BREAK_UPPER.entry + SLIPPAGE_YEN, initialStop: BREAK_UPPER.stopLoss,
    });
    expect(detectRangeFill(armed, BREAK_LOWER.entry)).toEqual({
      side: 'sell', entryPrice: BREAK_LOWER.entry - SLIPPAGE_YEN, initialStop: BREAK_LOWER.stopLoss,
    });
    // さらに行き過ぎても同じ(建値は逆指値+スリップで据置)。
    expect(detectRangeFill(armed, BREAK_UPPER.entry + LIMIT_FILL_MARGIN_YEN)).toEqual({
      side: 'buy', entryPrice: BREAK_UPPER.entry + SLIPPAGE_YEN, initialStop: BREAK_UPPER.stopLoss,
    });
    expect(detectRangeFill(armed, BREAK_LOWER.entry - LIMIT_FILL_MARGIN_YEN)).toEqual({
      side: 'sell', entryPrice: BREAK_LOWER.entry - SLIPPAGE_YEN, initialStop: BREAK_LOWER.stopLoss,
    });
    // レンジ内(未到達)は約定しない。
    expect(detectRangeFill(armed, PRICE)).toBeNull();
  });

  it('混在(上=逆指値/下=指値)は レッグ type ごとに条件が変わる', () => {
    const armed = planToArmed(
      { direction: 'range', rationale: 'r', range: { upper: BREAK_UPPER, lower: FADE_LOWER } }, 1_000,
    )!;
    // 上=逆指値: タッチで約定。
    expect(detectRangeFill(armed, BREAK_UPPER.entry)).toEqual({
      side: 'buy', entryPrice: BREAK_UPPER.entry + SLIPPAGE_YEN, initialStop: BREAK_UPPER.stopLoss,
    });
    // 下=指値: タッチでは約定せず、LIMIT_FILL_MARGIN_YEN 行き過ぎて約定(建値は指値のまま=スリップ無し)。
    expect(detectRangeFill(armed, FADE_LOWER.entry)).toBeNull();
    expect(detectRangeFill(armed, FADE_LOWER.entry - LIMIT_FILL_MARGIN_YEN)).toEqual({
      side: 'buy', entryPrice: FADE_LOWER.entry, initialStop: FADE_LOWER.stopLoss,
    });
  });
});
