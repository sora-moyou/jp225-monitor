import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchInvestingPrices } from '../sources/investingScrape.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS, USD_DENOMINATED } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import type { Price } from '../types.js';

// USD 建て銘柄を JPY 換算する。
// JPY=X の取得が一瞬抜けた tick でも、直近の有効レートをキャッシュしておき
// USD 銘柄には常に jpyPrice を付ける。これでバッファに USD/JPY が混ざらない。
// jpyChangePercent ≈ USD% + JPY=X% (1次近似、小幅変動では十分な精度)。

// USD/JPY が現実的に取り得る範囲。これ以外なら data 異常 → キャッシュ更新せず無視。
// 過去 30 年で 75–160 の範囲。300 は災害シナリオ含めて十分広い。
const JPY_RATE_MIN = 50;
const JPY_RATE_MAX = 300;

// JPY=X の changePercent (前日比) の許容範囲。±20% を超えるのはどう考えても異常。
const JPY_CHANGE_MAX = 20;

// 換算後の JPY 価格として現実的に取り得る範囲。
// 現状 NK=F (~66K USD × 150) ≈ 1000 万。最低 1000 円、最大 10 億で十分。
const JPY_PRICE_MIN = 1_000;
const JPY_PRICE_MAX = 1_000_000_000;

let cachedJpyRate = 0;
let cachedJpyChange = 0;

function applyJpyConversion(prices: Price[]): Price[] {
  const jpyX = prices.find(p => p.symbol === 'JPY=X');

  // 1. JPY=X が現実的範囲内 (50–300) かを検証。異常値ならキャッシュ放置 (= 直前の有効値を流用)
  if (jpyX && Number.isFinite(jpyX.price)) {
    if (jpyX.price >= JPY_RATE_MIN && jpyX.price <= JPY_RATE_MAX) {
      cachedJpyRate = jpyX.price;
      // changePercent も sanity check。データ異常で大きく振れたら 0 にしてスキップ
      const chg = jpyX.changePercent ?? 0;
      cachedJpyChange = Math.abs(chg) <= JPY_CHANGE_MAX ? chg : 0;
    } else {
      console.warn(`[priceLoop] JPY=X out of sane range: ${jpyX.price}, keeping cached ${cachedJpyRate}`);
    }
  }

  // まだ一度も有効な JPY=X を見ていない場合は変換しない (起動直後のみ)
  if (cachedJpyRate <= 0) return prices;

  return prices.map(p => {
    if (!USD_DENOMINATED.has(p.symbol)) return p;
    if (!Number.isFinite(p.price) || p.price <= 0) return p;

    const candidateJpy = p.price * cachedJpyRate;

    // 2. 換算結果が現実的範囲かを検証。範囲外 → jpy* 付けず生 USD を返す (frontend は USD 表示にフォールバック)
    if (!Number.isFinite(candidateJpy) || candidateJpy < JPY_PRICE_MIN || candidateJpy > JPY_PRICE_MAX) {
      console.warn(`[priceLoop] ${p.symbol}: implausible jpyPrice ${candidateJpy} (= ${p.price} × ${cachedJpyRate}), falling back to raw USD this tick`);
      return p;
    }

    return {
      ...p,
      jpyPrice: candidateJpy,
      jpyChangePercent: p.changePercent + cachedJpyChange,
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
