import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ─── ★プロバイダ失敗ログの「切り詰め」が診断値を捨てていた ───────────────────────
//
// 症状(稼働機で1日2,500回以上):
//   [LLM:groq] oversize (413 Request too large for model `llama-3.3-70b-versatile` in) — …
//                                                                                    ↑ 60文字でここまで
// Groq の 413 は続きに `on tokens per minute (TPM): Limit N, Requested M` が入る。
// **モデル名が長いせいで、超過量という唯一の打ち手材料が毎回捨てられていた**。
//
// ★否定対照(修正前のコードでこのファイルが赤くなること):
//   修正前は `msg.slice(0, 60)`(oversize) / `slice(0, 70)`(config) / `slice(0, 60)`(transient) で、
//   formatErrForLog は存在しない。実文の Limit/Requested は 137〜165 文字目にあるので、
//   「Limit 12000 / Requested 13500 がログに残る」アサーションは成立しえない。
//   実証手順: git show HEAD:server/llm/providers.ts で差し替えて実行。
//
// ★外部 LLM は絶対に叩かない: 'openai' を差し替え、その create() は呼ばれたら失敗する
//   (このファイルの経路は task 自身が投げるので、クライアントには一度も触れない)。

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
import { callWithFallback, formatErrForLog, reloadProviders, stripParsedInputSnippet } from './providers.js';

/** Groq の 413 の**形**(値は例)。★「全文」ではない: 実文はこの後ろにも続くことが確認されている
 *  (`… try again. Need more …`)。この機体の server.log には 60 字で切られた形しか残っていないので、
 *  ここでの全長は実測値ではなく **並びの再現**として扱う。テストが守るのは長さではなく
 *  「`Limit N, Requested M` がログに残ること」。 */
const GROQ_413 = '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_xxx` '
  + 'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 13500, '
  + 'please reduce your message size and try again.';

/** 上と同じ形で、**末尾がさらに続く**版(実文が 240 字を超えて切られる場合の確認用)。 */
const GROQ_413_LONGER = `${GROQ_413} Need more tokens per minute (TPM)? `
  + 'Upgrade to Dev Tier: https://console.groq.com/settings/billing';

const ENV_KEYS = [
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'GENERATOR_GEMINI_API_KEY', 'GENERATOR_GROQ_API_KEY', 'GENERATOR_OPENAI_API_KEY', 'GENERATOR_KIMI_API_KEY',
] as const;
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA };
const SAVED = new Map<string, string | undefined>();
let dir: string;

