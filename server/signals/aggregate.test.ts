import { describe, it, expect } from 'vitest';
import { aggregateSignals, DEFAULT_AGGREGATE, recentMomentumDir } from './aggregate.js';
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

  // ─── ★slope 方向一致ボーナス(momentumDir・40日ライブ: slope +52pt) ───────────────
  const P = { ...DEFAULT_AGGREGATE, slopeConfluenceBonus: 0.5 };

  it('momentumDir 未指定は従来と完全一致(加点なし)', () => {
    const input = [sig({ type: 'break', score: 0.9, direction: 'up', reference: { price: 65000, kind: 'lv' } })];
    // break 単独 0.9 < minScore1 → momentumDir 無しなら除外(=従来挙動)。
    expect(aggregateSignals(input, P)).toHaveLength(0);
    // 明示 null も同じ。
    expect(aggregateSignals(input, P, null)).toHaveLength(0);
  });

  it('momentumDir と同方向のクラスタにのみ加点(break 0.9+0.5=1.4 で emit)', () => {
    const input = [sig({ type: 'break', score: 0.9, direction: 'up', reference: { price: 65000, kind: 'lv' } })];
    const r = aggregateSignals(input, P, 'up');
    expect(r).toHaveLength(1);
    expect(r[0]!.score).toBeCloseTo(1.4, 5);   // 0.9 + slopeConfluenceBonus 0.5
  });

  it('momentumDir と逆方向のクラスタには加点しない(break 0.9 のまま → 除外)', () => {
    const input = [sig({ type: 'break', score: 0.9, direction: 'down', reference: { price: 65000, kind: 'lv' } })];
    expect(aggregateSignals(input, P, 'up')).toHaveLength(0);   // down クラスタに up モメンタムは効かない
  });

  it('slopeConfluenceBonus 未指定なら momentumDir を渡しても加点0(後方互換)', () => {
    const input = [sig({ type: 'break', score: 0.9, direction: 'up', reference: { price: 65000, kind: 'lv' } })];
    expect(aggregateSignals(input, DEFAULT_AGGREGATE, 'up')).toHaveLength(0);   // bonus 未定義=0
  });

  it('コンフルエンス加点と slope 加点は併算(別種 +0.5 と方向一致 +0.5)', () => {
    const r = aggregateSignals([
      sig({ type: 'break', score: 0.9, direction: 'up', reference: { price: 65000, kind: 'lv' } }),
      sig({ type: 'level_sr', score: 1.0, direction: 'up', reference: { price: 65010, kind: 'ma' } }),
    ], P, 'up');
    expect(r).toHaveLength(1);
    // primary=level_sr(1.0) + 別種1本(+0.5) + slope方向一致(+0.5) = 2.0
    expect(r[0]!.score).toBeCloseTo(2.0, 5);
  });
});

describe('recentMomentumDir', () => {
  const bar = (t: number, c: number): { t: number; c: number } => ({ t, c });

  it('10分前より +50円以上上昇 → up', () => {
    expect(recentMomentumDir([bar(0, 64000), bar(600_000, 64100)])).toBe('up');
  });

  it('10分前より -50円以上下落 → down', () => {
    expect(recentMomentumDir([bar(0, 64100), bar(600_000, 64000)])).toBe('down');
  });

  it('変化が minYen(50)未満 → null', () => {
    expect(recentMomentumDir([bar(0, 64000), bar(600_000, 64030)])).toBeNull();
  });

  it('lookbackMin 前のバーが無い(データ不足)→ null', () => {
    // 直近5分ぶんしか無い → cutoff(−10分)以前のバーが無い。
    expect(recentMomentumDir([bar(0, 64000), bar(300_000, 64500)])).toBeNull();
  });

  it('バー1本以下 → null', () => {
    expect(recentMomentumDir([bar(0, 64000)])).toBeNull();
    expect(recentMomentumDir([])).toBeNull();
  });
});
