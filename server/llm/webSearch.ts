// チャットの web_search ツール用。Gemini の Google Search グラウンディングで最新情報を取得する。
// キー未設定/失敗時は「検索できませんでした」等を返す(チャットは検索なしで継続=耐障害性維持)。
//
// ★実装経路: ネイティブ Gemini `:generateContent` + tools:[{google_search:{}}](plain fetch)。
//   OpenAI 互換エンドポイントの標準 tools では google_search が通らないためネイティブを使う。
//   grounding は Gemini 3+ モデル必須。既定 gemini-flash-latest(3.x 追従エイリアス)。
import { resolveWebSearchKey, resolveWebSearchModel } from '../configStore.js';

export interface SearchHit { title: string; url: string; content: string; publishedDate?: string; }
export interface GroundedResult { answer: string; sources: SearchHit[]; }

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export function isWebSearchEnabled(): boolean {
  return !!resolveWebSearchKey();
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
 * all-in-one: クエリを Gemini グラウンディングで検索し、チャットへ渡す整形文字列を返す。
 * キー無し/失敗は説明的な文言(チャットは検索なしで続行できる)。openai.ts の web_search ハンドラが使う。
 */
export async function webSearch(query: string): Promise<string> {
  if (!isWebSearchEnabled()) return '(web検索は未設定です)';
  const res = await geminiGroundedSearch(query);
  if (!res.answer && res.sources.length === 0) return '(検索できませんでした)';
  return formatGrounded(res);
}
