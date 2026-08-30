// ★GET /api/settings が TP(利確)の3キーを返すこと。
//   POST は既に対応済みだったが GET に出ていなかった=設定画面が「いまの値」を読めなかった。
//   ここは **GET の出力だけ** を見る(保存の規約は settingsSignalB / settingsLite 側が持つ)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_VARIANT = process.env.MONITOR_VARIANT;
let dir: string;

function mockRes() {
  const out: { code: number; body: Record<string, unknown> } = { code: 200, body: {} };
  return {
    out,
    status(c: number) { out.code = c; return this; },
    json(b: Record<string, unknown>) { out.body = b; return this; },
  };
}
function get(): Record<string, unknown> {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSettingsHandler({} as any, res as any);
  return res.out.body;
}
function post(body: Record<string, unknown>) {
  const res = mockRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postSettingsHandler({ body } as any, res as any);
  return res.out;
}
function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
  writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(obj, null, 2));
  resetConfigCache();
}

describe('GET /api/settings が TP(利確)の3キーを返す', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-settp-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    delete process.env.MONITOR_VARIANT;
    resetConfigCache();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未設定なら既定(使う=true / AI委任 / 80円)が返る', () => {
    writeConfig({});
    const g = get();
    expect(g.scalpTpEnabled).toBe(true);
    expect(g.scalpTpWidthSource).toBe('ai');   // ★他の source と違い既定は 'ai'
    expect(g.scalpTpWidthYen).toBe(80);
  });

  it('保存済みの値がそのまま返る(手動 / 幅 40 / TP無効)', () => {
    writeConfig({ scalpTpEnabled: false, scalpTpWidthSource: 'manual', scalpTpWidthYen: 40 });
    const g = get();
    expect(g.scalpTpEnabled).toBe(false);
    expect(g.scalpTpWidthSource).toBe('manual');
    expect(g.scalpTpWidthYen).toBe(40);
  });

  it('★POST → GET が繋がる(保存した値を設定画面が読み直せる)', () => {
    writeConfig({});
    expect(post({ scalpTpEnabled: true, scalpTpWidthSource: 'manual', scalpTpWidthYen: 35 }).code).toBe(200);
    const g = get();
    expect(g.scalpTpEnabled).toBe(true);
    expect(g.scalpTpWidthSource).toBe('manual');
    expect(g.scalpTpWidthYen).toBe(35);
  });

  it('★3キーが応答から欠落していない(キーの存在そのものを固定する)', () => {
    writeConfig({});
    const g = get();
    for (const k of ['scalpTpEnabled', 'scalpTpWidthSource', 'scalpTpWidthYen']) {
      expect(Object.prototype.hasOwnProperty.call(g, k), k).toBe(true);
    }
  });
});
