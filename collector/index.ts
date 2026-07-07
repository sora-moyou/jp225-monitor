// 日経225 データ収集デーモン v0.5.00。公開 HTTP フィード(ajax_cme/ajax_fx)を 2秒ごとに DB へ。
// v0.5.00: デーモン単独でアラート検知→DB記録(単一ライター・ハートビート調停)。アプリ閉でも24/7記録。
// v0.7.20: 価格源を公開 HTTP のみに統一(socket / Yahoo backfill を全廃)。
import { openDb, resolveDbPath, pruneTicks } from '../server/db/store.js';
import { recordFeedPrices } from './record.js';
// v0.7.20(全銘柄 HTTP 化): 価格の主経路を monitor の priceLoop と同一にする。socket / Yahoo realtime を全廃し、
// 監視 4 銘柄すべてを公開 HTTP から取る: ajax_cme.js(NIY=F/YM=F/NQ=F)+ ajax_fx.js(JPY=X)。両者とも毎 GET
// 新スナップショット(long-lived セッション無し=ドリフト無し)。合成は priceLoop の純関数 mergeSources を再利用。
import { fetchAjaxCmePrices } from '../server/sources/ajaxCmePrice.js';
import { fetchAjaxFxPrices } from '../server/sources/ajaxFxPrice.js';
import { mergeSources } from '../server/loops/priceLoop.js';
import type { Price } from '../server/types.js';
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

// 公開 HTTP(ajax_cme/ajax_fx)へのポライトネス: collector は 2s ポールだが、monitor の priceLoop も同じ
// エンドポイントを叩くため、collector 側の GET は ~4s に間引く(直近取得をキャッシュ)。
const AJAX_MIN_INTERVAL_MS = 4000;
let ajaxCache: Price[] = [];
let ajaxCacheAt = 0;

/** ~4s に間引いて ajax_cme(NIY=F/YM=F/NQ=F)+ ajax_fx(JPY=X)の全 fresh 価格を取得。前回取得が新しければ
 *  キャッシュを、その現在値として「新鮮な timestamp を付け直して」返す(recordFeedPrices が今この瞬間の
 *  tick として記録できるように)。取得不能は []。stale はここで既に落としてある(mergeSources)。 */
async function fetchAjaxThrottled(now: number): Promise<Price[]> {
  if (now - ajaxCacheAt >= AJAX_MIN_INTERVAL_MS) {
    const [cme, fx] = await Promise.all([fetchAjaxCmePrices(), fetchAjaxFxPrices()]);
    const fresh = mergeSources([cme, fx]);   // fresh(stale:false)のみ
    if (fresh.length) { ajaxCache = fresh; ajaxCacheAt = now; }
    return fresh;
  }
  // キャッシュ再利用: 直近取得値をこの瞬間の現在値として timestamp を更新して返す。
  return ajaxCache.map(p => ({ ...p, timestamp: now }));
}

async function main(): Promise<void> {
  if (!acquireLock()) { console.log('[collector] another instance is running — exiting'); return; }
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);
  console.log(`[collector] started ${new Date().toISOString()} (node ${process.version})`);

  // v0.7.20(全銘柄 HTTP 化 / no-Yahoo): 起動時 Yahoo backfill を全廃した。全 4 銘柄(NIY=F/YM=F/NQ=F/JPY=X)の
  // bars_1m は公開 HTTP のリアルタイム tick 経路(recordFeedPrices)だけで積む。ウォームアップは収集 DB からの
  // warmFromDb で賄う(Yahoo の遅延足を混ぜない = 実弾安全 v0.7.9 を全銘柄へ徹底)。
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
        // 価格の主経路(monitor priceLoop と同一): 全 4 銘柄を公開 HTTP から(~4s 間引き)。
        // fetchAjaxThrottled は既に fresh(stale:false)のみを返す(mergeSources 済み)。
        const prices = await fetchAjaxThrottled(start);
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
