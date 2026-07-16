// チャットの web_search ツール用。Gemini の Google Search グラウンディングで最新情報を取得する。
// キー未設定/失敗時は「検索できませんでした」等を返す(チャットは検索なしで継続=耐障害性維持)。
//
// ★実装経路: ネイティブ Gemini `:generateContent` + tools:[{google_search:{}}](plain fetch)。
//   OpenAI 互換エンドポイントの標準 tools では google_search が通らないためネイティブを使う。
//   grounding は Gemini 3+ モデル必須。既定 gemini-flash-latest(3.x 追従エイリアス)。
import OpenAI from 'openai';
import { resolveWebSearchKey, resolveWebSearchModel, resolveWebSearchOpenaiModel, resolveApiKey } from '../configStore.js';

export interface SearchHit { title: string; url: string; content: string; publishedDate?: string; }
export interface GroundedResult { answer: string; sources: SearchHit[]; }

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Web 検索の経路を純粋に決める。Gemini キーが解決できれば Gemini グラウンディング、
// 無くて OpenAI キーがあれば OpenAI 検索、どちらも無ければ検索不可('none')。
export type WebSearchRoute = 'gemini' | 'openai' | 'none';
export function chooseWebSearchRoute(geminiKey?: string, openaiKey?: string): WebSearchRoute {
  if (geminiKey && geminiKey.trim()) return 'gemini';
  if (openaiKey && openaiKey.trim()) return 'openai';
  return 'none';
}

export function isWebSearchEnabled(): boolean {
  return chooseWebSearchRoute(resolveWebSearchKey(), resolveApiKey('openai')) !== 'none';
}

/**
 * Gemini generateContent の応答(grounding つき)から answer と出典 sources を取り出す(純粋)。
 * - answer: candidates[0].content.parts[].text を連結。
 * - sources: candidates[0].groundingMetadata.groundingChunks[].web{uri,title} を SearchHit[] に。
 * 欠損に強い(どの階層が無くても空で返す)。
 */
export function parseGrounding(json: unknown): GroundedResult {
  const empty: GroundedResult = { answer: '', sources: [] };
  if (!json || typeof json !== 'object') return empty;
  const cand = (json as { candidates?: unknown[] }).candidates?.[0] as
    | { content?: { parts?: Array<{ text?: unknown }> }; groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }> } }
    | undefined;
  if (!cand) return empty;
  const answer = (cand.content?.parts ?? [])
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
  const sources: SearchHit[] = [];
  for (const ch of cand.groundingMetadata?.groundingChunks ?? []) {
    const uri = ch.web?.uri;
    const title = ch.web?.title;
    if (typeof uri === 'string' && uri) {
      sources.push({ title: typeof title === 'string' ? title : uri, url: uri, content: '' });
    }
  }
  return { answer, sources };
}

/** GroundedResult をチャットに渡す整形テキストに。answer が空でも sources があれば出典だけ返す。 */
export function formatGrounded(r: GroundedResult): string {
  const parts: string[] = [];
  if (r.answer) parts.push(r.answer);
  if (r.sources.length) {
    const list = r.sources.map((h, i) => `${i + 1}. ${h.title}${h.title !== h.url ? ` (${h.url})` : ''}`).join('\n');
    parts.push(`出典:\n${list}`);
  }
  return parts.length ? parts.join('\n\n') : '(検索結果なし)';
}

/**
 * Gemini グラウンディング検索を1回叩く。非200/例外/キー無しは空結果({answer:'',sources:[]})。
 * fetchImpl を注入可能(テスト用・既定 global fetch)。
 */
