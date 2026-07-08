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
import { tokyoCashOpen } from '../../collector/session.js';
import { isWebSearchEnabled, tavilySearch, formatHits } from './webSearch.js';
import { openDb, resolveDbPath, getRecentAlerts, getSessionOHLC, getRecentBars, type AlertRow } from '../db/store.js';
import { rowKind, summarize } from '../alertHistory.js';
import { crashDrawdown } from '../crash.js';
import { getPrices } from '../cache.js';
import { buildExplainInput } from './explainInput.js';
import { noteReferencedNews } from '../shockWindow.js';

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

// ─── ビジョン(チャート画像入力)対応判定 ───
// Gemini(OpenAI 互換エンドポイント)と OpenAI(gpt-4o 系)はマルチモーダル対応。
// Groq(llama-3.3-70b, テキスト専用)は非対応。プロバイダ名で判定する(chatModel も参照)。
const VISION_PROVIDERS = new Set(['gemini', 'openai']);

/** プロバイダ名(+チャットモデル)がチャート画像入力に対応するか。テキスト専用(groq)は false。 */
export function isVisionCapableProvider(name: string, chatModel = ''): boolean {
  if (!VISION_PROVIDERS.has(name)) return false;
  // モデル名に画像非対応が明示されていれば除外(将来のモデル差し替え対策)。
  if (/text-only|-tts|whisper|embedding/i.test(chatModel)) return false;
  return true;
}

/** 現在「利用可能(キーあり・非ポーズ)」で、かつビジョン対応の先頭プロバイダ名。無ければ null。
 *  scalp-plan が「画像を撮るべきか」を事前判断するために使う(callWithFallback の選択順と同じ優先順)。 */
