import { fetchAjaxCmePrices, ajaxCmeFeedState } from '../sources/ajaxCmePrice.js';
import { fetchAjaxFxPrices } from '../sources/ajaxFxPrice.js';
import { feedRealtimePrice } from '../feedBars.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import { inPollWindow, isMarketOpen } from '../../core/session.js';
import type { Price } from '../types.js';
import { feedPrice as tickDetectorFeed, getMomentum } from '../tickDetector.js';
import { feedSignalEngine } from '../signalTrade/engine.js';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import {
  buildPriceFeedHeartbeat, formatPriceFeedStatus, writePriceFeedHeartbeat,
  publishPriceFeedHeartbeat, niyStaleWatch,
  PRICE_FEED_HEARTBEAT_MS, type PriceFeedHeartbeat, type PriceFeedState,
} from '../db/priceFeedHeartbeat.js';

// v0.7.20(全銘柄 HTTP 化): 価格の全経路を公開 HTTP(ajax_cme2.js / ajax_fx.js)に統一。socket と Yahoo を
// 全廃した。ajax_cme2.js を 1 GET して NIY=F(136)/YM=F(731)/NQ=F(737)、ajax_fx.js を 1 GET して JPY=X(511)。
// (v0.9.110: 旧 ajax_cme.js は提供元が 2026-09-06 08:19 JST に凍結させたため ajax_cme2.js へ差し替え)
// どちらも毎 GET 新スナップショット = 長寿命セッションドリフト(約10分遅延)の事故が原理的に起きない。
// すべて real-time なので NIY=F の「遅延源を混ぜない」実取引安全ルールは自動的に満たされる(遅延 substitute が
// 存在しない)。取得失敗/清算(stale)の銘柄は mergeWithCached で前回値を stale として持ち越す。全滅時のみ
// バックオフして劣化中 (ステータス黄) を示す。

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let running = false;
let degradedUntil = 0;          // 全取得失敗でバックオフ中はこの時刻まで「劣化中」
let intervalMs = resolvePricePollMs();

// v0.7.17 診断: ajax_cme(HTTP)による取得の成否を明示ログする。毎ポール出すとスパムなので、
// 状態変化時と 60 秒ごとの1回だけ出す。
//
// ★v0.9.110: 文言が **事実と違っていた**。旧実装は「stale かどうか」しか見ずに、取得に成功して
//   liveFlag=0 だっただけの場合にも `HTTP フィード失敗(jss2/225225 両方)` と出していた
//   (2026-09-06〜08 の実ログに 1,355 行。読んだ人を「ネットワーク障害」へ誤誘導する)。
//   → 「取得失敗」「清算(liveFlag=0)」「★提供元の時計が凍結」「新鮮」を **区別して** 出す。
//   同じ判定を meta(price_feed_status)にも書くので、DB を開かずに気づける。
let ajaxCmeLoggedState: PriceFeedState | null = null;
let ajaxCmeLoggedAt = 0;
let priceFeedHbAt = 0;
let priceFeedDb: DatabaseSync | null = null;

function logAjaxCmeState(prices: readonly Price[], nowMs: number): PriceFeedHeartbeat {
  // ★立会中の NIY=F 欠測(2026-09-06 の損害の本体)も同じ判定に載せる。
  //   ここは **表示と記録のためだけ** に測る。prices も stale フラグも書き換えない。
  const niy = niyStaleWatch.observe(prices, nowMs);
  const hb = buildPriceFeedHeartbeat({ now: nowMs, prices, feed: ajaxCmeFeedState(), niy });
  publishPriceFeedHeartbeat(hb);   // 画面(/api/status)は常にこの最新の結論を見る
  if (hb.state !== ajaxCmeLoggedState || nowMs - ajaxCmeLoggedAt >= 60_000) {
    const line = `[priceLoop] ajax_cme2(HTTP): ${formatPriceFeedStatus(hb)}`;
    if (hb.state === 'ok' || hb.state === 'settled') console.log(line);
    else console.warn(line);
    ajaxCmeLoggedState = hb.state;
    ajaxCmeLoggedAt = nowMs;
  }
  // 運用者が DB を開かずに気づけるよう、既存の tick_archive_status / ledger_export_status と
  // 同じ流儀で共有DBの meta にも残す(= trade2 の 30分ごとの VACUUM INTO にそのまま乗る)。
  if (nowMs - priceFeedHbAt >= PRICE_FEED_HEARTBEAT_MS) {
    priceFeedHbAt = nowMs;
    try {
      if (!priceFeedDb) priceFeedDb = openDb(resolveDbPath());
      writePriceFeedHeartbeat(priceFeedDb, { now: nowMs, prices, feed: ajaxCmeFeedState(), niy });
    } catch (e) {
      // ★記録に失敗しても価格ループは止めない。ただし黙らない。
      console.warn('[priceLoop] price_feed_heartbeat を書けません:', e instanceof Error ? e.message : String(e));
      priceFeedDb = null;
    }
  }
  return hb;
}

const OFFHOURS_IDLE_MS = 30_000;   // 取引時間外はフェッチせず 30s 後に再判定(2s→バックオフ)

/**
 * HTTP 各源(ajax_cme=NIY=F/YM=F/NQ=F, ajax_fx=JPY=X)の価格を合成する純関数(テスト容易化)。
 * v0.7.20: 全経路が real-time HTTP なので、遅延 substitute(旧 Yahoo/socket)を混ぜる余地は無い。
 * ここでは各源の fresh(stale:false)のみを採用し、stale(清算/取得失敗)は落とす → 下流の
 * mergeWithCached が前回値を古い timestamp のまま stale で持ち越す(v0.7.9 実取引安全ルールを踏襲)。
 * これにより NIY=F を含む全銘柄で「遅延した現在値を新鮮に見せる」ことが原理的に起きない。
 */
