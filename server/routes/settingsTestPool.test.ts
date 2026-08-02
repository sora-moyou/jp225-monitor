import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★「キーを検証」をプール別に分ける ────────────────────────────────
//
// 検証は **実際に外部へリクエストを送る**。だからプールごとに正しいキーで送らなければならない:
//   - 「キーを検証」(pool 省略)      … 共通キー(実弾 A のキー)
//   - 「生成器のキーを検証」(generator) … 生成器専用キー。**専用キーがある行で共通キーを消費しない**。
//
// ★否定対照(修正前のコードでこのテストが赤くなること):
//   修正前は testProvider/testAllProviders が引数を取らず、常に default プールを ping していた。
//   → 「生成器の検証が専用キー(AIza-gen)を使う」アサーションは成立しえない(共通キーで ping される)。
//   また testSettingsHandler は req を無視していたので、不正な pool でも 400 にならなかった。
//
// 外部 LLM は絶対に叩かない: 'openai' モジュールを差し替え、ping に使われた apiKey だけを記録する。

const rec = vi.hoisted(() => ({ pings: [] as string[] }));

vi.mock('openai', () => {
  class FakeOpenAI {
    apiKey: string;
    chat: { completions: { create: () => Promise<unknown> } };
    constructor(opts: { apiKey?: string }) {
      this.apiKey = opts.apiKey ?? '';
      this.chat = {
        completions: {
          create: async () => { rec.pings.push(this.apiKey); return { choices: [{ message: { content: 'ok' } }] }; },
        },
      };
    }
  }
  return { default: FakeOpenAI };
});

import { resetConfigCache } from '../configStore.js';
import { reloadProviders } from '../llm/openai.js';
import { testSettingsHandler } from './settings.js';

const ORIG = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
};
const ENV_KEYS = [
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'GENERATOR_GEMINI_API_KEY', 'GENERATOR_GROQ_API_KEY', 'GENERATOR_OPENAI_API_KEY', 'GENERATOR_KIMI_API_KEY',
] as const;
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
async function test(query: Record<string, unknown>) {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await testSettingsHandler({ query } as any, res as any);
  return res.out;
}

describe('/api/settings/test のプール別検証', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-testpool-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED_ENV.set(k, process.env[k]); delete process.env[k]; }
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify({
      geminiKey: 'AIza-shared', groqKey: 'gsk-shared', openaiKey: 'sk-shared', kimiKey: 'kimi-shared',
      generatorKeys: { gemini: 'AIza-gen' },   // ★Gemini だけ専用キー。他は共通キーへフォールバック。
    }));
    resetConfigCache();
    reloadProviders();   // default を新しいキーで再構築 + generator プールを破棄(次回遅延構築)
    rec.pings = [];
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

  it('pool 省略は従来どおり共通キー(実弾 A のキー)で ping する', async () => {
    const out = await test({});
    expect(out.code).toBe(200);
    expect(out.body.pool).toBe('default');
    expect(rec.pings).toContain('AIza-shared');
    expect(rec.pings).not.toContain('AIza-gen');   // 生成器の専用キーは消費しない
  });

  it('★pool=generator は専用キーで ping する(生成器の検証で共通キーを消費しない)', async () => {
    const out = await test({ pool: 'generator' });
    expect(out.code).toBe(200);
    expect(out.body.pool).toBe('generator');
    expect(rec.pings).toContain('AIza-gen');       // 専用キーがある行は専用キー
    expect(rec.pings).not.toContain('AIza-shared');
  });

  it('専用キーが無い行は共通キーで ping する(=フォールバックしている実態どおり)', async () => {
    await test({ pool: 'generator' });
    // groq/openai/kimi は専用キーが無いので共通キーへフォールバックしたキーで検証される。
    expect(rec.pings).toContain('gsk-shared');
    expect(rec.pings).toContain('sk-shared');
  });

  it('★不正な pool は 400。黙って default に倒して共通キーを消費しない', async () => {
    const out = await test({ pool: 'bogus' });
    expect(out.code).toBe(400);
    expect(rec.pings).toEqual([]);
  });
});
