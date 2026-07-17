import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveShockParams, resolveOpenGuardBars, resolveFlashYen, resetConfigCache,
  resolveScalpLcCeiling, resolveScalpBias, resolveScalpCooldownSec, resolveScalpRangeEnabled,
  resolveScalpTrendVetoYen,
} from './configStore.js';
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

describe('AIエントリー設定 resolvers (scalpLcCeiling / scalpBias)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-scalp-'));
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

  function writeConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(obj), 'utf-8');
    resetConfigCache();
  }

  it('未設定は既定(LC=65 / bias=none / cooldown=90)', () => {
    expect(resolveScalpLcCeiling()).toBe(65);
    expect(resolveScalpBias()).toBe('none');
    expect(resolveScalpCooldownSec()).toBe(90);
  });

  it('config.json の値を反映(LC=90 / bias=long / cooldown=120)', () => {
    writeConfig({ scalpLcCeilingYen: 90, scalpBias: 'long', scalpCooldownSec: 120 });
    expect(resolveScalpLcCeiling()).toBe(90);
    expect(resolveScalpBias()).toBe('long');
    expect(resolveScalpCooldownSec()).toBe(120);
  });

  it('cooldown=0(無効)を反映', () => {
    writeConfig({ scalpCooldownSec: 0 });
    expect(resolveScalpCooldownSec()).toBe(0);
  });

  it('bias が不正値/欠落なら none にフォールバック', () => {
    writeConfig({ scalpBias: 'bogus' });
    expect(resolveScalpBias()).toBe('none');
  });

  it("bias='short' を反映", () => {
    writeConfig({ scalpBias: 'short' });
    expect(resolveScalpBias()).toBe('short');
  });

  it('scalpRangeEnabled 未設定は既定 false(OFF・実験終了 v0.7.53)', () => {
    expect(resolveScalpRangeEnabled()).toBe(false);
  });

  it('scalpRangeEnabled=false を反映', () => {
    writeConfig({ scalpRangeEnabled: false });
    expect(resolveScalpRangeEnabled()).toBe(false);
  });

  it('scalpRangeEnabled=true を反映', () => {
    writeConfig({ scalpRangeEnabled: true });
    expect(resolveScalpRangeEnabled()).toBe(true);
  });

  it('scalpRangeEnabled が非boolean(不正)は既定 false にフォールバック', () => {
    writeConfig({ scalpRangeEnabled: 'yes' });
    expect(resolveScalpRangeEnabled()).toBe(false);
  });

  it('scalpTrendVetoYen 未設定は既定 100', () => {
    expect(resolveScalpTrendVetoYen()).toBe(100);
  });

  it('scalpTrendVetoYen の値を反映(150)', () => {
    writeConfig({ scalpTrendVetoYen: 150 });
    expect(resolveScalpTrendVetoYen()).toBe(150);
  });

  it('scalpTrendVetoYen=0(veto 無効)を反映', () => {
    writeConfig({ scalpTrendVetoYen: 0 });
    expect(resolveScalpTrendVetoYen()).toBe(0);
  });
});
