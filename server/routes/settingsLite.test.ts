import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★lite 独立設定: lite で保存したら config.lite だけが変わり、最上位(monitor2 用)は 1つも変わらないこと。
//   full で保存したら config.lite は変わらないこと。GET は実行中 variant の実効値を返すこと。
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
const asLite = () => { process.env.MONITOR_VARIANT = 'lite'; };
const asFull = () => { delete process.env.MONITOR_VARIANT; };

// lite の UI(🎛️)が実際に送る body を GET の実効値から組み立てる。web の buildSavePayload と同様、
// 画面に出していない項目(トレンドveto/クールダウン/レンジ/各トグル/委任source/System B)も往復させる。
function liteFormBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const g = get();
  return {
    scalpBias: g.scalpBias, scalpLcFloorYen: g.scalpLcFloorYen, scalpLcCeilingYen: g.scalpLcCeilingYen,
    scalpLcHardMaxEnabled: g.scalpLcHardMaxEnabled, scalpLcHardMaxYen: g.scalpLcHardMaxYen,
    scalpCooldownSec: g.scalpCooldownSec, scalpTrendVetoYen: g.scalpTrendVetoYen,
    scalpRangeEnabled: g.scalpRangeEnabled, dotenEnabled: g.dotenEnabled,
    rangeReevalEnabled: g.rangeReevalEnabled, indicatorsEnabled: g.indicatorsEnabled,
    aiTechnicalEnabled: g.aiTechnicalEnabled, scalpChartFallbackText: g.scalpChartFallbackText,
    basedataAutoPublish: g.basedataAutoPublish,
    scalpBiasSource: g.scalpBiasSource, scalpLcCeilingSource: g.scalpLcCeilingSource,
    scalpLcFloorSource: g.scalpLcFloorSource, scalpTrendVetoSource: g.scalpTrendVetoSource,
    scalpCooldownSource: g.scalpCooldownSource, scalpRangeSource: g.scalpRangeSource,
    ...over,
  };
}

// 真偽トグルは既定値も明示保存しておく(未設定→既定の明示化はどの variant でも起きる現行仕様で、
// lite 独立性の検証とは別軸なので、前後を厳密比較できるよう最初から全て埋めておく)。
const BASE = {
  scalpBias: 'long', scalpLcFloorYen: 50, scalpLcCeilingYen: 80,
  scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
  scalpTrendVetoYen: 120, scalpCooldownSec: 60, scalpRangeEnabled: true,
  dotenEnabled: false, rangeReevalEnabled: true, indicatorsEnabled: true,
  aiTechnicalEnabled: true, scalpChartFallbackText: true, basedataAutoPublish: false,
  scalpBiasSource: 'ai', geminiKey: 'AIza-secret',
};

