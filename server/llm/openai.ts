import OpenAI from 'openai';
import type { NewsItem, Price } from '../types.js';
import {
  LLM_PROVIDERS, LLM_SYSTEM_PROMPT,
  NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN,
  NEWS_PROXIMITY_TIGHT_MIN, NEWS_PROXIMITY_LOOSE_MIN,
  INSTRUMENT_KEYWORDS, HIGH_IMPACT_KEYWORDS,
  INSTRUMENTS,
} from '../config.js';
import type { LLMProvider } from '../config.js';
import type { Mover } from '../marketSnapshot.js';
import { resolveApiKey } from '../configStore.js';

interface ProviderState {
  config: LLMProvider;
  client: OpenAI | null;
  circuitOpenUntil: number;
  consecutiveFails: number;
  lastFailAt: number;
}

const PAUSE_LADDER_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 8 * 3600_000];
const CONSECUTIVE_WINDOW_MS = 10 * 60_000;

function buildProvider(config: LLMProvider): ProviderState {
  const name = config.name as 'gemini' | 'groq' | 'openai';
  const key = resolveApiKey(name);
  const isPlaceholder = !key || key.includes('your-key');
  return {
    config,
    client: !isPlaceholder ? new OpenAI({ apiKey: key, baseURL: config.baseURL }) : null,
    circuitOpenUntil: 0,
    consecutiveFails: 0,
    lastFailAt: 0,
  };
}

let providers: ProviderState[] = LLM_PROVIDERS.map(buildProvider);
logEnabled();

function logEnabled(): void {
  const enabled = providers.filter(p => p.client !== null).map(p => p.config.name);
  console.log(`[LLM] enabled providers: ${enabled.join(', ') || '(none)'}`);
}

// 設定保存後に呼んでクライアントを差し替える
export function reloadProviders(): void {
  providers = LLM_PROVIDERS.map(buildProvider);
  logEnabled();
}

export function isLLMEnabled(): boolean {
  return providers.some(p => p.client !== null);
}

export function getProviderStatus() {
  return providers.map(p => ({
    name: p.config.name,
    enabled: p.client !== null,
    paused: Date.now() < p.circuitOpenUntil,
    pausedUntil: p.circuitOpenUntil,
  }));
}

function isAvailable(p: ProviderState): boolean {
  return p.client !== null && Date.now() >= p.circuitOpenUntil;
}

function tripCircuit(p: ProviderState, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/429|rate[_ ]limit|exhausted/i.test(msg)) return false;
  const now = Date.now();
  if (now - p.lastFailAt < CONSECUTIVE_WINDOW_MS) {
    p.consecutiveFails = Math.min(p.consecutiveFails + 1, PAUSE_LADDER_MS.length - 1);
  } else {
    p.consecutiveFails = 0;
  }
  p.lastFailAt = now;
  const pause = PAUSE_LADDER_MS[p.consecutiveFails]!;
  p.circuitOpenUntil = now + pause;
  const human = pause < 90_000 ? `${Math.round(pause / 1000)}s` : `${Math.round(pause / 60_000)}min`;
  console.warn(`[LLM:${p.config.name}] 429 #${p.consecutiveFails + 1} — paused for ${human}`);
  return true;
}

function recordSuccess(p: ProviderState): void {
  if (p.consecutiveFails > 0) {
    console.log(`[LLM:${p.config.name}] success — circuit reset`);
    p.consecutiveFails = 0;
  }
}

