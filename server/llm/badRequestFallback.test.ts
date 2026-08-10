// server/llm/badRequestFallback.test.ts
//
// ─── ★400 で「次のプロバイダへ回らない」欠陥の再発防止 ──────────────────────────
//
// 症状(稼働機・実データ):
//   ユーザーが Kimi のモデルを kimi-k3 にした 2026-08-10 13:27 JST から、ニュース翻訳が
//   `400 invalid temperature: only 1 is allowed for this model` で連続失敗し、
//   news テーブルの lang='en' 679件のうち **430件が未訳**(翻訳エラーは全部この 1 文)になった。
//
// 真因は temperature ではなく **分類の穴**:
//   classifyLLMError は `\b40[134]\b` しか config に落とさないので 400 は null =
//   callWithFallback が「429以外のエラーは再投げ」の枝に入り、**次のプロバイダを一度も試さない**。
//   2026-07-28 に 404 で同じ事故を起こして config 化した、その隣で 400 が同じ穴に落ちていた。
//
// ★分類は `badrequest`(ポーズ無し)。`config`(30分ポーズ)ではない:
//   400 には「一度きりの要求ミス」が混ざる。実ログの
//     `400 tool call validation failed: parameters for tool explain_move did not match schema` (×6件)
//   はモデルが一度おかしな引数を吐いただけで **プロバイダは健全**。これで30分ポーズすると
//   健全な gemini が止まり、traffic が groq(413連発)→ openai(有料)へ流れる=課金が増える。
//   だから 413(oversize)と同じ「ポーズせず次へ」に揃える。文言でのサブ分類はしない。
//
// ★否定対照(修正前のコードでこのファイルが赤くなること):
//   `git show HEAD:server/llm/providers.ts` の classifyLLMError は 400 を null に落とすため、
//   callWithFallback は 1 プロバイダ目で throw し、2 プロバイダ目の task は **呼ばれない**。
//   下の `calls` は ['kimi'] で止まり、`expect(calls).toEqual(['kimi','openai'])` が失敗する。
//   (scripts 無しで確かめる手順は上記 git show で providers.ts を差し替えて本ファイルを実行。)
// ★もう一方の否定対照は下の「401(config)なら 30分ポーズ」テスト: 同じ経路で **ポーズする側** を
//   実際に走らせ、400 との違いが仕様として出ていることを示す(=規律を一律に緩めていない)。
//
// ★外部 LLM は絶対に叩かない: openai SDK を差し替え、task 自身が投げる/返すので
//   クライアントの create() には一度も触れない。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('openai', () => {
  class FakeOpenAI {
    chat = {
      completions: {
        create: async () => { throw new Error('テストが外部へ出ようとした(あってはならない)'); },
      },
    };
    constructor(_opts: { apiKey?: string; baseURL?: string }) { /* 生成のみ */ }
  }
  return { default: FakeOpenAI };
});

import { resetConfigCache } from '../configStore.js';
import { callWithFallback, classifyLLMError, reloadProviders, getProviderStatus } from './providers.js';

/** ★稼働機の実文(serverlog_kabu.txt に 227 行・DB の translate_error 430 件と同一)。 */
const KIMI_400 = '400 invalid temperature: only 1 is allowed for this model';

const ENV_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'KIMI_API_KEY', 'OPENAI_API_KEY'] as const;
const SAVED = new Map<string, string | undefined>();
const ORIG: Record<string, string | undefined> = {};
let dir = '';

describe('★400 は次のプロバイダへフォールバックする', () => {
  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/jp225-400-`);
    ORIG.HOME = process.env.HOME; ORIG.USERPROFILE = process.env.USERPROFILE; ORIG.APPDATA = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED.set(k, process.env[k]); delete process.env[k]; }
    // kimi(400 を出す側)と openai(受け皿)だけを有効にする = 経路を一意にする。
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

  it('前提: 有効プロバイダは kimi → openai の 2 つ', () => {
    expect(getProviderStatus().filter(p => p.enabled).map(p => p.name)).toEqual(['kimi', 'openai']);
  });

  it('分類: 稼働機の実文が badrequest になる(修正前は null)', () => {
    expect(classifyLLMError(KIMI_400)).toBe('badrequest');
  });

  it('★kimi の 400 の後に openai が呼ばれ、翻訳が成功する', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    try {
      const text = await callWithFallback(async (p) => {
        calls.push(p.config.name);
        if (p.config.name === 'kimi') throw new Error(KIMI_400);
        return '1. 日銀が利上げ';
      }, 'translate-news');
      expect(text).toBe('1. 日銀が利上げ');
    } finally {
      warn.mockRestore();
    }
    // ★これが本丸: 修正前は ['kimi'] で止まり、openai の task は一度も呼ばれなかった。
    expect(calls).toEqual(['kimi', 'openai']);
  });

  it('★400 を出しても kimi はポーズされない(健全なプロバイダを止めない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await callWithFallback(async (p) => {
        if (p.config.name === 'kimi') throw new Error(KIMI_400);
        return 'ok';
      }, 'translate-news');
      const line = warn.mock.calls.map(c => c.map(String).join(' ')).find(l => l.includes('[LLM:kimi]'));
      expect(line).toContain('bad request');
      expect(line).toContain('ポーズせず次へフォールバック');
      expect(line).toContain('invalid temperature');
      // ★ログが嘘をつかないこと: 413 用の語(oversize)にも、長ポーズ用の語(config/paused)にも化けない。
      expect(line).not.toContain('oversize');
      expect(line).not.toContain('config error');
      expect(line).not.toContain('paused');
    } finally {
      warn.mockRestore();
    }
    const st = getProviderStatus();
    expect(st.find(p => p.name === 'kimi')!.paused).toBe(false);        // ★本丸
    expect(st.find(p => p.name === 'kimi')!.pausedUntil).toBe(0);       // ★時刻も1ミリも動かない
    expect(st.find(p => p.name === 'openai')!.paused).toBe(false);
  });

  it('★400 が何度続いても kimi は先頭で試され続ける(429 の ladder に混ざらない)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const seen: string[][] = [];
      for (let i = 0; i < 6; i++) {
        const calls: string[] = [];
        await callWithFallback(async (p) => {
          calls.push(p.config.name);
          if (p.config.name === 'kimi') throw new Error(KIMI_400);
          return 'ok';
        }, 'translate-news');
        seen.push(calls);
      }
      // 6回とも kimi → openai。連続失敗カウンタが積まれてポーズに化けることがない。
      expect(seen).toEqual(Array.from({ length: 6 }, () => ['kimi', 'openai']));
    } finally {
      warn.mockRestore();
    }
    expect(getProviderStatus().every(p => !p.paused)).toBe(true);
  });

  it('★否定対照: 401(config)なら 30分ポーズして候補から外れる=規律は弱めていない', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await callWithFallback(async (p) => {
        if (p.config.name === 'kimi') throw new Error('401 Incorrect API key provided');
        return 'ok';
      }, 'translate-news');
      const line = warn.mock.calls.map(c => c.map(String).join(' ')).find(l => l.includes('[LLM:kimi]'));
      expect(line).toContain('config error');
      expect(line).toContain('paused 30min');
      expect(getProviderStatus().find(p => p.name === 'kimi')!.paused).toBe(true);
      // 次の呼び出しでは候補から外れる(=400 との違いが実際に出ている)
      const calls: string[] = [];
      await callWithFallback(async (p) => { calls.push(p.config.name); return 'ok2'; }, 'translate-news');
      expect(calls).toEqual(['openai']);
    } finally {
      warn.mockRestore();
    }
  });
});
