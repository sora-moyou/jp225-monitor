import yahooFinance from 'yahoo-finance2';
import type { Price, Symbol } from '../types.js';
import { INSTRUMENTS } from '../config.js';

export async function fetchYahooPrices(): Promise<Price[]> {
  const symbols = INSTRUMENTS.map(i => i.symbol);
  const yf = new yahooFinance();
  const quotes = await yf.quote(symbols);
  const list = Array.isArray(quotes) ? quotes : [quotes];

  return list
    .filter(q => typeof q.regularMarketPrice === 'number')
    .map(q => ({
      symbol: q.symbol as Symbol,
      price: q.regularMarketPrice as number,
      changePercent: q.regularMarketChangePercent ?? 0,
      timestamp: (q.regularMarketTime instanceof Date
        ? q.regularMarketTime.getTime()
        : Date.now()),
      stale: false,
    }));
}