export function firstAvailableVisionProvider(): { name: string; chatModel: string } | null {
  for (const p of providers) {
    if (!isAvailable(p)) continue;
    if (isVisionCapableProvider(p.config.name, p.config.chatModel)) {
      return { name: p.config.name, chatModel: p.config.chatModel };
    }
  }
  return null;
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
  detectionKind: 'magnitude' | 'slope' | 'shock' | 'dtb' | 'granville' | 'break' | 'ma' | 'swingdtb'
    | 'double' | 'ma_sr' | 'level_sr' | 'pivot' | 'trend' | 'crash';
  direction?: 'up' | 'down';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
  crossAsset?: Mover[];
  newsSince?: number;     // ①: これ以降のニュースのみ参照(直前の急変以降)。0/未指定=従来の固定窓。
  l2Recent?: string;      // ①: 直近のテクニカル状態(L2シグナル)要約。テクニカル判定時に併記。
  newsWindowMs?: number;  // 暴落(crash)等で参照ニュース窓を広げる(未指定=既定4h)。
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
export function selectNewsPool(news: NewsItem[], now: number, sinceFloor = 0, windowMs = NEWS_RECENT_WINDOW_MS): NewsItem[] {
  // ①: 直前の急変以降に限定したい場合 sinceFloor を渡す。固定窓と「直前の急変以降」の遅い方を採用。
  // 暴落(crash)等は windowMs を広げて参照(ユーザー指定: ニュース期間を広く)。
  const cutoff = Math.max(now - windowMs, sinceFloor);
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

function rankAndFormatNews(pool: NewsItem[], symbol: string, now: number): string {
  const keywords = INSTRUMENT_KEYWORDS[symbol] ?? [];
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

export async function explain(input: ExplainInput): Promise<{ text: string; newsMaxPublishedAt: number }> {
  const now = Date.now();
  // ①: 参照プールを一度だけ確定し、実提示ニュースの最大 publishedAt を呼び出し側へ返す(アンカー前進用)。
  const pool = selectNewsPool(input.news, now, input.newsSince ?? 0, input.newsWindowMs ?? NEWS_RECENT_WINDOW_MS);
  const newsMaxPublishedAt = pool.reduce((m, n) => Math.max(m, n.publishedAt), 0);
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ'
    : input.detectionKind === 'shock' ? '急変'
    : input.detectionKind === 'dtb' ? 'ダブル天井/大底'
    : input.detectionKind === 'granville' ? 'グランビル'
    : input.detectionKind === 'break' ? '水準ブレイク'
    : input.detectionKind === 'ma' ? 'MA抜け'
    : input.detectionKind === 'swingdtb' || input.detectionKind === 'double' ? 'ダブル天底'
    : input.detectionKind === 'ma_sr' ? 'MAサポレジ'
    : input.detectionKind === 'level_sr' ? '水準サポレジ'
    : input.detectionKind === 'pivot' ? 'スイング形成'
    : input.detectionKind === 'trend' ? 'トレンド転換'
    : input.detectionKind === 'crash' ? '暴落' : 'トレンド';
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
    || input.detectionKind === 'granville' || input.detectionKind === 'break'
    || input.detectionKind === 'ma' || input.detectionKind === 'swingdtb'
    || input.detectionKind === 'double' || input.detectionKind === 'ma_sr'
    || input.detectionKind === 'level_sr' || input.detectionKind === 'pivot'
    || input.detectionKind === 'trend';
  const smallMag = !isTechnicalPattern && Math.abs(input.changePercent) <= 0.15;
  const ultraShort = input.detectionKind === 'slope' || input.windowSeconds <= 60;
  const noiseNotes = [
    smallMag ? '※ 急変幅が小さい (≤0.15%)。ノイズの可能性を考慮し、無理に材料を結びつけない。' : '',
    ultraShort ? '※ 超短期(〜1分)の動き。ニュース起因はまれ。同方向に動いた他資産が無ければ短期需給/テクニカルを既定とする。' : '',
  ].filter(Boolean).join('\n');
  // テクニカル系(dtb/granville/break)は「X秒でY%」の急変文ではなく、テクニカル局面として導入する。
  const headline = input.detectionKind === 'crash'
    ? `【暴落】${input.symbolLabel} がセッション高値から ${Math.abs(input.changePercent).toFixed(1)}% 急落しました(${dirEmphasis})。直近の材料を広く確認し、原因(ファンダ/需給/外部要因)を簡潔に。\n`
    : input.detectionKind === 'dtb'
    ? `【${kindLabel}】${input.symbolLabel} が主要な価格水準に ${dirEmphasis}(反転狙い)で接近しました(ダブルトップ/ボトム形成・ネック未達)。\n`
    : isTechnicalPattern
    ? `【${kindLabel}】${input.symbolLabel} がテクニカル局面(${kindLabel})にあります(${dirEmphasis})。\n`
    : `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa} (${dirEmphasis}) しました。\n`;
  // ①ファンダ/テクニカル判定: 値動き(急変/フラッシュ)で、直前の急変以降に参照すべきニュースが
  // 1件も無ければ、LLMを呼ばず「テクニカル要因の可能性」と明示し、直近のテクニカル状態(L2)を併記する。
  // ※ 暴落(crash)は重大イベントなので短絡せず、必ず広いニュース窓でLLMに原因を分析させる(ユーザー指定)。
  if (!isTechnicalPattern && input.detectionKind !== 'crash' && pool.length === 0) {
    const l2 = input.l2Recent ? ` 直近のテクニカル状況: ${input.l2Recent}。` : '';
    return { text: `直前の急変以降、該当する材料ニュースなし → テクニカル要因の可能性。${l2}`, newsMaxPublishedAt };
  }
  const oppositeExample = dir === 'down'
    ? '「停戦/地政学リスク後退/利下げ観測/円安/米株高」は株高(⬆)要因なので、下落の説明に使わない'
    : '「地政学緊張・戦闘激化/利上げ・金利上昇/円高/弱い指標/米株安」は株安(⬇)要因なので、上昇の説明に使わない';
  const userPrompt =
    headline +
    (noiseNotes ? noiseNotes + '\n' : '') +
    ctx15Line + pa15Line + range1hLine +
    `\n${formatCrossAsset(input.crossAsset ?? [])}\n` +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(pool, input.symbol, now)}\n\n` +
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

  const text = await callWithFallback(async (p) => {
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
    const t = choice?.message?.content?.trim() ?? '(no response)';
    if (choice?.finish_reason === 'length') {
      console.warn(`[explain:${p.config.name}] TRUNCATED. usage=${JSON.stringify(completion.usage)}`);
      return t + ' …(token切れ)';
    }
    return t;
  }, 'explain');
  return { text, newsMaxPublishedAt };
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

function formatPricesForChat(prices: Price[], now: number): string {
  if (prices.length === 0) return '(価格未取得)';
  const cashOpen = tokyoCashOpen(now);
  return prices.map(p => {
    const meta = LABEL_MAP.get(p.symbol);
    const label = meta?.labelJa ?? p.symbol;
    const sign = p.changePercent >= 0 ? '+' : '';
    // 東証個別株(.T)は 9:00-15:30 のみ取引。場外は前回終値で動かないので「今動いた」材料に誤用させない。
    const tokyoClosed = meta?.category === 'heavyweight' && !cashOpen;
    const staleMark = tokyoClosed ? ' ※東証クローズ中・前回終値(値動きなし)' : (p.stale ? ' (stale)' : '');
    const chgLabel = tokyoClosed ? '前場引け比' : '';
    return `- ${label} ${p.symbol}: ${fmt(p.price)} (${sign}${p.changePercent.toFixed(2)}%${chgLabel ? ' ' + chgLabel : ''})${staleMark}`;
  }).join('\n');
}

/** 文字バイグラム集合(空白・記号除去)。日本語は語分割が無いので2文字シングルで類似を測る。 */
function bigrams(s: string): string[] {
  const c = s.toLowerCase().replace(/[\s、。,.!?？！「」（）()・:：;；'"’”]/g, '');
  const out: string[] = [];
  for (let i = 0; i + 2 <= c.length; i++) out.push(c.slice(i, i + 2));
  return out;
}

export function formatNewsForChat(news: NewsItem[], now: number, queryText = ''): string {
  if (news.length === 0) return '(ニュースなし)';
  // ③: 最新発話と文字バイグラムが重なるニュースを優先。重なりゼロなら直近にフォールバック。
  const qGrams = new Set(bigrams(queryText));
  const scored = news.map(n => {
    const title = n.title.toLowerCase();
    let hits = 0;
    for (const g of qGrams) if (title.includes(g)) hits++;
    return { n, hits };
  });
  const relevant = scored.filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.n.publishedAt - a.n.publishedAt)
    .slice(0, 12)
    .map(s => s.n);
  const list = relevant.length > 0 ? relevant : news.slice(0, 15);
  return list.map(n => {
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
- 急変について問われたら、最相関銘柄の動きから「外部(ファンダ)要因か、日経固有(テクニカル/需給)要因か」を必ず一言示す
- 【重要】東証個別株(キーエンス/ファストリ/ディスコ/SMC/東京エレクトロン/ソフトバンクG/キオクシア等の .T 銘柄)は 9:00-15:30 JST のみ取引。それ以外(昼休み・夜間・早朝=先物のNightセッション等)は前回終値で固定され動かない。「※東証クローズ中」の銘柄は、その時点で「今動いた/今の材料」として絶対に引用しない(夜間の日経先物の動きの理由に個別株を持ち出さない)。場中(9:00-15:30)のみ連動材料として扱う
- web_search ツールが使える場合、手元の【市場の現状】で足りない最新の出来事・ニュースは検索して確認し、引用時は「(出典/日時)」を簡潔に添える。手元で足りる時は無理に検索しない`;

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: '最新の市況・ニュース・出来事を調べる。価格や材料を聞かれて手元のコンテキストに無い/古い時に使う。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '検索クエリ(日本語可)' } }, required: ['query'] },
  },
};
// ─── monitor 自身のデータ参照ツール(外部キー不要・常時有効) ───
const NIKKEI_SYMBOL = 'NIY=F';   // チャット/テクニカルと同じ日経シンボル(config INSTRUMENTS の main)

const EXPLAIN_MOVE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'explain_move',
    description: '直近の急変(急落/急騰)の原因を分析する。「なぜ急落した?」等、値動きの理由を問われたら使う。ニュース近接・他資産連動・極性から原因文を返す。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(省略時は日経 NIY=F)' },
        sinceMinutes: { type: 'number', description: '何分前までの急変を対象にするか(省略時60)' },
      },
    },
  },
};

