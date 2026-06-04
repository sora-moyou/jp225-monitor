import { describe, it, expect } from 'vitest';
import { aggregateSignals, DEFAULT_AGGREGATE } from './aggregate.js';
import type { AlertSignal } from './types.js';

const sig = (over: Partial<AlertSignal> = {}): AlertSignal => ({
  type: 'level_sr', direction: 'up', reference: { kind: 'sessionLow', price: 65000 },
  score: 1, text: 'セッション最安値65,000がサポートの可能性', triggeredAt: 1, ...over,
});

describe('aggregateSignals', () => {
  it('同方向・近接基準・異種別を1本に統合しコンフルエンス加点', () => {
    const r = aggregateSignals([
      sig({ type: 'level_sr', score: 1.5, reference: { kind: 'sessionLow', price: 65000 } }),
      sig({ type: 'ma_sr', score: 1.0, reference: { kind: 'ma25', price: 65010 } }),
      sig({ type: 'double', score: 1.2, reference: { kind: 'neck', price: 64995 } }),
    ], DEFAULT_AGGREGATE);
    expect(r).toHaveLength(1);
    expect(r[0]!.type).toBe('level_sr');                 // primary = 最大score
    expect(r[0]!.types).toEqual(['level_sr', 'double', 'ma_sr']);  // score合計降順
    expect(r[0]!.score).toBeCloseTo(1.5 + 0.5 * 2, 5);   // primary + bonus×(異種3-1)
    expect(r[0]!.text).toContain('も整合');
    expect(r[0]!.members).toHaveLength(3);
  });

  it('同種の重複はコンフルエンス加点しない', () => {
    const r = aggregateSignals([
      sig({ type: 'level_sr', score: 1.0, reference: { price: 65000, kind: 'a' } }),
      sig({ type: 'level_sr', score: 0.8, reference: { price: 65005, kind: 'b' } }),
    ], DEFAULT_AGGREGATE);
    expect(r).toHaveLength(1);
    expect(r[0]!.score).toBeCloseTo(1.0, 5);             // 異種1 → 加点なし
    expect(r[0]!.text).not.toContain('整合');
  });

  it('基準が離れていれば別局面として分ける', () => {
    const r = aggregateSignals([
      sig({ type: 'level_sr', score: 1, reference: { price: 65000, kind: 'lo' } }),
      sig({ type: 'level_sr', score: 1, reference: { price: 67000, kind: 'hi' } }),
    ], { ...DEFAULT_AGGREGATE, refTolYen: 15 });
    expect(r).toHaveLength(2);
  });

  it('逆方向は統合しない', () => {
    const r = aggregateSignals([
      sig({ direction: 'up', score: 1, reference: { price: 65000, kind: 'a' } }),
      sig({ direction: 'down', score: 1, reference: { price: 65000, kind: 'b' } }),
    ]);
    expect(r).toHaveLength(2);
  });

  it('minScore 未満は除外(非イベント抑制)', () => {
    const r = aggregateSignals([sig({ score: 0.4 })], { ...DEFAULT_AGGREGATE, minScore: 1 });
    expect(r).toHaveLength(0);
  });

  it('score 降順で返す', () => {
    const r = aggregateSignals([
      sig({ direction: 'up', score: 1, reference: { price: 65000, kind: 'a' } }),
      sig({ direction: 'down', score: 2, reference: { price: 67000, kind: 'b' } }),
    ]);
    expect(r.map(s => s.score)).toEqual([2, 1]);
  });

  it('空入力は空', () => {
    expect(aggregateSignals([])).toEqual([]);
  });
});
