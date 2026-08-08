import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS, FINANCE_RELEVANCE_KEYWORDS, FINANCE_BLACKLIST, HIGH_IMPACT_KEYWORDS } from '../config.js';
import { fetchNikkei225jpNews, fetchNikkei225jpNewsJp, fetchNikkei225jpNewsNy } from './nikkei225jp.js';
import { fetchEconIndicators } from './econIndicators.js';
import { scoreNewsImpact } from '../../core/newsImpact.js';
import { withConfidence } from '../../core/newsConfidence.js';

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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 FinanceMonitor/0.1';

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': UA },
});

// ─── 条件付き GET(重いフィード用) ─────────────────────────────────────────
// ★なぜ: White House の RSS は本文込みで 1 回 ~580KB ある。60 秒間隔でそのまま取ると
//   毎時 35MB を配信元に強いる。robots.txt が許可していても、それは礼儀として過剰。
//   ETag / Last-Modified を送り、304 が返ったら前回の結果をそのまま使う。
//   ★失敗時は必ず通常取得へフォールバックする(節約のために取得が止まる方が害)。
interface CacheEntry { etag?: string; lastModified?: string; items: NewsItem[] }
const conditionalCache = new Map<string, CacheEntry>();

/** テスト用: 条件付き GET のキャッシュを捨てる。 */
export function resetConditionalCacheForTest(): void { conditionalCache.clear(); }

async function fetchFeedText(url: string): Promise<{ text: string | null; etag?: string; lastModified?: string }> {
  const prev = conditionalCache.get(url);
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (prev?.etag) headers['If-None-Match'] = prev.etag;
  if (prev?.lastModified) headers['If-Modified-Since'] = prev.lastModified;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (res.status === 304) return { text: null };   // 変化なし=前回分を使う
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      text: await res.text(),
      etag: res.headers.get('etag') ?? undefined,
      lastModified: res.headers.get('last-modified') ?? undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(name: string, url: string, lang: 'ja' | 'en', heavy = false): Promise<NewsItem[]> {
  let feed;
  if (heavy) {
    try {
      const got = await fetchFeedText(url);
      if (got.text === null) return conditionalCache.get(url)?.items ?? [];   // 304
      feed = await parser.parseString(got.text);
      const items = mapFeedItems(feed, name, lang);
      conditionalCache.set(url, { etag: got.etag, lastModified: got.lastModified, items });
      return items;
    } catch (err) {
      console.warn(`[rss] ${name} conditional GET failed, falling back:`, err instanceof Error ? err.message : err);
      // フォールバックして通常経路へ(下へ抜ける)
    }
  }
  try {
    feed = await parser.parseURL(url);
  } catch (err) {
    console.warn(`[rss] ${name} failed:`, err instanceof Error ? err.message : err);
    throw err;
  }
  return mapFeedItems(feed, name, lang);
}

function mapFeedItems(feed: Parser.Output<Record<string, unknown>>, name: string, lang: 'ja' | 'en'): NewsItem[] {
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

export async function fetchAllNews(now = Date.now()): Promise<NewsItem[]> {
  const tasks: Promise<NewsItem[]>[] = [];
  for (const f of RSS_FEEDS.ja) tasks.push(fetchFeed(f.name, f.url, 'ja'));
  for (const f of RSS_FEEDS.en) tasks.push(fetchFeed(f.name, f.url, 'en', 'heavy' in f && f.heavy === true));
  tasks.push(fetchNikkei225jpNews());   // nikkei225jp 総合ニュース(他ソースと同列・広く取り込む)
  tasks.push(fetchNikkei225jpNewsJp()); // 225225.jp /1jp/ 国内ニュース(News_6)
  tasks.push(fetchNikkei225jpNewsNy()); // 225225.jp /3ny/ 米国ニュース(News_8)
  tasks.push(fetchEconIndicators());    // 米経済指標(minkabu・結果+NK225反応)
  const results = await Promise.allSettled(tasks);
  const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  // id で重複排除(別ソース経由の同一記事に備える)。
  const seen = new Set<string>();
  const uniq = items.filter(it => (seen.has(it.id) ? false : (seen.add(it.id), true)));
  // ★並びと件数の切り方は従来どおり「新しい順に NEWS_MAX_ITEMS 件」のまま変えない。
  //   ここを インパクト順で切ると **AI が見るニュースの集合が変わってしまう**
  //   (server/llm/explain.ts と chat の formatNewsForChat は、この配列の順序と内容に依存する)。
  //   今回の依頼は取得・保存・選別・表示までで、AI 文脈の組み立ては対象外なので集合は不変にする。
  //   インパクト順に並べ替えるのは **表示の直前**(web/components/newsFeed.ts)で行う。
  const recent = uniq
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, NEWS_MAX_ITEMS);
  // 採点と確度は「配列に足すだけ」。既存の消費者(AI)はこの欄を読まないので挙動は不変。
  // ★確度はプール全体を見ないと決まらない(裏取り = 別ソースに同じ出来事があるか)ので、
  //   切り詰めた後のプールに対して一度だけ評価する。
  const scored = recent.map(n => ({ ...n, impact: scoreNewsImpact(n, now) }));
  return withConfidence(scored);
}