const QUERY_ALERTS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'query_alerts',
    description: '直近のアラート履歴(暴落/急変/節目抜け/トレンド転換等)と種別別の継続率・戻り率・平均リターンを要約する。「最近どんなアラートが出た?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        withinMinutes: { type: 'number', description: '何分前までを対象にするか(省略時120)' },
        limit: { type: 'number', description: '最大件数(省略時10)' },
      },
    },
  },
};

const PRICE_HISTORY_TOOL = {
  type: 'function' as const,
  function: {
    name: 'price_history',
    description: '価格履歴を要約する。本日のセッションOHLC(today)か直近N分の値動き(recent)を返す。「本日の高安は?」「直近の値動きは?」等に使う。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '銘柄シンボル(例 NIY=F)' },
        window: { type: 'string', enum: ['today', 'recent'], description: 'today=本日OHLC / recent=直近N分(省略時 today)' },
        minutes: { type: 'number', description: 'recent の対象分数(省略時60)' },
      },
      required: ['symbol'],
    },
  },
};

const MAX_TOOL_ROUNDS = 3;

type CreateFn = (params: Record<string, unknown>) => Promise<any>;
/** ツール名→ハンドラ。引数は JSON.parse 済みオブジェクト。短い説明文字列を返す(例外を投げない)。 */
export type ToolHandlers = Record<string, (args: any) => Promise<string>>;

