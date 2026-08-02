import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, resolveApiKeyForPool, GENERATOR_DAILY_BUDGET_DEFAULT } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★提案生成器(caller='generator')の設定を ⚙️ から扱えるようにした分の契約テスト。
//
// この機能の一番の要点は **「専用キーが効いているのか共通キーに落ちているのかが一目で分かること」**。
// 専用キーが無いと生成器は黙って共通キーへフォールバックし、ローカルのポーズは分離されるのに
// 上流のクォータは実弾(A)と共有されたまま=「分離したつもりで分離できていない」が無音で成立する。
// そこで GET は **キーの値ではなく「どのキーを使うか」** を返し、UI がそれを文言にする。
//
// 併せて: キーの値は絶対に GET に出さない / 保存で他のフィールドを壊さない、も固定する。

const ORIG = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
  GEMINI: process.env.GEMINI_API_KEY, GROQ: process.env.GROQ_API_KEY,
  OPENAI: process.env.OPENAI_API_KEY, KIMI: process.env.KIMI_API_KEY,
  GEN_GEMINI: process.env.GENERATOR_GEMINI_API_KEY,
  GEN_OPENAI: process.env.GENERATOR_OPENAI_API_KEY,
  BUDGET: process.env.GENERATOR_DAILY_BUDGET,
  VARIANT: process.env.MONITOR_VARIANT,
};
const ENV_KEYS = [
  'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'KIMI_API_KEY',
  'GENERATOR_GEMINI_API_KEY', 'GENERATOR_GROQ_API_KEY', 'GENERATOR_OPENAI_API_KEY',
  'GENERATOR_KIMI_API_KEY', 'GENERATOR_DAILY_BUDGET', 'MONITOR_VARIANT',
] as const;

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
function get(): Record<string, unknown> {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsHandler({} as any, res as any);
  return res.out.body;
}
const configPath = () => join(dir, '.jp225-monitor', 'config.json');
function readRaw(): Record<string, unknown> {
  return existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf-8')) : {};
}
function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(obj, null, 2));
  resetConfigCache();
}
function sources(): Record<string, string> {
  return get().generatorKeySources as Record<string, string>;
}

