import { describe, it, expect } from 'vitest';
import { formatCrossAsset, explain, selectNewsPool, testProviderState, classifyLLMError } from './openai.js';
import type { LLMProvider } from '../config.js';
import type { Mover } from '../marketSnapshot.js';
import type { NewsItem } from '../types.js';

describe('classifyLLMError (5xx/timeout もフォールバック対象に)', () => {
  it('429/枯渇 → quota(長 ladder)', () => {
    expect(classifyLLMError('429 Too Many Requests')).toBe('quota');
    expect(classifyLLMError('Resource has been exhausted')).toBe('quota');
    expect(classifyLLMError('rate_limit exceeded')).toBe('quota');
  });
  it('5xx / タイムアウト / ネットワーク → transient(短ポーズ+フォールバック)', () => {
    expect(classifyLLMError('503 status code (no body)')).toBe('transient');
    expect(classifyLLMError('500 Internal Server Error')).toBe('transient');
    expect(classifyLLMError('529 overloaded')).toBe('transient');
    expect(classifyLLMError('aborted after 55000ms')).toBe('transient');
    expect(classifyLLMError('request timed out')).toBe('transient');
    expect(classifyLLMError('ECONNRESET')).toBe('transient');
    expect(classifyLLMError('fetch failed')).toBe('transient');
  });
  it('413/リクエスト過大(TPM・コンテキスト超過) → oversize(ポーズせず次の大きいモデルへ)', () => {
    // Groq 実エラー: 単一リクエストが on_demand tier の TPM を超過(=このモデルでは絶対に通らない)。
    expect(classifyLLMError('413 Request too large for model `llama-3.3-70b-versatile` in organization org_x service tier on_demand')).toBe('oversize');
    expect(classifyLLMError('Request too large ... on tokens per minute (TPM): Limit 12000, Requested 13000')).toBe('oversize');
    // OpenAI 系のコンテキスト超過表現も同カテゴリ。
    expect(classifyLLMError("This model's maximum context length is 8192 tokens")).toBe('oversize');
    expect(classifyLLMError('Please reduce the length of the messages')).toBe('oversize');
  });
  it('413 のうち rate limit 表現(429相当)は quota を優先(誤分類しない)', () => {
    expect(classifyLLMError('rate_limit_exceeded: too many requests')).toBe('quota');
  });
  it('401/404/400 等の恒久・設定エラー → null(フォールバックせず即 throw)', () => {
    expect(classifyLLMError('401 Incorrect API key provided')).toBeNull();
    expect(classifyLLMError('404 status code (no body)')).toBeNull();
    expect(classifyLLMError('400 Bad Request: invalid model')).toBeNull();
  });
});

describe('formatCrossAsset', () => {
  it('returns a "no linkage" line when there are no movers', () => {
    expect(formatCrossAsset([])).toBe('【他資産】同時刻に目立った連動なし。');
  });

  it('formats movers with arrow, signed percent, window and z', () => {
    const movers: Mover[] = [
      { symbol: 'NQ=F', label: 'ナスダック100先物', changePercent: -1.85, windowSeconds: 300, z: 4.3, direction: 'down' },
      { symbol: 'JPY=X', label: 'ドル円', changePercent: 0.42, windowSeconds: 60, z: 4.1, direction: 'up' },
    ];
    const out = formatCrossAsset(movers);
    expect(out).toContain('【同時刻に大きく動いた他資産(z>=4.0)】');
    expect(out).toContain('- ナスダック100先物 ▼ -1.85% (5分, z=4.3)');
    expect(out).toContain('- ドル円 ▲ +0.42% (1分, z=4.1)');
  });
});

const news = (id: string, ageMin: number): NewsItem => ({
  id, title: `news ${id}`, source: 'test', lang: 'ja', url: 'x', publishedAt: Date.now() - ageMin * 60_000,
});

describe('selectNewsPool sinceFloor (①: 直前の急変以降)', () => {
  it('sinceFloor より古いニュースは除外', () => {
    const now = Date.now();
    const items = [news('old', 50), news('new', 5)];
    const since = now - 20 * 60_000;   // 20分前以降のみ
    const pool = selectNewsPool(items, now, since);
    expect(pool.map(n => n.id)).toEqual(['new']);
  });
});

describe('testProviderState (APIキー実効性 ping)', () => {
  const cfg: LLMProvider = {
    name: 'fake', envVar: 'FAKE_KEY', baseURL: undefined,
    model: 'm', chatModel: 'fake-chat-model',
  };
  // OpenAI クライアントの chat.completions.create だけを持つ最小フェイク。
  const fakeClient = (create: (params: unknown) => Promise<unknown>) =>
    ({ chat: { completions: { create } } } as any);

  it('client が ping に成功 → { ok: true }', async () => {
    const calls: unknown[] = [];
    const p = { config: cfg, client: fakeClient(async (params) => { calls.push(params); return { choices: [] }; }) };
    const r = await testProviderState(p, 'fake');
    expect(r).toEqual({ name: 'fake', ok: true });
    // 極小 ping (1トークン・正しいモデル) で叩いている
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: 'fake-chat-model', max_tokens: 1 });
  });

  it('client が 401 を投げる → { ok: false, error にメッセージ }', async () => {
    const p = { config: cfg, client: fakeClient(async () => { throw new Error('401 Unauthorized: invalid api key'); }) };
    const r = await testProviderState(p, 'fake');
    expect(r.ok).toBe(false);
    expect(r.notset).toBeUndefined();
    expect(r.error).toContain('401');
  });

  it('client 無し(キー未設定/プレースホルダ) → { ok: false, notset: true }', async () => {
    const p = { config: cfg, client: null };
    expect(await testProviderState(p, 'fake')).toEqual({ name: 'fake', ok: false, notset: true });
    // プロバイダ状態自体が無い場合も notset
    expect(await testProviderState(undefined, 'gone')).toEqual({ name: 'gone', ok: false, notset: true });
  });
});

describe('explain ①ファンダ/テクニカル判定', () => {
  it('値動き(急変)で参照窓内にニュースが無ければ、LLMを呼ばず「テクニカル要因の可能性」+L2併記', async () => {
    const { text } = await explain({
      symbol: 'NIY=F', symbolLabel: '日経225先物', changePercent: -0.4, windowSeconds: 60,
      detectionKind: 'shock', direction: 'down', change15min: null, pa15min: null, range1h: null,
      news: [news('old', 300)], newsSince: Date.now() - 10 * 60_000,   // 窓内(10分)にニュース無し
      l2Recent: '水準ブレイク 67,470 ▼',
    });
    expect(text).toContain('テクニカル要因の可能性');
    expect(text).toContain('水準ブレイク 67,470 ▼');
  });
});
