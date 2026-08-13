import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resetConfigCache, LITE_OWNED_KEYS,
  resolveScalpBias, resolveScalpLcFloorYen, resolveScalpLcCeiling, resolveScalpLcHardMax,
  resolveScalpTrendVetoYen, resolveScalpCooldownSec, resolveScalpRangeEnabled,
  resolveScalpBiasDirective, resolveScalpLcCeilingDirective, resolveScalpLcFloorDirective,
  resolveScalpTrendVetoDirective, resolveScalpCooldownDirective, resolveScalpRangeDirective,
  resolveAllNumericParams,
} from './configStore.js';

// ★lite 独立設定: lite(簡易公開版)で UI に露出した 5項目だけを config.lite 名前空間に持ち、
//   monitor2(full)の最上位キーと混ざらないようにする。未設定なら最上位→組み込み既定へフォールバック
//   (バージョンアップで実効設定が黙って変わらないための安全弁)。
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_VARIANT = process.env.MONITOR_VARIANT;
let tmpHome: string;

function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(tmpHome, '.jp225-monitor'), { recursive: true });
  writeFileSync(join(tmpHome, '.jp225-monitor', 'config.json'), JSON.stringify(obj));
  resetConfigCache();
}
const asLite = () => { process.env.MONITOR_VARIANT = 'lite'; };
const asFull = () => { delete process.env.MONITOR_VARIANT; };