// プロバイダを順に試して、最初に成功したものの応答を返す
async function callWithFallback(
  task: (p: ProviderState) => Promise<string>,
  label: string,
): Promise<string> {
  const enabled = providers.filter(p => p.client !== null);
  if (enabled.length === 0) return '(LLM disabled — APIキーが未設定です。右上⚙️から設定してください)';
  const available = enabled.filter(isAvailable);
  if (available.length === 0) {
    const next = enabled.map(p => p.circuitOpenUntil).sort((a, b) => a - b)[0]!;
    const waitSec = Math.max(0, Math.round((next - Date.now()) / 1000));
    throw new Error(`429 (all providers paused, retry in ${waitSec}s)`);
  }
  let lastErr: unknown = null;
  for (const p of available) {
    try {
      const text = await task(p);
      recordSuccess(p);
      return text;
    } catch (err) {
      const tripped = tripCircuit(p, err);
      if (tripped) {
        console.warn(`[LLM] ${label}: ${p.config.name} failed → trying next`);
        lastErr = err;
        continue;
      }
      // 429以外のエラーは再投げ (キー無効など)
      throw err;
    }
  }
  // 全プロバイダが429だった
  throw lastErr ?? new Error('all providers failed');
}

export interface ExplainInput {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope' | 'shock' | 'dtb' | 'granville' | 'break';
  direction?: 'up' | 'down';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
  crossAsset?: Mover[];
}

export function scoreNews(news: NewsItem, keywords: string[], now: number): number {
  const title = news.title.toLowerCase();
  let kwHits = 0;
  for (const kw of keywords) if (title.includes(kw.toLowerCase())) kwHits++;
  let highImpactHits = 0;
  for (const kw of HIGH_IMPACT_KEYWORDS) if (title.includes(kw.toLowerCase())) highImpactHits++;
  const ageMin = (now - news.publishedAt) / 60000;
  const recency = Math.max(0, 1 - ageMin / NEWS_RECENCY_DECAY_MIN);
  return kwHits * 2 + highImpactHits * 6 + recency;
}

// 急変近接プール選別 (v0.3.9)
// 4h 全体から拾うと「4h 前のキーワード豊富な記事 > 直近の正体不明短文」となり、的外れな引用が増える。
// ±15min → ±60min → 4h の段階フォールバックで、急変直前の材料を最優先する。
export function selectNewsPool(news: NewsItem[], now: number): NewsItem[] {
  const cutoff = now - NEWS_RECENT_WINDOW_MS;
  const recent = news.filter(n => n.publishedAt >= cutoff);
  const tightMs = NEWS_PROXIMITY_TIGHT_MIN * 60_000;
  const looseMs = NEWS_PROXIMITY_LOOSE_MIN * 60_000;
  const tight = recent.filter(n => now - n.publishedAt <= tightMs);
  if (tight.length > 0) return tight;
  const loose = recent.filter(n => now - n.publishedAt <= looseMs);
  if (loose.length > 0) return loose;
  return recent;
}

export function formatCrossAsset(movers: Mover[]): string {
  if (movers.length === 0) return '【他資産】同時刻に目立った連動なし。';
  const lines = movers.map(m => {
    const arrow = m.direction === 'up' ? '▲' : '▼';
    const win = m.windowSeconds >= 300 ? '5分' : '1分';
    const sign = m.changePercent >= 0 ? '+' : '';
    return `- ${m.label} ${arrow} ${sign}${m.changePercent.toFixed(2)}% (${win}, z=${m.z.toFixed(1)})`;
  });
  return `【同時刻に大きく動いた他資産(z>=4.0)】\n${lines.join('\n')}`;
}

