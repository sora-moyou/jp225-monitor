// 米経済指標(結果)を NEWS に取り込むソース。無料・robots許可の minkabu 経済指標カレンダー
// (https://fx.minkabu.jp/indicators)を取得し、US × 重要度★4+ × 発表済み(結果あり)を抽出する。
// 各指標に NK225夜間先物の「発表後10分」の反応(pt)を価格DBから付与する。
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getBarCloseNear } from '../db/store.js';
import type { NewsItem } from '../types.js';

const BASE_URL = 'https://fx.minkabu.jp/indicators';
const MIN_IMPORTANCE = 4;                   // ★4以上(高インパクト)
const REACTION_SYMBOL = 'NIY=F';            // NK225 夜間先物(指数値)
const REACTION_WINDOW_MS = 10 * 60_000;     // 発表後10分
const NEAR_TOL_MS = 3 * 60_000;             // 終値近傍許容(欠損足対策)
const RECENT_MS = 18 * 60 * 60_000;         // 直近18時間に発表されたもののみ(古い指標で板を埋めない)

export interface EconIndicator {
  name: string;        // 指標名(日本語・国名/参照月/別名を除去)
  releaseAt: number;   // 発表時刻(epoch ms・JST)
  importance: number;  // 重要度(★の数)
  previous: string;    // 前回
  forecast: string;    // 予想
  actual: string;      // 結果(発表済みのみ非'---')
}

function clean(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

// 指標名を整形。国名/参照月を除去し、末尾 [..] は「サブ種別(前月比/コア等)」なら名前に残す
// (CPI の前月比/前年比/コアを区別するため)。冗長な別名(MSIP の正式名など)は付けない。
//   "アメリカ・消費者物価指数（CPI） 05月 [前月比]" → "消費者物価指数（CPI）（前月比）"
//   "アメリカ・ミシガン大学消費者信頼感指数（速報値） 06月 [ミシガン大学消費者信頼感指数]"
//     → "ミシガン大学消費者信頼感指数（速報値）"(別名は基本名に内包されるため付けない)
function tidyName(raw: string): string {
  let s = clean(raw).replace(/^アメリカ・/, '');
  const bracket = /\[([^\]]*)\]\s*$/.exec(s)?.[1]?.trim();
  s = s.replace(/\s*\[[^\]]*\]\s*$/, '').replace(/\s*\d{1,2}月\s*$/, '').trim();
  if (bracket && !s.includes(bracket) && !bracket.includes(s)) s = `${s}（${bracket}）`;
  return s;
}

/** minkabu 単日ページHTML(date=その日)から US×重要度★MIN+×全行 を抽出。
 *  発表済み判定は actual!=='---'。releaseAt は dateYmd(JST) + 行の時刻。 */
