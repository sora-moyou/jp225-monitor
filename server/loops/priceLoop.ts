import { fetchYahooChartPrices } from '../sources/yahooChart.js';
import { fetchFeedPrices } from '../sources/nikkei225jpFeed.js';
import { feedRealtimePrice } from '../feedBars.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
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

function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

async function tick(): Promise<number> {
  try {
    // v0.3.30/31: 日経225先物(OSE) と米国系(ダウ/ナスダック/原油/10年債)・ドル円は
    // nikkei225jp のリアルタイム feed を主経路にする。Yahoo は CME/NYMEX を約10分ディレイで
    // 返すため、feed で取れた銘柄はそれで上書きし、取れない銘柄(S&P/VIX 等)は Yahoo を残す。
    const [yahoo, feed] = await Promise.all([
      fetchYahooChartPrices(SYMBOLS),
      fetchFeedPrices().catch(() => [] as Price[]),
    ]);
    const feedSyms = new Set(feed.map(p => p.symbol));
    const prices = [...yahoo.filter(p => !feedSyms.has(p.symbol)), ...feed];
    if (prices.length === 0) throw new Error('No prices fetched (Yahoo chart API failed)');

    // v0.3.30/31: リアルタイム価格を銘柄ごとに 1 分足ビルダー + 生サンプルへ。
    // 急変は確定足ベース(alertLoop の 60秒タイマ → evaluateBarsNiy)で発火。realtime z-score は廃止。
    // 停止/参照値(stale)はバー化しない: 約定していない銘柄の凍結値で幽霊バーが積まれ、
    // 動いていないのに急変等が誤発火するのを防ぐ(collector の recordFeedPrices と同じ方針)。
    // 注: 立会外ぶんを落とすため realtime 足には時間ギャップが残る(例 15:44→夜間17:00 が隣接)。
    // この寄りシームの段差は emitAlert の openGuard(寄り OPEN_GUARD_BARS 本抑制)で吸収している。
    // openGuardBars を 0 にするとこのシームが露出するので注意(feedBars 自体はギャップ補正しない)。
    for (const p of feed) if (!p.stale) feedRealtimePrice(p.symbol, p.price, p.timestamp);

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
