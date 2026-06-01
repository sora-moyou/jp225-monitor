import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, recordTick } from './db/store.js';
import { selectWarmup } from './warmup.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
const M = 60_000;

describe('selectWarmup', () => {
  it('returns null when DB has no NIY=F ticks', () => {
    expect(selectWarmup(memDb(), 100 * M)).toBeNull();
  });

  it('returns null when latest NIY=F tick is older than 2 minutes (stale collector)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 100 * M, 67000);
    expect(selectWarmup(db, 100 * M + 3 * M)).toBeNull();   // 3 min later → stale
  });

  it('returns bars(by symbol) + NIY=F ticks when latest tick is fresh (<2 min)', () => {
    const db = memDb();
    for (let i = 0; i < 65; i++) recordTick(db, 'NIY=F', (100 + i) * M, 67000 + i);
    recordTick(db, 'NQ=F', 164 * M, 30000);
    const now = 165 * M;   // latest NIY=F tick at 164*M → 1 min old → fresh
    const w = selectWarmup(db, now)!;
    expect(w).not.toBeNull();
    expect(w.barsBySymbol.get('NIY=F')!.length).toBeGreaterThanOrEqual(60);
    expect(w.niyTicks.length).toBeGreaterThan(0);
    expect(w.barsBySymbol.get('NQ=F')!.length).toBe(1);
  });
});
