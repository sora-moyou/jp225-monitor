import { fetchYahooChartPrices } from '../sources/yahooChart.js';
import { getSocketPrices } from '../sources/nikkei225jpSocket.js';
import { fetchAjaxCmePrice } from '../sources/ajaxCmePrice.js';
import { feedRealtimePrice } from '../feedBars.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import { inPollWindow } from '../../collector/session.js';
import type { Price } from '../types.js';
import { feedPrice as tickDetectorFeed, getMomentum } from '../tickDetector.js';

// v0.3.29: 価格の主経路を Yahoo chart endpoint に変更(crumb 依存を撤去)。
// 旧主経路 quote() は crumb が必須で、この環境では恒常的に 429 になっていた。
// chart endpoint は crumb 不要・全銘柄取得可で、quote() の 429 に影響されない。
// 取得は銘柄ごと (Promise.allSettled) なので一部失敗にも強く、取れた分だけ反映。
// 取れなかった銘柄は mergeWithCached で前回値を stale として保持。全滅時のみ
// バックオフして劣化中 (Y ドット黄) を示す。

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let running = false;
let degradedUntil = 0;          // 全取得失敗でバックオフ中はこの時刻まで「劣化中」
let intervalMs = resolvePricePollMs();

const SYMBOLS = INSTRUMENTS.map(i => i.symbol);
const OFFHOURS_IDLE_MS = 30_000;   // 取引時間外はフェッチせず 30s 後に再判定(2s→バックオフ)

// v0.7.x(実弾安全): NIY=F(実際に建てる大阪取引所の日経先物)は Yahoo(CME・約10分ディレイ)を
// 絶対に出さない。過去、リアルタイム feed が落ちた際に Yahoo の遅延値へ静かにフォールバックし、
// トレードボットが約10分古い価格で発注 → 実損した。よって NIY=F の LIVE 供給源は
// リアルタイム feed のみ。feed に NIY=F が無い/stale の時は「取得不能(stale)」として
// 前回値を表示専用で持ち越し、決して新鮮な Yahoo 値で埋めない。
const REALTIME_ONLY = new Set<string>(['NIY=F']);

/**
 * Yahoo 側・socket feed 側・ajax_cme 側の価格を、実弾安全ルールで合成する純粋関数(テスト容易化)。
 *  - NIY=F(REALTIME_ONLY)の LIVE 供給源は **ajax_cme のみ**(v0.7.16)。socket の code 136 も
 *    Yahoo も NIY=F には一切使わない。ajax_cme が無い/fail のときは fresh から欠落 → 下流の
 *    mergeWithCached が前回値を stale(古い timestamp のまま)で持ち越す(v0.7.9 ルール)。
 *  - socket feed は NIY=F **以外**の銘柄(NQ=F/YM=F/^HSI/CL=F/^TNX/JPY=X)を従来どおり供給する。
 *  - それ以外の銘柄は feed 優先・feed に無ければ Yahoo フォールバック(NIY=F だけはこの経路を通さない)。
 * @param ajaxCme ajax_cme.js から取得した NIY=F(取れなければ null)。fresh(=live)のみを採用する。
 */
export function mergeSources(yahoo: Price[], feed: Price[], ajaxCme: Price | null = null): Price[] {
  // NIY=F は socket feed から取らない(ajax_cme が唯一の LIVE 供給源)。socket の 136 は捨てる。
  const feedForward = feed.filter(p => !REALTIME_ONLY.has(p.symbol));
  const forwardSyms = new Set(feedForward.map(p => p.symbol));
  // ajax_cme の NIY=F が fresh(live)なら採用する。stale は fresh に載せず落とす → 下流が前回値を
  // 古い timestamp のまま持ち越す(新しい now を付けた stale を fresh にすると遅延ガードをすり抜けるため)。
  const niy = ajaxCme && REALTIME_ONLY.has(ajaxCme.symbol) && !ajaxCme.stale ? [ajaxCme] : [];
  if (niy.length) forwardSyms.add(ajaxCme!.symbol);
  // NIY=F を含む REALTIME_ONLY 銘柄は Yahoo 由来を捨てる(遅延値を混ぜない)。
  const yahooSafe = yahoo.filter(p => !forwardSyms.has(p.symbol) && !REALTIME_ONLY.has(p.symbol));
  return [...yahooSafe, ...feedForward, ...niy];
}

export function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

async function tick(): Promise<number> {
  if (!inPollWindow(Date.now())) return OFFHOURS_IDLE_MS;   // 取引時間外は何もしない(軽量化)
  try {
    // v0.3.30/31 → v0.8: 日経225先物(OSE) と米国系(ダウ/ナスダック/原油/10年債)・ドル円は
    // nikkei225jp のリアルタイム socket(バックグラウンドで常時接続)を主経路にする。ここでは毎ポール
    // socket の最新スナップショットを **同期読み** する(HTTP ポーリングは廃止=旧 ajax_TOP.js は停止したため)。
    // Yahoo は CME/NYMEX を約10分ディレイで返すため、socket で取れた銘柄はそれで上書きし、
    // 取れない銘柄(S&P/VIX 等)は Yahoo を残す。
    // v0.7.16: NIY=F は ajax_cme.js(公開 HTTP・毎 GET 新スナップショット=ドリフト無し)を主経路にする。
    // 他銘柄(米国系・ドル円・香港)は従来どおり socket。Yahoo は socket/ajax_cme に無い銘柄用のフォールバック。
    // 3 経路を並行取得(ajax_cme の失敗は null で返り throw しない)。
    const [yahoo, ajaxCme] = await Promise.all([
      fetchYahooChartPrices(SYMBOLS),
      fetchAjaxCmePrice('136'),
    ]);
    const feed = getSocketPrices(Date.now());
    const prices = mergeSources(yahoo, feed, ajaxCme);
    if (prices.length === 0) throw new Error('No prices fetched (Yahoo chart API failed)');

    // v0.3.30/31: リアルタイム価格を銘柄ごとに 1 分足ビルダー + 生サンプルへ。
    // 急変は確定足ベース(alertLoop の 60秒タイマ → evaluateBarsNiy)で発火。realtime z-score は廃止。
    // 停止/参照値(stale)はバー化しない: 約定していない銘柄の凍結値で幽霊バーが積まれ、
    // 動いていないのに急変等が誤発火するのを防ぐ(collector の recordFeedPrices と同じ方針)。
    // 注: 立会外ぶんを落とすため realtime 足には時間ギャップが残る(例 15:44→夜間17:00 が隣接)。
    // この寄りシームの段差は emitAlert の openGuard(寄り OPEN_GUARD_BARS 本抑制)で吸収している。
    // openGuardBars を 0 にするとこのシームが露出するので注意(feedBars 自体はギャップ補正しない)。
    // v0.7.16: バー化はリアルタイム経路(socket 他銘柄 + ajax_cme の NIY=F)のみ。Yahoo 由来の
    // 遅延銘柄(.T 値がさ株等)はバー化しない(幽霊バー→誤検知防止、従来方針)。socket の 136 は
    // 使わない(NIY=F は ajax_cme を正とする)ので、feed から NIY=F を除き、ajax_cme の NIY=F を足す。
    const barFeed = feed.filter(p => !REALTIME_ONLY.has(p.symbol));
    if (ajaxCme && !ajaxCme.stale) barFeed.push(ajaxCme);
    for (const p of barFeed) if (!p.stale) feedRealtimePrice(p.symbol, p.price, p.timestamp);

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
