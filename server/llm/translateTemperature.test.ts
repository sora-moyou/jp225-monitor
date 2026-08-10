// server/llm/translateTemperature.test.ts
//
// ─── ★temperature を受け付けないモデルでも翻訳が通ること(実HTTP) ────────────────
//
// 事故(2026-08-10): Kimi のモデルを kimi-k3 にしたところ、翻訳の `temperature: 0.1` が
//   `400 invalid temperature: only 1 is allowed for this model` で拒否され、英語記事 430件が未訳になった。
//
// ★このファイルは **本物の openai SDK** を、**本物のローカル HTTP サーバ**(127.0.0.1)に向けて動かす。
//   モックの `create()` を差し替えるだけでは「SDK が実際に何を送っているか」を1バイトも見ていないので、
//   temperature を外したつもりで外れていない、という無言の失敗を捕まえられない。
//   ★外部へは1バイトも出ない(baseURL は起動したローカルサーバ・ネットワーク宛先を持たない)。
//
// ★否定対照: 修正前は temperature を必ず送るので、下の「拒否サーバ」は毎回 400 を返し、
//   `runTranslationCompletion` は例外になる(= このファイルの最初のテストが落ちる)。

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import {
  runTranslationCompletion, resetTemperatureMemoForTest, modelSkipsTemperature,
  isTemperatureRejection, TRANSLATE_TEMPERATURE, TRANSLATE_MAX_TOKENS,
  buildTranslationPrompt, parseTranslationBatch, TRUNCATED_MARK,
} from './translateNews.js';
import type { CompletionFn } from './translateNews.js';

/** サーバが実際に受け取ったリクエスト本文(SDK が何を送ったかの唯一の証拠)。 */
const received: Array<Record<string, unknown>> = [];
/** 訳を返さず 400 を返すモデル名(= temperature を拒否する側)。 */
const REJECTING_MODEL = 'kimi-k3';
/** どんな 400 を返すか(実文 or 別の 400)。 */
let rejectionBody = 'invalid temperature: only 1 is allowed for this model';

let server: Server;
let baseURL = '';

function jaLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `${i + 1}. 日本語の訳${i + 1}`).join('\n');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      received.push(body);
      const model = String(body.model ?? '');
      // ★温度を受け付けないモデルの再現: temperature が **キーとして存在するだけ** で 400。
      if (model === REJECTING_MODEL && Object.prototype.hasOwnProperty.call(body, 'temperature')) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: rejectionBody, type: 'invalid_request_error' } }));
        return;
      }
      const msgs = body.messages as Array<{ role: string; content: string }>;
      const count = (msgs[msgs.length - 1]?.content ?? '').split('\n').filter(Boolean).length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: jaLines(count) } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(() => {
  received.length = 0;
  rejectionBody = 'invalid temperature: only 1 is allowed for this model';
  resetTemperatureMemoForTest();
});

/** 実 SDK のクライアント(宛先はローカルの偽サーバのみ)。 */
function client(): OpenAI {
  return new OpenAI({ apiKey: 'test-key-not-real', baseURL, maxRetries: 0 });
}
function createFn(c: OpenAI): CompletionFn {
  return (params) => c.chat.completions.create(params);
}

