import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentBars } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import type { Price } from '../server/types.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
function px(symbol: Price['symbol'], price: number, t: number): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale: false };
}

describe('recordFeedPrices (session-aware)', () => {
  it('writes in-session prices with session tag; drops out-of-session and stale', () => {
    const db = memDb();
    // 2026-06-01 is Monday. 12:00 JST = Day session; 16:00 JST = break (closed)
    const daySession = Date.UTC(2026, 5, 1, 12 - 9, 0, 0);    // Mon 12:00 JST
    const breakTime  = Date.UTC(2026, 5, 1, 16 - 9, 0, 0);    // Mon 16:00 JST (closed)
    recordFeedPrices(db, [px('NIY=F', 67000, daySession)]);
    recordFeedPrices(db, [px('NIY=F', 99999, breakTime)]);                       // out of session → dropped
    recordFeedPrices(db, [{ ...px('NIY=F', 88888, daySession + 1000), stale: true }]); // stale → dropped
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.session).toBe('Day');
    expect(bars[0]!.session_date).toBe('2026-06-01');
  });
});

describe('backfillBars (session-tagged, idempotent)', () => {
  it('tags each backfilled bar by its open time and skips out-of-session bars', () => {
    const db = memDb();
    const t1 = Date.UTC(2026, 5, 1, 12 - 9, 0, 0);   // Mon 12:00 JST (Day)
    const t2 = Date.UTC(2026, 5, 1, 16 - 9, 0, 0);   // Mon 16:00 JST (closed → skipped)
    backfillBars(db, 'NIY=F', [{ t: t1, close: 67000 }, { t: t2, close: 67100 }]);
    backfillBars(db, 'NIY=F', [{ t: t1, close: 67000 }]);            // idempotent
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.t).toBe(Math.floor(t1 / 60_000) * 60_000);
    expect(bars[0]!.session).toBe('Day');
  });
});
