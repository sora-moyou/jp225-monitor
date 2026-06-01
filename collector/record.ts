import type { DatabaseSync } from 'node:sqlite';
import { recordTick } from '../server/db/store.js';
import type { Price } from '../server/types.js';
import type { Bar } from '../server/correlation.js';

/** feed のリアルタイム価格を tick/1分足として DB へ。stale はスキップ。 */
export function recordFeedPrices(db: DatabaseSync, prices: Price[]): void {
  for (const p of prices) {
    if (p.stale) continue;
    recordTick(db, p.symbol, p.timestamp, p.price);
  }
}

/** Yahoo 分足履歴を欠損のみ埋める (close を o=h=l=c として bars_1m に INSERT OR IGNORE)。 */
export function backfillBars(db: DatabaseSync, symbol: string, bars: Bar[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO bars_1m (symbol, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const b of bars) {
    if (Number.isFinite(b.close) && b.close > 0) {
      stmt.run(symbol, b.t, b.close, b.close, b.close, b.close);
    }
  }
}
