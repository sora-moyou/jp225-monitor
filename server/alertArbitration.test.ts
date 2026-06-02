import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, getRecentAlerts } from './db/store.js';
import { writeHeartbeat, isCollectorAlive } from './collectorHeartbeat.js';

describe('cross-process single-writer arbitration', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jp225-arb-')); dbPath = join(dir, 'jp225.db'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a heartbeat written on one connection is visible on a separate connection (WAL)', () => {
    const collectorDb = openDb(dbPath);   // process A
    const monitorDb = openDb(dbPath);     // process B (separate handle, same file)
    const now = 5_000_000;
    expect(isCollectorAlive(monitorDb, now)).toBe(false);   // no heartbeat yet → monitor would persist
    writeHeartbeat(collectorDb, now);                       // collector stamps
    expect(isCollectorAlive(monitorDb, now + 1_000)).toBe(true);   // monitor SEES it → defers
    collectorDb.close(); monitorDb.close();
  });

  it('the monitor takes over once the heartbeat goes stale', () => {
    const collectorDb = openDb(dbPath);
    const monitorDb = openDb(dbPath);
    const now = 5_000_000;
    writeHeartbeat(collectorDb, now);
    expect(isCollectorAlive(monitorDb, now + 50_000)).toBe(false);   // >45s later → stale → monitor persists
    collectorDb.close(); monitorDb.close();
  });

  it('no rows are pre-existing on a fresh file (sanity)', () => {
    const db = openDb(dbPath);
    expect(getRecentAlerts(db, 10).length).toBe(0);
    db.close();
  });
});
