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
    { name: 'Yahoo News',     url: 'https://news.yahoo.co.jp/rss/categories/business.xml' },
    { name: 'NHK ビジネス',   url: 'https://www3.nhk.or.jp/rss/news/cat5.xml' },
    { name: '東洋経済',       url: 'https://toyokeizai.net/list/feed/rss' },
    { name: '朝日',           url: 'https://www.asahi.com/rss/asahi/business.rdf' },
    { name: 'ITmedia',        url: 'https://rss.itmedia.co.jp/rss/2.0/business.xml' },
    { name: '毎日',           url: 'https://mainichi.jp/rss/etc/mainichi-flash.rss' },
    { name: '共同',           url: 'https://www.kyodo.co.jp/feed/?cat=economy' },
  ],
  en: [
    { name: 'CNBC Markets',   url: 'https://www.cnbc.com/id/15839135/device/rss/rss.html' },
    { name: 'CNBC Economy',   url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
    { name: 'Fed',            url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
    { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Yahoo Finance',  url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Investing.com',  url: 'https://www.investing.com/rss/news.rss' },
    { name: 'ZeroHedge',      url: 'https://feeds.feedburner.com/zerohedge/feed' },
    { name: 'ForexLive',      url: 'https://www.forexlive.com/feed' },
    { name: 'Benzinga',       url: 'https://www.benzinga.com/news/feed' },
    { name: 'SeekingAlpha',   url: 'https://seekingalpha.com/market_currents.xml' },
  ],
} as const;

export const PRICE_POLL_INTERVAL_MS = 2000;
export const NEWS_POLL_INTERVAL_MS = 60_000;
export const PRICE_BACKOFF_MS = [5000, 10_000, 30_000, 60_000];
export const NEWS_MAX_ITEMS = 100;
export const NEWS_RECENT_WINDOW_MS = 30 * 60 * 1000;

export const LLM_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。日本語で1〜2文、結論先出しで簡潔に答えてください。該当しそうなニュースがなければ「明確な材料なし」と返してください。`;

// LLM プロバイダ: Groq（無料、Llama 3.3 70B、OpenAI互換API）
// OpenAI に戻すには LLM_BASE_URL を undefined、LLM_MODEL を 'gpt-4o-mini' などへ
export const LLM_BASE_URL: string | undefined = 'https://api.groq.com/openai/v1';
export const LLM_MODEL = 'llama-3.3-70b-versatile';
