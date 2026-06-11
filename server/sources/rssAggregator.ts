import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS, FINANCE_RELEVANCE_KEYWORDS, FINANCE_BLACKLIST, HIGH_IMPACT_KEYWORDS } from '../config.js';
import { fetchNikkei225jpNews } from './nikkei225jp.js';

// 金融関連かどうかを判定 (v0.3.9 タイトル+本文 ハイブリッド)
// - BLACKLIST はタイトル限定 (本文の偶発ヒットで金融ニュースを誤除外しないため)
// - HIGH_IMPACT はタイトルor本文1ヒットで通過
// - 通常 keyword はタイトル2ヒット or タイトル1+本文1 で通過 (本文を入れて recall を上げる)
export function isFinanceRelevant(title: string, body: string = ''): boolean {
  const titleLc = title.toLowerCase();
  const bodyLc = body.toLowerCase();
  // Blacklist はタイトル限定で 1 ヒット即除外
  for (const kw of FINANCE_BLACKLIST) {
    if (titleLc.includes(kw.toLowerCase())) return false;
  }
  // HIGH_IMPACT は title or body 1 ヒットで通過
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    const kwLc = kw.toLowerCase();
    if (titleLc.includes(kwLc) || bodyLc.includes(kwLc)) return true;
  }
  // 通常 keyword: title 2 ヒット or title 1 + body 1 で通過
  let titleHits = 0;
  let bodyHit = false;
  for (const kw of FINANCE_RELEVANCE_KEYWORDS) {
    const kwLc = kw.toLowerCase();
    if (titleLc.includes(kwLc)) {
      titleHits++;
      if (titleHits >= 2) return true;
    } else if (!bodyHit && bodyLc.includes(kwLc)) {
      bodyHit = true;
    }
  }
  return titleHits >= 1 && bodyHit;
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
    const body = item.contentSnippet ?? item.content ?? '';
    if (!isFinanceRelevant(item.title, body)) return [];   // 非金融トピックを除外
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
  tasks.push(fetchNikkei225jpNews());   // nikkei225jp 総合ニュース(他ソースと同列・広く取り込む)
  const results = await Promise.allSettled(tasks);
  const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  // id で重複排除(別ソース経由の同一記事に備える)。
  const seen = new Set<string>();
  const uniq = items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  return uniq
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, NEWS_MAX_ITEMS);
}
