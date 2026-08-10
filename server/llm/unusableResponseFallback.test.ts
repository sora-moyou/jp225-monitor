// server/llm/unusableResponseFallback.test.ts
//
// ─── ★400 の隣にあった同型の穴(2026-08-11) ──────────────────────────────────
//
// 実測(Kimi): temperature を外すと **200 で返るが中身が空**。そのとき旧実装は:
//   ・空 + finish_reason=length → `throw new Error('truncated: …')`
//       → classifyLLMError=null → tripCircuit=false → 「429以外は再投げ」枝で **即 throw**
//       → 次のプロバイダに回らない = 400 で塞いだのと **まったく同じ穴**
//   ・空 + finish_reason=stop   → `''` を返して **成功扱い**(recordSuccess で circuit reset まで走る)
//       → 空応答が「成功」として記録され、事故が計測にすら残らない
//
// ★このファイルは **本物の openai SDK** を **本物のローカル HTTP サーバ**へ向け、
//   **本物の callWithFallback のプロバイダ連鎖**を通す。モックの create() を差し替えるだけでは
//   「連鎖が実際に次へ進んだか」を見ていないので、この穴は捕まらない。
//   ★外部へは1バイトも出ない(baseURL を全プロバイダぶんローカルへ差し替える)。
//
// ★否定対照: `git show HEAD:server/llm/translateNews.ts` / `providers.ts` に差し替えると
//   「空 → 次のプロバイダ」「空 → 例外」がいずれも成立せず、下の3本が赤くなる。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** テスト中の全 OpenAI クライアントをローカルの偽サーバへ向ける(SDK 本体はそのまま使う)。 */
const FAKE = { baseURL: '' };
vi.mock('openai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openai')>();
  class Routed extends actual.default {
    constructor(opts: ConstructorParameters<typeof actual.default>[0]) {
      super({ ...opts, baseURL: FAKE.baseURL, maxRetries: 0 });
    }
  }
  return { ...actual, default: Routed };
});

import { resetConfigCache } from '../configStore.js';
import { callWithFallback, reloadProviders, getProviderStatus, UnusableResponseError } from './providers.js';
import {
  runTranslationCompletion, resetTemperatureMemoForTest, translateTitles,
  TRUNCATED_MARK, EMPTY_MARK, type CompletionFn,
} from './translateNews.js';
import OpenAI from 'openai';

/** サーバが返す応答の台本(先頭から1つずつ消費)。 */
type Scripted = { content: string | null; finish: string };
let script: Scripted[] = [];
let fallbackReply: Scripted = { content: '1. 既定の訳', finish: 'stop' };
const seen: Array<Record<string, unknown>> = [];

