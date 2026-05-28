import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchInvestingPrices } from '../sources/investingScrape.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_POLL_INTERVAL_MS, PRICE_BACKOFF_MS } from '../config.js';
import type { Price } from '../types.js';

const YAHOO_SKIP_AFTER_FAIL_MS = 5 * 60 * 1000;

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let yahooSkipUntil = 0;

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
        if (yahooSkipUntil > 0) {
          console.log('[priceLoop] Yahoo recovered, back to primary source');
          yahooSkipUntil = 0;
        }
      } catch (err) {
        if (yahooSkipUntil === 0) {
          console.warn(`[priceLoop] Yahoo unavailable (${err instanceof Error ? err.message : err}), using Investing.com for next 5 min`);
        }
        yahooSkipUntil = now + YAHOO_SKIP_AFTER_FAIL_MS;
      }
    }

    const missing = INSTRUMENTS
      .map(i => i.symbol)
      .filter(s => !prices.find(p => p.symbol === s));
    if (missing.length > 0) {
      const fallback = await fetchInvestingPrices(missing);
      prices = [...prices, ...fallback];
    }

    if (prices.length === 0) throw new Error('No prices fetched (Yahoo + Investing.com both failed)');

    const merged = mergeWithCached(prices);
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    backoffIndex = -1;
    return PRICE_POLL_INTERVAL_MS;
  } catch (err) {
    backoffIndex = Math.min(backoffIndex + 1, PRICE_BACKOFF_MS.length - 1);
    const wait = PRICE_BACKOFF_MS[backoffIndex] ?? PRICE_POLL_INTERVAL_MS;
    console.error(`[priceLoop] error, backing off ${wait}ms:`, err instanceof Error ? err.message : err);
    return wait;
  }
}

export function startPriceLoop(): void {
  const schedule = async () => {
    const wait = await tick();
    timer = setTimeout(schedule, wait);
  };
  void schedule();
}

export function stopPriceLoop(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
