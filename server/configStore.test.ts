import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import {
  resolvePricePollMs, resolveNewsPollMs, resolvePort,
  validateParam, resetConfigCache, resolveApiKey,
  resolveWebSearchOpenaiModel, DEFAULT_WEB_SEARCH_OPENAI_MODEL,
  resolveBasedataSaveDir, loadConfig, saveConfig,
} from './configStore.js';
import { LLM_PROVIDERS } from './config.js';

// configStore は homedir() を内部で呼ぶ。HOME / USERPROFILE を一時 dir に差し替えてテストする
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_PORT = process.env.PORT;
let tmpHome: string;

describe('configStore resolvers', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'jp225-test-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.PORT;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_PORT !== undefined) process.env.PORT = ORIG_PORT; else delete process.env.PORT;
    resetConfigCache();
  });

  function writeFileConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(tmpHome, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(tmpHome, '.jp225-monitor', 'config.json'), JSON.stringify(obj));
    resetConfigCache();
  }

  it('resolvePricePollMs returns default (2000) when no config', () => {
    expect(resolvePricePollMs()).toBe(2000);
  });

  it('resolvePricePollMs reads config.json when set', () => {
    writeFileConfig({ pricePollMs: 5000 });
    expect(resolvePricePollMs()).toBe(5000);
  });

  it('resolveNewsPollMs returns default (60000) when no config', () => {
    expect(resolveNewsPollMs()).toBe(60_000);
  });

  it('resolveNewsPollMs reads config.json when set', () => {
    writeFileConfig({ newsPollMs: 30000 });
    expect(resolveNewsPollMs()).toBe(30_000);
  });

  it('resolvePort: env PORT overrides default but config overrides env', () => {
    process.env.PORT = '4000';
    resetConfigCache();
    expect(resolvePort()).toBe(4000);

    writeFileConfig({ port: 5000 });
    expect(resolvePort()).toBe(5000);
  });

  it('saveConfig はバックアップ(config.json.bak)も書く', () => {
    saveConfig({ geminiKey: 'k1', dotenEnabled: true });
    const bak = join(tmpHome, '.jp225-monitor', 'config.json.bak');
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, 'utf-8'))).toMatchObject({ geminiKey: 'k1', dotenEnabled: true });
  });

  it('config.json が破損しても .bak から復元して設定を失わない', () => {
    saveConfig({ geminiKey: 'good', scalpBias: 'long' });
    // 主ファイルを壊す(空/半端書き込みを模擬)。
    writeFileSync(join(tmpHome, '.jp225-monitor', 'config.json'), '{ broken', 'utf-8');
    resetConfigCache();
    expect(loadConfig()).toMatchObject({ geminiKey: 'good', scalpBias: 'long' });
  });

  it('config.json が欠落しても .bak から復元する', () => {
    saveConfig({ openaiKey: 'ok' });
    rmSync(join(tmpHome, '.jp225-monitor', 'config.json'), { force: true });
    resetConfigCache();
    expect(loadConfig()).toMatchObject({ openaiKey: 'ok' });
  });

  it('resolveBasedataSaveDir defaults to ~/Downloads when unset', () => {
    expect(resolveBasedataSaveDir()).toBe(join(tmpHome, 'Downloads'));
  });

  it('resolveBasedataSaveDir uses config value when set', () => {
    writeFileConfig({ basedataSaveDir: 'D:/synced/basedata' });
    expect(resolveBasedataSaveDir()).toBe('D:/synced/basedata');
  });

  it('validateParam returns null for valid range', () => {
    expect(validateParam('pricePollMs', 5000)).toBeNull();
    expect(validateParam('newsPollMs', 30000)).toBeNull();
    expect(validateParam('port', 3000)).toBeNull();
  });

  it('validateParam returns error message for out-of-range', () => {
    expect(validateParam('pricePollMs', 100)).toMatch(/pricePollMs/);
    expect(validateParam('pricePollMs', 999999)).toMatch(/pricePollMs/);
    expect(validateParam('port', 100)).toMatch(/port/);
    expect(validateParam('port', 99999)).toMatch(/port/);
  });

  it('kimi is placed after the free tiers (gemini/groq) and before paid openai', () => {
    const names = LLM_PROVIDERS.map(p => p.name);
    const iGemini = names.indexOf('gemini');
    const iGroq = names.indexOf('groq');
    const iKimi = names.indexOf('kimi');
    const iOpenai = names.indexOf('openai');
    expect(iKimi).toBeGreaterThan(iGemini);
    expect(iKimi).toBeGreaterThan(iGroq);
    expect(iKimi).toBeLessThan(iOpenai);
  });

  it("resolveApiKey('kimi') reads config.kimiKey, then falls back to env KIMI_API_KEY", () => {
    const ORIG = process.env.KIMI_API_KEY;
    try {
      // config.json 優先
      writeFileConfig({ kimiKey: '  sk-from-config  ' });
      expect(resolveApiKey('kimi')).toBe('sk-from-config');
      // config 無し → env fallback
      delete process.env.KIMI_API_KEY;
      writeFileConfig({});
      process.env.KIMI_API_KEY = '  sk-from-env  ';
      resetConfigCache();
      expect(resolveApiKey('kimi')).toBe('sk-from-env');
    } finally {
      if (ORIG !== undefined) process.env.KIMI_API_KEY = ORIG; else delete process.env.KIMI_API_KEY;
    }
  });

  it('resolveWebSearchOpenaiModel returns default when unset', () => {
    expect(resolveWebSearchOpenaiModel()).toBe(DEFAULT_WEB_SEARCH_OPENAI_MODEL);
    expect(DEFAULT_WEB_SEARCH_OPENAI_MODEL).toBe('gpt-4o-mini-search-preview');
  });

  it('resolveWebSearchOpenaiModel reads config.json when set (trims); blank falls back to default', () => {
    writeFileConfig({ webSearchOpenaiModel: '  gpt-4o-search-preview  ' });
    expect(resolveWebSearchOpenaiModel()).toBe('gpt-4o-search-preview');
    writeFileConfig({ webSearchOpenaiModel: '   ' });
    expect(resolveWebSearchOpenaiModel()).toBe(DEFAULT_WEB_SEARCH_OPENAI_MODEL);
  });
});
