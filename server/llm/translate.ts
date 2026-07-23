import { callWithFallback } from './providers.js';

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
