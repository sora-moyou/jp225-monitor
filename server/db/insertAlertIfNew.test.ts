import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertAlertIfNew, getRecentAlerts, type AlertInsert } from './store.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
const base: AlertInsert = {
  symbol: 'NIY=F', triggeredAt: 1_000_000, direction: 'up', detectionKind: 'slope',
  windowSeconds: 60, changePercent: 0.4, price: 30000, sessionDate: '2026-06-02', session: 'Day',
};

describe('insertAlertIfNew', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('inserts when no recent duplicate', () => {
    expect(insertAlertIfNew(db, base, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('suppresses a duplicate within the window (same symbol/dir/kind/window)', () => {
    insertAlertIfNew(db, base, 120_000);
    const dup = { ...base, triggeredAt: base.triggeredAt + 90_000 };
    expect(insertAlertIfNew(db, dup, 120_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('allows a distinct direction within the window', () => {
    insertAlertIfNew(db, base, 120_000);
    const opp = { ...base, direction: 'down', triggeredAt: base.triggeredAt + 30_000 };
    expect(insertAlertIfNew(db, opp, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  it('allows the same alert again after the window elapses', () => {
    insertAlertIfNew(db, base, 120_000);
    const later = { ...base, triggeredAt: base.triggeredAt + 200_000 };
    expect(insertAlertIfNew(db, later, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });
});