/** ツール実行ループ。tool_calls が出る限りハンドラへディスパッチ→再投入。上限到達時は tools 無しで最終回答。
 *  テスト可能な純ループ。handlers は tool_call の function.name で引く(未知名は「unknown tool」を返しループ継続)。 */
export async function runChatWithTools(
  create: CreateFn, messages: any[], tools: unknown[], handlers: ToolHandlers, maxRounds = MAX_TOOL_ROUNDS,
): Promise<string> {
  const msgs = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const completion = await create({ messages: msgs, tools, tool_choice: 'auto' });
    const choice = completion.choices?.[0];
    const msg = choice?.message;
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) {
      const text = msg?.content?.trim() ?? '(no response)';
      return choice?.finish_reason === 'length' ? text + ' …(token切れ)' : text;
    }
    msgs.push(msg);
    for (const tc of calls) {
      const name = tc.function?.name ?? '';
      const handler = handlers[name];
      let result: string;
      if (!handler) {
        result = `(unknown tool: ${name || 'unnamed'})`;
      } else {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { args = {}; }
        // ハンドラ自身が try/catch する規約だが、二重の安全網としてここでも握る。
        try { result = await handler(args); } catch (e) { result = `(ツール失敗: ${e instanceof Error ? e.message : String(e)})`; }
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  // 上限到達: tools 無しで必ず1回答
  const final = await create({ messages: msgs });
  return final.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}

// ─── monitor データ参照: 常時注入ブロック & ツールハンドラ ───

function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

/** チャット system prompt に常時注入する monitor データ要約(直近アラート + 本日OHLC)。
 *  DB 不在/データ無しでも例外を投げず、出せるブロックだけ返す(空なら '')。 */
export function buildMonitorContext(now = Date.now()): string {
  const blocks: string[] = [];
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    // 直近アラート(60分以内・最大8件)
    try {
      const recent = getRecentAlerts(db, 8).filter(a => now - a.triggered_at <= 60 * 60_000);
      if (recent.length > 0) {
        const lines = recent.map(a => {
          const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
          const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
          return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
        });
        blocks.push(`■ 直近アラート(60分以内):\n${lines.join('\n')}`);
      }
    } catch { /* アラート要約は欠落許容 */ }
    // 本日のセッションOHLC(日経 NIY)
    try {
      const s = getSessionOHLC(db, NIKKEI_SYMBOL, 1)[0];
      if (s) {
        blocks.push(`■ 本日の日経(${s.session}): 高値 ${Math.round(s.high).toLocaleString('ja-JP')}(${hhmm(s.highT)}) / `
          + `安値 ${Math.round(s.low).toLocaleString('ja-JP')}(${hhmm(s.lowT)}) / 現値 ${Math.round(s.close).toLocaleString('ja-JP')}`);
      }
    } catch { /* OHLC は欠落許容 */ }
  } catch { /* DB 不在は無視(注入なし) */ }
  finally { try { db?.close(); } catch { /* ignore */ } }
  return blocks.join('\n\n');
}

/** explain_move の入力組立(DB 読みのみ・LLM 非依存=テスト可能)。直近の crash/shock 行、
 *  無ければセッション高値 vs 現在値を crashDrawdown で算出して BuildExplainArgs を返す。該当無しは null。 */
