// ─── ★打ち切り(censoring)を後から必ず検定できること ──────────────────────────────
//
// 何を守っているか(サブリーダー指摘 D4):
//   事前登録は「打ち切りでないもの」で母集団を切るが、**打ち切り率は spec に依存する**
//   (床が緩いほど長く生きる)。しかも 'ticks_exhausted' は時間帯に依存する(夜間終盤に武装した
//   提案の地平は 06:00〜08:45 の空白帯を跨ぐ)= spec × 時間帯 の交絡になりうる。時間帯は
//   過去の検証で判明した最大の効果軸なので、切る前の数を **いつでも** 出せなければならない。
//
// ★否定対照: shadowCensorByHour / shadowSpecTotals を消す(= git show HEAD:server/db/shadowStore.ts で
//   旧版に差し替える)と、このファイルは import 解決に失敗して全部赤になる。

import { describe, it, expect } from 'vitest';
import {
  openShadowDb, insertShadowRows, shadowCensorByHour, shadowSpecTotals,
} from './shadowStore.js';
import type { ShadowRow } from '../signalTrade/shadow/sim.js';

/** JST の t を作る(2026-01-05 の JST h 時 0 分)。 */
const jst = (h: number): number => Date.UTC(2026, 0, 5, h - 9, 0, 0);

const base: ShadowRow = {
  epoch: 'e1', source: 'generator', proposalId: 'p1', spec: 'sh01', paramClass: 'ratchet', dir: 'buy',
  armedT: jst(10), armedPrice: 38_010,
  entryT: jst(10) + 1_000, entryPrice: 38_000, entryLeg: 'limit', initialStop: 37_900,
  exitT: jst(10) + 3_000, exitPrice: 38_045, exitReason: 'ratchet_floor', pnl: 45,
  outcome: 'exit', censored: false, censorReason: null, unrealized: null,
  mfe: 200, mae: -5, peakProfit: 200,
  holdMs: 2_000, elapsedMs: 3_000, horizonMs: 480 * 60_000, concurrent: 30, ticks: 3,
  createdAt: jst(10) + 3_000,
};

/** 打ち切り行(決済していない=pnl は無く含み損益がある)。 */
function censoredRow(over: Partial<ShadowRow>): ShadowRow {
  return {
    ...base, outcome: 'censored', censored: true, censorReason: 'horizon',
    exitT: null, exitPrice: null, exitReason: null, pnl: null, unrealized: 30,
    ...over,
  };
}

describe('★打ち切りの内訳が spec 別 × 時間帯別に出せる', () => {
  it('spec × JST時 × 打ち切り理由 で数えられる(打ち切っていない行も同じ表に出る)', () => {
    const db = openShadowDb(':memory:');
    insertShadowRows(db, [
      // 日中10時: sh01 は決済、sh02 は地平で打ち切り
      { ...base, proposalId: 'p1', spec: 'sh01' },
      censoredRow({ proposalId: 'p1', spec: 'sh02', armedT: jst(10) }),
      // 夜間翌朝5時(=日の境界 06:00 の直前)に武装 → ティックが尽きて打ち切り
      censoredRow({ proposalId: 'p2', spec: 'sh02', armedT: jst(5), censorReason: 'ticks_exhausted' }),
      censoredRow({ proposalId: 'p3', spec: 'sh03', armedT: jst(5), censorReason: 'ticks_exhausted' }),
    ]);

    const cells = shadowCensorByHour(db, 'e1');
    // 打ち切っていない行も同じ表に出る(=率の分母が作れる)
    expect(cells).toContainEqual({ spec: 'sh01', jstHour: 10, censorReason: null, n: 1 });
    expect(cells).toContainEqual({ spec: 'sh02', jstHour: 10, censorReason: 'horizon', n: 1 });
    // ★spec × 時間帯 の交絡が見える形: 5時台の ticks_exhausted が spec 別に出る
    expect(cells).toContainEqual({ spec: 'sh02', jstHour: 5, censorReason: 'ticks_exhausted', n: 1 });
    expect(cells).toContainEqual({ spec: 'sh03', jstHour: 5, censorReason: 'ticks_exhausted', n: 1 });
    // ticks_exhausted だけを時間帯別に足せる
    const exhausted = cells.filter(c => c.censorReason === 'ticks_exhausted');
    expect(exhausted.every(c => c.jstHour === 5)).toBe(true);
    expect(exhausted.reduce((n, c) => n + c.n, 0)).toBe(2);
    db.close();
  });

  it('★打ち切り行は 含み損益 / MFE / MAE / 経過時間 を持ったまま記録されている(切る前の情報が残る)', () => {
    const db = openShadowDb(':memory:');
    insertShadowRows(db, [censoredRow({ spec: 'sh02', unrealized: 77, mfe: 120, mae: -33, elapsedMs: 480 * 60_000 })]);
    const row = db.prepare(
      'SELECT unrealized, mfe, mae, elapsed_ms AS e, hold_ms AS h, pnl FROM shadow_exits',
    ).get() as { unrealized: number; mfe: number; mae: number; e: number; h: number; pnl: number | null };
    expect(row).toEqual({ unrealized: 77, mfe: 120, mae: -33, e: 480 * 60_000, h: 2_000, pnl: null });
    db.close();
  });
});

describe('★「打ち切りを除いた集計」と「含めた集計」の両方が出せる', () => {
  it('spec × 打ち切りの有無 で母数と合計が返る(平均を返して母数を消さない)', () => {
    const db = openShadowDb(':memory:');
    insertShadowRows(db, [
      { ...base, proposalId: 'p1', spec: 'sh01', pnl: 40 },
      { ...base, proposalId: 'p2', spec: 'sh01', pnl: -10 },
      censoredRow({ proposalId: 'p3', spec: 'sh01', unrealized: 100 }),
    ]);
    const totals = shadowSpecTotals(db, 'e1');
    const done = totals.find(t => t.spec === 'sh01' && t.censored === 0)!;
    const cut = totals.find(t => t.spec === 'sh01' && t.censored === 1)!;

    // 打ち切りを **除いた** 集計: 決済2件・合計 +30
    expect(done.n).toBe(2);
    expect(done.nPnl).toBe(2);
    expect(done.sumPnl).toBe(30);
    // 打ち切りを **含めた** 集計: 打ち切り1件の含み損益 +100 を足せる(pnl は無い)
    expect(cut.n).toBe(1);
    expect(cut.nPnl).toBe(0);
    expect(cut.nUnrealized).toBe(1);
    expect(cut.sumUnrealized).toBe(100);
    // 母集団の差そのものが出せる(3件中1件=33%が打ち切りだった)
    expect(done.n + cut.n).toBe(3);
    db.close();
  });
});