export async function geminiGroundedSearch(
  query: string,
  key = resolveWebSearchKey(),
  model = resolveWebSearchModel(),
  fetchImpl: typeof fetch = fetch,
): Promise<GroundedResult> {
  if (!key) return { answer: '', sources: [] };
  try {
    const url = `${GEMINI_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    const r = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: query }] }],
        tools: [{ google_search: {} }],
      }),
    });
    if (!r.ok) { console.warn(`[webSearch] Gemini grounding ${r.status}`); return { answer: '', sources: [] }; }
    return parseGrounding(await r.json());
  } catch (e) {
    console.warn(`[webSearch] error: ${e instanceof Error ? e.message : e}`);
    return { answer: '', sources: [] };
  }
}

/**
 * OpenAI chat.completions の Web 検索応答から answer と出典 sources を取り出す(純粋)。
 * - answer: choices[0].message.content。
 * - sources: choices[0].message.annotations[].url_citation{url,title} を SearchHit[] に。
 * 欠損に強い(どの階層が無くても空で返す)。
 */
export function parseOpenAiSearch(json: unknown): GroundedResult {
  const empty: GroundedResult = { answer: '', sources: [] };
  if (!json || typeof json !== 'object') return empty;
  const choice = (json as { choices?: unknown[] }).choices?.[0] as
    | { message?: { content?: unknown; annotations?: Array<{ type?: unknown; url_citation?: { url?: unknown; title?: unknown } }> } }
    | undefined;
  const msg = choice?.message;
  if (!msg) return empty;
  const answer = typeof msg.content === 'string' ? msg.content.trim() : '';
  const sources: SearchHit[] = [];
  for (const a of msg.annotations ?? []) {
    const url = a.url_citation?.url;
    const title = a.url_citation?.title;
    if (typeof url === 'string' && url) {
      sources.push({ title: typeof title === 'string' && title ? title : url, url, content: '' });
    }
  }
  return { answer, sources };
}

/** OpenAI chat.completions の create 相当。テストでモックを注入するための最小シグネチャ。 */
export type OpenAiCreateFn = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * OpenAI の Web 検索対応モデル(chat.completions・既定 gpt-4o-mini-search-preview)で1回検索する。
 * search-preview 系は temperature 等の非対応があるため最小パラメータで呼ぶ。
 * 非200/例外/キー無しは空結果({answer:'',sources:[]})。createFn を注入可能(テスト用・既定は OpenAI SDK)。
 */
export async function openaiWebSearch(
  query: string,
  key = resolveApiKey('openai'),
  model = resolveWebSearchOpenaiModel(),
  createFn?: OpenAiCreateFn,
): Promise<GroundedResult> {
  if (!key) return { answer: '', sources: [] };
  try {
    const create: OpenAiCreateFn = createFn
      ?? ((params) => new OpenAI({ apiKey: key }).chat.completions.create(params as never) as Promise<unknown>);
    // 最小パラメータ(temperature/top_p 等は search-preview で非対応のため付けない)。
    const completion = await create({
      model,
      messages: [{ role: 'user', content: query }],
    });
    return parseOpenAiSearch(completion);
  } catch (e) {
    console.warn(`[webSearch] OpenAI search error: ${e instanceof Error ? e.message : e}`);
    return { answer: '', sources: [] };
  }
}

/**
 * all-in-one: クエリを Web 検索し、チャットへ渡す整形文字列を返す。
 * 経路: Gemini キー解決可 → Gemini グラウンディング / それが無く OpenAI キーあり → OpenAI 検索 / 両方無し → 未設定文言。
 * キー無し/失敗は説明的な文言(チャットは検索なしで続行できる)。openai.ts の web_search ハンドラが使う。
 */
export async function webSearch(query: string): Promise<string> {
  const openaiKey = resolveApiKey('openai');
  const route = chooseWebSearchRoute(resolveWebSearchKey(), openaiKey);
  if (route === 'none') return '(web検索は未設定です)';
  let res = route === 'gemini' ? await geminiGroundedSearch(query) : await openaiWebSearch(query);
  // Gemini が空(枠切れ429/失敗)で OpenAI キーがあれば OpenAI 検索へフォールバック(Gemini 枠切れでも検索を止めない)。
  if (route === 'gemini' && !res.answer && res.sources.length === 0 && openaiKey && openaiKey.trim()) {
    res = await openaiWebSearch(query);
  }
  if (!res.answer && res.sources.length === 0) return '(検索できませんでした)';
  return formatGrounded(res);
}
