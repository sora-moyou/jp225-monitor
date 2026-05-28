import OpenAI from 'openai';
import type { NewsItem } from '../types.js';
import { LLM_MODEL, LLM_SYSTEM_PROMPT, NEWS_RECENT_WINDOW_MS } from '../config.js';

const apiKey = process.env.OPENAI_API_KEY?.trim();
const isPlaceholder = !apiKey || apiKey === 'sk-your-key-here' || apiKey.includes('your-key');
const client = !isPlaceholder ? new OpenAI({ apiKey }) : null;

export function isLLMEnabled(): boolean { return client !== null; }

export interface ExplainInput {
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope';
  news: NewsItem[];
}

function formatNewsForPrompt(news: NewsItem[]): string {
  const cutoff = Date.now() - NEWS_RECENT_WINDOW_MS;
  return news
    .filter(n => n.publishedAt >= cutoff)
    .slice(0, 20)
    .map(n => {
      const t = new Date(n.publishedAt).toISOString().slice(11, 16);
      return `- [${t}] [${n.source}] ${n.title}`;
    })
    .join('\n');
}

export async function explain(input: ExplainInput): Promise<string> {
  if (!client) return '(LLM disabled — OPENAI_API_KEY 未設定)';

  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ' : 'トレンド';
  const userPrompt =
    `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% 動きました。\n` +
    `【関連ニュース直近30分】\n${formatNewsForPrompt(input.news) || '(なし)'}\n\n` +
    `この値動きの最も可能性の高い理由を1〜2文で説明してください。`;

  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.3,
    max_tokens: 150,
    messages: [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? '(no response)';
}