let server: Server;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push(JSON.parse(raw || '{}') as Record<string, unknown>);
      const r = script.shift() ?? fallbackReply;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'fake',
        choices: [{ index: 0, finish_reason: r.finish, message: { role: 'assistant', content: r.content } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  FAKE.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY'] as const;
const SAVED = new Map<string, string | undefined>();
const ORIG: Record<string, string | undefined> = {};
let dir = '';

beforeEach(() => {
  script = [];
  seen.length = 0;
  resetTemperatureMemoForTest();
});

describe('★使えない応答(空 / 長さ切れ)は次のプロバイダへ回る(実HTTP・実SDK・実連鎖)', () => {
  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/jp225-unusable-`);
    ORIG.HOME = process.env.HOME; ORIG.USERPROFILE = process.env.USERPROFILE; ORIG.APPDATA = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED.set(k, process.env[k]); delete process.env[k]; }
    process.env.KIMI_API_KEY = 'sk-kimi_dummy_test_key_not_real';
    process.env.OPENAI_API_KEY = 'sk-openai_dummy_test_key_not_real';
    resetConfigCache();
    reloadProviders();
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = SAVED.get(k);
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    if (ORIG.HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIG.HOME;
    if (ORIG.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = ORIG.USERPROFILE;
    if (ORIG.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = ORIG.APPDATA;
    resetConfigCache();
    reloadProviders();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 実プロバイダ連鎖 + 実 SDK + 実 HTTP で 1 バッチ訳す(本番と同じ組み立て)。 */
  function translateThroughChain(prompt: string): Promise<string> {
    return callWithFallback(async (p) => {
      const create: CompletionFn = (params) => p.client!.chat.completions.create(params);
      return runTranslationCompletion(create, p.config.model, prompt);
    }, 'translate-news');
  }

  it('前提: 有効プロバイダは kimi → openai の 2 つ', () => {
    expect(getProviderStatus().filter(p => p.enabled).map(p => p.name)).toEqual(['kimi', 'openai']);
  });

  it('★空応答(finish=stop)→ 次のプロバイダへ回って訳が返る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    script = [{ content: '', finish: 'stop' }];             // 1番目(kimi)は空
    fallbackReply = { content: '1. 日銀が利上げ', finish: 'stop' };
    const text = await translateThroughChain('1. BOJ hikes rates');
    warn.mockRestore();
    expect(text).toBe('1. 日銀が利上げ');
    expect(seen).toHaveLength(2);                            // ★kimi → openai の 2 回叩いている
  });

  it('★空応答(content=null)でも同じ(null と空文字を区別しない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    script = [{ content: null, finish: 'stop' }];
    fallbackReply = { content: '1. 訳', finish: 'stop' };
    await expect(translateThroughChain('1. x')).resolves.toBe('1. 訳');
    warn.mockRestore();
    expect(seen).toHaveLength(2);
  });

  it('★長さ切れ(finish=length)→ 次のプロバイダへ回って訳が返る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    script = [{ content: '', finish: 'length' }];
    fallbackReply = { content: '1. 訳', finish: 'stop' };
    await expect(translateThroughChain('1. x')).resolves.toBe('1. 訳');
    warn.mockRestore();
    expect(seen).toHaveLength(2);
  });

  it('★どのプロバイダも空なら例外(空文字を成功として返さない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fallbackReply = { content: '', finish: 'stop' };
    await expect(translateThroughChain('1. x')).rejects.toThrow(EMPTY_MARK);
    warn.mockRestore();
    expect(seen).toHaveLength(2);                            // 両方試した上で失敗している
  });

  it('★使えない応答でプロバイダをポーズしない(健全な相手を止めない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    script = [{ content: '', finish: 'stop' }];
    fallbackReply = { content: '1. 訳', finish: 'stop' };
    await translateThroughChain('1. x');
    const line = warn.mock.calls.map(c => c.map(String).join(' ')).find(l => l.includes('[LLM:kimi]'));
    warn.mockRestore();
    expect(line).toContain('unusable response');
    expect(line).not.toContain('paused');
    expect(getProviderStatus().every(p => !p.paused)).toBe(true);
  });

  it('★translateTitles まで通しても「成功0件」が正しく出る(空を訳文にしない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fallbackReply = { content: '', finish: 'stop' };
    const { results, failures, error } = await translateTitles(['A', 'B'], translateThroughChain);
    warn.mockRestore();
    expect(results).toEqual([null, null]);
    expect(failures).toEqual(['provider', 'provider']);      // ★回数を消費しない帰属
    expect(error).toContain(EMPTY_MARK);
  });
});

describe('readTranslationChoice の型(UnusableResponseError であること)', () => {
  const good: CompletionFn = async () => ({ choices: [{ finish_reason: 'stop', message: { content: '1. 訳' } }] });

  it('空は UnusableResponseError', async () => {
    const empty: CompletionFn = async () => ({ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] });
    await expect(runTranslationCompletion(empty, 'm', 'x')).rejects.toBeInstanceOf(UnusableResponseError);
    await expect(runTranslationCompletion(empty, 'm', 'x')).rejects.toThrow(EMPTY_MARK);
  });

  it('長さ切れも UnusableResponseError', async () => {
    const cut: CompletionFn = async () => ({ choices: [{ finish_reason: 'length', message: { content: '1. 途' } }] });
    await expect(runTranslationCompletion(cut, 'm', 'x')).rejects.toBeInstanceOf(UnusableResponseError);
    await expect(runTranslationCompletion(cut, 'm', 'x')).rejects.toThrow(TRUNCATED_MARK);
  });

  it('choices が空でも UnusableResponseError(黙って空文字を返さない)', async () => {
    await expect(runTranslationCompletion(async () => ({ choices: [] }), 'm', 'x'))
      .rejects.toBeInstanceOf(UnusableResponseError);
    await expect(runTranslationCompletion(async () => ({}), 'm', 'x'))
      .rejects.toBeInstanceOf(UnusableResponseError);
  });

  it('正常な応答はそのまま返る(挙動不変)', async () => {
    await expect(runTranslationCompletion(good, 'm', 'x')).resolves.toBe('1. 訳');
  });

  it('★SDK を直接叩けば空が返ることの確認(偽サーバの前提=修正前の姿)', async () => {
    const c = new OpenAI({ apiKey: 'k', baseURL: FAKE.baseURL, maxRetries: 0 });
    script = [{ content: '', finish: 'stop' }];
    const r = await c.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(r.choices[0]?.message?.content).toBe('');          // 200 で中身が空
    expect(r.choices[0]?.finish_reason).toBe('stop');
  });
});