describe('configStore: lite 独立名前空間(config.lite)', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'jp225-lite-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    asFull();
    resetConfigCache();
  });
  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
  });

  it('lite に露出する項目だけが LITE_OWNED_KEYS(値5 + 委任モード3。それ以外は最上位のまま)', () => {
    expect([...LITE_OWNED_KEYS].sort()).toEqual([
      'scalpBias', 'scalpBiasSource',
      'scalpLcCeilingSource', 'scalpLcCeilingYen',
      'scalpLcFloorSource', 'scalpLcFloorYen',
      'scalpLcHardMaxEnabled', 'scalpLcHardMaxYen',
    ]);
  });

  // ─── ② フォールバック(バージョンアップで実効値が変わらないこと) ───────────────
  it('★config.lite が無い既存 config を lite で読むと、実効値は従来(最上位)と完全に同じ', () => {
    writeConfig({
      scalpBias: 'short', scalpLcFloorYen: 50, scalpLcCeilingYen: 80,
      scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
    });
    asFull();
    const full = {
      bias: resolveScalpBias(), floor: resolveScalpLcFloorYen(),
      ceiling: resolveScalpLcCeiling(), hard: resolveScalpLcHardMax(),
    };
    asLite();
    expect(resolveScalpBias()).toBe(full.bias);
    expect(resolveScalpLcFloorYen()).toBe(full.floor);
    expect(resolveScalpLcCeiling()).toBe(full.ceiling);
    expect(resolveScalpLcHardMax()).toEqual(full.hard);
    expect(full).toEqual({ bias: 'short', floor: 50, ceiling: 80, hard: { enabled: false, value: 200 } });
  });

  it('config.lite も最上位も無ければ組み込み既定(55/65/159/有効/両方向)', () => {
    writeConfig({});
    asLite();
    expect(resolveScalpBias()).toBe('none');
    expect(resolveScalpLcFloorYen()).toBe(55);
    expect(resolveScalpLcCeiling()).toBe(65);
    expect(resolveScalpLcHardMax()).toEqual({ enabled: true, value: 159 });
  });

  it('config.lite の一部だけ設定なら、残りは最上位へフォールバックする(項目ごと)', () => {
    writeConfig({ scalpLcFloorYen: 50, scalpLcCeilingYen: 80, lite: { scalpLcCeilingYen: 70 } });
    asLite();
    expect(resolveScalpLcCeiling()).toBe(70);   // lite 名前空間
    expect(resolveScalpLcFloorYen()).toBe(50);  // 最上位へフォールバック
  });

  // ─── ① 独立(lite ↔ monitor2) ─────────────────────────────────────────
  it('★config.lite があると lite はそれを使い、full(monitor2)は最上位のまま=互いに独立', () => {
    writeConfig({
      scalpBias: 'long', scalpLcFloorYen: 45, scalpLcCeilingYen: 65,
      scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 150,
      lite: {
        scalpBias: 'short', scalpLcFloorYen: 30, scalpLcCeilingYen: 100,
        scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 250,
      },
    });
    asLite();
    expect(resolveScalpBias()).toBe('short');
    expect(resolveScalpLcFloorYen()).toBe(30);
    expect(resolveScalpLcCeiling()).toBe(100);
    expect(resolveScalpLcHardMax()).toEqual({ enabled: false, value: 250 });
    asFull();
    expect(resolveScalpBias()).toBe('long');
    expect(resolveScalpLcFloorYen()).toBe(45);
    expect(resolveScalpLcCeiling()).toBe(65);
    expect(resolveScalpLcHardMax()).toEqual({ enabled: true, value: 150 });
  });

  it("lite の 'none' / false も明示値として尊重する(最上位を引き継がない)", () => {
    writeConfig({
      scalpBias: 'long', scalpLcHardMaxEnabled: true,
      lite: { scalpBias: 'none', scalpLcHardMaxEnabled: false },
    });
    asLite();
    expect(resolveScalpBias()).toBe('none');
    expect(resolveScalpLcHardMax().enabled).toBe(false);
    asFull();
    expect(resolveScalpBias()).toBe('long');
    expect(resolveScalpLcHardMax().enabled).toBe(true);
  });

  // ─── monitor2(full)の不変性 ──────────────────────────────────────────
  it('★full は config.lite を一切見ない(monitor2 の挙動は不変)', () => {
    writeConfig({ lite: { scalpBias: 'short', scalpLcCeilingYen: 999, scalpLcFloorYen: 21 } });
    asFull();
    expect(resolveScalpBias()).toBe('none');          // 既定(lite は無視)
    expect(resolveScalpLcCeiling()).toBe(65);
    expect(resolveScalpLcFloorYen()).toBe(55);
    expect(resolveAllNumericParams().scalpLcCeilingYen).toBe(65);
  });

  // ─── 委任モード(手動/AI)も lite 独立 ─────────────────────────────────
  it('★委任モード(初期LC下限/最大初期LC/バイアス)も lite 名前空間から解決し、full は最上位のまま', () => {
    writeConfig({
      scalpLcFloorSource: 'ai', scalpLcCeilingSource: 'manual', scalpBiasSource: 'ai',
      lite: { scalpLcFloorSource: 'manual', scalpLcCeilingSource: 'ai', scalpBiasSource: 'manual' },
    });
    asLite();
    expect(resolveScalpLcFloorDirective().mode).toBe('manual');
    expect(resolveScalpLcCeilingDirective().mode).toBe('ai');
    expect(resolveScalpBiasDirective().mode).toBe('manual');
    asFull();
    expect(resolveScalpLcFloorDirective().mode).toBe('ai');
    expect(resolveScalpLcCeilingDirective().mode).toBe('manual');
    expect(resolveScalpBiasDirective().mode).toBe('ai');
  });

  it('★委任モードが lite 未設定なら最上位へフォールバック(既存 config で挙動が変わらない)', () => {
    writeConfig({ scalpLcFloorSource: 'ai', scalpBiasSource: 'ai', lite: { scalpLcCeilingSource: 'ai' } });
    asLite();
    expect(resolveScalpLcFloorDirective().mode).toBe('ai');    // 最上位へフォールバック
    expect(resolveScalpBiasDirective().mode).toBe('ai');       // 最上位へフォールバック
    expect(resolveScalpLcCeilingDirective().mode).toBe('ai');  // lite 名前空間
  });

  it("lite の 'manual' も明示値として尊重する(最上位の 'ai' を引き継がない)", () => {
    writeConfig({ scalpBiasSource: 'ai', lite: { scalpBiasSource: 'manual' } });
    asLite();
    expect(resolveScalpBiasDirective().mode).toBe('manual');
    asFull();
    expect(resolveScalpBiasDirective().mode).toBe('ai');
  });

  // ─── ③ 露出項目以外は名前空間の対象外 ───────────────────────────────
  it('露出項目以外(トレンドveto/クールダウン/レンジ + その委任source)は lite でも最上位から解決する', () => {
    writeConfig({
      scalpTrendVetoYen: 200, scalpCooldownSec: 30, scalpRangeEnabled: true,
      scalpTrendVetoSource: 'ai', scalpCooldownSource: 'ai', scalpRangeSource: 'ai',
      // lite 名前空間に紛れ込んでいても対象外キーは読まない(混入への防御)。
      lite: {
        scalpTrendVetoYen: 1, scalpCooldownSec: 1, scalpRangeEnabled: false,
        scalpTrendVetoSource: 'manual', scalpCooldownSource: 'manual', scalpRangeSource: 'manual',
      } as Record<string, unknown>,
    });
    asLite();
    expect(resolveScalpTrendVetoYen()).toBe(200);
    expect(resolveScalpCooldownSec()).toBe(30);
    expect(resolveScalpRangeEnabled()).toBe(true);
    expect(resolveScalpTrendVetoDirective().mode).toBe('ai');
    expect(resolveScalpCooldownDirective().mode).toBe('ai');
    expect(resolveScalpRangeDirective().mode).toBe('ai');
  });

  // ─── System B との関係 ───────────────────────────────────────────────
  it('B(仮想取引専用)は signalB を最優先し、未設定なら lite の実効値へフォールバックする', () => {
    writeConfig({
      scalpLcCeilingYen: 65, lite: { scalpLcCeilingYen: 100 },
      signalB: { scalpLcFloorYen: 33 },
    });
    asLite();
    expect(resolveScalpLcCeiling('B')).toBe(100);   // signalB 未設定 → lite 実効値
    expect(resolveScalpLcFloorYen('B')).toBe(33);   // signalB 明示値が最優先
    asFull();
    expect(resolveScalpLcCeiling('B')).toBe(65);    // full は最上位へフォールバック(不変)
  });
});
