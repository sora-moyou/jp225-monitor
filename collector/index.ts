// 日経225 データ収集デーモン v0.4.00。feed を 2秒ごとに DB へ。起動時に Yahoo 分足で backfill。
import { openDb, resolveDbPath } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import { fetchFeedPrices } from '../server/sources/nikkei225jpFeed.js';
import { fetchMinuteBars } from '../server/correlation.js';
import { INSTRUMENTS } from '../server/config.js';

export const COLLECTOR_VERSION = '0.4.00';
const POLL_MS = 2000;
const SYMBOLS = INSTRUMENTS.map(i => i.symbol as string);

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);

  // 起動時 backfill (Yahoo 分足で直近を埋める。失敗は無視)
  await Promise.all(SYMBOLS.map(async (sym) => {
    try { backfillBars(db, sym, await fetchMinuteBars(sym)); }
    catch (err) { console.warn(`[collector] backfill ${sym} failed:`, err instanceof Error ? err.message : err); }
  }));
  console.log('[collector] backfill done');

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    const start = Date.now();
    try {
      const prices = await fetchFeedPrices();
      recordFeedPrices(db, prices);
    } catch (err) {
      console.error('[collector] poll error:', err instanceof Error ? err.message : err);
    }
    const wait = Math.max(0, POLL_MS - (Date.now() - start));
    await new Promise(r => setTimeout(r, wait));
  }
  db.close();
  console.log('[collector] stopped');
}

void main();
