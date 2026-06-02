// 日経225 データ収集デーモン v0.5.00。feed を 2秒ごとに DB へ。起動時に Yahoo 分足で backfill。
// v0.5.00: デーモン単独でアラート検知→DB記録(単一ライター・ハートビート調停)。アプリ閉でも24/7記録。
import { openDb, resolveDbPath, pruneTicks } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import { fetchFeedPrices } from '../server/sources/nikkei225jpFeed.js';
import { fetchMinuteBars } from '../server/correlation.js';
import { INSTRUMENTS } from '../server/config.js';
import { inPollWindow } from './session.js';
import { acquireLock, releaseLock } from './lock.js';
import { AlertCollector } from './alertCollector.js';
import { writeHeartbeat } from '../server/collectorHeartbeat.js';
import { setCooldownMs } from '../server/alertCooldown.js';
import { resolveCooldownMin } from '../server/configStore.js';
import { warmFromDb } from '../server/warmup.js';

export const COLLECTOR_VERSION = '0.5.00';
const POLL_MS = 2000;
const IDLE_MS = 30_000;
const SYMBOLS = INSTRUMENTS.map(i => i.symbol as string);

async function main(): Promise<void> {
  if (!acquireLock()) { console.log('[collector] another instance is running — exiting'); return; }
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);

  // 起動時 backfill (Yahoo 分足で直近を埋める。失敗は無視)
  await Promise.all(SYMBOLS.map(async (sym) => {
    try { backfillBars(db, sym, await fetchMinuteBars(sym)); }
    catch (err) { console.warn(`[collector] backfill ${sym} failed:`, err instanceof Error ? err.message : err); }
  }));
  console.log('[collector] backfill done');

  setCooldownMs(resolveCooldownMin() * 60_000);   // match the monitor's configured cooldown (before AlertCollector, which reads it)
  warmFromDb();                                    // freshness-gated seed of the feedBars realtime buffer (reused, tested)
  const alerts = new AlertCollector(db);
  console.log('[collector] alert detection armed');
  let lastFollowup = 0;

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  let lastPrune = 0;
  while (running) {
    const start = Date.now();
    let wait = IDLE_MS;
    writeHeartbeat(db, start);
    if (inPollWindow(start)) {
      try {
        const prices = await fetchFeedPrices();
        recordFeedPrices(db, prices);
        // Feed the realtime detector for the SAME set the monitor's priceLoop feeds: all fresh
        // (non-stale) prices, no session gate here. The sink stamps session metadata per alert;
        // the engine only fires for NIY=F. recordFeedPrices already handles DB persistence + its
        // own stale/session gating for tick storage.
        for (const p of prices) {
          if (p.stale) continue;
          alerts.onPrice(p.symbol, p.price, p.timestamp);
        }
        alerts.onMinute(Date.now());
      } catch (err) {
        console.error('[collector] poll error:', err instanceof Error ? err.message : err);
      }
      wait = POLL_MS;
    }
    if (start - lastFollowup > 30_000) { try { alerts.followup(start); } catch { /* ignore */ } lastFollowup = start; }
    // 1分に1回、3日より古い tick を間引く (bars_1m は長期保持)
    if (Date.now() - lastPrune > 60_000) {
      pruneTicks(db, Date.now() - 3 * 24 * 60 * 60 * 1000);
      lastPrune = Date.now();
    }
    await new Promise(r => setTimeout(r, Math.max(0, wait - (Date.now() - start))));
  }
  releaseLock();
  db.close();
  console.log('[collector] stopped');
}

void main();
