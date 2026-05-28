import OpenAI from 'openai';
import type { NewsItem, Price } from '../types.js';
import {
  LLM_MODEL, LLM_CHAT_MODEL, LLM_BASE_URL, LLM_SYSTEM_PROMPT,
  NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN,
  INSTRUMENT_KEYWORDS, HIGH_IMPACT_KEYWORDS,
  INSTRUMENTS,
} from '../config.js';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const isPlaceholder = !apiKey
  || apiKey === 'sk-your-key-here'
  || apiKey === 'gsk_your-key-here'
  || apiKey === 'AIza-your-key-here'
  || apiKey.includes('your-key');
const client = !isPlaceholder
  ? new OpenAI({ apiKey, baseURL: LLM_BASE_URL })
  : null;

export function isLLMEnabled(): boolean { return client !== null; }

// ─── サーキットブレーカー: 429を受けたらN秒は LLM 呼ばずに即フォールバック ───
const CIRCUIT_PAUSE_MS = 60_000;
let circuitOpenUntil = 0;

function checkCircuit(): void {
  if (Date.now() < circuitOpenUntil) {
    throw new Error('429 (circuit open, cooldown)');
  }
}
function tripCircuit(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/429|rate[_ ]limit|exhausted/i.test(msg)) {
    circuitOpenUntil = Date.now() + CIRCUIT_PAUSE_MS;
    const sec = Math.round(CIRCUIT_PAUSE_MS / 1000);
    console.warn(`[LLM] 429 detected — circuit open for ${sec}s`);
  }
}

export interface ExplainInput {
  symbol: string;            // ランク付けキー (NK=F 等)
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
}

// 急変銘柄に対するニュースの関連度スコア（高いほど関連）
// 重要マクロ材料は数時間前でも上位に残るよう、HIGH_IMPACT を強くし
// recency 減衰をゆるく (2時間で0) する
function scoreNews(news: NewsItem, keywords: string[], now: number): number {
  const title = news.title.toLowerCase();
  let kwHits = 0;
  for (const kw of keywords) {
    if (title.includes(kw.toLowerCase())) kwHits++;
  }
  let highImpactHits = 0;
  for (const kw of HIGH_IMPACT_KEYWORDS) {
    if (title.includes(kw.toLowerCase())) highImpactHits++;
  }
  const ageMin = (now - news.publishedAt) / 60000;
  // 新しいほど加点 (0〜NEWS_RECENCY_DECAY_MIN 分の線形減衰)
  const recency = Math.max(0, 1 - ageMin / NEWS_RECENCY_DECAY_MIN);
  // 重大マクロ材料は時間が経っても重要 → 6倍ブースト
  return kwHits * 2 + highImpactHits * 6 + recency;
}

