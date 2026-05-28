import OpenAI from 'openai';
import type { NewsItem } from '../types.js';
import {
  LLM_MODEL, LLM_BASE_URL, LLM_SYSTEM_PROMPT,
  NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN,
  INSTRUMENT_KEYWORDS, HIGH_IMPACT_KEYWORDS,
} from '../config.js';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const isPlaceholder = !apiKey
  || apiKey === 'sk-your-key-here'
  || apiKey === 'gsk_your-key-here'
  || apiKey.includes('your-key');
const client = !isPlaceholder
  ? new OpenAI({ apiKey, baseURL: LLM_BASE_URL })
  : null;

export function isLLMEnabled(): boolean { return client !== null; }

export interface ExplainInput {
  symbol: string;            // ランク付けキー (NK=F 等)
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope';
  change15min: number | null;
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
    .slice(0, 15)
    .map(x => x.n);

  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}

export async function explain(input: ExplainInput): Promise<string> {
  if (!client) return '(LLM disabled — OPENAI_API_KEY 未設定)';

  const now = Date.now();
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ' : 'トレンド';
  const dirJa = input.changePercent >= 0 ? '上昇' : '下落';
  const windowHours = Math.round(NEWS_RECENT_WINDOW_MS / 3600_000);
  const ctx15Line = input.change15min !== null
    ? `【15分コンテキスト】直近15分の変化: ${input.change15min >= 0 ? '+' : ''}${input.change15min.toFixed(2)}%\n\n`
    : '';
  const userPrompt =
    `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa}しました。\n` +
    ctx15Line +
    `【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(input, now)}\n\n` +
    `上記の急変・コンテキスト・ニュースを総合し、最有力の材料を1つ選び、「○○分前のXXがYYのため」の形で1〜2文で説明してください。古くても相場転換の引き金となる材料（FOMC, 介入, 地政学, 重要指標）を優先してください。`;

  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.3,
    max_tokens: 180,
    messages: [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? '(no response)';
}