describe('★temperature を拒否するモデルでも翻訳が通る(実HTTP・実SDK)', () => {
  it('1回目: temperature 付きで 400 → 外して出し直し、訳文が返る', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prompt = buildTranslationPrompt(['BOJ hikes rates', 'Oil surges on OPEC cut']);
    const text = await runTranslationCompletion(createFn(client()), REJECTING_MODEL, prompt);
    warn.mockRestore();

    // ★訳文として使える形で返っている(=バッチが破棄されない)。
    expect(parseTranslationBatch(text, 2)).toEqual(['日本語の訳1', '日本語の訳2']);
    // ★SDK が実際に送った中身: 1回目は temperature あり、2回目は **キーごと無い**。
    expect(received).toHaveLength(2);
    expect(received[0]!.temperature).toBe(TRANSLATE_TEMPERATURE);
    expect(Object.prototype.hasOwnProperty.call(received[1]!, 'temperature')).toBe(false);
    expect(received[1]!.max_tokens).toBe(TRANSLATE_MAX_TOKENS);
    expect(received[1]!.model).toBe(REJECTING_MODEL);
  });

  it('★否定対照: temperature を付けたまま出すと 400(=修正前の姿)', async () => {
    await expect(client().chat.completions.create({
      model: REJECTING_MODEL, temperature: TRANSLATE_TEMPERATURE, max_tokens: TRANSLATE_MAX_TOKENS,
      messages: [{ role: 'user', content: '1. a' }],
    })).rejects.toThrow(/invalid temperature: only 1 is allowed for this model/);
  });

  it('2回目以降: 同じモデルには最初から temperature を送らない(無駄な往復は初回だけ)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = client();
    await runTranslationCompletion(createFn(c), REJECTING_MODEL, buildTranslationPrompt(['a']));
    warn.mockRestore();
    expect(modelSkipsTemperature(REJECTING_MODEL)).toBe(true);

    received.length = 0;
    const text = await runTranslationCompletion(createFn(c), REJECTING_MODEL, buildTranslationPrompt(['b']));
    expect(parseTranslationBatch(text, 1)).toEqual(['日本語の訳1']);
    expect(received).toHaveLength(1);                                          // ★往復は1回だけ
    expect(Object.prototype.hasOwnProperty.call(received[0]!, 'temperature')).toBe(false);
  });

  it('★受け付けるモデルの挙動は1ミリも変わらない(temperature 0.1 のまま・往復1回)', async () => {
    const text = await runTranslationCompletion(createFn(client()), 'gemini-flash-latest', buildTranslationPrompt(['a', 'b', 'c']));
    expect(parseTranslationBatch(text, 3)).toEqual(['日本語の訳1', '日本語の訳2', '日本語の訳3']);
    expect(received).toHaveLength(1);
    expect(received[0]!.temperature).toBe(TRANSLATE_TEMPERATURE);
    expect(modelSkipsTemperature('gemini-flash-latest')).toBe(false);
  });

  it('★temperature と無関係な 400 は出し直さない(素通しで投げ直す=フォールバックに任せる)', async () => {
    rejectionBody = 'tool call validation failed: parameters did not match schema';
    await expect(
      runTranslationCompletion(createFn(client()), REJECTING_MODEL, buildTranslationPrompt(['a'])),
    ).rejects.toThrow(/tool call validation failed/);
    expect(received).toHaveLength(1);                     // ★1回だけ。無限に出し直さない
    expect(modelSkipsTemperature(REJECTING_MODEL)).toBe(false);
  });

  it('長さ切れ(finish_reason=length)は従来どおり TRUNCATED_MARK で投げる', async () => {
    await expect(runTranslationCompletion(
      async () => ({ choices: [{ finish_reason: 'length', message: { content: '1. 途中' } }] }),
      'any-model', 'x',
    )).rejects.toThrow(TRUNCATED_MARK);
  });
});

describe('isTemperatureRejection(純関数・両方向の表)', () => {
  for (const msg of [
    '400 invalid temperature: only 1 is allowed for this model',      // ★稼働機の実文
    "Unsupported value: 'temperature' does not support 0.1 with this model. Only the default (1) is supported.",
    '400 invalid_request_error: temperature is not supported',
    'temperature must be 1 for this model',
  ]) it(`true: ${msg.slice(0, 50)}`, () => expect(isTemperatureRejection(msg)).toBe(true));

  for (const msg of [
    '429 rate_limit_exceeded: Limit 6000, Used 6000, Requested 512',
    '413 Request too large for model `llama-3.3-70b-versatile`',
    '404 Not found the model kimi-latest or Permission denied',
    '401 Incorrect API key provided',
    '400 tool call validation failed: parameters did not match schema',
    '503 status code (no body)',
    'truncated: 出力が長さ上限(3000)で切れました',
  ]) it(`false: ${msg.slice(0, 50)}`, () => expect(isTemperatureRejection(msg)).toBe(false));
});
