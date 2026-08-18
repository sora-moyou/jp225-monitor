import { describe, it, expect } from 'vitest';
import { planToArmed, armedToCurrentSignal, toSignalTradeState, reverseToDoten, type EngineState } from './decisions.js';
import type { AiPlan } from '../llm/openai.js';

// ★v0.9.86: AI の「相場の読み」(strategy / strategyWhy)を **画面まで** 運ぶ配線の実証。
//   v0.9.85 は台帳(signal_plans)にだけ記録し、SSE には1バイトも載せていなかった=画面に出しようがなかった。
//   経路: AiPlan → planToArmed(ArmedBracket) → armedToCurrentSignal(CurrentSignal) → toSignalTradeState(SSE payload)。
//   ★記録専用の持ち回り: 採否・価格・脚落ちには一切影響しない(下の「否定対照」で価格が同一であることを固定する)。

const BUY_PLAN = {
  direction: 'buy' as const,
  limitEntry: 68725, stopLossForLimit: 68665,
  stopEntry: 68780, stopLossForStop: 68720,
  rationale: '押し目買い',
};
const STRATEGY = 'トレンド押し目・戻り';
const WHY = '上昇トレンド中、S1まで引きつけて反発を取る';

describe('planToArmed: 相場の読みを armed へ運ぶ', () => {
  it('directional: strategy / strategyWhy がそのまま載る', () => {
    const a = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000);
    expect(a?.strategy).toBe(STRATEGY);
    expect(a?.strategyWhy).toBe(WHY);
  });

  it('range: 両面ストラドルでも載る', () => {
    const a = planToArmed({
      direction: 'range', rationale: 'レンジ',
      range: {
        upper: { side: 'sell', type: 'limit', entry: 68900, stopLoss: 68960 },
        lower: { side: 'buy', type: 'limit', entry: 68700, stopLoss: 68640 },
      },
      strategy: 'レンジ内', strategyWhy: '上下端が効いている',
    }, 1000);
    expect(a?.mode).toBe('range');
    expect(a?.strategy).toBe('レンジ内');
    expect(a?.strategyWhy).toBe('上下端が効いている');
  });

  it('★一覧外のラベルも丸めない(台帳と同じ規約)', () => {
    expect(planToArmed({ ...BUY_PLAN, strategy: '寄り天狙い' }, 1000)?.strategy).toBe('寄り天狙い');
  });

  it('★否定対照: 欠落した計画から作る armed は従来と byte 一致(価格も1円も動かない)', () => {
    const bare = planToArmed(BUY_PLAN, 1000);
    const withS = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000);
    expect('strategy' in (bare as object)).toBe(false);
    expect('strategyWhy' in (bare as object)).toBe(false);
    // 採否・価格・脚は完全に同一(記録専用=判断に使っていない)。
    expect({ ...withS, strategy: undefined, strategyWhy: undefined })
      .toEqual({ ...bare, strategy: undefined, strategyWhy: undefined });
    expect(withS?.limitEntry).toBe(bare?.limitEntry);
    expect(withS?.stopEntry).toBe(bare?.stopEntry);
    expect(withS?.stopLossForLimit).toBe(bare?.stopLossForLimit);
    expect(withS?.stopLossForStop).toBe(bare?.stopLossForStop);
  });
});

describe('armedToCurrentSignal: 相場の読みを現在シグナルへ運ぶ', () => {
  it('在れば引き継ぎ、無ければフィールドごと付けない', () => {
    const a = planToArmed({ ...BUY_PLAN, strategy: STRATEGY, strategyWhy: WHY }, 1000)!;
    const s = armedToCurrentSignal(a, 7);
    expect(s.strategy).toBe(STRATEGY);
    expect(s.strategyWhy).toBe(WHY);
    const bare = armedToCurrentSignal(planToArmed(BUY_PLAN, 1000)!, 7);
    expect('strategy' in bare).toBe(false);
    expect('strategyWhy' in bare).toBe(false);
  });
});

describe('toSignalTradeState: SSE payload に載る(★これが無いと画面に出しようがない)', () => {
  const armedState = (strategy?: string, why?: string): EngineState => ({
    phase: 'armed',
    armed: planToArmed({ ...BUY_PLAN, ...(strategy ? { strategy } : {}), ...(why ? { strategyWhy: why } : {}) }, 1000)!,
  });

  it('signal / entry の両方に載る(パネルはどちらの経路でも描ける)', () => {
    const st = armedState(STRATEGY, WHY);
    const sig = armedToCurrentSignal(st.armed!, 7);
    const s = toSignalTradeState(st, 68750, 2000, sig);
    expect(s.signal?.strategy).toBe(STRATEGY);
    expect(s.signal?.strategyWhy).toBe(WHY);
    expect(s.entry?.strategy).toBe(STRATEGY);
    expect(s.entry?.strategyWhy).toBe(WHY);
    // ★実際に SSE へ流れるのは JSON。文字列化しても消えないことを見る。
    const json = JSON.parse(JSON.stringify(s));
    expect(json.signal.strategy).toBe(STRATEGY);
    expect(json.signal.strategyWhy).toBe(WHY);
  });

  it('保有中(filled)でも現在シグナルの読みは載り続ける', () => {
    const sig = armedToCurrentSignal(armedState(STRATEGY, WHY).armed!, 7);
    const filled: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 68725, qty: 1, initialStop: 68665, peakProfit: 0, rationale: '押し目買い', at: 1500 },
    };
    const s = toSignalTradeState(filled, 68750, 2000, sig);
    expect(s.signal?.strategy).toBe(STRATEGY);
    expect(s.signal?.strategyWhy).toBe(WHY);
  });

  it('★否定対照: 欠落なら SSE の JSON は従来と byte 一致(dedupe / 旧クライアント互換)', () => {
    const st = armedState();
    const sig = armedToCurrentSignal(st.armed!, 7);
    const json = JSON.stringify(toSignalTradeState(st, 68750, 2000, sig));
    expect(json.includes('strategy')).toBe(false);
    // 参照実装: strategy を持たない armed から作った state(=従来の形)と完全一致。
    expect(json).toBe(JSON.stringify(toSignalTradeState(
      { phase: 'armed', armed: planToArmed(BUY_PLAN, 1000)! }, 68750, 2000,
      armedToCurrentSignal(planToArmed(BUY_PLAN, 1000)!, 7),
    )));
  });

  it('ドテン(反転)経路でも読みが運ばれる', () => {
    const held: EngineState = {
      phase: 'filled',
      position: { direction: 'sell', entryPrice: 68900, qty: 1, initialStop: 68960, peakProfit: 0, rationale: '戻り売り', at: 500 },
    };
    const plan: AiPlan = { ...BUY_PLAN, refPrice: 68750, strategy: 'ドテン', strategyWhy: '上昇転換で保有の売りを畳む' };
    const rev = reverseToDoten(held, plan, 68750, 2000);
    expect(rev?.armed.strategy).toBe('ドテン');
    const s = toSignalTradeState(rev!.next, 68750, 2000, armedToCurrentSignal(rev!.armed, 8));
    expect(s.signal?.strategy).toBe('ドテン');
    expect(s.signal?.strategyWhy).toBe('上昇転換で保有の売りを畳む');
    expect(s.signal?.doten).toBe(true);
  });
});
