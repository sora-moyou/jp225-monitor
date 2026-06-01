import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentBars } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import type { Price } from '../server/types.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
function px(symbol: Price['symbol'], price: number, t: number): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale: false };
}
const M = 60_000;

describe('recordFeedPrices', () => {
  it('writes every feed price as a tick/bar (skips stale)', () => {
    const db = memDb();
    recordFeedPrices(db, [px('NIY=F', 67000, 10 * M), px('NQ=F', 30000, 10 * M)]);
    recordFeedPrices(db, [{ ...px('NIY=F', 99999, 11 * M), stale: true }]);  // stale → skip
    expect(getRecentBars(db, 'NIY=F', 0).map(b => b.c)).toEqual([67000]);
    expect(getRecentBars(db, 'NQ=F', 0)).toHaveLength(1);
  });
});

describe('backfillBars', () => {
  it('inserts only missing 1m bars from fetched history (idempotent)', () => {
    const db = memDb();
    const bars = [{ t: 10 * M, close: 67000 }, { t: 11 * M, close: 67100 }];
    backfillBars(db, 'NIY=F', bars);
    backfillBars(db, 'NIY=F', bars);   // 2回目は何も増えない
    const out = getRecentBars(db, 'NIY=F', 0);
    expect(out.map(b => [b.t, b.c])).toEqual([[10 * M, 67000], [11 * M, 67100]]);
    expect(out.every(b => b.o === b.h && b.h === b.l && b.l === b.c)).toBe(true);
  });
});
