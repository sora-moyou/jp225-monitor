import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchYahooChartPrices } from '../sources/yahooChart.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import type { Price } from '../types.js';
import { feedPrice as tickDetectorFeed } from '../tickDetector.js';

// Yahoo Finance 失敗時のスキップ期間。連続失敗で長くなる:
//   1 回目失敗 → 90 秒
//   2 回目失敗 → 3 分
//   3 回目以降 → 5 分
// 成功で即リセット。これで一時的な 429 から早期復帰できる。
const YAHOO_SKIP_LADDER_MS = [90_000, 3 * 60_000, 5 * 60_000];

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let running = false;
let yahooSkipUntil = 0;
let yahooConsecutiveFails = 0;
let intervalMs = resolvePricePollMs();

function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

async function tick(): Promise<number> {
  try {
    let prices: Price[] = [];
    const now = Date.now();

    if (now >= yahooSkipUntil) {
      try {
        prices = await fetchYahooPrices();
        if (yahooSkipUntil > 0 || yahooConsecutiveFails > 0) {
          console.log('[priceLoop] Yahoo recovered, back to primary source');
          yahooSkipUntil = 0;
          yahooConsecutiveFails = 0;
        }
      } catch (err) {
        const idx = Math.min(yahooConsecutiveFails, YAHOO_SKIP_LADDER_MS.length - 1);
        const skipMs = YAHOO_SKIP_LADDER_MS[idx]!;
        if (yahooConsecutiveFails === 0) {
          console.warn(`[priceLoop] Yahoo quote() unavailable (${err instanceof Error ? err.message : err}), using Yahoo chart API fallback for next ${Math.round(skipMs/1000)}s`);
        }
        yahooConsecutiveFails++;
        yahooSkipUntil = now + skipMs;
      }
    }

    const missing = INSTRUMENTS
      .map(i => i.symbol)
      .filter(s => !prices.find(p => p.symbol === s));
    if (missing.length > 0) {
      const fallback = await fetchYahooChartPrices(missing);
      prices = [...prices, ...fallback];
    }

    if (prices.length === 0) throw new Error('No prices fetched (Yahoo quote + chart both failed)');

    const merged = mergeWithCached(prices);
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    tickDetectorFeed(merged);   // v0.3.17: 超短期 (5s/10s) フラッシュ検知
    backoffIndex = -1;
    return intervalMs;
  } catch (err) {
    backoffIndex = Math.min(backoffIndex + 1, PRICE_BACKOFF_MS.length - 1);
    const wait = PRICE_BACKOFF_MS[backoffIndex] ?? intervalMs;
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

export function getYahooStatus(): { fallback: boolean; skipUntil: number } {
  return { fallback: Date.now() < yahooSkipUntil, skipUntil: yahooSkipUntil };
}
