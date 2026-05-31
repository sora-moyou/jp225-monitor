import type { Price, Symbol } from '../types.js';

// v0.3.28: 価格フォールバックを Yahoo chart endpoint に変更。
// 旧 Investing.com スクレイプは Cloudflare で恒常的に 403 ブロックされ機能不全。
// chart endpoint は crumb 不要で、quote() が 429 の間も生きていることが多く、
// meta.regularMarketPrice を現在値として使える(分足取得 correlation.ts と同系統)。

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.3';

interface ChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;   // Unix 秒
}
interface ChartResponse {
  chart: {
    result: Array<{ meta?: ChartMeta }> | null;
    error: { description?: string } | null;
  };
}

async function fetchOne(symbol: Symbol): Promise<Price | null> {
  // interval=1d&range=1d は最小ペイロード。価格は meta に入るので interval 非依存。
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) return null;
  const data = await res.json() as ChartResponse;
  if (data.chart.error) return null;
  const meta = data.chart.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  const changePercent = typeof prev === 'number' && prev > 0 ? ((price - prev) / prev) * 100 : 0;
  return {
    symbol,                       // 要求した symbol を使う (meta.symbol は USDJPY=X 等になる)
    price,
    changePercent,
    timestamp: typeof meta?.regularMarketTime === 'number' ? meta.regularMarketTime * 1000 : Date.now(),
    stale: false,                 // live フェッチ。stale は「キャッシュ流用」専用フラグ
  };
}

export async function fetchYahooChartPrices(symbols: Symbol[]): Promise<Price[]> {
  const results = await Promise.allSettled(symbols.map(fetchOne));
  return results.flatMap(r => (r.status === 'fulfilled' && r.value ? [r.value] : []));
}
