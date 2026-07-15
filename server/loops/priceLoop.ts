import { fetchAjaxCmePrices } from '../sources/ajaxCmePrice.js';
import { fetchAjaxFxPrices } from '../sources/ajaxFxPrice.js';
import { feedRealtimePrice } from '../feedBars.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import { inPollWindow, isMarketOpen } from '../../collector/session.js';
import type { Price } from '../types.js';
import { feedPrice as tickDetectorFeed, getMomentum } from '../tickDetector.js';
import { feedSignalEngine } from '../signalTrade/engine.js';

// v0.7.20(全銘柄 HTTP 化): 価格の全経路を公開 HTTP(ajax_cme.js / ajax_fx.js)に統一。socket と Yahoo を
// 全廃した。ajax_cme.js を 1 GET して NIY=F(136)/YM=F(731)/NQ=F(737)、ajax_fx.js を 1 GET して JPY=X(511)。
// どちらも毎 GET 新スナップショット = 長寿命セッションドリフト(約10分遅延)の事故が原理的に起きない。
// すべて real-time なので NIY=F の「遅延源を混ぜない」実弾安全ルールは自動的に満たされる(遅延 substitute が
// 存在しない)。取得失敗/清算(stale)の銘柄は mergeWithCached で前回値を stale として持ち越す。全滅時のみ
// バックオフして劣化中 (ステータス黄) を示す。

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let running = false;
let degradedUntil = 0;          // 全取得失敗でバックオフ中はこの時刻まで「劣化中」
let intervalMs = resolvePricePollMs();

// v0.7.17 診断: ajax_cme(HTTP)による NIY=F 取得の成否を明示ログする(新ロジックが動いている証拠 +
// kabu 機で HTTP エンドポイントが通っているかの確認)。毎ポール出すとスパムなので、状態変化時
// (成功↔失敗)と 60 秒ごとの1回だけ出す。
let ajaxCmeLoggedOk: boolean | null = null;
let ajaxCmeLoggedAt = 0;
function logAjaxCmeState(niy: Price | null): void {
  const ok = !!(niy && !niy.stale);
  const nowMs = Date.now();
  if (ok !== ajaxCmeLoggedOk || nowMs - ajaxCmeLoggedAt >= 60_000) {
    if (ok) console.log(`[priceLoop] NIY=F ajax_cme(HTTP)=${niy!.price} 新鮮 [v0.7.17]`);
    else console.warn('[priceLoop] NIY=F ajax_cme(HTTP) 取得不能 — HTTP フィード失敗(jss2/225225 両方) [v0.7.17]');
    ajaxCmeLoggedOk = ok;
    ajaxCmeLoggedAt = nowMs;
  }
}

const OFFHOURS_IDLE_MS = 30_000;   // 取引時間外はフェッチせず 30s 後に再判定(2s→バックオフ)

/**
 * HTTP 各源(ajax_cme=NIY=F/YM=F/NQ=F, ajax_fx=JPY=X)の価格を合成する純関数(テスト容易化)。
 * v0.7.20: 全経路が real-time HTTP なので、遅延 substitute(旧 Yahoo/socket)を混ぜる余地は無い。
 * ここでは各源の fresh(stale:false)のみを採用し、stale(清算/取得失敗)は落とす → 下流の
 * mergeWithCached が前回値を古い timestamp のまま stale で持ち越す(v0.7.9 実弾安全ルールを踏襲)。
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
    return OFFHOURS_IDLE_MS;             // 取引時間外は何もしない(軽量化)
  }
  broadcastMarket(isMarketOpen(Date.now()));   // 窓内 = 開場
  try {
    // v0.7.20: 監視 4 銘柄をすべて公開 HTTP から並行取得。
    //   ajax_cme.js を 1 GET → NIY=F(136)/YM=F(731)/NQ=F(737)、ajax_fx.js を 1 GET → JPY=X(511)。
    // どちらも毎 GET 新スナップショット(long-lived セッション無し=ドリフト無し)。失敗は [] で返り throw しない。
    const [cme, fx] = await Promise.all([
      fetchAjaxCmePrices(),
      fetchAjaxFxPrices(),
    ]);
    logAjaxCmeState(cme.find(p => p.symbol === 'NIY=F') ?? null);   // v0.7.17: HTTP 経路の成否を明示
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
    // トレードシグナル紙エンジンに現在値を供給(擬似約定/擬似決済 → signalTrade を別途 broadcast)。
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
