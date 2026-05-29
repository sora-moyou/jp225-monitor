import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchInvestingPrices } from '../sources/investingScrape.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS, USD_DENOMINATED } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import { tryUpdate as updateJpyCache, getRate as getJpyRate, getChangePercent as getJpyChange } from '../jpyRateCache.js';
import type { Price } from '../types.js';

// USD 建て銘柄を JPY 換算する (v0.3.7 多層防御版)。
//
// 1. 永続キャッシュ (~/.jp225-monitor/jpy-cache.json) を起動時に読み込み済み (server/index.ts)。
//    → 再起動直後でも前回終値ベースで換算可能。
// 2. 新規 JPY=X はレンジチェック [50, 300] + 急変動チェック (1 tick で > 2% は data 異常)。
// 3. 計算後の jpyPrice が [1000, 1B] レンジ外なら、銘柄ごとに保存した直前 jpyPrice を流用。
// 4. それも無ければ jpy フィールドを付けず raw を返す (frontend は raw 表示にフォールバック)。

const JPY_PRICE_MIN = 1_000;
const JPY_PRICE_MAX = 1_000_000_000;

// 銘柄ごとの直前の有効 jpyPrice。一時的な data 異常があってもこれで補える。
const lastValidJpyBySymbol = new Map<string, number>();

function applyJpyConversion(prices: Price[]): Price[] {
  const jpyX = prices.find(p => p.symbol === 'JPY=X');

  // 1. JPY=X 永続キャッシュを更新試行 (異常値は中で拒否される)
  if (jpyX) {
    updateJpyCache(jpyX.price, jpyX.changePercent);
  }

  const rate = getJpyRate();
  const change = getJpyChange();
  if (rate <= 0) return prices;   // まだキャッシュ無し (本当に初回起動 + 初回 JPY=X 取得失敗)

  return prices.map(p => {
    if (!USD_DENOMINATED.has(p.symbol)) return p;
    if (!Number.isFinite(p.price) || p.price <= 0) return p;

    const candidateJpy = p.price * rate;

    // 2. 換算結果が現実的範囲かを検証
    if (!Number.isFinite(candidateJpy) || candidateJpy < JPY_PRICE_MIN || candidateJpy > JPY_PRICE_MAX) {
      console.warn(`[priceLoop] ${p.symbol}: implausible jpyPrice ${candidateJpy} (= ${p.price} × ${rate})`);
      // 3. 銘柄ごとの直前有効値があればそれを使う (異常値表示を回避)
      const lastGood = lastValidJpyBySymbol.get(p.symbol);
      if (lastGood !== undefined) {
        return {
          ...p,
          jpyPrice: lastGood,
          jpyChangePercent: p.changePercent + change,
          stale: true,   // UI で「stale」マークが出るように
        };
      }
      return p;   // 初回 + 異常: jpy フィールド無しで返す (raw 表示)
    }

    // 4. 正常: 銘柄キャッシュも更新
    lastValidJpyBySymbol.set(p.symbol, candidateJpy);
    return {
      ...p,
      jpyPrice: candidateJpy,
      jpyChangePercent: p.changePercent + change,
    };
  });
}

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
          console.warn(`[priceLoop] Yahoo unavailable (${err instanceof Error ? err.message : err}), using Investing.com for next ${Math.round(skipMs/1000)}s`);
        }
        yahooConsecutiveFails++;
        yahooSkipUntil = now + skipMs;
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
    const converted = applyJpyConversion(merged);
    setPrices(converted);
    broadcast({ type: 'prices', payload: converted });
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
