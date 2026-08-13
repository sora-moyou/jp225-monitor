import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ─── 公開版(lite)は「2つ目の API キー」を持たない ───────────────────────────────
//
// ① GET は generator* を **1つも返さない** → 画面に描くものが無い(隠すだけにしない)。
// ② POST は generator* を **一切見ない** → lite と full は同じ config ファイルを共有するので、
//    lite の保存が monitor2 側の分析用設定(専用キー/日次予算)を黙って消してはならない。
//    ★これは実害のある壊れ方: UI を隠すと入力欄は空のまま送られ、空=null=「既定に戻す」として
//      full 側の設定が消える。隠すだけで済ませると、この消去が無音で起きる。
//
// ★否定対照(修正前の routes/settings.ts): lite でも generatorKeySources 等が返り、
//   lite の保存で generatorDailyBudget が消える → 本ファイルが赤。
//   実証手順: git show HEAD:server/routes/settings.ts でファイルを差し替えて実行。

const ORIG = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
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

describe('/api/settings — lite は分析用の設定を持たない', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-setgenlite-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    process.env.APPDATA = dir;   // ★実 DB を触らない
    for (const k of ENV_KEYS) delete process.env[k];
    resetConfigCache();
  });
  afterEach(() => {
    const restore = (name: string, v: string | undefined) => {
      if (v !== undefined) process.env[name] = v; else delete process.env[name];
    };
    restore('HOME', ORIG.HOME); restore('USERPROFILE', ORIG.USERPROFILE); restore('APPDATA', ORIG.APPDATA);
    restore('MONITOR_VARIANT', ORIG.VARIANT);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lite の GET は generator* を1つも返さない(2つ目のキー欄に出す材料が無い)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    writeConfig({ geminiKey: 'AIza-shared', generatorKeys: { openai: 'sk-gen' }, generatorDailyBudget: 300 });
    const body = get();
    for (const k of ['generatorKeySources', 'generatorDailyBudget', 'generatorDailyBudgetDefault', 'generatorDailyBudgetMax']) {
      expect(Object.prototype.hasOwnProperty.call(body, k)).toBe(false);
    }
    // 共通キー(1つ目)の情報は従来どおり返る=lite でも設定できる。
    expect(body.geminiSet).toBe(true);
  });

  it('★lite の保存は full 側の分析用設定を消さない(空欄=null が届いても無視する)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    writeConfig({ generatorKeys: { openai: 'sk-gen' }, generatorDailyBudget: 300, chromePath: 'C:\\chrome.exe' });
    // UI を隠しても、input が空のまま buildSavePayload に載って null が飛んでくる形を再現する。
    expect(post({ generatorDailyBudget: null, generatorKeys: { openai: null, gemini: null } }).code).toBe(200);
    const raw = readRaw();
    expect(raw.generatorDailyBudget).toBe(300);
    expect(raw.generatorKeys).toEqual({ openai: 'sk-gen' });
    expect(raw.chromePath).toBe('C:\\chrome.exe');   // 既存フィールドも巻き込まない
  });

  it('lite では新しい分析用キー/予算を **設定できない**(入口ごと閉じている)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    writeConfig({ chromePath: 'C:\\chrome.exe' });
    expect(post({ generatorKeys: { openai: 'sk-new' }, generatorDailyBudget: 900 }).code).toBe(200);
    const raw = readRaw();
    expect(raw.generatorKeys).toBeUndefined();
    expect(raw.generatorDailyBudget).toBeUndefined();
  });

  it('★full(未設定)は従来どおり: GET に generator* が載り、保存も効く', () => {
    delete process.env.MONITOR_VARIANT;
    writeConfig({ generatorKeys: { openai: 'sk-gen' }, generatorDailyBudget: 300 });
    const body = get();
    expect(body.generatorKeySources).toBeDefined();
    expect(body.generatorDailyBudget).toBe(300);
    expect(post({ generatorDailyBudget: 900 }).code).toBe(200);
    expect(readRaw().generatorDailyBudget).toBe(900);
  });
});
