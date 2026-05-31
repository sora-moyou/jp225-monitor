import { fetchYahooChartPrices } from '../sources/yahooChart.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import type { Price } from '../types.js';
import { feedPrice as tickDetectorFeed } from '../tickDetector.js';

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
    const prices = await fetchYahooChartPrices(SYMBOLS);
    if (prices.length === 0) throw new Error('No prices fetched (Yahoo chart API failed)');

    const merged = mergeWithCached(prices);
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    tickDetectorFeed(merged);   // v0.3.17: 超短期 (5s/10s) フラッシュ検知
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
