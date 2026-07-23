import { describe, it, expect } from 'vitest';
import { checkSanity, MAX_ENTRY_DISTANCE_YEN, MAX_BRACKET_WIDTH_YEN } from './sanity.js';
import type { AiPlan } from '../llm/openai.js';

// trade2 の src/ai/sanity.ts と論理等価であることを担保する(先取り検証=正規シグナルのゲート)。
// 各拒否クラス(向き違い / 単レッグ>200 / ブラケット>400 / レンジ違反 / 非有限価格)と通過を検証する。

const PRICE = 38000;

describe('checkSanity 定数', () => {
  it('trade2 と同一の閾値', () => {
    expect(MAX_ENTRY_DISTANCE_YEN).toBe(200);
    expect(MAX_BRACKET_WIDTH_YEN).toBe(400);
  });
});

describe('checkSanity: 非有限価格', () => {
  it('現在値が NaN なら NG', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, Number.NaN).ok).toBe(false);
  });
});

describe('checkSanity: 通過(両レッグ OCO)', () => {
  it('buy: 指値<現値<逆指値・各SL外側・幅≤400 → OK', () => {
    const plan: AiPlan = {
      direction: 'buy', limitEntry: 37950, stopEntry: 38100,
      stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', refPrice: PRICE,
    };
    expect(checkSanity(plan, PRICE)).toEqual({ ok: true });
  });
  it('sell: 逆指値<現値<指値・各SL外側・幅≤400 → OK', () => {
    const plan: AiPlan = {
      direction: 'sell', limitEntry: 38100, stopEntry: 37950,
      stopLossForLimit: 38150, stopLossForStop: 38010, rationale: 'r', refPrice: PRICE,
    };
    expect(checkSanity(plan, PRICE)).toEqual({ ok: true });
  });
});

describe('checkSanity: 向き違い(即約定=不正)は NG', () => {
  it('buy 指値が現在値の上 → NG', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: 38050, stopLossForLimit: 38000, rationale: 'r', refPrice: PRICE };
    const r = checkSanity(plan, PRICE);
    expect(r.ok).toBe(false);
  });
  it('buy 逆指値が現在値の下 → NG', () => {
    const plan: AiPlan = { direction: 'buy', stopEntry: 37950, stopLossForStop: 37900, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('sell 指値が現在値の下 → NG', () => {
    const plan: AiPlan = { direction: 'sell', limitEntry: 37950, stopLossForLimit: 38000, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('buy 指値SL が指値の外側でない(上) → NG', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37960, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('同値(境界)も NG(厳密不等号)', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: PRICE, stopLossForLimit: 37900, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
});

describe('checkSanity: 単レッグ距離>200 は NG(片側のみ)', () => {
  it('buy 指値のみ・現在値から300円離れ → NG', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: 37700, stopLossForLimit: 37650, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('buy 指値のみ・200円ちょうど → OK(境界内)', () => {
    const plan: AiPlan = { direction: 'buy', limitEntry: 37800, stopLossForLimit: 37750, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE)).toEqual({ ok: true });
  });
  it('sell 逆指値のみ・現在値から300円離れ → NG', () => {
    const plan: AiPlan = { direction: 'sell', stopEntry: 37700, stopLossForStop: 38050, rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
});

describe('checkSanity: ブラケット幅>400 は NG(両レッグ)', () => {
  it('buy 指値-逆指値の幅500 → NG(単レッグ距離は不適用でも幅で落ちる)', () => {
    const plan: AiPlan = {
      direction: 'buy', limitEntry: 37700, stopEntry: 38200,
      stopLossForLimit: 37650, stopLossForStop: 38150, rationale: 'r', refPrice: PRICE,
    };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('buy 幅400ちょうど → OK(境界内)', () => {
    const plan: AiPlan = {
      direction: 'buy', limitEntry: 37850, stopEntry: 38250,
      stopLossForLimit: 37800, stopLossForStop: 38200, rationale: 'r', refPrice: PRICE,
    };
    expect(checkSanity(plan, PRICE)).toEqual({ ok: true });
  });
});

describe('checkSanity: レッグ皆無は NG', () => {
  it('buy で指値/逆指値とも欠落 → NG', () => {
    const plan: AiPlan = { direction: 'buy', rationale: 'r', refPrice: PRICE };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
});

describe('checkSanity: レンジ両面(direction=range)', () => {
  it('upper>現値>lower・各SL正しい向き・幅≤400 → OK', () => {
    const plan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38150, stopLoss: 38200 },
        lower: { side: 'buy', type: 'limit', entry: 37900, stopLoss: 37850 },
      },
    };
    expect(checkSanity(plan, PRICE)).toEqual({ ok: true });
  });
  it('upper が現在値の上にない → NG', () => {
    const plan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 37900, stopLoss: 37950 },
        lower: { side: 'buy', type: 'limit', entry: 37800, stopLoss: 37750 },
      },
    };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('lower の SL 向きが side と不整合 → NG', () => {
    const plan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38150, stopLoss: 38200 },
        lower: { side: 'buy', type: 'limit', entry: 37900, stopLoss: 37950 },  // buy なのに SL が上
      },
    };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('両レッグの幅>400 → NG', () => {
    const plan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38300, stopLoss: 38350 },
        lower: { side: 'buy', type: 'limit', entry: 37800, stopLoss: 37750 },  // 幅500
      },
    };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('片面(upperのみ)で距離>200 → NG', () => {
    const plan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: { upper: { side: 'sell', type: 'limit', entry: 38300, stopLoss: 38350 } },  // 300円離れ
    };
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
  it('レンジだがレッグ皆無 → NG', () => {
    const plan: AiPlan = { direction: 'range', rationale: 'r', refPrice: PRICE, range: {} };
    // isRangePlan=false(レッグ無し)→ directional 経路で「レッグが無い」で NG。
    expect(checkSanity(plan, PRICE).ok).toBe(false);
  });
});
