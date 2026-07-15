import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveShockParams, resolveOpenGuardBars, resolveFlashYen, resetConfigCache } from './configStore.js';
import { DEFAULT_SHOCK_PARAMS } from './shockDetector.js';

// configStore は os.homedir() (Windowsは USERPROFILE, Unixは HOME) /.jp225-monitor/config.json を読む。
// 実ユーザーの config を読まないよう、HOME と USERPROFILE の両方を一時dirへ差し替える
// (configStore.test.ts と同じ隔離手法)。
describe('shock param resolvers', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-resolv-'));
    origHome = process.env.HOME;
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir;
    process.env.USERPROFILE = dir;
    resetConfigCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns defaults when config is empty', () => {
    const p = resolveShockParams();
    expect(p.shock1).toBe(DEFAULT_SHOCK_PARAMS.shock1);       // 50
    expect(p.accelTh).toBe(DEFAULT_SHOCK_PARAMS.accelTh);     // 10
    expect(p.scoreNeed).toBe(5); // 厳選(価格変動アラート絞り込み): PARAM_BOUNDS 既定=5(旧4)。resolveShockParams は PARAM_BOUNDS が源で DEFAULT_SHOCK_PARAMS とは別。
    expect(resolveOpenGuardBars()).toBe(3);
    expect(resolveFlashYen()).toBe(80);
  });

  it('reflects config.json values', () => {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'),
      JSON.stringify({ shock1Yen: 90, shockAccelYen: 5, openGuardBars: 1, flashYen: 120 }), 'utf-8');
    resetConfigCache();
    const p = resolveShockParams();
    expect(p.shock1).toBe(90);
    expect(p.accelTh).toBe(5);
    expect(resolveOpenGuardBars()).toBe(1);
    expect(resolveFlashYen()).toBe(120);
  });
});