export function resolveExplainMoveArgs(
  db: ReturnType<typeof openDb>, symbol: string, sinceMs: number, now: number,
): import('./explainInput.js').BuildExplainArgs | null {
  const meta = LABEL_MAP.get(symbol);
  const symbolLabel = meta?.labelJa ?? symbol;
  // 1) 直近の crash/shock アラート行を探す(対象シンボル・期間内)
  const row = getRecentAlerts(db, 30).find(a =>
    a.symbol === symbol && (a.detection_kind === 'crash' || a.detection_kind === 'shock')
    && now - a.triggered_at <= sinceMs);
  if (row) {
    return {
      symbol, symbolLabel,
      changePercent: row.change_percent ?? 0,
      windowSeconds: row.window_seconds ?? 60,
      detectionKind: row.detection_kind as ExplainInput['detectionKind'],
      direction: row.direction === 'up' || row.direction === 'down' ? row.direction : undefined,
      change15min: null, pa15min: null, range1h: null,
    };
  }
  // 2) アラート行が無ければセッション高値 vs 現在値を crashDrawdown で算出
  const s = getSessionOHLC(db, symbol, 1)[0];
  const current = getPrices().find(pp => pp.symbol === symbol)?.price ?? s?.close ?? 0;
  if (!s || current <= 0) return null;
  const dd = crashDrawdown(s.high, current);   // 高値からの下落率(0〜1)
  const changePercent = -dd * 100;             // 下落=負
  return {
    symbol, symbolLabel, changePercent, windowSeconds: 300,
    detectionKind: dd >= 0.03 ? 'crash' : 'shock',
    direction: changePercent >= 0 ? 'up' : 'down',
    change15min: null, pa15min: null, range1h: null,
  };
}

