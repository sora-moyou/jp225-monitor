import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, resolveGeneratorEnabled } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★分析用サイドカーの有効/無効(既定=無効)を、**既存の設定機構**(config.json + /api/settings)に載せた分の契約。
//
// この設定の存在理由はただ1つ: 分析用は配布物(サイドカー)に同梱されるので、**既定で有効だと
// インストールした瞬間から LLM 予算を食い始める**。だから「明示的に有効化するまで走らない」を
// 設定として持ち、既定は false に倒す。
//
// ★否定対照(この変更を戻すと赤くなること):
//   ・resolveGeneratorEnabled の既定を true にする → 「既定は無効」が赤
//   ・EXPLICIT_PARAM_KEYS / decided から generatorEnabled を外す → 「保存で往復する」が赤
//     (型でも落ちる: settings.ts の _AllConfigKeysClassified がコンパイルエラーになる)
//   ・lite の素通し(analysis 分岐)を外す → 「lite の保存が monitor2 の設定を消さない」が赤

const ORIG = {
  HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, APPDATA: process.env.APPDATA,
  VARIANT: process.env.MONITOR_VARIANT, ENABLED: process.env.GENERATOR_ENABLED,
};

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

describe('/api/settings 分析用の有効/無効(既定=無効)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-genen-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir; process.env.APPDATA = dir;
    delete process.env.MONITOR_VARIANT;
    delete process.env.GENERATOR_ENABLED;
    resetConfigCache();
  });
  afterEach(() => {
    const restore = (name: string, v: string | undefined) => {
      if (v !== undefined) process.env[name] = v; else delete process.env[name];
    };
    restore('HOME', ORIG.HOME); restore('USERPROFILE', ORIG.USERPROFILE); restore('APPDATA', ORIG.APPDATA);
    restore('MONITOR_VARIANT', ORIG.VARIANT); restore('GENERATOR_ENABLED', ORIG.ENABLED);
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★既定は無効。設定ファイルが空でも false(=同梱しても勝手に走り出さない)', () => {
    expect(resolveGeneratorEnabled()).toBe(false);
    expect(get().generatorEnabled).toBe(false);
  });

  it('★true で保存すると有効になり、GET でも true が返る(有効化したら動き出す)', () => {
    expect(post({ generatorEnabled: true }).code).toBe(200);
    expect(readRaw().generatorEnabled).toBe(true);
    expect(resolveGeneratorEnabled()).toBe(true);
    expect(get().generatorEnabled).toBe(true);
  });

  it('★一度有効にしても false で戻せる(戻したら走らない)', () => {
    post({ generatorEnabled: true });
    expect(resolveGeneratorEnabled()).toBe(true);
    post({ generatorEnabled: false });
    expect(readRaw().generatorEnabled).not.toBe(true);
    expect(resolveGeneratorEnabled()).toBe(false);
    expect(get().generatorEnabled).toBe(false);
  });

  it('★他の設定を保存しても分析用の有効/無効は巻き添えにならない(既存値を持ち越す)', () => {
    post({ generatorEnabled: true });
    post({ indicatorsEnabled: false });   // 分析用のフィールドを送らない保存
    expect(resolveGeneratorEnabled()).toBe(true);
  });

  it('env GENERATOR_ENABLED=1 でも有効になる(config が優先)', () => {
    process.env.GENERATOR_ENABLED = '1';
    resetConfigCache();
    expect(resolveGeneratorEnabled()).toBe(true);
    writeConfig({ generatorEnabled: false });
    expect(resolveGeneratorEnabled()).toBe(false);   // config が env に勝つ
  });

  it('★公開版(lite)では応答に出さない(存在しない機構のスイッチを見せない)', () => {
    process.env.MONITOR_VARIANT = 'lite';
    expect(Object.prototype.hasOwnProperty.call(get(), 'generatorEnabled')).toBe(false);
  });

  it('★lite の保存は monitor2 が有効化した設定を消さない(同じ config を共有するため)', () => {
    writeConfig({ generatorEnabled: true });
    process.env.MONITOR_VARIANT = 'lite';
    expect(post({ generatorEnabled: false }).code).toBe(200);
    expect(readRaw().generatorEnabled).toBe(true);
  });
});
