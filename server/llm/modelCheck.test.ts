import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★「キーを検証」が **キー無効** と **モデルが使えない** を区別する ───────────────
//
// 実運用の症状:
//     kimi: 404 Not found the model kimi-latest or Permission denied
//   従来の検証は 1トークンの chat ping で ✅/❌ を返すだけだったので、これが
//   「キーが無効」なのか「そのキーにそのモデルの権限が無い」のか **画面から区別できなかった**。
//   区別できないと、こちらでモデル名を選び直して**リリース**する以外の手が無い(実際2回やった)。
//
// ★否定対照(修正前のコードでこのテストが赤くなること):
//   修正前の /api/settings/test は testAllProviders() だけで、戻り値は {name, ok, notset?, error?}。
//   reason/keyOk/modelOk/models は存在しないので、以下のアサーションは全て成立しない。
//   また修正前は **必ず chat ping を投げる**ので「キーが無効なら ping を投げない(=トークンを使わない)」
//   のアサーションも成立しない。
//
// 外部 API は絶対に叩かない: 'openai' モジュールを差し替え、キーごとの応答を決める。

const rec = vi.hoisted(() => ({
  behavior: new Map<string, { kind: 'list' | 'auth' | 'nolist'; ids?: string[]; pingFails?: boolean }>(),
  pings: [] as string[],
  lists: [] as string[],
}));

vi.mock('openai', () => {
  class FakeOpenAI {
    apiKey: string;
    models: { list: () => Promise<unknown> };
    chat: { completions: { create: () => Promise<unknown> } };
    constructor(opts: { apiKey?: string }) {
      this.apiKey = opts.apiKey ?? '';
      const b = () => rec.behavior.get(this.apiKey) ?? { kind: 'list' as const, ids: [] };
      this.models = {
        list: async () => {
          rec.lists.push(this.apiKey);
          const cur = b();
          if (cur.kind === 'auth') {
            const e = Object.assign(new Error('401 Incorrect API key provided'), { status: 401 });
            throw e;
          }
          if (cur.kind === 'nolist') {
            const e = Object.assign(new Error('404 page not found'), { status: 404 });
            throw e;
          }
          return { data: (cur.ids ?? []).map(id => ({ id })) };
        },
      };
      this.chat = {
        completions: {
          create: async () => {
            rec.pings.push(this.apiKey);
            if (b().pingFails) throw new Error('boom');
            return { choices: [{ message: { content: 'ok' } }] };
          },
        },
      };
    }
  }
  return { default: FakeOpenAI };
});

import { resetConfigCache, saveConfig, loadConfig } from '../configStore.js';
import { checkProviderModels, normalizeModelId, isKeyError, redactSecrets } from './modelCheck.js';

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY'] as const;
const SAVED_ENV = new Map<string, string | undefined>();
let dir: string;

const pick = (rs: Awaited<ReturnType<typeof checkProviderModels>>, name: string) => rs.find(r => r.name === name)!;

