import * as cheerio from 'cheerio';
import type { Price, Symbol } from '../types.js';

const INVESTING_URLS: Partial<Record<Symbol, string>> = {
  'NK=F':  'https://www.investing.com/indices/japan-225-futures',
  'NQ=F':  'https://www.investing.com/indices/nq-100-futures',
  'YM=F':  'https://www.investing.com/indices/us-30-futures',
  'ES=F':  'https://www.investing.com/indices/us-spx-500-futures',
  'JPY=X': 'https://www.investing.com/currencies/usd-jpy',
  'CL=F':  'https://www.investing.com/commodities/crude-oil',
  '^VIX':  'https://www.investing.com/indices/volatility-s-p-500',
  '^TNX':  'https://www.investing.com/rates-bonds/u.s.-10-year-bond-yield',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FinanceMonitor/0.1',
  'Accept': 'text/html',
};

async function scrapeOne(symbol: Symbol): Promise<Price | null> {
  const url = INVESTING_URLS[symbol];
  if (!url) return null;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  const priceText = $('[data-test="instrument-price-last"]').first().text().replace(/,/g, '');
  const changePctText = $('[data-test="instrument-price-change-percent"]').first().text()
    .replace(/[%()+]/g, '').trim();
  const price = parseFloat(priceText);
  const changePercent = parseFloat(changePctText);
  if (!Number.isFinite(price)) return null;
  return {
    symbol,
    price,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    timestamp: Date.now(),
    stale: true,
  };
}

export async function fetchInvestingPrices(symbols: Symbol[]): Promise<Price[]> {
  const results = await Promise.allSettled(symbols.map(scrapeOne));
  return results.flatMap(r =>
    r.status === 'fulfilled' && r.value ? [r.value] : []
  );
}