describe('/api/settings の lite 独立保存', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-setlite-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    asFull();
    resetConfigCache();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★lite で保存すると最上位キーは 1つも変わらず、lite 配下だけが変わる', () => {
    writeConfig(BASE);
    const before = readRaw();
    asLite();
    expect(post(liteFormBody({ scalpLcFloorYen: 55, scalpBias: 'short' })).code).toBe(200);
    const after = readRaw();
    // 最上位は完全に据え置き(lite キーの追加を除いて前後一致)。
    const { lite: liteAfter, ...topAfter } = after;
    const { lite: _liteBefore, ...topBefore } = before;
    expect(topAfter).toEqual(topBefore);
    expect(liteAfter).toEqual({
      scalpLcFloorYen: 55, scalpLcCeilingYen: 80, scalpLcHardMaxYen: 200,
      scalpBias: 'short', scalpLcHardMaxEnabled: false,
      scalpLcFloorSource: 'manual', scalpLcCeilingSource: 'manual', scalpBiasSource: 'ai',
    });
  });

  it('★lite で保存しても、画面に出していない設定は lite 名前空間に混入しない', () => {
    writeConfig(BASE);
    asLite();
    post(liteFormBody({ scalpLcCeilingYen: 90 }));
    const lite = readRaw().lite as Record<string, unknown>;
    expect(Object.keys(lite).sort()).toEqual([
      'scalpBias', 'scalpBiasSource',
      'scalpLcCeilingSource', 'scalpLcCeilingYen',
      'scalpLcFloorSource', 'scalpLcFloorYen',
      'scalpLcHardMaxEnabled', 'scalpLcHardMaxYen',
    ]);
    // トレンドveto/クールダウン/レンジ は最上位のまま(値も不変)。
    const raw = readRaw();
    expect(raw.scalpTrendVetoYen).toBe(120);
    expect(raw.scalpCooldownSec).toBe(60);
    expect(raw.scalpRangeEnabled).toBe(true);
    // ★lite に露出した委任source も最上位は据え置き(BASE の 'ai' のまま)。
    expect(raw.scalpBiasSource).toBe('ai');
  });

  // ─── ★委任モード(手動/AI)も lite 独立 ────────────────────────────────
  it('★lite で AI委任 に切り替えて保存 → source は config.lite にだけ入り、最上位の source は不変', () => {
    writeConfig(BASE);
    asLite();
    const before = readRaw();
    expect(post(liteFormBody({ scalpLcFloorSource: 'ai', scalpBiasSource: 'manual' })).code).toBe(200);
    const after = readRaw();
    // 最上位の source は 1つも変わらない(BASE の scalpBiasSource:'ai' が保たれる)。
    expect(after.scalpLcFloorSource).toBe(before.scalpLcFloorSource);   // 未設定のまま
    expect(after.scalpBiasSource).toBe('ai');
    expect(after.scalpLcCeilingSource).toBe(before.scalpLcCeilingSource);
    const lite = after.lite as Record<string, unknown>;
    expect(lite.scalpLcFloorSource).toBe('ai');
    expect(lite.scalpBiasSource).toBe('manual');       // 'manual' も明示保存(最上位の 'ai' を引き継がない)
    expect(lite.scalpLcCeilingSource).toBe('manual');
  });

  it('★lite で AI委任 にしても full(monitor2)の実効 source は変わらない', () => {
    writeConfig(BASE);
    asLite();
    post(liteFormBody({ scalpLcFloorSource: 'ai', scalpLcCeilingSource: 'ai', scalpBiasSource: 'manual' }));
    asFull();
    const f = get();
    expect(f.scalpLcFloorSource).toBe('manual');   // 最上位は未設定=既定 manual のまま
    expect(f.scalpLcCeilingSource).toBe('manual');
    expect(f.scalpBiasSource).toBe('ai');          // BASE のまま
    asLite();
    const l = get();
    expect(l.scalpLcFloorSource).toBe('ai');
    expect(l.scalpLcCeilingSource).toBe('ai');
    expect(l.scalpBiasSource).toBe('manual');
  });

  it('★config.lite に source が無い既存 config なら lite の実効 source は従来どおり(フォールバック)', () => {
    writeConfig(BASE);
    asFull();
    const f = get();
    asLite();
    const l = get();
    for (const k of ['scalpLcFloorSource', 'scalpLcCeilingSource', 'scalpBiasSource']) {
      expect(l[k]).toEqual(f[k]);
    }
    expect(l.scalpBiasSource).toBe('ai');
  });

  it('lite の委任モード変更は、画面に出していない委任source(トレンドveto等)を最上位で書き換えない', () => {
    writeConfig({ ...BASE, scalpTrendVetoSource: 'ai', scalpCooldownSource: 'ai' });
    asLite();
    post(liteFormBody({ scalpBiasSource: 'ai' }));
    const raw = readRaw();
    expect(raw.scalpTrendVetoSource).toBe('ai');
    expect(raw.scalpCooldownSource).toBe('ai');
    expect((raw.lite as Record<string, unknown>).scalpTrendVetoSource).toBeUndefined();
    expect((raw.lite as Record<string, unknown>).scalpCooldownSource).toBeUndefined();
  });

  it('★full で保存しても config.lite は変わらない(monitor2 は lite を触らない)', () => {
    writeConfig({ ...BASE, lite: { scalpBias: 'short', scalpLcFloorYen: 30, scalpLcCeilingYen: 100 } });
    asFull();
    expect(post({ scalpLcFloorYen: 45, scalpLcCeilingYen: 65, scalpBias: 'none', scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 150 }).code).toBe(200);
    const raw = readRaw();
    expect(raw.lite).toEqual({ scalpBias: 'short', scalpLcFloorYen: 30, scalpLcCeilingYen: 100 });
    // full 側は従来どおり最上位が書き換わる。
    expect(raw.scalpLcFloorYen).toBe(45);
    expect(raw.scalpLcCeilingYen).toBe(65);
    expect(raw.scalpBias).toBeUndefined();   // 'none' は既定=未設定で保存(現行仕様のまま)
  });

  it('★lite で値を変えても full 側の実効値は変わらない(独立の実証)', () => {
    writeConfig(BASE);
    asLite();
    post(liteFormBody({ scalpLcCeilingYen: 120, scalpBias: 'short' }));
    asFull();
    const g = get();
    expect(g.scalpLcCeilingYen).toBe(80);
    expect(g.scalpBias).toBe('long');
    expect(g.scalpLcFloorYen).toBe(50);
    asLite();
    const l = get();
    expect(l.scalpLcCeilingYen).toBe(120);
    expect(l.scalpBias).toBe('short');
  });

  it('★config.lite が無い既存 config で GET すると lite の実効値は full と同一(フォールバック)', () => {
    writeConfig(BASE);
    asFull();
    const f = get();
    asLite();
    const l = get();
    for (const k of ['scalpBias', 'scalpLcFloorYen', 'scalpLcCeilingYen', 'scalpLcHardMaxEnabled', 'scalpLcHardMaxYen']) {
      expect(l[k]).toEqual(f[k]);
    }
  });

  it('lite 保存後の GET は lite の実効値を返す(往復)', () => {
    writeConfig(BASE);
    asLite();
    post(liteFormBody({ scalpLcFloorYen: 35, scalpLcHardMaxEnabled: true, scalpLcHardMaxYen: 111 }));
    const g = get();
    expect(g.scalpLcFloorYen).toBe(35);
    expect(g.scalpLcHardMaxEnabled).toBe(true);
    expect(g.scalpLcHardMaxYen).toBe(111);
  });

  it('lite でも API キー等の非対象フィールドは従来どおり最上位に保存される', () => {
    writeConfig(BASE);
    asLite();
    post(liteFormBody({ openaiKey: 'sk-new' }));
    const raw = readRaw();
    expect(raw.openaiKey).toBe('sk-new');
    expect(raw.geminiKey).toBe('AIza-secret');   // 空欄未送信=変更なし
    expect((raw.lite as Record<string, unknown>).openaiKey).toBeUndefined();
  });

  // ★実測(新規インストールの lite で「保存」を1回押しただけ)で、画面に無い項目が最上位へ
  //   「その時の既定値」で焼き付いていた。値は当時の既定と同じなので即時の挙動は変わらないが、
  //   将来リリースで既定を変えても、その機だけ古い値のまま無音で走り続ける。
  it('★新規 config の lite で保存しても、最上位に画面外のキーが増えない(既定の焼き付き防止)', () => {
    writeConfig({ pricePollMs: 2000, newsPollMs: 60000, port: 3000, cooldownMin: 15 });
    const before = Object.keys(readRaw()).sort();
    asLite();
    expect(post(liteFormBody()).code).toBe(200);
    const after = Object.keys(readRaw()).sort();
    // 増えてよいのは lite 名前空間だけ。scalpRangeEnabled / dotenEnabled / indicatorsEnabled …は入らない。
    expect(after).toEqual([...before, 'lite'].sort());
  });

  it('★lite の保存は最上位の数値(ポーリング/クールダウン等)も書き換えない=再起動も要求しない', () => {
    writeConfig({ ...BASE, pricePollMs: 2000, cooldownMin: 15, port: 3000 });
    asLite();
    const r = post(liteFormBody({ pricePollMs: 9000, cooldownMin: 45, port: 3999 }));
    expect(r.code).toBe(200);
    expect(r.body.portRequiresRestart).toBe(false);
    const raw = readRaw();
    expect(raw.pricePollMs).toBe(2000);
    expect(raw.cooldownMin).toBe(15);
    expect(raw.port).toBe(3000);
  });

  it('★lite でも「画面にある」API キー欄とモデル欄は最上位へ書ける(消去=null も含む)', () => {
    writeConfig({ ...BASE, groqKey: 'gsk-old', geminiModel: 'old-model' });
    asLite();
    expect(post(liteFormBody({ groqKey: null, geminiModel: 'gemini-3-pro' })).code).toBe(200);
    const raw = readRaw();
    expect(raw.groqKey).toBeUndefined();          // 消去できる
    expect(raw.geminiModel).toBe('gemini-3-pro'); // モデル欄も lite の画面にある
  });

  it('★full の保存は従来どおり全キーを最上位へ書ける(lite の関門は full に効かない)', () => {
    writeConfig({});
    asFull();
    expect(post({
      scalpRangeEnabled: true, dotenEnabled: true, indicatorsEnabled: false,
      scalpCooldownSec: 45, scalpTrendVetoYen: 130, basedataAutoPublish: true,
      pricePollMs: 4000,
    }).code).toBe(200);
    const raw = readRaw();
    expect(raw.scalpRangeEnabled).toBe(true);
    expect(raw.dotenEnabled).toBe(true);
    expect(raw.indicatorsEnabled).toBe(false);
    expect(raw.scalpCooldownSec).toBe(45);
    expect(raw.scalpTrendVetoYen).toBe(130);
    expect(raw.basedataAutoPublish).toBe(true);
    expect(raw.pricePollMs).toBe(4000);
  });

  it('lite で範囲外の値は 400 で拒否し、config は書き換わらない', () => {
    writeConfig(BASE);
    asLite();
    const before = readRaw();
    const r = post(liteFormBody({ scalpLcFloorYen: 5 }));   // min=20
    expect(r.code).toBe(400);
    expect(readRaw()).toEqual(before);
  });
});
