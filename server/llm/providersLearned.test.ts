import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ─── ★同じ拒否を毎回繰り返さない(2026-08-15) ─────────────────────────────────
//
// 実測(稼働機ログ 53時間):
//   [LLM:groq@generator] oversize (413 … TPM: Limit 12000, Requested 21618)  … 1日 1,100〜1,300回
//   [LLM:kimi] config error (404 Not found the model kimi-latest …)          … 30分ごとに永久 114回
//
// どちらも **答えが返る前から結果が分かっている** 拒否:
//   ・413 は「この大きさの要求はこのモデルでは通らない」= 次も同じ大きさなら必ず通らない。
//   ・404(モデルが無い/権限が無い)は時間で治らない。30分ごとに叩き直しても同じ答えが返る。
// 無駄打ちは課金・遅延・ログの雑音を増やし、**本当の障害を埋もれさせる**。
//
// ★ここで守る契約:
//   (1) 413 を返したプロバイダは、**同じかそれ以上の大きさ**の要求では以後スキップする。
//   (2) それより小さい要求では今までどおり使う(プロバイダ自体は健全なので締め出さない)。
//   (3) 404/権限エラーのプロバイダは、設定が変わる(reloadProviders)まで使わない。
//   (4) スキップは無音にしない(最初の1回だけ理由を残す)。
//
// ★否定対照: 修正前の providers.ts では (1)(3) が成立しない(毎回叩きに行く)。
//   実証手順: git show HEAD:server/llm/providers.ts で差し替えて実行 → 該当テストが赤。
//
// ★外部 LLM は絶対に叩かない: openai SDK を差し替え、create() は呼ばれたら失敗する。

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = { completions: { create: async () => { throw new Error('テストが外部へ出ようとした'); } } };
    constructor(_o: unknown) { /* 生成のみ */ }
  }
  return { default: FakeOpenAI };
});

import { resetConfigCache } from '../configStore.js';
import { callWithFallback, reloadProviders } from './providers.js';

/** Groq の 413 の形(値は例)。 */
const GROQ_413 = '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_x` '
  + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 21618, '
  + 'please reduce your message size and try again.';
/** Kimi の 404 の形(実文)。 */
const KIMI_404 = '404 Not found the model kimi-latest or Permission denied';

