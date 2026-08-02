// 影の記録先(専用DB)の検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   shadowStore.ts が無いため import 段で解決できず、このファイルは全部赤。
//   また列(epoch / param_class / censored / source / concurrent / censor_reason)のどれか1つでも
//   欠けたスキーマでは INSERT が失敗し、下のテストは赤になる。

import { describe, it, expect } from 'vitest';
import {
  openShadowDb, insertShadowRows, countShadowRows, shadowOutcomeCounts, resolveShadowDbPath,
  recordShadowLadderMeta, readShadowLadderMeta,
} from './shadowStore.js';
import type { ShadowRow } from '../signalTrade/shadow/sim.js';
import { EMPTY_SHADOW_LADDER, type ShadowExitLadder } from '../signalTrade/exit/index.js';

const base: ShadowRow = {
  epoch: 'e1', source: 'generator', proposalId: 'p1', spec: 'sh01', paramClass: 'ratchet', dir: 'buy',
  armedT: 1_700_000_000_000, armedPrice: 38_010,
  entryT: 1_700_000_001_000, entryPrice: 38_000, entryLeg: 'limit', initialStop: 37_900,
  exitT: 1_700_000_003_000, exitPrice: 38_045, exitReason: 'ratchet_floor', pnl: 45,
  outcome: 'exit', censored: false, censorReason: null, unrealized: null,
  mfe: 200, mae: -5, peakProfit: 200,
  holdMs: 2_000, elapsedMs: 3_000, horizonMs: 480 * 60_000, concurrent: 30, ticks: 3,
  createdAt: 1_700_000_003_000,
};

describe('影の記録(専用DB)', () => {
  it('共有 DB(jp225.db)とは別ファイルに置く', () => {
    process.env.JP225_SHADOW_DB = '';
    const p = resolveShadowDbPath();
    expect(p.endsWith('jp225.db')).toBe(false);
    expect(p).toContain('shadow');
    delete process.env.JP225_SHADOW_DB;
  });

  it('必須の列(epoch/param_class/censored/source/concurrent)を最初から持つ', () => {
    const db = openShadowDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(shadow_exits)').all() as unknown as Array<{ name: string }>)
      .map(c => c.name);
    for (const c of ['epoch', 'param_class', 'censored', 'source', 'concurrent', 'censor_reason']) {
      expect(cols).toContain(c);
    }
    db.close();
  });

  it('決済行と打ち切り行を、混ぜずに記録できる', () => {
    const db = openShadowDb(':memory:');
    const censored: ShadowRow = {
      ...base, spec: 'sh02', outcome: 'censored', censored: true, censorReason: 'horizon',
      exitT: null, exitPrice: null, exitReason: null, pnl: null, unrealized: 120,
    };
    const r = insertShadowRows(db, [base, censored]);
    expect(r).toEqual({ inserted: 2, skipped: 0 });
    expect(countShadowRows(db)).toBe(2);
    const rows = db.prepare('SELECT spec, outcome, censored, pnl, unrealized FROM shadow_exits ORDER BY spec')
      .all() as unknown as Array<{ spec: string; outcome: string; censored: number; pnl: number | null; unrealized: number | null }>;
    expect(rows[0]).toEqual({ spec: 'sh01', outcome: 'exit', censored: 0, pnl: 45, unrealized: null });
    expect(rows[1]).toEqual({ spec: 'sh02', outcome: 'censored', censored: 1, pnl: null, unrealized: 120 });
    // 集計の入口も outcome を分けたまま返す(打ち切りを決済に足し込まない)。
    expect(shadowOutcomeCounts(db, 'e1')).toEqual([
      { spec: 'sh01', outcome: 'exit', n: 1 },
      { spec: 'sh02', outcome: 'censored', n: 1 },
    ]);
    db.close();
  });

  it('同じ提案×同じ決済仕様は1行だけ(再生を2回流しても二重計上しない)', () => {
    const db = openShadowDb(':memory:');
    insertShadowRows(db, [base]);
    const r = insertShadowRows(db, [base]);
    expect(r).toEqual({ inserted: 0, skipped: 1 });
    expect(countShadowRows(db)).toBe(1);
    db.close();
  });

  // ★このファイルは公開リポにも載る。決済の実数値は一切書かない・一切 assert しない。
  //   ここで見るのは「epoch と一緒に、変種↔spec の **不透明名の対応** が残ること」という構造だけ。
  it('変種↔spec の対応を epoch と一緒に残す(1年後の分析者が対応を再導出しなくて済む)', () => {
    const db = openShadowDb(':memory:');
    const ladder: ShadowExitLadder = {
      epoch: 'e1', specs: [],
      variantSpecs: { 'current': 'sh01', 'candidate-a': 'sh02' },
    };
    expect(recordShadowLadderMeta(db, ladder)).toEqual({ written: true });
    expect(readShadowLadderMeta(db, 'e1')).toEqual({ 'candidate-a': 'sh02', 'current': 'sh01' });
    // 冪等(同じ内容の再実行で二重に書かない)
    expect(recordShadowLadderMeta(db, ladder)).toEqual({ written: false });
    expect(readShadowLadderMeta(db, 'other-epoch')).toBeNull();
    db.close();
  });

  it('★同じ epoch に **違う対応** を書こうとしたら throw(版を上げずに定義を変えた=集計が壊れる)', () => {
    const db = openShadowDb(':memory:');
    recordShadowLadderMeta(db, { epoch: 'e1', specs: [], variantSpecs: { 'current': 'sh01', 'candidate-a': 'sh02' } });
    expect(() => recordShadowLadderMeta(db, {
      epoch: 'e1', specs: [], variantSpecs: { 'current': 'sh01', 'candidate-a': 'sh07' },
    })).toThrow();
    // 別の epoch なら共存できる(版が違えば対応も違ってよい)
    expect(recordShadowLadderMeta(db, {
      epoch: 'e2', specs: [], variantSpecs: { 'current': 'sh01', 'candidate-a': 'sh07' },
    })).toEqual({ written: true });
    db.close();
  });

  it('対応を持たないラダー(公開フォールバック=影0本)は何も書かない', () => {
    const db = openShadowDb(':memory:');
    expect(recordShadowLadderMeta(db, EMPTY_SHADOW_LADDER)).toEqual({ written: false, skipped: 'no-variant-specs' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM meta').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('非有限の数値は NULL にする(NaN/Infinity を DB に置かない)', () => {
    const db = openShadowDb(':memory:');
    insertShadowRows(db, [{ ...base, spec: 'sh03', mfe: NaN, mae: Infinity, armedPrice: NaN }]);
    const row = db.prepare('SELECT mfe, mae, armed_price FROM shadow_exits WHERE spec = ?').get('sh03') as
      { mfe: number | null; mae: number | null; armed_price: number | null };
    expect(row).toEqual({ mfe: null, mae: null, armed_price: null });
    db.close();
  });
});
