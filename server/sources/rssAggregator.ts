import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS, FINANCE_RELEVANCE_KEYWORDS, FINANCE_BLACKLIST } from '../config.js';

// タイトルが金融関連かどうかを判定
// - BLACKLIST に1つでもヒット → 除外
// - WHITELIST に1つもヒットしない → 除外
function isFinanceRelevant(title: string): boolean {
  const lc = title.toLowerCase();
  for (const kw of FINANCE_BLACKLIST) {
    if (lc.includes(kw.toLowerCase())) return false;
  }
  for (const kw of FINANCE_RELEVANCE_KEYWORDS) {
    if (lc.includes(kw.toLowerCase())) return true;
  }
  return false;
}

const parser = new Parser({
  timeout: 8000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.1',
  },
});

async function fetchFeed(name: string, url: string, lang: 'ja' | 'en'): Promise<NewsItem[]> {
  let feed;
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    console.warn(`[rss] ${name} failed:`, err instanceof Error ? err.message : err);
    throw err;
  }
  return (feed.items ?? []).flatMap(item => {
    const published = item.isoDate ? Date.parse(item.isoDate) : Date.now();
    if (!item.title || !item.link) return [];
    if (!isFinanceRelevant(item.title)) return [];   // 非金融トピックを除外
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