// 関連順にトップNを返す（キーワード未ヒットでも入れる）
function rankAndFormatNews(input: ExplainInput, now: number): string {
  const cutoff = now - NEWS_RECENT_WINDOW_MS;
  const recent = input.news.filter(n => n.publishedAt >= cutoff);
  const keywords = INSTRUMENT_KEYWORDS[input.symbol] ?? [];
  const ranked = [...recent]
    .map(n => ({ n, s: scoreNews(n, keywords, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)   // トークン節約 (Groq無料枠: 6000 TPM)
    .map(x => x.n);

  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export async function explain(input: ExplainInput): Promise<string> {
  if (!client) return '(LLM disabled — OPENAI_API_KEY 未設定)';
  checkCircuit();

  const now = Date.now();
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ' : 'トレンド';
  const dirJa = input.changePercent >= 0 ? '上昇' : '下落';
  const windowHours = Math.round(NEWS_RECENT_WINDOW_MS / 3600_000);
  const ctx15Line = input.change15min !== null
    ? `【15分変化率】${input.change15min >= 0 ? '+' : ''}${input.change15min.toFixed(2)}%\n`
    : '';
  // 直近15分のOHLCを文字で表現 → LLMが「下髭」「サポート反転」等を読める
  const pa15Line = input.pa15min
    ? `【15分OHLC】始値 ${fmt(input.pa15min.open)} / 高値 ${fmt(input.pa15min.high)} / 安値 ${fmt(input.pa15min.low)} / 現値 ${fmt(input.pa15min.current)}\n`
    : '';
  const range1hLine = input.range1h
    ? `【1時間レンジ】高値 ${fmt(input.range1h.high)} / 安値 ${fmt(input.range1h.low)}\n`
    : '';
  const userPrompt =
    `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa}しました。\n` +
    ctx15Line +
    pa15Line +
    range1hLine +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(input, now)}\n\n` +
    `上記の急変・価格アクション・ニュースを総合し、1〜2文で説明してください。\n` +
    `- 必ずニュース1件を「○○分前のXXがYYのため」の形で引用する\n` +
    `- 価格アクション（下髭/上髭/サポート反転/レンジブレイク等）が読み取れれば併記してよい (例: 「ただし15分OHLCで安値64480→現値64720と大きな下髭、サポート反転の兆し」)\n` +
    `- 古くても相場転換の引き金となる材料（FOMC, 介入, 地政学, 重要指標）を優先`;

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.3,
      max_tokens: 1500,   // Gemini lite でも余裕を持たせる
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt + '\n\n出力は必ず200文字以内、1〜2文で。' },
      ],
    });
  } catch (err) {
    tripCircuit(err);
    throw err;
  }
  const choice = completion.choices[0];
  const text = choice?.message?.content?.trim() ?? '(no response)';
  if (choice?.finish_reason === 'length') {
    const usage = completion.usage;
    console.warn(`[explain] TRUNCATED by token limit. usage=${JSON.stringify(usage)}`);
    return text + ' …(token切れ)';
  }
  return text;
}

// 価格を読みやすい桁数で
function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

// ─── チャット機能 ─────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string; }

export interface ChatInput {
  messages: ChatMessage[];
  prices: Price[];
  news: NewsItem[];
}

const LABEL_MAP = new Map(INSTRUMENTS.map(i => [i.symbol as string, i]));

function formatPricesForChat(prices: Price[]): string {
  if (prices.length === 0) return '(価格未取得)';
  return prices.map(p => {
    const meta = LABEL_MAP.get(p.symbol);
    const label = meta?.labelJa ?? p.symbol;
    const sign = p.changePercent >= 0 ? '+' : '';
    const staleMark = p.stale ? ' (stale)' : '';
    return `- ${label} ${p.symbol}: ${fmt(p.price)} (${sign}${p.changePercent.toFixed(2)}%)${staleMark}`;
  }).join('\n');
}

function formatNewsForChat(news: NewsItem[], now: number): string {
  if (news.length === 0) return '(ニュースなし)';
  return news.slice(0, 15).map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

const CHAT_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。
ユーザーから現在の相場や銘柄について質問が来るので、以下の【市場の現状】を踏まえて日本語で簡潔に答えてください。

- 日本語で、結論先出し、箇条書きや短い段落で読みやすく
- 数字を出すときは現状データから具体的に引用する
- 推測や仮説は「〜と推察される」「〜の可能性が高い」と明示
- 不明な場合は素直に「データなし」と答える
- 銘柄間の連動性、テクニカル要因（サポレジ・ボラ）、ファンダ材料を組み合わせて分析する`;

export async function chat(input: ChatInput): Promise<string> {
  if (!client) return '(LLM disabled — OPENAI_API_KEY 未設定)';
  checkCircuit();

  const now = Date.now();
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices)}\n\n` +
    `■ 直近ニュース (上位15件):\n${formatNewsForChat(input.news, now)}`;

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: LLM_CHAT_MODEL,         // Thinking 有効モデル
      temperature: 0.5,
      max_tokens: 4000,              // Thinking + 長めの回答に十分な余裕
      messages: [
        { role: 'system', content: systemPrompt },
        ...input.messages,
      ],
    });
  } catch (err) {
    tripCircuit(err);
    throw err;
  }
  const choice = completion.choices[0];
  const text = choice?.message?.content?.trim() ?? '(no response)';
  if (choice?.finish_reason === 'length') {
    console.warn(`[chat] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
    return text + ' …(token切れ)';
  }
  return text;
}
