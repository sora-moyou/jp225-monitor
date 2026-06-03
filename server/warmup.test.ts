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

  it('returns null when latest NIY=F tick is older than the freshness window (30s)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 100 * M, 67000, '2026-06-01', 'Day');
    expect(selectWarmup(db, 100 * M + 60_000)).toBeNull();   // 60s later (>30s) → stale
  });

  it('returns bars(by symbol) + NIY=F ticks when latest tick is fresh (≤30s)', () => {
    const db = memDb();
    for (let i = 0; i < 65; i++) recordTick(db, 'NIY=F', (100 + i) * M, 67000 + i, '2026-06-01', 'Day');
    recordTick(db, 'NQ=F', 164 * M, 30000, '2026-06-01', 'Day');
    const now = 164 * M + 20_000;   // latest NIY=F tick at 164*M → 20s old → fresh
    const w = selectWarmup(db, now)!;
    expect(w).not.toBeNull();
    expect(w.barsBySymbol.get('NIY=F')!.length).toBeGreaterThanOrEqual(60);
    expect(w.niyTicks.length).toBeGreaterThan(0);
    expect(w.barsBySymbol.get('NQ=F')!.length).toBe(1);
  });

  it('未来日時のバー/ティックは種付けしない(基礎データ取り込みの未来バー対策)', () => {
    const db = memDb();
    for (let i = 0; i < 65; i++) recordTick(db, 'NIY=F', (100 + i) * M, 67000 + i, '2026-06-01', 'Day');
    const now = 164 * M + 20_000;
    // now より未来のバー/ティック(取り込みデータの夜間翌朝ぶん等)を追加
    recordTick(db, 'NIY=F', 300 * M, 68000, '2026-06-02', 'Night');
    const w = selectWarmup(db, now)!;
    const niyBars = w.barsBySymbol.get('NIY=F')!;
    expect(niyBars.every(b => b.t <= now)).toBe(true);            // 未来バーは含まれない
    expect(niyBars.some(b => b.t === 300 * M)).toBe(false);
    expect(w.niyTicks.every(t => t.t <= now)).toBe(true);         // 未来ティックも含まれない
  });
});