const ENV_KEYS = [
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'GENERATOR_GEMINI_API_KEY', 'GENERATOR_GROQ_API_KEY', 'GENERATOR_OPENAI_API_KEY', 'GENERATOR_KIMI_API_KEY',
] as const;
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
const SAVED = new Map<string, string | undefined>();
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prov-learn-'));
  process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
  for (const k of ENV_KEYS) { SAVED.set(k, process.env[k]); delete process.env[k]; }
  // 3本だけ有効にする(gemini → groq → openai の順で呼ばれる)。
  process.env.GEMINI_API_KEY = 'k-gemini';
  process.env.GROQ_API_KEY = 'k-groq';
  process.env.OPENAI_API_KEY = 'k-openai';
  resetConfigCache();
  reloadProviders();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) { const v = SAVED.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  process.env.HOME = ORIG.HOME; process.env.USERPROFILE = ORIG.USERPROFILE; process.env.APPDATA = ORIG.APPDATA;
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

/** どのプロバイダが呼ばれたかを記録しつつ、指定プロバイダだけ失敗させる task を作る。 */
function taskThatFails(failing: Record<string, string>, seen: string[]) {
  return async (p: { config: { name: string } }) => {
    seen.push(p.config.name);
    const err = failing[p.config.name];
    if (err) throw new Error(err);
    return `ok:${p.config.name}`;
  };
}

describe('★413(大きすぎる要求)を返したプロバイダは、同じ大きさでは二度と叩かない', () => {
  it('1回目は叩いてフォールバック、2回目以降は最初からスキップ', async () => {
    const seen: string[] = [];
    const big = 90_000;   // 送るプロンプトのおおよその文字数
    const first = await callWithFallback(taskThatFails({ gemini: GROQ_413 }, seen), 'テスト', 'default', big);
    expect(first).toBe('ok:groq');
    expect(seen).toContain('gemini');

    seen.length = 0;
    const second = await callWithFallback(taskThatFails({ gemini: GROQ_413 }, seen), 'テスト', 'default', big);
    expect(second).toBe('ok:groq');
    expect(seen, '2回目も gemini を叩いている(学習していない)').not.toContain('gemini');
  });

  it('★小さい要求では今までどおり使う(プロバイダを締め出さない)', async () => {
    const seen: string[] = [];
    await callWithFallback(taskThatFails({ gemini: GROQ_413 }, seen), 'テスト', 'default', 90_000);
    seen.length = 0;
    // gemini を失敗させて groq まで進ませる。小さい要求なので groq は使えるはず。
    const r = await callWithFallback(taskThatFails({}, seen), 'テスト', 'default', 1_000);
    expect(r).toBe('ok:gemini');
    expect(seen).toContain('gemini');
  });

  it('要求の大きさを渡さない呼び出しは従来どおり(スキップしない)', async () => {
    const seen: string[] = [];
    await callWithFallback(taskThatFails({ gemini: GROQ_413 }, seen), 'テスト', 'default', 90_000);
    seen.length = 0;
    const r = await callWithFallback(taskThatFails({}, seen), 'テスト');
    expect(r).toBe('ok:gemini');
  });

  it('スキップは無音にしない(最初の1回だけ理由がログに出る)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await callWithFallback(taskThatFails({ gemini: GROQ_413 }, []), 'テスト', 'default', 90_000);
    warn.mockClear();
    await callWithFallback(taskThatFails({}, []), 'テスト', 'default', 90_000);
    const lines1 = warn.mock.calls.map(c => c.map(String).join(' '));
    expect(lines1.some(l => l.includes('gemini') && l.includes('スキップ'))).toBe(true);
    warn.mockClear();
    await callWithFallback(taskThatFails({}, []), 'テスト', 'default', 90_000);
    const lines2 = warn.mock.calls.map(c => c.map(String).join(' '));
    expect(lines2.some(l => l.includes('スキップ')), '2回目以降も同じ行を出している(雑音)').toBe(false);
  });
});

describe('★モデルが無い/権限が無い(404)プロバイダは、設定が変わるまで使わない', () => {
  it('1回目で学習し、2回目以降は叩かない', async () => {
    const seen: string[] = [];
    const r1 = await callWithFallback(taskThatFails({ gemini: KIMI_404 }, seen), 'テスト');
    expect(r1).toBe('ok:groq');
    expect(seen).toContain('gemini');

    seen.length = 0;
    const r2 = await callWithFallback(taskThatFails({ gemini: KIMI_404 }, seen), 'テスト');
    expect(r2).toBe('ok:groq');
    expect(seen, '404 を返したプロバイダを叩き続けている').not.toContain('gemini');
  });

  it('★設定を変えたら(reloadProviders)また使う', async () => {
    const seen: string[] = [];
    await callWithFallback(taskThatFails({ gemini: KIMI_404 }, seen), 'テスト');
    reloadProviders();
    seen.length = 0;
    await callWithFallback(taskThatFails({}, seen), 'テスト');
    expect(seen, '設定を直しても復帰しない(手が無くなる)').toContain('gemini');
  });

  it('★全部が使えなくなっても、理由の分かるエラーで落ちる(無音で固まらない)', async () => {
    const seen: string[] = [];
    await expect(
      callWithFallback(taskThatFails({ gemini: KIMI_404, groq: KIMI_404, openai: KIMI_404 }, seen), 'テスト'),
    ).rejects.toThrow();
    seen.length = 0;
    await expect(callWithFallback(taskThatFails({}, seen), 'テスト')).rejects.toThrow(/設定|config|使えるプロバイダ/);
  });
});
