// 日経225 データ収集デーモン v0.5.00。feed を 2秒ごとに DB へ。起動時に Yahoo 分足で backfill。
// v0.5.00: デーモン単独でアラート検知→DB記録(単一ライター・ハートビート調停)。アプリ閉でも24/7記録。
import { openDb, resolveDbPath, pruneTicks } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
// v0.7.18: 旧 HTTP フィード fetchFeedPrices(ajax_TOP.js)は上流廃止で死んでいたため撤去。
// 価格の主経路を monitor の priceLoop と同一にする: NIY=F は ajax_cme(HTTP・毎GET新スナップショット)、
// 副銘柄(NQ=F/YM=F/^HSI/CL=F/^TNX/JPY=X)は socket。合成は priceLoop の純関数 mergeSources を再利用。
import { getSocketPrices, startSocket, stopSocket } from '../server/sources/nikkei225jpSocket.js';
import { fetchAjaxCmePrice } from '../server/sources/ajaxCmePrice.js';
import { mergeSources } from '../server/loops/priceLoop.js';
import type { Price } from '../server/types.js';
import { fetchMinuteBars } from '../server/correlation.js';
import { INSTRUMENTS } from '../server/config.js';
import { inPollWindow } from './session.js';
import { acquireLock, releaseLock } from './lock.js';
import { AlertCollector } from './alertCollector.js';
import { writeHeartbeat } from '../server/collectorHeartbeat.js';
import { setCooldownMs } from '../server/alertCooldown.js';
import { resolveCooldownMin } from '../server/configStore.js';
import { warmFromDb } from '../server/warmup.js';

// バンドルした依存(express/rss-parser/https-proxy-agent 等)が出す非推奨警告(DEP0169 url.parse 等)を抑制。
// 自前コードは url.parse 不使用。これは deprecation 種別のみを抑え、他の警告は残す。
process.noDeprecation = true;

export const COLLECTOR_VERSION = '0.5.00';
const POLL_MS = 2000;
const IDLE_MS = 30_000;
const SYMBOLS = INSTRUMENTS.map(i => i.symbol as string);

// ajax_cme(公開 HTTP)へのポライトネス: collector は 2s ポールだが、monitor の priceLoop も同じ
// エンドポイントを叩くため、collector 側の GET は ~4s に間引く(直近取得をキャッシュ)。socket 読みは
// ローカルのメモリスナップショットなので毎ポール(2s)でよい。
const AJAX_CME_MIN_INTERVAL_MS = 4000;
let ajaxCmeCache: Price | null = null;
let ajaxCmeCacheAt = 0;

/** ~4s に間引いて ajax_cme の NIY=F を取得。前回取得が新しければキャッシュを、その現在値として
 *  「新鮮な timestamp を付け直して」返す(recordFeedPrices が今この瞬間の tick として記録できるように)。
 *  取得不能/古い(stale)キャッシュは null(recordFeedPrices 側で無視される)。 */
async function fetchAjaxCmeThrottled(now: number): Promise<Price | null> {
  if (now - ajaxCmeCacheAt >= AJAX_CME_MIN_INTERVAL_MS) {
    const fresh = await fetchAjaxCmePrice('136');
    if (fresh) { ajaxCmeCache = fresh; ajaxCmeCacheAt = now; }
    return fresh;
  }
  // キャッシュ再利用: 直近取得値をこの瞬間の現在値として timestamp を更新して返す。
  if (ajaxCmeCache && !ajaxCmeCache.stale) return { ...ajaxCmeCache, timestamp: now };
  return null;
}

async function main(): Promise<void> {
  if (!acquireLock()) { console.log('[collector] another instance is running — exiting'); return; }
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);
  console.log(`[collector] started ${new Date().toISOString()} (node ${process.version})`);

  // 起動時 backfill (Yahoo 分足で直近を埋める。失敗は無視)
  // v0.7.18(実弾安全 v0.7.9 の徹底): NIY=F は Yahoo(CME・約10分ディレイ)から backfill しない。
  // NIY=F の bars_1m は ajax_cme のリアルタイム tick 経路(recordFeedPrices)だけで積む。
  // 副銘柄(NQ/YM/HSI/CL/TNX/JPY 等)は従来どおり Yahoo で欠損を埋める(相関/AI 説明の元ネタ)。
  await Promise.all(SYMBOLS.filter(sym => sym !== 'NIY=F').map(async (sym) => {
    try { backfillBars(db, sym, await fetchMinuteBars(sym)); }
    catch (err) { console.warn(`[collector] backfill ${sym} failed:`, err instanceof Error ? err.message : err); }
  }));
  console.log('[collector] backfill done');

  setCooldownMs(resolveCooldownMin() * 60_000);   // match the monitor's configured cooldown (before AlertCollector, which reads it)
  warmFromDb();                                    // freshness-gated seed of the feedBars realtime buffer (reused, tested)
  startSocket();                                   // 副銘柄(NQ=F/YM=F/^HSI/CL=F/^TNX/JPY=X)のリアルタイム socket を接続
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
        // 価格の主経路(monitor priceLoop と同一): NIY=F は ajax_cme(HTTP・~4s 間引き)、副銘柄は socket。
        // mergeSources に yahoo=[] を渡す — collector のリアルタイム記録経路は socket+ajax_cme のみ。
        // (NIY=F は決して Yahoo(CME・約10分ディレイ)から記録しない。Yahoo は起動 backfillBars 専用。)
        const ajaxCme = await fetchAjaxCmeThrottled(start);
        const feed = getSocketPrices(Date.now());
        const prices = mergeSources([], feed, ajaxCme);
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
  stopSocket();
  releaseLock();
  db.close();
  console.log('[collector] stopped');
}

void main();
