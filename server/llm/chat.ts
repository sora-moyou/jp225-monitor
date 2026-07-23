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
- 【重要】東証個別株(キーエンス/ファストリ/ディスコ/SMC/東京エレクトロン/ソフトバンクG/キオクシア等の .T 銘柄)は 9:00-15:30 JST のみ取引。それ以外(昼休み・夜間・早朝=先物のNightセッション等)は前回終値で固定され動かない。「※東証クローズ中」の銘柄は、その時点で「今動いた/今の材料」として絶対に引用しない(夜間の日経先物の動きの理由に個別株を持ち出さない)。場中(9:00-15:30)のみ連動材料として扱う
- web_search ツールが使える場合、手元の【市場の現状】で足りない最新の出来事・ニュースは検索して確認し、引用時は「(出典/日時)」を簡潔に添える。手元で足りる時は無理に検索しない`;

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
