import type { NewsItem, Price } from '../types.js';
import { callWithFallback } from './providers.js';
import { isWebSearchEnabled, webSearch } from './webSearch.js';
import {
  formatPricesForChat, formatNewsForChat, buildMonitorContext, buildDataToolHandlers, runChatWithTools,
  EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL, WEB_SEARCH_TOOL,
  type ToolHandlers, type CreateFn,
} from './dataTools.js';

// ─── チャット ─────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }
// v0.3.34: AI に渡す「相関の高い1銘柄」。急変が外部要因(ファンダ)か日経固有(テクニカル)かの切り分け用。
export interface Correlate { label: string; corr: number; samples: number; changePercent: number; }
export interface ChatInput { messages: ChatMessage[]; prices: Price[]; news: NewsItem[]; technical?: string | null; correlate?: Correlate; }

function formatCorrelate(c: Correlate | undefined): string {
  if (!c) return '';
  const sign = c.changePercent >= 0 ? '+' : '';
  const rel = c.corr >= 0 ? '同方向に連動' : '逆方向に連動';
  return `■ 最相関銘柄 (急変要因の切り分け用):\n` +
    `- ${c.label} (日経との相関 ${c.corr.toFixed(2)}, n=${c.samples}, 通常は${rel}) 現在 ${sign}${c.changePercent.toFixed(2)}%\n` +
    `  → この銘柄が相関どおり動いていれば外部(マクロ/ファンダ)要因、動いていなければ日経固有(テクニカル/需給)要因の可能性。`;
}

const CHAT_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。
ユーザーから現在の相場や銘柄について質問が来るので、以下の【市場の現状】を踏まえて日本語で簡潔に答えてください。

- 日本語で、結論先出し、簡潔に
- 出力はプレーンテキスト。マークダウンの見出し(#・##・###)や強調(**太字**)は使わない。箇条書きは行頭「*」、見出し的な区切りは記号なしの短い語(例: 上値メド)で示す
- 数字を出すときは現状データから具体的に引用する
- 上値メド・下値メドは「+80円」のような距離ではなく価格(例 67,000円)で示す
- 推測や仮説は「〜と推察される」「〜の可能性が高い」と明示
- 不明な場合は素直に「データなし」と答える
- 銘柄間の連動性、テクニカル要因（サポレジ・ボラ）、ファンダ材料を組み合わせて分析する
- 急変について問われたら、最相関銘柄の動きから「外部(ファンダ)要因か、日経固有(テクニカル/需給)要因か」を必ず一言示す
- 【重要・取引時間】東証個別株(.T)は 9:00-15:30 JST のみ取引。昼休み・夜間・早朝(=先物のNightセッション等)は動いていないので、その時刻の日経先物の急変の理由に個別株の値動きを持ち出さない。個別株を連動材料にしてよいのは東証の立会中(9:00-15:30)に限る
- web_search ツールが使える場合、手元の【市場の現状】で足りない最新の出来事・ニュースは検索して確認し、引用時は「(出典/日時)」を簡潔に添える。手元で足りる時は無理に検索しない`;
// ★上の【重要・取引時間】の行について(v0.9.71 の値がさ株7削除に伴う整理)。
//   元の行は 2 つの節でできていた:
//     (a)「『※東証クローズ中』の銘柄は今の材料として引用しない」
//         → **死文なので落とした**。このマーカーを出していたのは formatPricesForChat の
//           heavyweight 分岐で、値がさ株7を INSTRUMENTS ごと削除した今は二度と出ない。
//     (b)「東証個別株は 9:00-15:30 のみ取引 / 夜間の日経先物の理由に個別株を持ち出さない」
//         → **生きているガードなので残す**。★価格を取らなくなっても、個別株は
//           **ニュース経由でモデルに届く**(systemPrompt は【市場の現状】に ■現在価格 だけでなく
//           ■関連ニュース も入れており、「売買代金はキオクシア…が上位」のような見出しが実際に来る)。
//           むしろ (a) のマーカーが消えて「今は東証が閉まっている」という帯域内シグナルを失ったぶん、
//           このガードの必要性は **上がっている**。
//   ★文言は server/config.ts の LLM_SYSTEM_PROMPT(explain 側)L203 と揃えてある。
//     explain に残して chat から消す、という非対称を同一チェンジセット内に作らないため。
//   ★この編集は **チャットの system prompt だけ**。取引の判断に使う scalpPlan.ts / explain.ts の
//     プロンプトには一切触れていない(両ファイルは HEAD と全文ハッシュ一致)。

export async function chat(input: ChatInput): Promise<string> {
  const now = Date.now();
  const lastUser = [...input.messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const monitorCtx = buildMonitorContext(now);
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (input.correlate ? `${formatCorrelate(input.correlate)}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(input.news, now, lastUser)}`;

  // データツール(explain_move/query_alerts/price_history)は外部キー不要ゆえ常時有効。
  // web_search は Gemini グラウンディング用キー(webSearchKey か共通 geminiKey)がある時のみ追加する。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? await webSearch(q) : '(クエリ空)';
    };
  }
  return callWithFallback(async (p) => {
    // 8000: スイング分析など長文の途中切れ対策。推論モデルは thinking トークンもこの枠を消費するため余裕を持たせる。
    // 注: 静的オブジェクトに messages が無いと SDK オーバーロード解決で TS2769。as any でキャスト。
    const create: CreateFn = (params) => p.client!.chat.completions.create({
      model: p.config.chatModel, temperature: 0.5, max_tokens: 8000, ...params,
    } as any);
    const baseMessages = [{ role: 'system', content: systemPrompt }, ...input.messages];
    // データツールが常に存在するため、常に tool ループを通す(web_search はキーがある時のみ tools に含まれる)。
    return runChatWithTools(create, baseMessages, tools, handlers);
  }, 'chat');
}
