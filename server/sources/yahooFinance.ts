import yahooFinance from 'yahoo-finance2';
import type { Price, Symbol } from '../types.js';
import { INSTRUMENTS } from '../config.js';

// 取得順設計 (v0.3.7+):
//   Step 1: JPY=X を単独で先にフェッチ → 即キャッシュ更新 (priceLoop 側)
//   Step 2: 残り銘柄を一括フェッチ (NK=F 等 USD 建てを含む)
// これにより USD 銘柄を JPY 換算する時点で JPY=X は確実に最新化済み。
// 失敗時はそれぞれ独立に handle され、片方失敗しても他方は使える。

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

  // Step 1: JPY=X を先に
  let jpyXPrice: Price | null = null;
  try {
    const jpyQuote = await yf.quote('JPY=X');
    const arr = Array.isArray(jpyQuote) ? jpyQuote : [jpyQuote];
    jpyXPrice = arr.map(mapQuote).find((p): p is Price => p !== null) ?? null;
  } catch (err) {
    // JPY=X 単独で失敗 — Investing.com への fallback は priceLoop 側で実施
    console.warn('[yahooFinance] JPY=X fetch failed:', err instanceof Error ? err.message : err);
  }

  // Step 2: 残り全銘柄
  const otherSymbols = INSTRUMENTS.map(i => i.symbol).filter(s => s !== 'JPY=X');
  const quotes = await yf.quote(otherSymbols);
  const list = Array.isArray(quotes) ? quotes : [quotes];
  const others = list.map(mapQuote).filter((p): p is Price => p !== null);

  return jpyXPrice ? [jpyXPrice, ...others] : others;
}