export function mergeSources(sources: Price[][]): Price[] {
  const fresh: Price[] = [];
  for (const src of sources) {
    for (const p of src) if (!p.stale) fresh.push(p);
  }
  return fresh;
}

export function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

// v0.7.24: 市場開場フラグを SSE で配信する(価格ボードの「取引時間外」表示用)。
// 状態変化時のみ broadcast(スパム抑制)。stream 接続時のスナップショットは stream.ts が別途送る。
let lastMarketOpen: boolean | null = null;
function broadcastMarket(open: boolean): void {
  if (open === lastMarketOpen) return;
  lastMarketOpen = open;
  broadcast({ type: 'market', payload: { open } });
}

async function tick(): Promise<number> {
  if (!inPollWindow(Date.now())) {
    broadcastMarket(false);              // 取引時間外は「閉場」を明示(取得不能=障害 と区別)
    // ★取引時間外でもハートビートは書く(state='offhours')。書かないと毎晩2.5時間・週末50時間ぶん
    //   `at` が古くなり、読み手が「monitor が死んだ」と誤読する(tick_archive の idle と同じ流儀)。
    logAjaxCmeState([], Date.now());
    return OFFHOURS_IDLE_MS;             // 取引時間外は取得しない(軽量化)
  }
  broadcastMarket(isMarketOpen(Date.now()));   // 窓内 = 開場
  try {
    // v0.7.20: 監視 4 銘柄をすべて公開 HTTP から並行取得。
    //   ajax_cme2.js を 1 GET → NIY=F(136)/YM=F(731)/NQ=F(737)、ajax_fx.js を 1 GET → JPY=X(511)。
    // どちらも毎 GET 新スナップショット(long-lived セッション無し=ドリフト無し)。失敗は [] で返り throw しない。
    const [cme, fx] = await Promise.all([
      fetchAjaxCmePrices(),
      fetchAjaxFxPrices(),
    ]);
    logAjaxCmeState(cme, Date.now());   // v0.7.17/v0.9.110: HTTP 経路の状態(取得失敗/清算/凍結/新鮮)を明示
    const prices = mergeSources([cme, fx]);
    if (prices.length === 0) throw new Error('No prices fetched (ajax_cme/ajax_fx HTTP failed)');

    // v0.3.30/31: リアルタイム価格を銘柄ごとに 1 分足ビルダー + 生サンプルへ。
    // 急変は確定足ベース(alertLoop の 60秒タイマ → evaluateBarsNiy)で発火。realtime z-score は廃止。
    // 停止/参照値(stale)はバー化しない: 約定していない銘柄の凍結値で幽霊バーが積まれ、
    // 動いていないのに急変等が誤発火するのを防ぐ(collector の recordFeedPrices と同じ方針)。
    // 注: 立会外ぶんを落とすため realtime 足には時間ギャップが残る(例 15:44→夜間17:00 が隣接)。
    // この寄りシームの段差は emitAlert の openGuard(寄り OPEN_GUARD_BARS 本抑制)で吸収している。
    // v0.7.20: バー化は全 HTTP 銘柄(全て real-time)の fresh 値のみ。stale はバー化しない。
    for (const p of prices) if (!p.stale) feedRealtimePrice(p.symbol, p.price, p.timestamp);

    const merged = mergeWithCached(prices);
    tickDetectorFeed(merged);   // v0.3.17: 超短期 (5s/10s) フラッシュ検知 (バッファ更新)
    // v0.3.33: 日経カードに「超短期(値幅)/短期(率)」を出すため momentum を添付。
    // tickDetectorFeed 後に算出 (最新 tick がバッファに入った状態で読む)。
    const niy = merged.find(p => p.symbol === 'NIY=F');
    if (niy && !niy.stale) {
      const mom = getMomentum('NIY=F');
      if (mom) niy.momentum = mom;
    }
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    // トレードシグナル仮想取引エンジンに現在値を供給(擬似約定/擬似決済 → signalTrade を別途 broadcast)。
    // エンジン未起動時は no-op。既存の 'prices' イベントは不変。
    if (niy && !niy.stale) feedSignalEngine(niy.price, Date.now());
    degradedUntil = 0;
    backoffIndex = -1;
    return intervalMs;
  } catch (err) {
    backoffIndex = Math.min(backoffIndex + 1, PRICE_BACKOFF_MS.length - 1);
    const wait = PRICE_BACKOFF_MS[backoffIndex] ?? intervalMs;
    degradedUntil = Date.now() + wait;
    console.error(`[priceLoop] error, backing off ${wait}ms:`, err instanceof Error ? err.message : err);
    return wait;
  }
}

function schedule(): void {
  if (!running) return;
  void (async () => {
    const wait = await tick();
    if (running) {
      timer = setTimeout(schedule, wait);
    }
  })();
}

export function startPriceLoop(): void {
  if (running) return;
  running = true;
  intervalMs = resolvePricePollMs();
  backoffIndex = -1;
  schedule();
}

export function stopPriceLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (priceFeedDb) { try { priceFeedDb.close(); } catch { /* 閉じられなくても止める */ } priceFeedDb = null; }
}

// 設定変更後の即時 reload。次の tick から新間隔で動く。
export function restartPriceLoop(): void {
  stopPriceLoop();
  startPriceLoop();
}

// Y ステータスドット用。chart 取得が正常なら fallback=false (緑)。
// 全滅バックオフ中のみ fallback=true (黄) + 再試行予定時刻。
export function getYahooStatus(): { fallback: boolean; skipUntil: number } {
  return { fallback: Date.now() < degradedUntil, skipUntil: degradedUntil };
}