describe('checkProviderModels — キー無効 / モデルが使えない を区別する', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-modelcheck-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED_ENV.set(k, process.env[k]); delete process.env[k]; }
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    // kimi はキーあり / groq はキーあり / openai はキーあり / gemini はキーあり。
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify({
      geminiKey: 'g-key', groqKey: 'q-key', openaiKey: 'o-key', kimiKey: 'k-key',
    }));
    resetConfigCache();
    rec.behavior.clear(); rec.pings = []; rec.lists = [];
    // Gemini は OpenAI 互換一覧が "models/" 前置きで返る(実測)。
    rec.behavior.set('g-key', { kind: 'list', ids: ['models/gemini-flash-latest', 'models/gemini-2.5-pro'] });
    // ★Kimi: キーは通るが、そのキーの一覧に kimi-latest が無い(=Permission denied の正体)。
    rec.behavior.set('k-key', { kind: 'list', ids: ['moonshot-v1-8k', 'kimi-k2-turbo-preview'] });
    rec.behavior.set('o-key', { kind: 'auth' });      // キーそのものが無効
    rec.behavior.set('q-key', { kind: 'nolist' });    // 一覧に非対応 → 従来の ping にフォールバック
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

  it('★モデルが使えないときは「キーは有効(keyOk)・モデル不可(reason=model)」+ 使えるモデル一覧を返す', async () => {
    const r = pick(await checkProviderModels(), 'kimi');
    expect(r.keyOk).toBe(true);        // キーのせいではない
    expect(r.modelOk).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('model');
    expect(r.model).toBe('kimi-latest');           // 検証したモデル名を必ず返す
    expect(r.models).toEqual(['kimi-k2-turbo-preview', 'moonshot-v1-8k']);   // 次の一手(選べる候補)
    expect(r.modelsTotal).toBe(2);
    expect(r.via).toBe('models');
    expect(r.error).toContain('kimi-latest');
  });

  it('★キーが無効なときは reason=key(モデル以前)。しかも **ping を投げない**(トークンを使わない)', async () => {
    const r = pick(await checkProviderModels(), 'openai');
    expect(r.reason).toBe('key');
    expect(r.keyOk).toBe(false);
    expect(r.ok).toBe(false);
    expect(rec.pings).not.toContain('o-key');
  });

  it('モデル一覧は "models/" 前置きを外して突き合わせる(Gemini を誤って「使えない」と言わない)', async () => {
    const r = pick(await checkProviderModels(), 'gemini');
    expect(r.ok).toBe(true);
    expect(r.modelOk).toBe(true);
    expect(r.model).toBe('gemini-flash-latest');
    expect(r.isDefaultModel).toBe(true);
    expect(r.models).toContain('gemini-flash-latest');   // 正規化済みで返る
    expect(normalizeModelId('models/gemini-flash-latest')).toBe('gemini-flash-latest');
  });

  it('モデル一覧が取れない提供元は従来どおり 1トークンの ping で判定する(検証機能が退化しない)', async () => {
    const r = pick(await checkProviderModels(), 'groq');
    expect(r.via).toBe('ping');
    expect(r.ok).toBe(true);
    expect(rec.pings).toContain('q-key');
    expect(r.listError).toContain('404');
  });

  it('★設定でモデルを変えると、検証対象のモデルも変わる(=画面の指示どおり直せる)', async () => {
    saveConfig({ ...loadConfig(), kimiModel: 'kimi-k2-turbo-preview' });
    resetConfigCache();
    const r = pick(await checkProviderModels(), 'kimi');
    expect(r.model).toBe('kimi-k2-turbo-preview');
    expect(r.ok).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.isDefaultModel).toBe(false);
  });

  it('キー未設定のプロバイダは notset。外部へは1回も出ない', async () => {
    saveConfig({ geminiKey: 'g-key' });   // kimi/groq/openai のキーを消す
    resetConfigCache();
    rec.lists = []; rec.pings = [];
    const rs = await checkProviderModels();
    for (const name of ['kimi', 'groq', 'openai']) {
      expect(pick(rs, name).notset).toBe(true);
      expect(pick(rs, name).ok).toBe(false);
    }
    expect(rec.lists).toEqual(['g-key']);   // gemini だけ問い合わせた
    expect(rec.pings).toEqual([]);
  });

  it('★提供元がエラー本文にキーをエコーバックしても、画面には出さない(伏字にする)', () => {
    // 実測: OpenAI の 401 は `Incorrect API key provided: sk-proj-****…Y9EA` を返す。
    const red = redactSecrets('401 Incorrect API key provided: sk-proj-abc123DEF456. See docs');
    expect(red).not.toContain('sk-proj-abc123DEF456');
    expect(red).toContain('<キー伏字>');
    expect(redactSecrets('API key not valid: AIzaSyABCDEFG12345')).not.toContain('AIzaSyABCDEFG12345');
    expect(redactSecrets('404 not found the model kimi-latest')).toBe('404 not found the model kimi-latest');
  });

  it('キー無効の判定は 401/403 と本文の両方を見る(Google は 400 "API key not valid" を返す)', () => {
    expect(isKeyError(401, 'nope')).toBe(true);
    expect(isKeyError(403, 'nope')).toBe(true);
    expect(isKeyError(400, 'API key not valid. Please pass a valid API key.')).toBe(true);
    expect(isKeyError(404, 'Not found the model kimi-latest')).toBe(false);   // これはモデルの話
    expect(isKeyError(500, 'internal error')).toBe(false);
  });
});
