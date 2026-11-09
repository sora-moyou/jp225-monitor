// collector の心拍/ティック間引きが **DB ロックで collector を落とさない** ことを、実際の SQLite ロックで確かめる。
//
// ★2026-10-27/28 の実事故: 基礎データ取り込みが書き込みロックを 5秒以上持ち、collector の
//   writeHeartbeat → setMeta が `database is locked` を投げ、try の外だったので unhandledRejection →
//   exit code=1 で落ちた。ここでは別の接続で BEGIN IMMEDIATE を握って同じ状況を作る。
//   ★変更前の実装(writeHeartbeat / pruneTicks を直接呼ぶ)に戻すと、ここで例外が外へ出て赤になる。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getMeta } from '../server/db/store.js';
import { HEARTBEAT_KEY } from '../server/collectorHeartbeat.js';
import {
  createHousekeepingState, runHeartbeatStep, runPruneStep, PRUNE_EVERY_MS, TICK_RETENTION_MS,
} from './housekeeping.js';

describe('collector housekeeping(心拍・ティック間引き)は DB ロックで落ちない', () => {
  let dir: string;
  let db: DatabaseSync;
  let holder: DatabaseSync;
  const lines: string[] = [];
  const report = (l: string): void => { lines.push(l); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-hk-'));
    const path = join(dir, 'jp225.db');
    db = openDb(path);
    db.exec('PRAGMA busy_timeout = 20');   // 本番は 5000ms。テストを速くするためだけに短くする(結末は同じ SQLITE_BUSY)
    holder = new DatabaseSync(path);
    lines.length = 0;
  });
  afterEach(() => {
    try { holder.exec('ROLLBACK'); } catch { /* 開いていない */ }
    holder.close(); db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const lock = (): void => {
    holder.exec('BEGIN IMMEDIATE');
    holder.exec("INSERT INTO meta(key,value) VALUES('holder','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  };
  const unlock = (): void => { holder.exec('COMMIT'); };

  it('ロック中の心拍は例外を外へ出さず、連続失敗を数えて5回目で共用ログに出し、復帰も残す', () => {
    const st = createHousekeepingState();
    lock();
    for (let i = 1; i <= 5; i++) {
      expect(() => runHeartbeatStep(db, 1000 + i, st, report)).not.toThrow();
      expect(st.heartbeatStreak).toBe(i);
    }
    // 無音にしない: 5回目(shouldReportStreak の firstAt)で1行。
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('心拍(writeHeartbeat)');
    expect(lines[0]).toContain('5 回連続');
    expect(lines[0]).toMatch(/locked|busy/i);
    unlock();
    // ロックが外れたら心拍は書け、復帰が残る。
    expect(runHeartbeatStep(db, 9999, st, report)).toBe(true);
    expect(getMeta(db, HEARTBEAT_KEY)).toBe('9999');
    expect(st.heartbeatStreak).toBe(0);
    expect(lines.at(-1)).toContain('復帰');
  });

  it('ロック中のティック間引きも例外を外へ出さず、周期は進める(ロック中に毎周回 busy 待ちを繰り返さない)', () => {
    const st = createHousekeepingState();
    const now = 10 * TICK_RETENTION_MS;
    lock();
    expect(() => runPruneStep(db, now, st, report)).not.toThrow();
    expect(st.pruneStreak).toBe(1);
    expect(st.lastPrune).toBe(now);
    // 周期内は実行しない(null)。
    expect(runPruneStep(db, now + 1000, st, report)).toBeNull();
    unlock();
    // 周期が来たら実行・成功で連続失敗はリセット・古い tick は消える。
    db.prepare('INSERT INTO ticks(symbol,t,price) VALUES(?,?,?)').run('NIY=F', 1, 100);
    db.prepare('INSERT INTO ticks(symbol,t,price) VALUES(?,?,?)').run('NIY=F', now, 100);
    expect(runPruneStep(db, now + PRUNE_EVERY_MS + 1, st, report)).toBe(true);
    expect(st.pruneStreak).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM ticks').get() as any).n).toBe(1);
  });
});
