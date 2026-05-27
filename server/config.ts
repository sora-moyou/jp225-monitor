import type { InstrumentMeta } from './types.js';

export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NK=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'ES=F',  labelJa: 'S&P500先物',     labelEn: 'S&P500 Fut',     magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.07, unit: 'percent' },
  { symbol: 'CL=F',  labelJa: 'WTI原油',        labelEn: 'WTI Crude',      magnitudeThreshold: 0.50, slopeThreshold: 0.20, unit: 'percent' },
  { symbol: '^VIX',  labelJa: 'VIX',            labelEn: 'VIX',            magnitudeThreshold: 5.00, slopeThreshold: 2.00, unit: 'percent' },
  { symbol: '^TNX',  labelJa: '米10年債利回り',   labelEn: 'US 10Y Yield',   magnitudeThreshold: 2.00, slopeThreshold: 1.00, unit: 'bp' },
];

export const RSS_FEEDS = {
  ja: [
    { name: '日経',           url: 'https://www.nikkei.com/news/feed/' },
    { name: 'Reuters JP',     url: 'https://jp.reuters.com/rssFeed/businessNews' },
    { name: 'Bloomberg JP',   url: 'https://www.bloomberg.co.jp/feeds/bbiz/sitemap_news.xml' },
    { name: 'みんかぶ',        url: 'https://minkabu.jp/news.rss' },
  ],
  en: [
    { name: 'CNBC',           url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'Reuters',        url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Yahoo Finance',  url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Investing.com',  url: 'https://www.investing.com/rss/news.rss' },
    { name: 'ZeroHedge',      url: 'https://feeds.feedburner.com/zerohedge/feed' },
  ],
} as const;

export const PRICE_POLL_INTERVAL_MS = 2000;
export const NEWS_POLL_INTERVAL_MS = 60_000;
export const PRICE_BACKOFF_MS = [5000, 10_000, 30_000, 60_000];
export const NEWS_MAX_ITEMS = 100;
export const NEWS_RECENT_WINDOW_MS = 30 * 60 * 1000;

export const LLM_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。日本語で1〜2文、結論先出しで簡潔に答えてください。該当しそうなニュースがなければ「明確な材料なし」と返してください。`;

export const LLM_MODEL = 'gpt-4o-mini';
