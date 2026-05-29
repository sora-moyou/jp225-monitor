import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS, FINANCE_RELEVANCE_KEYWORDS, FINANCE_BLACKLIST, HIGH_IMPACT_KEYWORDS } from '../config.js';

// タイトルが金融関連かどうかを判定 (v0.3.5+ 厳格版)
// - BLACKLIST に1つでもヒット → 除外
// - HIGH_IMPACT が 1 つ以上ヒット → 通す (中銀・要人・指標・地政学等は単独でも重要)
// - 通常 keyword は 2 つ以上ヒットしないと除外 (「トヨタ」単独で新車ニュースが通る等を防ぐ)
function isFinanceRelevant(title: string): boolean {
  const lc = title.toLowerCase();
  // Blacklist 1 ヒットで即除外
  for (const kw of FINANCE_BLACKLIST) {
    if (lc.includes(kw.toLowerCase())) return false;
  }
  // HIGH_IMPACT 1 ヒットで通過
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (lc.includes(kw.toLowerCase())) return true;
  }
  // 通常 keyword は 2 ヒット以上必要
  let hits = 0;
  for (const kw of FINANCE_RELEVANCE_KEYWORDS) {
    if (lc.includes(kw.toLowerCase())) {
      hits++;
      if (hits >= 2) return true;
    }
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
