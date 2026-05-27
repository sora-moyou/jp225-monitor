import type { Price, NewsItem } from './types.js';

let latestPrices: Price[] = [];
let latestNews: NewsItem[] = [];

export function setPrices(p: Price[]) { latestPrices = p; }
export function getPrices(): Price[] { return latestPrices; }
export function setNews(n: NewsItem[]) { latestNews = n; }
export function getNews(): NewsItem[] { return latestNews; }