/** explain_move: 直近の crash/shock 行(無ければセッション高値 vs 現在値)を特定し explain() で原因文を返す。 */
async function handleExplainMove(args: { symbol?: string; sinceMinutes?: number }): Promise<string> {
  const now = Date.now();
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const sinceMs = (typeof args.sinceMinutes === 'number' && args.sinceMinutes > 0 ? args.sinceMinutes : 60) * 60_000;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const moveArgs = resolveExplainMoveArgs(db, symbol, sinceMs, now);
    if (!moveArgs) return '該当する急変データなし。';
    const result = await explain(buildExplainInput(moveArgs));
    if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);
    return result.text;
  } catch (e) {
    return `(原因分析に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** query_alerts: 直近アラート一覧 + 種別別 継続率/戻り率/平均リターンの要約。 */
async function handleQueryAlerts(args: { withinMinutes?: number; limit?: number }): Promise<string> {
  const now = Date.now();
  const withinMs = (typeof args.withinMinutes === 'number' && args.withinMinutes > 0 ? args.withinMinutes : 120) * 60_000;
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 50) : 10;
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    const rows: AlertRow[] = getRecentAlerts(db, Math.max(limit, 50)).filter(a => now - a.triggered_at <= withinMs);
    if (rows.length === 0) return `直近${Math.round(withinMs / 60_000)}分のアラートなし。`;
    const list = rows.slice(0, limit).map(a => {
      const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
      const price = a.price != null ? Math.round(a.price).toLocaleString('ja-JP') : '-';
      return `- ${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow} ${price}`;
    });
    const stats = summarize(rows).map(s =>
      `- ${s.label}(${s.count}件): 継続${(s.hitRate * 100).toFixed(0)}% 戻り${(s.revertRate * 100).toFixed(0)}% 15分平均${s.avgRet15 >= 0 ? '+' : ''}${s.avgRet15.toFixed(2)}%`);
    return `直近アラート:\n${list.join('\n')}\n\n種別別統計(15分基準):\n${stats.join('\n')}`;
  } catch (e) {
    return `(アラート照会に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** price_history: 本日OHLC(today)か直近N分(recent)の値動きを要約。 */
async function handlePriceHistory(args: { symbol?: string; window?: 'today' | 'recent'; minutes?: number }): Promise<string> {
  const symbol = typeof args.symbol === 'string' && args.symbol ? args.symbol : NIKKEI_SYMBOL;
  const meta = LABEL_MAP.get(symbol);
  const label = meta?.labelJa ?? symbol;
  const window = args.window === 'recent' ? 'recent' : 'today';
  let db: ReturnType<typeof openDb> | null = null;
  try {
    db = openDb(resolveDbPath());
    if (window === 'today') {
      const s = getSessionOHLC(db, symbol, 1)[0];
      if (!s) return `${label}: 本日のデータなし。`;
      const move = s.open > 0 ? ((s.close - s.open) / s.open) * 100 : 0;
      return `${label} 本日(${s.session}): 始値 ${fmt(s.open)} / 高値 ${fmt(s.high)}(${hhmm(s.highT)}) / `
        + `安値 ${fmt(s.low)}(${hhmm(s.lowT)}) / 現値 ${fmt(s.close)}(始値比 ${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
    }
    const minutes = typeof args.minutes === 'number' && args.minutes > 0 ? Math.min(Math.floor(args.minutes), 1440) : 60;
    const bars = getRecentBars(db, symbol, Date.now() - minutes * 60_000);
    if (bars.length === 0) return `${label}: 直近${minutes}分のデータなし。`;
    const open = bars[0]!.o;
    const last = bars[bars.length - 1]!.c;
    let high = -Infinity, low = Infinity;
    for (const b of bars) { if (b.h > high) high = b.h; if (b.l < low) low = b.l; }
    const move = open > 0 ? ((last - open) / open) * 100 : 0;
    return `${label} 直近${minutes}分: 始値 ${fmt(open)} / 高値 ${fmt(high)} / 安値 ${fmt(low)} / `
      + `現値 ${fmt(last)}(${move >= 0 ? '+' : ''}${move.toFixed(2)}%)`;
  } catch (e) {
    return `(価格履歴に失敗: ${e instanceof Error ? e.message : String(e)})`;
  } finally { try { db?.close(); } catch { /* ignore */ } }
}

/** データツールのハンドラマップ(外部キー不要・常時有効)。 */
export function buildDataToolHandlers(): ToolHandlers {
  return {
    explain_move: handleExplainMove,
    query_alerts: handleQueryAlerts,
    price_history: handlePriceHistory,
  };
}

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
  // web_search は Tavily キーがある時のみ追加する。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? formatHits(await tavilySearch(q)) : '(クエリ空)';
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

// ─── スキャル計画 (POST /api/scalp-plan) ─────────────────────────────
// 兄弟アプリ jp225-trade2(AI トレーダー)が呼ぶ。monitor の LLM を「固定のスキャル戦略質問」で走らせ、
// buildMonitorContext + データツール(explain_move/query_alerts/price_history/web_search)を使って
// ライブデータに基づく構造化プランを返す。既存の chat と同じプロバイダ選択・キー解決・tool ループを再利用する。

/** trade2 が受け取る構造化スキャルプラン。 */
export interface AiPlan {
  direction: 'buy' | 'sell';
  limitEntry: number;        // 指値(押し目/戻り側の新規)
  stopEntry: number;         // 逆指値(ブレイク側の新規)
  stopLossForLimit: number;  // 指値約定時の損切り逆指値
  stopLossForStop: number;   // 逆指値約定時の損切り逆指値
  rationale: string;         // 判断理由(日本語)
  refPrice: number;          // 計画時に見た現在値(NIY=F)
}

export type ScalpPlanResult = { ok: true; plan: AiPlan } | { ok: false; error: string };

// 固定のスキャル戦略質問(ユーザー指定・日本語)。
const SCALP_QUESTION =
  'あなたが考える現在のスキャル戦略を教えてください。' +
  '①最初に買い/売りのどちらかを判断 ' +
  '②指値と逆指値の両方の新規注文を作り、先に約定した方で取引します ' +
  '(指値と逆指値は、現在値からそれぞれ少なくとも50円以上離すこと) ' +
  '③それぞれのストップ(逆指値の損切り)を定めてください。ただしストップ幅に5円加えること。';

const SCALP_SYSTEM_PROMPT = `あなたは日経225先物(NIY=F)のスキャルピングを専門とするトレーダーです。
手元の【市場の現状】(現在価格・テクニカル節目・直近アラート・本日OHLC・ニュース)と、
利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、
現在の相場に対する具体的なスキャルのエントリー計画を1つ立ててください。

制約:
- direction は buy か sell のどちらか一方に必ず決める。
- 指値(limitEntry)は押し目買い/戻り売り側の新規、逆指値(stopEntry)はブレイク追随側の新規として、両方の価格を出す。
- それぞれの約定時の損切り逆指値(stopLossForLimit / stopLossForStop)を出す。損切りは「本来のストップ幅に5円を加えた」水準にする。
- すべての価格は円単位の実数(NIY=F の実値レンジ)で、refPrice(現在値)と整合させる。
- rationale は日本語で判断根拠を簡潔に述べる。`;

// LLM に構造化 JSON を強制するための出力指示。JSON モード非対応プロバイダでも効くよう厳格な文言で指示し、パースで検証する。
function scalpJsonInstruction(refPrice: number): string {
  return `最終的な回答は、次のスキーマに厳密に一致する JSON オブジェクトのみを出力してください(前後の説明文・コードフェンス・マークダウンは一切付けない)。\n` +
    `{\n` +
    `  "direction": "buy" | "sell",\n` +
    `  "limitEntry": number,        // 指値(押し目/戻り側の新規)\n` +
    `  "stopEntry": number,         // 逆指値(ブレイク側の新規)\n` +
    `  "stopLossForLimit": number,  // 指値約定時の損切り逆指値(ストップ幅+5円)\n` +
    `  "stopLossForStop": number,   // 逆指値約定時の損切り逆指値(ストップ幅+5円)\n` +
    `  "rationale": string,         // 判断理由(日本語)\n` +
    `  "refPrice": number           // 計画時に見た現在値(${refPrice})\n` +
    `}\n` +
    `refPrice は ${refPrice} を使うこと。数値はすべて円単位の実数(引用符なし)。`;
}

/** LLM のテキスト応答から AiPlan を抽出・検証する純関数。refPrice は monitor 側の現在値で必ず上書きする。
 *  コードフェンスや前後の説明文が混じっていても最初の { … } を拾ってパースする。失敗時は { ok:false }。 */
export function parseScalpPlan(raw: string, refPrice: number): ScalpPlanResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty response' };
  // ```json … ``` を剥がし、最初の { から最後の } までを候補にする。
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let obj: unknown;
  try {
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not an object' };
  const o = obj as Record<string, unknown>;
  if (o.direction !== 'buy' && o.direction !== 'sell') return { ok: false, error: 'invalid direction' };
  const num = (v: unknown): number | null =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const limitEntry = num(o.limitEntry);
  const stopEntry = num(o.stopEntry);
  const stopLossForLimit = num(o.stopLossForLimit);
  const stopLossForStop = num(o.stopLossForStop);
  if (limitEntry === null || stopEntry === null || stopLossForLimit === null || stopLossForStop === null) {
    return { ok: false, error: 'invalid price field(s)' };
  }
  const rationale = typeof o.rationale === 'string' ? o.rationale.trim() : '';
  if (!rationale) return { ok: false, error: 'missing rationale' };
  // refPrice は LLM の自己申告ではなく monitor の現在値を正とする。
  return {
    ok: true,
    plan: { direction: o.direction, limitEntry, stopEntry, stopLossForLimit, stopLossForStop, rationale, refPrice },
  };
}

/** マルチモーダルなユーザメッセージ content を組み立てる。画像があればテキスト+image_url の配列、
 *  無ければ従来どおりプレーン文字列(テキストのみ)を返す。OpenAI/Gemini(OpenAI 互換)共通形式。
 *  data URL は `data:image/png;base64,<...>`。テスト可能な純関数。 */
export function buildScalpUserContent(userPrompt: string, imageDataUrl?: string | null): any {
  if (!imageDataUrl) return userPrompt;
  return [
    { type: 'text', text: userPrompt },
    { type: 'image_url', image_url: { url: imageDataUrl } },
  ];
}

/** スキャルプラン生成の純ループ(LLM 非依存=テスト可能)。tool ループで回答→parse、失敗なら tools 無しで
 *  厳格に1回だけ再要求→再parse。成功で AiPlan、失敗で例外。create/handlers を注入してテストする。
 *  imageDataUrl を渡すと初回・再要求ともにチャート画像を添付する(ビジョン対応プロバイダ時のみ呼び出し側で渡す)。 */
export async function runScalpPlan(
  create: CreateFn, systemPrompt: string, userPrompt: string,
  tools: unknown[], handlers: ToolHandlers, refPrice: number,
  imageDataUrl?: string | null,
): Promise<AiPlan> {
  const userContent = buildScalpUserContent(userPrompt, imageDataUrl);
  const baseMessages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];
  const first = await runChatWithTools(create, baseMessages, tools, handlers);
  const parsed = parseScalpPlan(first, refPrice);
  if (parsed.ok) return parsed.plan;
  // パース失敗 → 厳格に1回だけ再要求(tools 無し・JSON のみ)。
  const retry = await create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
      { role: 'assistant', content: first },
      { role: 'user', content: `直前の応答は指定 JSON スキーマに一致していません(${parsed.error})。説明やコードフェンスを一切付けず、スキーマに厳密一致する JSON オブジェクトだけを出力し直してください。` },
    ],
  });
  const retryText = retry.choices?.[0]?.message?.content?.trim() ?? '';
  const parsed2 = parseScalpPlan(retryText, refPrice);
  if (parsed2.ok) return parsed2.plan;
  throw new Error(`parse failed after retry: ${parsed2.error}`);
}

export interface ScalpPlanInput {
  symbol?: string;
  prices?: Price[];
  news?: NewsItem[];
  technical?: string | null;
  /** チャート画像(data URL: `data:image/png;base64,<...>`)。渡されるとビジョン対応プロバイダに添付する。 */
  chartImageDataUrl?: string | null;
}

/** 固定のスキャル質問で LLM を走らせ、構造化 AiPlan を返す。既存の chat と同じ tool ループ・プロバイダ選択・
 *  キー解決を再利用する。キー未設定は { ok:false, error:'LLM未設定' }。パース失敗は1回だけ厳格に再要求する。
 *  refPrice は monitor の現在 NIY=F 価格。 */
export async function buildScalpPlan(input: ScalpPlanInput = {}): Promise<ScalpPlanResult> {
  if (!isLLMEnabled()) return { ok: false, error: 'LLM未設定' };
  const now = Date.now();
  const symbol = typeof input.symbol === 'string' && input.symbol ? input.symbol : NIKKEI_SYMBOL;
  const prices = input.prices ?? getPrices();
  const news = input.news ?? [];
  const refPrice = prices.find(p => p.symbol === symbol)?.price ?? 0;
  const monitorCtx = buildMonitorContext(now);
  const systemPrompt =
    `${SCALP_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (monitorCtx ? `${monitorCtx}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(news, now, SCALP_QUESTION)}`;

  // chat と同じデータツール(常時有効)+ web_search(Tavily キーがある時のみ)。
  const tools: unknown[] = [EXPLAIN_MOVE_TOOL, QUERY_ALERTS_TOOL, PRICE_HISTORY_TOOL];
  const handlers: ToolHandlers = buildDataToolHandlers();
  if (isWebSearchEnabled()) {
    tools.push(WEB_SEARCH_TOOL);
    handlers.web_search = async (a: { query?: string }) => {
      const q = typeof a.query === 'string' ? a.query : '';
      return q ? formatHits(await tavilySearch(q)) : '(クエリ空)';
    };
  }

  // チャート画像がある時は判断材料にするよう明示的に指示する(ビジョン対応プロバイダ時のみ添付される)。
  const img = input.chartImageDataUrl && input.chartImageDataUrl.startsWith('data:image/')
    ? input.chartImageDataUrl : null;
  const visionNote = img ? '添付のチャート画像(当日の日経225先物のローソク足・主要水準・直近アラート)も判断材料にすること。\n\n' : '';
  const userPrompt = `${SCALP_QUESTION}\n\n${visionNote}${scalpJsonInstruction(refPrice)}`;

  try {
    const raw = await callWithFallback(async (p) => {
      const create: CreateFn = (params) => p.client!.chat.completions.create({
        model: p.config.chatModel, temperature: 0.4, max_tokens: 8000, ...params,
      } as any);
      // ビジョン非対応プロバイダに切り替わった場合は画像を外す(image_url をテキスト専用モデルへ送らない)。
      const imgForThis = img && isVisionCapableProvider(p.config.name, p.config.chatModel) ? img : null;
      // 成功時は整形済み plan JSON 文字列を返す(callWithFallback は string 契約)。
      return JSON.stringify(await runScalpPlan(create, systemPrompt, userPrompt, tools, handlers, refPrice, imgForThis));
    }, 'scalp-plan');
    // callWithFallback から返った plan JSON を再パースして返す。
    return parseScalpPlan(raw, refPrice);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
