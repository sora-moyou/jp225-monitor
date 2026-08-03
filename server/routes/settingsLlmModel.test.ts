import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★LLM のモデル名を設定で変えられる(コード固定をやめる) ─────────────────────
//
// 症状: kimi-k2-0905-preview → 404 → v0.9.33 で kimi-latest → **それも 404**。
//   モデル名は提供元の都合(廃止/改名)とキーごとの権限で動く外部の識別子なのに、コードに
//   固定していたため、そのたびにアプリのリリースが必要だった。
//
// ★否定対照(修正前のコードでこのテストが赤くなること):
//   修正前は `LLM_PROVIDERS[].model` が固定の文字列リテラルで、UserConfig に <provider>Model が無く、
//   保存経路(EXPLICIT_PARAM_KEYS)にも入っていない。よって
//     - 「保存したモデルが LLM_PROVIDERS に反映される」は成立しない(常に固定値)
//     - GET /api/settings の llmModels* も存在しない
//   なお「未設定なら既定」(後方互換)のケースだけは修正前でも通る=**それが狙い**(挙動不変の証拠)。
//
// 外部 API は叩かない: reloadProviders() は OpenAI クライアントを組むだけ(ネットワーク無し)。

import { resetConfigCache } from '../configStore.js';
import { LLM_PROVIDERS, DEFAULT_LLM_MODELS, resolveLlmModel } from '../config.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY'] as const;
const SAVED_ENV = new Map<string, string | undefined>();
let dir: string;

function mockRes() {
  const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
  return {
    out,
    status(c: number) { out.code = c; return this; },
    json(b: Record<string, unknown>) { out.body = b; return this; },
  };
}
function post(body: Record<string, unknown>) {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postSettingsHandler({ body } as any, res as any);
  return res.out;
}
function get() {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsHandler({} as any, res as any);
  return res.out.body;
}
const configFile = () => join(dir, '.jp225-monitor', 'config.json');
const readRaw = () => JSON.parse(readFileSync(configFile(), 'utf-8')) as Record<string, unknown>;
const providerModel = (name: string) => LLM_PROVIDERS.find(p => p.name === name)!;

describe('LLM モデル名の設定(保存で反映・未設定は既定)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-llmmodel-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED_ENV.set(k, process.env[k]); delete process.env[k]; }
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(configFile(), JSON.stringify({ kimiKey: 'k-key' }));
    resetConfigCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    const restore = (n: string, v: string | undefined) => { if (v !== undefined) process.env[n] = v; else delete process.env[n]; };
    restore('HOME', ORIG.HOME); restore('USERPROFILE', ORIG.USERPROFILE); restore('APPDATA', ORIG.APPDATA);
    for (const [k, v] of SAVED_ENV) restore(k, v);
    resetConfigCache();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★未設定ならコードの既定モデル(=従来の挙動が1ミリも変わらない)', () => {
    expect(resolveLlmModel('kimi')).toBe(DEFAULT_LLM_MODELS.kimi);
    expect(providerModel('kimi').model).toBe(DEFAULT_LLM_MODELS.kimi);
    expect(providerModel('kimi').chatModel).toBe(DEFAULT_LLM_MODELS.kimi);
    expect(providerModel('gemini').model).toBe('gemini-flash-latest');
    expect(providerModel('groq').chatModel).toBe('llama-3.3-70b-versatile');
    expect(providerModel('openai').model).toBe('gpt-4o-mini');
  });

  it('★保存すると LLM が実際に使うモデル(explain/chat 両方)が変わる', () => {
    expect(post({ kimiModel: 'kimi-k2-turbo-preview' }).code).toBe(200);
    expect(readRaw().kimiModel).toBe('kimi-k2-turbo-preview');
    expect(providerModel('kimi').model).toBe('kimi-k2-turbo-preview');
    expect(providerModel('kimi').chatModel).toBe('kimi-k2-turbo-preview');
    // 他プロバイダは巻き添えにならない
    expect(providerModel('gemini').model).toBe(DEFAULT_LLM_MODELS.gemini);
  });

  it('空欄で保存すると設定が消えて既定に戻る(Web検索モデルと同じ規約)', () => {
    post({ kimiModel: 'kimi-k2-turbo-preview' });
    expect(providerModel('kimi').model).toBe('kimi-k2-turbo-preview');
    post({ kimiModel: '' });
    expect(readRaw().kimiModel).toBeUndefined();
    expect(providerModel('kimi').model).toBe(DEFAULT_LLM_MODELS.kimi);
  });

  it('モデル欄を送らない保存では既存のモデル設定を消さない(未指定=変更なし)', () => {
    post({ kimiModel: 'kimi-k2-turbo-preview' });
    post({});   // 他の設定だけ保存した状況
    expect(readRaw().kimiModel).toBe('kimi-k2-turbo-preview');
    expect(providerModel('kimi').model).toBe('kimi-k2-turbo-preview');
  });

  it('GET /api/settings が 保存値 / 実効値 / 既定 の3つを返す(空欄の意味が画面で分かる)', () => {
    post({ kimiModel: 'kimi-k2-turbo-preview' });
    const body = get();
    expect((body.llmModels as Record<string, string>).kimi).toBe('kimi-k2-turbo-preview');
    expect((body.llmModels as Record<string, string>).gemini).toBe('');            // 未設定は空欄
    expect((body.llmModelsEffective as Record<string, string>).kimi).toBe('kimi-k2-turbo-preview');
    expect((body.llmModelsEffective as Record<string, string>).gemini).toBe(DEFAULT_LLM_MODELS.gemini);
    expect((body.llmModelDefaults as Record<string, string>).kimi).toBe(DEFAULT_LLM_MODELS.kimi);
  });

  it('前後の空白は落として保存する(コピペ事故で 404 にしない)', () => {
    post({ kimiModel: '  kimi-k2-turbo-preview  ' });
    expect(readRaw().kimiModel).toBe('kimi-k2-turbo-preview');
  });
});