describe('/api/settings 提案生成器(キー/予算)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-setgen-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    process.env.APPDATA = dir;   // ★実 DB を触らない(getSettingsHandler が meta を読むため)
    for (const k of ENV_KEYS) delete process.env[k];
    resetConfigCache();
  });
  afterEach(() => {
    const restore = (name: string, v: string | undefined) => {
      if (v !== undefined) process.env[name] = v; else delete process.env[name];
    };
    restore('HOME', ORIG.HOME); restore('USERPROFILE', ORIG.USERPROFILE); restore('APPDATA', ORIG.APPDATA);
    restore('GEMINI_API_KEY', ORIG.GEMINI); restore('GROQ_API_KEY', ORIG.GROQ);
    restore('OPENAI_API_KEY', ORIG.OPENAI); restore('KIMI_API_KEY', ORIG.KIMI);
    restore('GENERATOR_GEMINI_API_KEY', ORIG.GEN_GEMINI); restore('GENERATOR_OPENAI_API_KEY', ORIG.GEN_OPENAI);
    restore('GENERATOR_DAILY_BUDGET', ORIG.BUDGET); restore('MONITOR_VARIANT', ORIG.VARIANT);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  // ─── ★要点: フォールバックが見えること ──────────────────────────────
  it('★専用キーが無いプロバイダは shared(=共通キーを使用中) として返る。none(未設定) ではない', () => {
    writeConfig({ geminiKey: 'AIza-shared', openaiKey: 'sk-shared' });
    // 共通キーはあるが生成器専用キーは無い → 生成器は共通キーで動く(=上流クォータは A と共有)。
    expect(sources().gemini).toBe('shared');
    expect(sources().openai).toBe('shared');
    // 共通キーすら無いプロバイダだけが none。
    expect(sources().groq).toBe('none');
    expect(sources().kimi).toBe('none');
  });

  it('★専用キーを入れると own に切り替わり、実際に生成器プールがその値を使う', () => {
    writeConfig({ geminiKey: 'AIza-shared', openaiKey: 'sk-shared' });
    expect(post({ generatorKeys: { openai: 'sk-generator' } }).code).toBe(200);
    expect(sources().openai).toBe('own');
    expect(sources().gemini).toBe('shared');   // 入れていない側はフォールバックのまま
    // 表示と実際の解決が一致すること(表示だけ own で中身は共通キー、を許さない)。
    expect(resolveApiKeyForPool('openai', 'generator')).toBe('sk-generator');
    expect(resolveApiKeyForPool('gemini', 'generator')).toBe('AIza-shared');
    // ★default プール(実弾 A)は一切変わらない。
    expect(resolveApiKeyForPool('openai', 'default')).toBe('sk-shared');
  });

  it('★環境変数の専用キーは env として返る(config が空でも「共通キーを使用中」と誤表示しない)', () => {
    writeConfig({ geminiKey: 'AIza-shared' });
    process.env.GENERATOR_GEMINI_API_KEY = 'AIza-generator-env';
    resetConfigCache();
    expect(sources().gemini).toBe('env');
    expect(resolveApiKeyForPool('gemini', 'generator')).toBe('AIza-generator-env');
  });

  it('★専用キーを消去(null)すると shared へ戻る=フォールバック表示が実際に切り替わる', () => {
    writeConfig({ geminiKey: 'AIza-shared', generatorKeys: { gemini: 'AIza-generator' } });
    expect(sources().gemini).toBe('own');
    expect(post({ generatorKeys: { gemini: null } }).code).toBe(200);
    expect(sources().gemini).toBe('shared');
    expect(resolveApiKeyForPool('gemini', 'generator')).toBe('AIza-shared');
    expect(readRaw().generatorKeys).toBeUndefined();   // 空になったらキーごと落とす
  });

  // ─── 秘密の扱い ────────────────────────────────────────────────
  it('★キーの値は GET に一切出ない(出どころだけ)', () => {
    writeConfig({ geminiKey: 'AIza-shared', generatorKeys: { openai: 'sk-generator-secret' } });
    const json = JSON.stringify(get());
    expect(json).not.toContain('sk-generator-secret');
    expect(json).not.toContain('AIza-shared');
    expect(json).not.toContain('generatorKeys":{"openai"');
  });

  it('空欄(空文字)は変更なし=既存の専用キーを消さない(既存の秘密フィールドと同じ規約)', () => {
    writeConfig({ generatorKeys: { openai: 'sk-generator' } });
    expect(post({ generatorKeys: { openai: '', gemini: '' } }).code).toBe(200);
    expect(readRaw().generatorKeys).toEqual({ openai: 'sk-generator' });
  });

  it('generatorKeys を送らない普通の保存では専用キーが消えない', () => {
    writeConfig({ generatorKeys: { openai: 'sk-generator' }, generatorDailyBudget: 300, chromePath: 'C:\\chrome.exe' });
    expect(post({ scalpLcFloorYen: 45, pricePollMs: 2000 }).code).toBe(200);
    const raw = readRaw();
    expect(raw.generatorKeys).toEqual({ openai: 'sk-generator' });
    expect(raw.generatorDailyBudget).toBe(300);
    expect(raw.chromePath).toBe('C:\\chrome.exe');
  });

  // ─── 日次予算 ──────────────────────────────────────────────────
  it('日次予算を保存/再取得できる。空欄(null)は既定へ戻す', () => {
    expect(get().generatorDailyBudget).toBe(GENERATOR_DAILY_BUDGET_DEFAULT);
    expect(post({ generatorDailyBudget: 800 }).code).toBe(200);
    expect(get().generatorDailyBudget).toBe(800);
    expect(readRaw().generatorDailyBudget).toBe(800);
    expect(post({ generatorDailyBudget: null }).code).toBe(200);
    expect(Object.prototype.hasOwnProperty.call(readRaw(), 'generatorDailyBudget')).toBe(false);
    expect(get().generatorDailyBudget).toBe(GENERATOR_DAILY_BUDGET_DEFAULT);
  });

  it('0(=生成器を無効化)は有効な値として保存される', () => {
    expect(post({ generatorDailyBudget: 0 }).code).toBe(200);
    expect(readRaw().generatorDailyBudget).toBe(0);
    expect(get().generatorDailyBudget).toBe(0);
  });

  it('★範囲外/非整数は 400 で拒否し、config を書き換えない(黙って丸めない)', () => {
    writeConfig({ generatorDailyBudget: 300, chromePath: 'C:\\chrome.exe' });
    const before = readRaw();
    expect(post({ generatorDailyBudget: 5001 }).code).toBe(400);
    expect(post({ generatorDailyBudget: -1 }).code).toBe(400);
    expect(post({ generatorDailyBudget: 1.5 }).code).toBe(400);
    expect(readRaw()).toEqual(before);
  });

  it('GET は既定値/上限も返す(UI のプレースホルダと max 属性の SSOT)', () => {
    const g = get();
    expect(g.generatorDailyBudgetDefault).toBe(GENERATOR_DAILY_BUDGET_DEFAULT);
    expect(g.generatorDailyBudgetMax).toBe(5000);
  });
});
