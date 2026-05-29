import yahooFinance from 'yahoo-finance2';
import type { Price, Symbol } from '../types.js';
import { INSTRUMENTS } from '../config.js';

// v0.3.10: 全銘柄を 1 回の yf.quote() で取得。
// v0.3.7 で JPY=X 先取り用に 2 段階分割していたが、v0.3.8 で JPY 換算を
// 撤去した時点で分割の意義が消滅。毎 tick 2 呼びが Yahoo のレート制限を
// 倍速で踏みに行き、Y ステータスドットが黄色から戻らない原因になっていた。

function mapQuote(q: { symbol?: string; regularMarketPrice?: number; regularMarketChangePercent?: number | null; regularMarketTime?: Date }): Price | null {
  if (typeof q.regularMarketPrice !== 'number' || !q.symbol) return null;
  return {
    symbol: q.symbol as Symbol,
    price: q.regularMarketPrice,
    changePercent: q.regularMarketChangePercent ?? 0,
    timestamp: q.regularMarketTime instanceof Date ? q.regularMarketTime.getTime() : Date.now(),
    stale: false,
  };
}

export async function fetchYahooPrices(): Promise<Price[]> {
  const yf = new yahooFinance();
  const symbols = INSTRUMENTS.map(i => i.symbol);
  const quotes = await yf.quote(symbols);
  const list = Array.isArray(quotes) ? quotes : [quotes];
  return list.map(mapQuote).filter((p): p is Price => p !== null);
}
