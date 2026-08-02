// ★A(実弾につながる系統)と同じ武装ゲートを通していることの検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   - server/replay/gates.ts が無いため import 段で解決できず、このファイルは全部赤。
//   - 「門を通さずに素通しする」実装(applyArmGates が常に ok を返す)にすると、
//     下の『sanity / refstale / stale / recheck それぞれで落ちる』が全部赤になる。
//   - 判定条件を書き写した実装にすると、『本番の関数をそのまま呼ぶ』の spy 検証が赤になる。
//
// ★このファイルは公開リポにも載る。決済の実数値は書かない(ここに出る価格は合成の相場)。

import { describe, it, expect, vi } from 'vitest';

// ─── 「再実装していない」ことを観測するための包み(中身は本物をそのまま呼ぶ) ───────────────
const spied = vi.hoisted(() => ({
  checkSanity: vi.fn(), checkRefDrift: vi.fn(), recheckArmedSanity: vi.fn(),
  checkStaleLegs: vi.fn(), planToArmed: vi.fn(),
}));
vi.mock('../signalTrade/sanity.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signalTrade/sanity.js')>();
  spied.checkSanity.mockImplementation(actual.checkSanity);
  return { ...actual, checkSanity: spied.checkSanity };
});
vi.mock('../signalTrade/armGate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signalTrade/armGate.js')>();
  spied.checkRefDrift.mockImplementation(actual.checkRefDrift);
  spied.recheckArmedSanity.mockImplementation(actual.recheckArmedSanity);
  return { ...actual, checkRefDrift: spied.checkRefDrift, recheckArmedSanity: spied.recheckArmedSanity };
});
vi.mock('../signalTrade/decisions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../signalTrade/decisions.js')>();
  spied.checkStaleLegs.mockImplementation(actual.checkStaleLegs);
  spied.planToArmed.mockImplementation(actual.planToArmed);
  return { ...actual, checkStaleLegs: spied.checkStaleLegs, planToArmed: spied.planToArmed };
});

import { applyArmGates } from './gates.js';
import { planToArmed } from '../signalTrade/decisions.js';
import { MAX_ENTRY_DISTANCE_YEN } from '../signalTrade/sanity.js';
import { MAX_REF_DRIFT_YEN } from '../signalTrade/armGate.js';
import type { AiPlan } from '../llm/scalpPlan.js';

const T0 = 1_700_000_000_000;

/** 合成の買い計画(2レッグ)。現値 38_050 を挟む。 */
const twoLeg: AiPlan = {
  direction: 'buy', rationale: '合成', refPrice: 38_050,
  limitEntry: 38_000, stopLossForLimit: 37_900,
  stopEntry: 38_100, stopLossForStop: 38_000,
};
/** 合成の買い計画(指値のみ)。 */
const oneLeg: AiPlan = {
  direction: 'buy', rationale: '合成', refPrice: 38_050,
  limitEntry: 38_000, stopLossForLimit: 37_900,
};

describe('★A と同じ門を、本番の純関数をそのまま呼んで通す', () => {
  it('4つの門をすべて本番の関数に問う(条件を書き写していない)', () => {
    for (const s of Object.values(spied)) s.mockClear();
    // 指値レッグが ARM 時価格で通過済み → 単レッグ化 → recheck まで到達する形を作る。
    const r = applyArmGates(twoLeg, 37_990, T0);
    expect(spied.checkSanity).toHaveBeenCalledWith(twoLeg, twoLeg.refPrice);
    expect(spied.checkRefDrift).toHaveBeenCalledWith(twoLeg.refPrice, 37_990);
    expect(spied.planToArmed).toHaveBeenCalledWith(twoLeg, T0, { vetoFired: undefined });
    expect(spied.checkStaleLegs).toHaveBeenCalledTimes(1);
    expect(spied.recheckArmedSanity).toHaveBeenCalledTimes(1);   // 脚が落ちたので再検証された
    expect(r.ok).toBe(true);
  });

  it('脚が落ちていないときは recheckArmedSanity を呼ばない(A と同じ適用条件)', () => {
    for (const s of Object.values(spied)) s.mockClear();
    const r = applyArmGates(twoLeg, 38_050, T0);
    expect(r.ok).toBe(true);
    expect(spied.checkStaleLegs).toHaveBeenCalledTimes(1);
    expect(spied.recheckArmedSanity).not.toHaveBeenCalled();
  });

  it('通った計画は planToArmed に戻すと同じブラケットになる(影は同じ形を武装する)', () => {
    const r = applyArmGates(twoLeg, 38_050, T0);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(planToArmed(r.plan, T0)).toEqual(r.armed);
  });
});

describe('★どの門で落ちたかが分かる', () => {
  it('sanity: 計画時価格に対して不正な形(指値が現値の上にある買い)', () => {
    const bad: AiPlan = { ...oneLeg, limitEntry: 38_100 };   // buy 指値が refPrice の上
    const r = applyArmGates(bad, 38_050, T0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.gate).toBe('sanity');
  });

  it('refstale: 計画時価格と ARM 時価格の乖離が上限超', () => {
    const live = twoLeg.refPrice + MAX_REF_DRIFT_YEN + 1;
    const r = applyArmGates(twoLeg, live, T0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.gate).toBe('refstale');
  });

  it('stale: 全レッグが ARM 時価格で既に通過済み', () => {
    // 単レッグ(指値のみ)を通過した価格 → 残る脚が無い。
    const r = applyArmGates(oneLeg, 37_990, T0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.gate).toBe('stale');
  });

  it('recheck: 単レッグ化した後に距離上限を超える(実害 sid=361 と同型)', () => {
    // 逆指値だけが残り、ARM 時価格から MAX_ENTRY_DISTANCE_YEN 超に離れている形。
    const far: AiPlan = {
      direction: 'buy', rationale: '合成', refPrice: 38_050,
      limitEntry: 38_000, stopLossForLimit: 37_900,
      stopEntry: 38_000 + MAX_ENTRY_DISTANCE_YEN + 100, stopLossForStop: 38_000,
    };
    // live=37_990 で指値レッグが通過済み → 逆指値のみ → live から 300円 → 上限超で落ちる。
    const r = applyArmGates(far, 37_990, T0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.gate).toBe('recheck');
  });

  it('レンジ提案は対象外(影はラチェットを測るもの)', () => {
    const range: AiPlan = {
      direction: 'range', rationale: '合成', refPrice: 38_050,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38_200, stopLoss: 38_300 },
        lower: { side: 'buy', type: 'limit', entry: 37_900, stopLoss: 37_800 },
      },
    };
    const r = applyArmGates(range, 38_050, T0);
    expect(r.ok === false && r.gate).toBe('not-directional');
  });

  it('見送り(none)は武装しない', () => {
    const none: AiPlan = { direction: 'none', rationale: '見送り', refPrice: 38_050 };
    const r = applyArmGates(none, 38_050, T0);
    expect(r.ok === false && r.gate).toBe('not-armable');
  });
});
