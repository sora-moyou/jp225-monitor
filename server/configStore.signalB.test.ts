import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resetConfigCache,
  resolveScalpLcCeiling, resolveScalpLcCeilingDirective,
  resolveScalpBias, resolveScalpBiasDirective,
  resolveScalpRangeEnabled, resolveScalpLcHardMax,
  resolveScalpTrendVetoDirective, resolveScalpLcFloorDirective,
} from './configStore.js';

// ★v0.8.2: System B(signalB)の profile 解決テスト。
//   B は signalB.<knob> を優先し、未設定は A(グローバル)値/source へフォールバックする。
//   ★A(profile 省略)は signalB の有無に関わらず一切影響を受けない(実売買 A の不変性)。
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
let tmpHome: string;

describe('configStore: System B(signalB) profile 解決', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'jp225-signalb-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    resetConfigCache();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    resetConfigCache();
  });
  function writeConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(tmpHome, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(tmpHome, '.jp225-monitor', 'config.json'), JSON.stringify(obj));
    resetConfigCache();
  }

  it('signalB 未設定なら B は A(グローバル)値へフォールバック', () => {
    writeConfig({ scalpLcCeilingYen: 80 });
    expect(resolveScalpLcCeiling('A')).toBe(80);
    expect(resolveScalpLcCeiling('B')).toBe(80);   // フォールバック
    expect(resolveScalpLcCeiling()).toBe(80);      // profile 省略=A
  });

  it('signalB に値があれば B はそれを使い、A は不変', () => {
    writeConfig({ scalpLcCeilingYen: 80, signalB: { scalpLcCeilingYen: 40 } });
    expect(resolveScalpLcCeiling('A')).toBe(80);   // A は signalB を見ない
    expect(resolveScalpLcCeiling()).toBe(80);      // profile 省略も A のまま
    expect(resolveScalpLcCeiling('B')).toBe(40);   // B は signalB
  });

  it('directive の source も B は signalB 優先→未設定は A へフォールバック', () => {
    // A source='ai'、signalB に source 無し → B は A の 'ai' を継ぐ
    writeConfig({ scalpLcCeilingSource: 'ai', scalpLcCeilingYen: 70 });
    expect(resolveScalpLcCeilingDirective('A').mode).toBe('ai');
    expect(resolveScalpLcCeilingDirective('B').mode).toBe('ai');   // フォールバック
    // signalB で B だけ manual に上書き(A は 'ai' のまま)
    writeConfig({ scalpLcCeilingSource: 'ai', scalpLcCeilingYen: 70, signalB: { scalpLcCeilingSource: 'manual', scalpLcCeilingYen: 55 } });
    expect(resolveScalpLcCeilingDirective('A').mode).toBe('ai');
    expect(resolveScalpLcCeilingDirective('A').value).toBe(70);
    expect(resolveScalpLcCeilingDirective('B').mode).toBe('manual');
    expect(resolveScalpLcCeilingDirective('B').value).toBe(55);
  });

  it('bias / range / hardMax も B は独立(未設定=A追従)', () => {
    writeConfig({
      scalpBias: 'long', scalpRangeEnabled: true, scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
      signalB: { scalpBias: 'short', scalpLcHardMaxEnabled: true },
    });
    // A 不変
    expect(resolveScalpBias('A')).toBe('long');
    expect(resolveScalpRangeEnabled('A')).toBe(true);
    expect(resolveScalpLcHardMax('A')).toEqual({ enabled: false, value: 200 });
    // B: bias/hardMaxEnabled は上書き、range/hardMaxValue は A フォールバック
    expect(resolveScalpBias('B')).toBe('short');
    expect(resolveScalpRangeEnabled('B')).toBe(true);                   // フォールバック
    expect(resolveScalpLcHardMax('B')).toEqual({ enabled: true, value: 200 }); // enabled=上書き / value=フォールバック
  });

  it('B が none を明示指定すると A(long)に追従せず none になる', () => {
    writeConfig({ scalpBias: 'long', signalB: { scalpBias: 'none' } });
    expect(resolveScalpBias('A')).toBe('long');
    expect(resolveScalpBias('B')).toBe('none');
  });

  it('未設定時は A/B とも既定値(trendVeto=100 / lcFloor=55)', () => {
    writeConfig({});
    expect(resolveScalpTrendVetoDirective('A').value).toBe(100);
    expect(resolveScalpTrendVetoDirective('B').value).toBe(100);
    expect(resolveScalpLcFloorDirective('A').value).toBe(55);
    expect(resolveScalpLcFloorDirective('B').value).toBe(55);
    expect(resolveScalpLcFloorDirective('B').mode).toBe('manual');   // 既定 manual
  });
});