describe('formatErrForLog — ログの切り詰めが診断値を残す', () => {
  it('★Groq 413 の Limit / Requested の数値が残る(=打ち手が決まる)', () => {
    const out = formatErrForLog(GROQ_413);
    expect(out).toContain('Limit 12000');
    expect(out).toContain('Requested 13500');
    // ★否定対照: 修正前の 60 文字ではこの数値が1つも残らない。
    expect(GROQ_413.slice(0, 60)).not.toContain('Limit');
    expect(GROQ_413.slice(0, 60)).not.toContain('Requested');
  });

  it('★実文の末尾が上限を超えても、数値は残り末尾だけが落ちる(240 は「全文が入る長さ」ではない)', () => {
    const out = formatErrForLog(GROQ_413_LONGER);
    expect(out).toContain('Limit 12000');
    expect(out).toContain('Requested 13500');
    expect(out.endsWith('…')).toBe(true);            // 末尾は切れる=それでよい
    expect(out).not.toContain('console.groq.com');   // 落ちるのは定型の案内文
  });

  it('上限を超えたら末尾に … を付けて切る(ログ行を無限に伸ばさない)', () => {
    const long = `${'x'.repeat(400)}TAIL`;
    const out = formatErrForLog(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('TAIL');
    expect(out.length).toBeLessThanOrEqual(241);
  });

  it('★APIキーらしき文字列は伏せる(長くする以上、秘密を落とすのはセット)', () => {
    const out = formatErrForLog(
      '401 Incorrect API key provided: sk-proj-abc123DEF456ghi. gsk_LIVEkey0987654321 AIzaSyABCDEFG12345',
    );
    expect(out).not.toContain('sk-proj-abc123DEF456ghi');
    expect(out).not.toContain('gsk_LIVEkey0987654321');
    expect(out).not.toContain('AIzaSyABCDEFG12345');
    expect(out).toContain('<キー伏字>');
    expect(out).toContain('401');             // 診断に要る部分は残る
  });

  it('★伏字は「切る前」に効く(境界に来たキーの断片が生き残らない)', () => {
    // 上限(240)の境界にキーを置く。先に切ると断片 `gsk_LIVE` が残り、しかも伏字の最小長
    // (区切りの後 6文字以上)を割るので、**後から伏字をかけても捕まらない**。
    const msg = `${'y'.repeat(231)} gsk_LIVEsecret0123456789 tail`;
    const out = formatErrForLog(msg);
    expect(out).not.toContain('gsk_LIVE');
    // ★否定対照: 切ってから見る順序(=修正前が出していた文字列)にはキーの断片が残る。
    expect(msg.slice(0, 240)).toContain('gsk_LIVE');
  });
});

// ─── ★アプリ由来データがログに載る唯一の経路(V8 の JSON.parse メッセージ) ──────────
//
// scalpPlan の `parse failed after retry: JSON parse failed: <V8のメッセージ>` は、
// V8 が **入力(=モデルの生出力)の断片を引用符で埋め込む**ため、ニュース文や価格を含む
// アプリのデータをそのままログへ運ぶ。しかも `41,500` の `500` が classifyLLMError の
// `\b50[0-4]\b` に当たって transient と誤分類されるので、この経路は毎回ログに出る。
// (60字時代は切れて見えず、240字にして初めて表に出た。)
//
// ★V8 のメッセージは**この場で実際に JSON.parse させて**作る(形をハードコードしない)。
describe('stripParsedInputSnippet — V8 が埋め込む入力断片を落とす', () => {
  /** 実際に JSON.parse を失敗させて V8 のメッセージを得る。 */
  function v8Message(input: string): string {
    try { JSON.parse(input); throw new Error('パースが成功してしまった'); }
    catch (e) { return e instanceof Error ? e.message : String(e); }
  }
  // アプリ由来データの見本(架空。実在のニュース文ではない)。
  const APP = '節目 41,500 円を上抜けたら追随';
  const shapes: Array<[string, string]> = [
    ['先頭形', `x${APP}`],
    ['中間形', `{"pad":"${'y'.repeat(200)}","rationale":"${APP}",あ}`],
    ['末尾形', `{"rationale":"${APP}"あ`],
    ['全体形', `${APP.slice(0, 3)}`],
  ];
  for (const [label, input] of shapes) {
    it(`${label}: 引用符の中身が落ち、V8 の診断部分は残る`, () => {
      const msg = v8Message(input);
      const out = stripParsedInputSnippet(msg);
      // 断片が実際に埋め込まれている形だけを対象にする(埋め込まない形は素通しでよい)
      if (!/ is not valid JSON$/.test(msg)) { expect(out).toBe(msg); return; }
      expect(out).toContain('<入力省略>');
      expect(out).toContain('is not valid JSON');
      expect(out).toMatch(/Unexpected token/);      // 何が起きたかは残る
      for (const frag of [APP.slice(0, 4), '41,5', '節目']) {
        if (msg.includes(frag)) expect(out).not.toContain(frag);
      }
    });
  }

  it('★プロバイダの実エラー文は1文字も変わらない', () => {
    for (const s of [
      GROQ_413, GROQ_413_LONGER,
      '404 Not found the model kimi-latest or Permission denied',
      'models/gemini-flash-latest is not found for API version v1beta, or is not supported for generateContent',
      '401 Incorrect API key provided: sk-proj-****…Y9EA. You can find your API key at https://platform.openai.com/account/api-keys',
      '503 status code (no body)',
      '429 rate_limit_exceeded: Limit 6000, Used 6000, Requested 512',
    ]) {
      expect(stripParsedInputSnippet(s)).toBe(s);
    }
  });

  it('★formatErrForLog 経由でも落ちる(伏字 → 断片除去 → 切り詰め の順)', () => {
    const msg = `parse failed after retry: JSON parse failed: ${
      v8Message(`{"pad":"${'y'.repeat(200)}","rationale":"${APP}",あ}`)}`;
    const out = formatErrForLog(msg);
    expect(out).toContain('parse failed after retry');   // どこで失敗したかは残る
    expect(out).not.toContain('節目');
    expect(out).not.toContain('41,5');
  });
});

describe('tripCircuit の実ログ行(console.warn を実測)', () => {
  beforeEach(() => {
    dir = mkdtempSync(`${tmpdir()}/jp225-llmlog-`);
    ORIG.HOME = process.env.HOME; ORIG.USERPROFILE = process.env.USERPROFILE; ORIG.APPDATA = process.env.APPDATA;
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    for (const k of ENV_KEYS) { SAVED.set(k, process.env[k]); delete process.env[k]; }
    // groq だけキーを持たせる(=有効プロバイダを1つに固定し、ログ行を一意にする)。
    process.env.GROQ_API_KEY = 'gsk_dummy_test_key_not_real';
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

  /** callWithFallback に「必ず投げる task」を渡し、tripCircuit が実際に出した warn 行を集める。 */
  async function warnLines(errMessage: string): Promise<string[]> {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        callWithFallback(async () => { throw new Error(errMessage); }, 'テスト'),
      ).rejects.toThrow();
      return spy.mock.calls.map(c => c.map(String).join(' '));
    } finally {
      spy.mockRestore();
    }
  }

  it('★413(実文)の warn 行に Limit / Requested の数値が残る', async () => {
    const lines = await warnLines(GROQ_413);
    const line = lines.find(l => l.includes('oversize'));
    expect(line).toBeDefined();
    expect(line).toContain('[LLM:groq]');
    expect(line).toContain('Limit 12000');
    expect(line).toContain('Requested 13500');
    expect(line).toContain('ポーズせず次(大きいモデル)へフォールバック');
  });

  it('★config(401)の warn 行にキーが出ない', async () => {
    const lines = await warnLines('401 Incorrect API key provided: sk-proj-abc123DEF456ghi. You can find your API key at https://platform.openai.com/account/api-keys');
    const line = lines.find(l => l.includes('config error'));
    expect(line).toBeDefined();
    expect(line).not.toContain('sk-proj-abc123DEF456ghi');
    expect(line).toContain('<キー伏字>');
    expect(line).toContain('paused 30min');
  });

  it('★parse 失敗の warn 行にアプリのデータ(モデルの生出力)が残らない', async () => {
    // ★V8 が断片を埋め込む形を実際に作る。断片に価格の `500` が入ると
    //   classifyLLMError の `\b50[0-4]\b` に当たって transient と誤分類される(稼働機で観測された形)。
    const bad = `{"pad":"${'y'.repeat(200)}","legs":["節目 41,500",あ]}`;
    let v8 = '';
    try { JSON.parse(bad); } catch (e) { v8 = e instanceof Error ? e.message : String(e); }
    expect(v8).toContain('41,500');   // 前提: この Node で断片にアプリのデータが入っている
    const lines = await warnLines(`parse failed after retry: JSON parse failed: ${v8}`);
    // `41,500` の `500` で transient に誤分類される(既存の分類挙動。ここでは変えない)。
    const line = lines.find(l => l.includes('transient'));
    expect(line).toBeDefined();
    expect(line).toContain('parse failed after retry');   // 何が起きたかは残る
    expect(line).toContain('is not valid JSON');          // 何で失敗したかも残る
    expect(line).toContain('<入力省略>');
    expect(line).not.toContain('41,500');                 // ★アプリのデータは残らない
    expect(line).not.toContain('目 ');
  });

  it('transient(503)の warn 行も従来どおり出る(分類の挙動は不変)', async () => {
    const lines = await warnLines('503 status code (no body) — upstream temporarily unavailable');
    expect(lines.find(l => l.includes('transient'))).toBeDefined();
  });
});
