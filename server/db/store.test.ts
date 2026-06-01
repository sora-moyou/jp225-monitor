import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { initSchema, recordTick, getRecentBars, getRecentTicks, getLatestTick, openDb, pruneTicks } from './store.js';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}
const M = 60_000;

describe('store', () => {
  it('recordTick inserts a tick and creates a 1m bar (o=h=l=c on first tick of minute)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    expect(getRecentTicks(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', t: 10 * M + 1000, price: 67000 }]);
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', session_date: '2026-06-01', session: 'Day', t: 10 * M, o: 67000, h: 67000, l: 67000, c: 67000 }]);
  });

  it('recordTick updates the same minute bar h/l/c, keeps o', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 20000, 67080, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 40000, 66950, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 59000, 67010, '2026-06-01', 'Day');
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([
      { symbol: 'NIY=F', session_date: '2026-06-01', session: 'Day', t: 10 * M, o: 67000, h: 67080, l: 66950, c: 67010 },
    ]);
  });

  it('recordTick rolls to a new bar on minute change', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 11 * M + 1000, 67100, '2026-06-01', 'Day');
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars.map(b => [b.t, b.c])).toEqual([[10 * M, 67000], [11 * M, 67100]]);
  });

  it('duplicate tick (same symbol+t) is ignored, no throw', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    expect(getRecentTicks(db, 'NIY=F', 0)).toHaveLength(1);
  });

  it('getRecentBars filters by sinceT and is per-symbol, ascending t', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 9 * M, 100, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M, 200, '2026-06-01', 'Day');
    recordTick(db, 'NQ=F', 10 * M, 300, '2026-06-01', 'Day');
    expect(getRecentBars(db, 'NIY=F', 10 * M).map(b => b.t)).toEqual([10 * M]);
    expect(getRecentBars(db, 'NQ=F', 0)).toHaveLength(1);
  });

  it('getLatestTick returns the newest tick or null', () => {
    const db = memDb();
    expect(getLatestTick(db, 'NIY=F')).toBeNull();
    recordTick(db, 'NIY=F', 10 * M, 100, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 11 * M, 200, '2026-06-01', 'Day');
    expect(getLatestTick(db, 'NIY=F')).toEqual({ symbol: 'NIY=F', t: 11 * M, price: 200 });
  });

  it('bar carries session_date + session from recordTick', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Night');
    const b = getRecentBars(db, 'NIY=F', 0)[0]!;
    expect(b.session_date).toBe('2026-06-01');
    expect(b.session).toBe('Night');
    expect(b.t).toBe(10 * M);
  });
});

describe('pruneTicks', () => {
  it('deletes ticks older than cutoff but keeps bars_1m', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 1 * 60_000, 100, '2026-06-01', 'Day');   // old
    recordTick(db, 'NIY=F', 100 * 60_000, 200, '2026-06-01', 'Day'); // recent
    pruneTicks(db, 50 * 60_000);
    expect(getRecentTicks(db, 'NIY=F', 0).map(t => t.t)).toEqual([100 * 60_000]);
    expect(getRecentBars(db, 'NIY=F', 0)).toHaveLength(2);  // bars 保持
  });
});

describe('openDb', () => {
  it('opens a file db with WAL and persists across reopen', () => {
    const path = join(tmpdir(), `jp225-test-${process.pid}.db`);
    rmSync(path, { force: true });
    const db1 = openDb(path);
    recordTick(db1, 'NIY=F', 10 * 60_000, 67000, '2026-06-01', 'Day');
    db1.close();
    const db2 = openDb(path);
    expect(getRecentBars(db2, 'NIY=F', 0)).toHaveLength(1);
    db2.close();
    rmSync(path, { force: true });
    rmSync(path + '-wal', { force: true });
    rmSync(path + '-shm', { force: true });
  });
});
