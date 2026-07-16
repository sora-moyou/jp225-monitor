import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolvePricePollMs, resolveNewsPollMs, resolvePort,
  validateParam, resetConfigCache,
  resolveWebSearchOpenaiModel, DEFAULT_WEB_SEARCH_OPENAI_MODEL,
} from './configStore.js';

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
