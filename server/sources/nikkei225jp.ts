// nikkei225jp.com の総合ニュースを取り込むソース。RSS ではなく独自の JS データファイル
// (/_data/_nfsWEB/rss/News_ALL1.js)を取得し、`News[n]='a__b__...';n++` 形式をパースする。
// 他のニュースソースと同列に扱い、指標に限らず広く取り込む(明らかな非金融=ブラックリストのみ除外)。
import type { NewsItem } from '../types.js';
import { FINANCE_BLACKLIST } from '../config.js';

// 総合ニュース(全カテゴリ)。robots は /_data/ を Disallow するが、提供元の有料利用者が
// 自分用に低頻度取得する用途(ユーザー承認済)。
const NEWS_URL = 'https://nikkei225jp.com/_data/_nfsWEB/rss/News_ALL1.js';

// タイトルが明らかに非金融(スポーツ/芸能/グルメ等)なら除外。それ以外は広く取り込む。
function passesBlacklist(title: string): boolean {
  const t = title.toLowerCase();
  for (const kw of FINANCE_BLACKLIST) {
    if (t.includes(kw.toLowerCase())) return false;
  }
  return true;
}

/** "2026/06/12 06:49"(JST) → epoch ms。形式不一致は NaN。 */
export function parseJstDateTime(s: string): number {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:00+09:00`);
}

/** News_ALL1.js 本文(News[n]='a__b__...';n++ の羅列)を NewsItem[] に変換。
 *  __ 区切り: [0]id [1]日時(JST) [2..4]コード [5]ソース [6]URL [7]見出し [8,9]フラグ。
 *  非金融(ブラックリスト)見出しは除外し、それ以外は広く取り込む(指標限定にしない)。 */
export function parseNikkei225jpNews(text: string): NewsItem[] {
  const out: NewsItem[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(/News\[n\]\s*=\s*'([\s\S]*?)';\s*n\+\+/g)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const f = raw.split('__');
    if (f.length < 8) continue;
    const title = (f[7] ?? '').trim();
    const url = (f[6] ?? '').trim();
    const publishedAt = parseJstDateTime(f[1] ?? '');
    if (!title || !Number.isFinite(publishedAt)) continue;
    if (!passesBlacklist(title)) continue;
    const id = `n225jp:${url || `${f[1]}:${title.slice(0, 24)}`}`;
    if (seen.has(id)) continue;   // 同一ファイル内の重複除去
    seen.add(id);
    out.push({
      id,
      title,
      source: (f[5] ?? '').trim() || 'nikkei225jp',   // 実際の配信元(Yahoo!/CoinPost 等)
      lang: 'ja',
      url,
      publishedAt,
    });
  }
  return out;
}

/** nikkei225jp の総合ニュースを取得。失敗時は [](他ソースに影響させない)。 */
export async function fetchNikkei225jpNews(): Promise<NewsItem[]> {
  try {
    const res = await fetch(NEWS_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FinanceMonitor/0.1',
        'Referer': 'https://nikkei225jp.com/news/',
      },
    });
    if (!res.ok) return [];
    const text = await res.text();
    return parseNikkei225jpNews(text);
  } catch (err) {
    console.warn('[nikkei225jp] failed:', err instanceof Error ? err.message : err);
    return [];
  }
}
