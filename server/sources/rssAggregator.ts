import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS } from '../config.js';

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'FinanceMonitor/0.1' },
});

async function fetchFeed(name: string, url: string, lang: 'ja' | 'en'): Promise<NewsItem[]> {
  const feed = await parser.parseURL(url);
  return (feed.items ?? []).flatMap(item => {
    const published = item.isoDate ? Date.parse(item.isoDate) : Date.now();
    if (!item.title || !item.link) return [];
    return [{
      id: `${name}:${item.guid ?? item.link}`,
      title: item.title,
      source: name,
      lang,
      url: item.link,
      publishedAt: published,
    }];
  });
}

export async function fetchAllNews(): Promise<NewsItem[]> {
  const tasks: Promise<NewsItem[]>[] = [];
  for (const f of RSS_FEEDS.ja) tasks.push(fetchFeed(f.name, f.url, 'ja'));
  for (const f of RSS_FEEDS.en) tasks.push(fetchFeed(f.name, f.url, 'en'));
  const results = await Promise.allSettled(tasks);
  const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  return items
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, NEWS_MAX_ITEMS);
}