export function parseMinkabuIndicators(html: string, dateYmd: string): EconIndicator[] {
  const out: EconIndicator[] = [];
  // <tr class="fs-s" data_importance="N" data_country="US"> ... </tr>
  const rowRe = /<tr class="fs-s" data_importance="(\d+)" data_country="US">([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(rowRe)) {
    const importance = Number(m[1]);
    const inner = m[2] ?? '';
    if (!Number.isFinite(importance) || importance < MIN_IMPORTANCE) continue;

    const time = /<span>\s*(\d{1,2}:\d{2})\s*<\/span>/.exec(inner)?.[1];
    if (!time) continue;
    const nameRaw = /href="\/indicators\/[^"]*">\s*<p[^>]*>([\s\S]*?)<\/p>/.exec(inner)?.[1];
    if (!nameRaw) continue;
    // eilist__data セル(前回・予想・結果)を順に取得。
    const data = [...inner.matchAll(/eilist__data[^>]*">\s*<span>([\s\S]*?)<\/span>/g)].map(d => clean(d[1] ?? ''));
    if (data.length < 3) continue;
    const [previous, forecast, actual] = [data[0]!, data[1]!, data[2]!];
    if (actual === '' || actual === '---') continue;   // 未発表は除外

    const releaseAt = Date.parse(`${dateYmd}T${time.padStart(5, '0')}:00+09:00`);
    if (!Number.isFinite(releaseAt)) continue;

    out.push({ name: tidyName(nameRaw), releaseAt, importance, previous, forecast, actual });
  }
  return out;
}

/** 発表時点と +10分時点の終値差(pt・符号付)。いずれか欠損なら null。 */
export function computeReaction(baseClose: number | null, afterClose: number | null): number | null {
  if (baseClose === null || afterClose === null) return null;
  if (!Number.isFinite(baseClose) || !Number.isFinite(afterClose)) return null;
  return Math.round(afterClose - baseClose);
}

/** EconIndicator を NewsItem に整形(結果・予想・前回・反応)。 */
export function toNewsItem(ind: EconIndicator, reaction: number | null): NewsItem {
  const fp: string[] = [];
  if (ind.forecast && ind.forecast !== '---') fp.push(`予想 ${ind.forecast}`);
  if (ind.previous && ind.previous !== '---') fp.push(`前回 ${ind.previous}`);
  const ctx = fp.length ? `（${fp.join('／')}）` : '';
  const react = reaction === null ? '' : ` → NK225 ${reaction >= 0 ? '+' : ''}${reaction}pt(10分)`;
  return {
    id: `econ:${ind.name}:${ind.releaseAt}`,
    title: `📊 米指標 ${ind.name}: 結果 ${ind.actual}${ctx}${react}`,
    source: '米経済指標',
    lang: 'ja',
    url: BASE_URL,
    publishedAt: ind.releaseAt,
  };
}

// --- 取得 + 反応算出(副作用あり) ---
let _db: DatabaseSync | null = null;
function db(): DatabaseSync { return (_db ??= openDb(resolveDbPath())); }
const _reactionMemo = new Map<string, number>();

/** JST の YYYY-MM-DD を offsetDays 日ずらして返す。 */
function jstDate(now: number, offsetDays: number): string {
  return new Date(now + 9 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

async function fetchDay(dateYmd: string): Promise<EconIndicator[]> {
  const url = `${BASE_URL}?date=${dateYmd}&days=1&importance=${MIN_IMPORTANCE}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FinanceMonitor/0.1' } });
  if (!res.ok) return [];
  return parseMinkabuIndicators(await res.text(), dateYmd);
}

/** 米経済指標(発表済み・直近18h)を NewsItem[] で返す。失敗時は []。 */
export async function fetchEconIndicators(): Promise<NewsItem[]> {
  const now = Date.now();
  let inds: EconIndicator[];
  try {
    // 当日 + 前日(JST日付境界をまたぐ深夜発表に備える)。
    const days = await Promise.all([jstDate(now, 0), jstDate(now, -1)].map(d => fetchDay(d).catch(() => [])));
    inds = days.flat();
  } catch { return []; }

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  for (const ind of inds) {
    if (now - ind.releaseAt > RECENT_MS) continue;   // 古い指標は出さない(板を埋めない)
    const id = `econ:${ind.name}:${ind.releaseAt}`;
    if (seen.has(id)) continue;
    seen.add(id);

    let reaction = _reactionMemo.get(id) ?? null;
    if (reaction === null && now >= ind.releaseAt + REACTION_WINDOW_MS) {
      try {
        const base = getBarCloseNear(db(), REACTION_SYMBOL, ind.releaseAt, NEAR_TOL_MS);
        const after = getBarCloseNear(db(), REACTION_SYMBOL, ind.releaseAt + REACTION_WINDOW_MS, NEAR_TOL_MS);
        reaction = computeReaction(base, after);
        if (reaction !== null) _reactionMemo.set(id, reaction);
      } catch { reaction = null; }
    }
    items.push(toNewsItem(ind, reaction));
  }
  return items;
}
