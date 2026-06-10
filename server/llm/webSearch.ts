// チャットの web_search ツール用。Tavily REST を叩いて要約付き検索結果を返す。
// キー未設定/失敗時は空配列(チャットは検索なしで継続)。
import { resolveTavilyKey } from '../configStore.js';

export interface SearchHit { title: string; url: string; content: string; publishedDate?: string; }

export function isWebSearchEnabled(): boolean {
  return !!resolveTavilyKey();
}

export async function tavilySearch(query: string, maxResults = 5, key = resolveTavilyKey()): Promise<SearchHit[]> {
  if (!key) return [];
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', topic: 'general' }),
    });
    if (!r.ok) { console.warn(`[webSearch] Tavily ${r.status}`); return []; }
    const data = await r.json() as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (data.results ?? []).map(x => ({
      title: x.title ?? '', url: x.url ?? '', content: x.content ?? '', publishedDate: x.published_date,
    }));
  } catch (e) {
    console.warn(`[webSearch] error: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '(検索結果なし)';
  return hits.map((h, i) => `${i + 1}. ${h.title}${h.publishedDate ? ` (${h.publishedDate})` : ''}\n   ${h.url}\n   ${h.content}`).join('\n');
}
