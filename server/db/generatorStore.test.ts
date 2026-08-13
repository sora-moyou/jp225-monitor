// 分析用の台帳(専用DB)の検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   generatorStore.ts が無いため import 段で解決できず、このファイルは全部赤。
//   また列(epoch / cycle_id / arm / retried / pre_retry_reason / shot_id / none_reason 等)の
//   どれか1つでも欠けたスキーマでは INSERT が失敗し、下のテストは赤になる。
//   lite ゲート(openGeneratorDb の isAnalysisEnabled)を外すと「lite では開けない」が赤になる。

import { describe, it, expect, afterEach } from 'vitest';
import {
  openGeneratorDb, openGeneratorDbReadOnly, resolveGeneratorDbPath,
  insertProposal, insertRun, appendDailyTally, countProposals, readGeneratorLedgerStatus,
  type ProposalRow,
} from './generatorStore.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const base: ProposalRow = {
  epoch: 'g1:abc', cycleId: 'c-1', arm: 'current', exitVariant: 'current', seq: 0,
  sessionDate: '2026-08-03', requestedAt: 1_700_000_000_000, respondedAt: 1_700_000_010_000, latencyMs: 10_000,
  status: 'plan', skipReason: null, httpStatus: 200, error: null,
  retried: 0, retryCount: 0, preRetryReason: null,
  direction: 'none', planJson: '{"direction":"none"}', refPrice: 38_250, regime: 'range', confidence: 40,
  noneReason: 'trend', noneLegsJson: '{"dir":"buy","legs":[]}', vetoFired: 1, rangeAnomalyJson: null,
  shotId: 'aa-1', shotAgeMs: 0, shotOrigin: 'fresh', createdAt: 1_700_000_010_000,
};

const tmpDirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'jp225-gen-'));
  tmpDirs.push(d);
  return join(d, 'generator_proposals.db');
}
afterEach(() => {
  while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('台帳の置き場所', () => {
  it('★共有 DB(jp225.db)とは別ファイルに置く(trade2 の VACUUM INTO を太らせない)', () => {
    delete process.env.JP225_GENERATOR_DB;
    const p = resolveGeneratorDbPath();
    expect(p.endsWith('jp225.db')).toBe(false);
    expect(p).toContain('generator');
  });
  it('環境変数で上書きできる(隔離テスト/オフライン再生用)', () => {
    process.env.JP225_GENERATOR_DB = 'C:/tmp/x.db';
    expect(resolveGeneratorDbPath()).toBe('C:/tmp/x.db');
    delete process.env.JP225_GENERATOR_DB;
  });
});

describe('スキーマ — 列は最初から全部持たせる', () => {
  it('提案・見送り理由・腕・サイクルID・epoch・再試行・撮影の同一性の列がある', () => {
    const db = openGeneratorDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(proposals)').all() as unknown as Array<{ name: string }>).map(c => c.name);
    for (const c of [
      'epoch', 'cycle_id', 'arm', 'exit_variant', 'seq', 'session_date',
      'requested_at', 'responded_at', 'latency_ms', 'status', 'skip_reason', 'http_status', 'error',
      'retried', 'retry_count', 'pre_retry_reason',
      'direction', 'plan_json', 'ref_price', 'regime', 'confidence',
      'none_reason', 'none_legs_json', 'veto_fired', 'range_anomaly_json',
      'shot_id', 'shot_age_ms', 'shot_origin', 'created_at',
    ]) expect(cols).toContain(c);
    db.close();
  });

  it('起動ごとの追記表(runs)と、取引日ごとの件数(daily_tally)を持つ', () => {
    const db = openGeneratorDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{ name: string }>)
      .map(t => t.name);
    expect(tables).toContain('runs');
    expect(tables).toContain('daily_tally');
    db.close();
  });
});

describe('記録(全数・追記のみ)', () => {
  it('見送り(none)もエラーも skipped も全部1行として入る', () => {
    const db = openGeneratorDb(':memory:');
    expect(insertProposal(db, base)).toBe(true);
    expect(insertProposal(db, { ...base, cycleId: 'c-2', status: 'plan-error', direction: null, planJson: null, error: 'chart-not-generated' })).toBe(true);
    expect(insertProposal(db, { ...base, cycleId: 'c-3', status: 'skipped', skipReason: 'busy', httpStatus: 429, retried: 1, retryCount: 1, preRetryReason: 'busy' })).toBe(true);
    expect(countProposals(db)).toBe(3);
    const row = db.prepare('SELECT * FROM proposals WHERE cycle_id = ?').get('c-3') as Record<string, unknown>;
    expect(row.skip_reason).toBe('busy');
    expect(row.retried).toBe(1);
    expect(row.pre_retry_reason).toBe('busy');
    db.close();
  });

  it('★同じ (epoch, cycle_id, arm) は1行だけ(再送しても二重計上しない)', () => {
    const db = openGeneratorDb(':memory:');
    expect(insertProposal(db, base)).toBe(true);
    expect(insertProposal(db, base)).toBe(false);
    expect(countProposals(db)).toBe(1);
    db.close();
  });

  it('★同じサイクルの ①/①\'/② は腕が違うので3行として共存する(対応比較の結合キー)', () => {
    const db = openGeneratorDb(':memory:');
    insertProposal(db, { ...base, arm: 'current', seq: 0 });
    insertProposal(db, { ...base, arm: 'control', seq: 1 });
    insertProposal(db, { ...base, arm: 'candidate-a', exitVariant: 'candidate-a', seq: 2 });
    expect(countProposals(db)).toBe(3);
    const arms = (db.prepare('SELECT arm FROM proposals WHERE cycle_id = ? ORDER BY seq').all('c-1') as unknown as Array<{ arm: string }>).map(r => r.arm);
    expect(arms).toEqual(['current', 'control', 'candidate-a']);
    db.close();
  });

  it('起動を追記する(凍結設定・決済の版と指紋・epoch の入力を残す)', () => {
    const db = openGeneratorDb(':memory:');
    insertRun(db, {
      startedAt: 1, epoch: 'g1:abc', monitorUrl: 'http://127.0.0.1:3000',
      exitImpl: 'private', exitVariantImpl: 'private', exitConfigVersion: 3, exitConfigHash: 'e01dde67fe62b2f8',
      settingsJson: '{"scalpLcFloorYen":45}', epochInputJson: '{"schema":"g1"}', generatorConfigJson: '{"intervalMs":120000}',
    });
    const r = db.prepare('SELECT * FROM runs').get() as Record<string, unknown>;
    expect(r.exit_config_hash).toBe('e01dde67fe62b2f8');
    expect(r.settings_json).toBe('{"scalpLcFloorYen":45}');
    db.close();
  });
});

describe('取引日ごとの件数(append-only)— 「いつ止まったか」が必ず読める', () => {
  it('★更新ではなく追記する(過去のスナップショットが残る)', () => {
    const db = openGeneratorDb(':memory:');
    insertProposal(db, base);
    expect(appendDailyTally(db, 1_700_000_100_000)).toBe(1);
    insertProposal(db, { ...base, cycleId: 'c-2' });
    expect(appendDailyTally(db, 1_700_000_200_000)).toBe(1);
    const rows = db.prepare('SELECT at, n FROM daily_tally ORDER BY at').all() as unknown as Array<{ at: number; n: number }>;
    expect(rows).toEqual([{ at: 1_700_000_100_000, n: 1 }, { at: 1_700_000_200_000, n: 2 }]);
    db.close();
  });

  it('腕別・見送り理由別に分けて数える', () => {
    const db = openGeneratorDb(':memory:');
    insertProposal(db, { ...base, arm: 'current', noneReason: 'trend' });
    insertProposal(db, { ...base, arm: 'candidate-a', exitVariant: 'candidate-a', noneReason: 'ai' });
    insertProposal(db, { ...base, cycleId: 'c-2', arm: 'candidate-a', exitVariant: 'candidate-a', noneReason: 'ai' });
    appendDailyTally(db, 9);
    const rows = db.prepare('SELECT arm, none_reason, n FROM daily_tally ORDER BY arm, none_reason').all() as unknown as
      Array<{ arm: string; none_reason: string; n: number }>;
    expect(rows).toEqual([
      { arm: 'candidate-a', none_reason: 'ai', n: 2 },
      { arm: 'current', none_reason: 'trend', n: 1 },
    ]);
    db.close();
  });

  it('セッション外(session_date=NULL)は (closed) として数える', () => {
    const db = openGeneratorDb(':memory:');
    insertProposal(db, { ...base, sessionDate: null, status: 'skipped', skipReason: 'closed', noneReason: null });
    appendDailyTally(db, 9);
    const r = db.prepare('SELECT session_date, status, none_reason FROM daily_tally').get() as Record<string, unknown>;
    expect(r.session_date).toBe('(closed)');
    expect(r.status).toBe('skipped');
    expect(r.none_reason).toBe('');
    db.close();
  });
});

describe('/api/status 用の死活読み取り(readOnly・例外を投げない)', () => {
  it('★台帳が無い環境では available:false(表示のために台帳を作らない)', () => {
    const p = join(tmpdir(), `jp225-gen-missing-${Date.now()}.db`);
    const s = readGeneratorLedgerStatus(p, Date.now());
    expect(s.available).toBe(false);
    expect(s.lastRecordAt).toBeNull();
    expect(openGeneratorDbReadOnly(p)).toBeNull();
  });

  it('★最終記録が何分前かを返す(腕別の当日件数つき)', () => {
    const p = tmpDb();
    const db = openGeneratorDb(p);
    insertProposal(db, { ...base, arm: 'current' });
    insertProposal(db, { ...base, arm: 'candidate-a', exitVariant: 'candidate-a' });
    db.close();
    const now = base.requestedAt + 7 * 60_000;
    const s = readGeneratorLedgerStatus(p, now);
    expect(s.available).toBe(true);
    expect(s.lastRecordAt).toBe(base.requestedAt);
    expect(s.ageMin).toBe(7);
    expect(s.total).toBe(2);
    expect(s.today).toEqual([
      { sessionDate: '2026-08-03', arm: 'candidate-a', n: 1 },
      { sessionDate: '2026-08-03', arm: 'current', n: 1 },
    ]);
  });

  it('★読み取り専用で開く(そのハンドルからは1行も書けない)', () => {
    const p = tmpDb();
    const db = openGeneratorDb(p);
    insertProposal(db, base);
    db.close();
    const ro = openGeneratorDbReadOnly(p);
    expect(ro).not.toBeNull();
    // readOnly を外すと ここが書けてしまう(=表示のために台帳を書き換えられる状態)。
    expect(() => ro!.exec("INSERT INTO meta (key, value) VALUES ('x','y')")).toThrow();
    ro!.close();
    const check = openGeneratorDb(p);
    expect(countProposals(check)).toBe(1);
    check.close();
  });

  it('★台帳が無いときに読んでも **ファイルを作らない**(「まだ動いていない」を捏造しない)', () => {
    const p = join(tmpdir(), `jp225-gen-nocreate-${Date.now()}.db`);
    readGeneratorLedgerStatus(p, Date.now());
    expect(existsSync(p)).toBe(false);
  });
});

describe('公開版(lite)では台帳を開かない', () => {
  it('★lite で openGeneratorDb は throw する(黙って専用DBが増え続けない)', () => {
    const saved = process.env.MONITOR_VARIANT;
    process.env.MONITOR_VARIANT = 'lite';
    try {
      expect(() => openGeneratorDb(':memory:')).toThrow(/分析専用/);
    } finally {
      if (saved === undefined) delete process.env.MONITOR_VARIANT; else process.env.MONITOR_VARIANT = saved;
    }
  });
});