function rankAndFormatNews(input: ExplainInput, now: number): string {
  const pool = selectNewsPool(input.news, now);
  const keywords = INSTRUMENT_KEYWORDS[input.symbol] ?? [];
  const ranked = [...pool]
    .map(n => ({ n, s: scoreNews(n, keywords, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.n);
  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export async function explain(input: ExplainInput): Promise<string> {
  const now = Date.now();
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ'
    : input.detectionKind === 'shock' ? '急変'
    : input.detectionKind === 'dtb' ? 'ダブル天井/大底'
    : input.detectionKind === 'granville' ? 'グランビル'
    : input.detectionKind === 'break' ? '水準ブレイク' : 'トレンド';
  // 方向は direction を真の源とし(dtb は changePercent=0 のため符号では判定不可)、無ければ符号で代替。
  const dir = input.direction ?? (input.changePercent >= 0 ? 'up' : 'down');
  const dirJa = dir === 'up' ? '上昇' : '下落';
  const windowHours = Math.round(NEWS_RECENT_WINDOW_MS / 3600_000);
  const ctx15Line = input.change15min !== null
    ? `【15分変化率】${input.change15min >= 0 ? '+' : ''}${input.change15min.toFixed(2)}%\n`
    : '';
  const pa15Line = input.pa15min
    ? `【15分OHLC】始値 ${fmt(input.pa15min.open)} / 高値 ${fmt(input.pa15min.high)} / 安値 ${fmt(input.pa15min.low)} / 現値 ${fmt(input.pa15min.current)}\n`
    : '';
  const range1hLine = input.range1h
    ? `【1時間レンジ】高値 ${fmt(input.range1h.high)} / 安値 ${fmt(input.range1h.low)}\n`
    : '';
  const dirEmphasis = dir === 'up' ? '⬆ 上昇方向' : '⬇ 下落方向';
  // テクニカル系(dtb/granville/break)は値幅(%)ではなくパターン局面なので、
  // 急変文・ノイズ注記(急変幅判定)を出さない。
  const isTechnicalPattern = input.detectionKind === 'dtb'
    || input.detectionKind === 'granville' || input.detectionKind === 'break';
  const smallMag = !isTechnicalPattern && Math.abs(input.changePercent) <= 0.15;
  const ultraShort = input.detectionKind === 'slope' || input.windowSeconds <= 60;
  const noiseNotes = [
    smallMag ? '※ 急変幅が小さい (≤0.15%)。ノイズの可能性を考慮し、無理に材料を結びつけない。' : '',
    ultraShort ? '※ 超短期(〜1分)の動き。ニュース起因はまれ。同方向に動いた他資産が無ければ短期需給/テクニカルを既定とする。' : '',
  ].filter(Boolean).join('\n');
  // テクニカル系(dtb/granville/break)は「X秒でY%」の急変文ではなく、テクニカル局面として導入する。
  const headline = input.detectionKind === 'dtb'
    ? `【${kindLabel}】${input.symbolLabel} が主要な価格水準に ${dirEmphasis}(反転狙い)で接近しました(ダブルトップ/ボトム形成・ネック未達)。\n`
    : isTechnicalPattern
    ? `【${kindLabel}】${input.symbolLabel} がテクニカル局面(${kindLabel})にあります(${dirEmphasis})。\n`
    : `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa} (${dirEmphasis}) しました。\n`;
  const oppositeExample = dir === 'down'
    ? '「停戦/地政学リスク後退/利下げ観測/円安/米株高」は株高(⬆)要因なので、下落の説明に使わない'
    : '「地政学緊張・戦闘激化/利上げ・金利上昇/円高/弱い指標/米株安」は株安(⬇)要因なので、上昇の説明に使わない';
  const userPrompt =
    headline +
    (noiseNotes ? noiseNotes + '\n' : '') +
    ctx15Line + pa15Line + range1hLine +
    `\n${formatCrossAsset(input.crossAsset ?? [])}\n` +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(input, now)}\n\n` +
    `[材料の方向(株式の一般則)]\n` +
    `・株高(⬆)要因: 停戦/地政学リスク後退, 利下げ観測, 良い経済指標, 円安, 米株高, リスクオン\n` +
    `・株安(⬇)要因: 地政学緊張・戦闘激化, 利上げ/金利上昇, 悪い経済指標, 円高, 米株安, リスクオフ\n` +
    `[手順]\n` +
    `1) まず「他資産」を見る。${dirEmphasis} と同方向に大きく動いた資産があれば、連動(リスクオン/オフ・金利・為替)として最優先で説明に使う。\n` +
    `2) 次に候補ニュースを上から見て、上の方向則で「その材料の極性」を判定し、${dirEmphasis} と一致するかを必ず確認する。\n` +
    `3) 極性が一致する材料(他資産 or ニュース)だけを選び「○○分前のXX、(方向の根拠)」形式で説明。\n` +
    `4) 極性が逆の材料は絶対に引用しない(例: ${oppositeExample})。一致する材料が無ければ「整合する明確な材料なし、短期需給/テクニカルの可能性」と書く。無理に結びつけない。\n` +
    `5) OHLCで下髭/上髭/サポート反転等が読めれば併記してよい。\n\n` +
    `出力は必ず200文字以内、1〜2文で。矛盾(株高要因で下落を説明する等)は禁止。`;

  return callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model,
      temperature: 0.3,
      max_tokens: 1500,
      messages: [
        { role: 'system', content: LLM_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });
    const choice = completion.choices[0];
    const text = choice?.message?.content?.trim() ?? '(no response)';
    if (choice?.finish_reason === 'length') {
      console.warn(`[explain:${p.config.name}] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
      return text + ' …(token切れ)';
    }
    return text;
  }, 'explain');
}

function fmt(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}

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

- 日本語で、結論先出し、簡潔に
- 出力はプレーンテキスト。マークダウンの見出し(#・##・###)や強調(**太字**)は使わない。箇条書きは行頭「*」、見出し的な区切りは記号なしの短い語(例: 上値メド)で示す
- 数字を出すときは現状データから具体的に引用する
- 上値メド・下値メドは「+80円」のような距離ではなく価格(例 67,000円)で示す
- 推測や仮説は「〜と推察される」「〜の可能性が高い」と明示
- 不明な場合は素直に「データなし」と答える
- 銘柄間の連動性、テクニカル要因（サポレジ・ボラ）、ファンダ材料を組み合わせて分析する
- 急変について問われたら、最相関銘柄の動きから「外部(ファンダ)要因か、日経固有(テクニカル/需給)要因か」を必ず一言示す`;

export async function chat(input: ChatInput): Promise<string> {
  const now = Date.now();
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (input.correlate ? `${formatCorrelate(input.correlate)}\n\n` : '') +
    `■ 直近ニュース (上位15件):\n${formatNewsForChat(input.news, now)}`;

  return callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.chatModel,
      temperature: 0.5,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: systemPrompt },
        ...input.messages,
      ],
    });
    const choice = completion.choices[0];
    const text = choice?.message?.content?.trim() ?? '(no response)';
    if (choice?.finish_reason === 'length') {
      console.warn(`[chat:${p.config.name}] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
      return text + ' …(token切れ)';
    }
    return text;
  }, 'chat');
}

// ─── 翻訳 ─────────────────────────────────────────
// 英文ニュースタイトルを簡潔な日本語に翻訳。同一テキストは LRU でキャッシュ。

const TRANSLATE_CACHE_MAX = 500;
const translateCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = translateCache.get(key);
  if (v !== undefined) {
    // LRU: 再アクセス時に最新化
    translateCache.delete(key);
    translateCache.set(key, v);
  }
  return v;
}

function cacheSet(key: string, value: string): void {
  if (translateCache.has(key)) translateCache.delete(key);
  translateCache.set(key, value);
  if (translateCache.size > TRANSLATE_CACHE_MAX) {
    const oldest = translateCache.keys().next().value;
    if (oldest !== undefined) translateCache.delete(oldest);
  }
}

export async function translate(text: string): Promise<string> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  const cached = cacheGet(trimmed);
  if (cached !== undefined) return cached;

  const systemPrompt = '英文を簡潔で自然な日本語に訳すアシスタント。ニュースのタイトルを訳すので、主語の省略 OK、改行なし、引用符・句読点は最低限、訳文のみを返す。';

  const result = await callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model,
      temperature: 0.2,
      max_tokens: 300,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: trimmed },
      ],
    });
    return completion.choices[0]?.message?.content?.trim() ?? '';
  }, 'translate');

  if (result) cacheSet(trimmed, result);
  return result;
}
