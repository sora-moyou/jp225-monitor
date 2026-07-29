import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache } from '../configStore.js';
import { postSettingsHandler } from './settings.js';

// ★保存で設定が消えない保証: postSettingsHandler が組み立てる next は「既存 config を土台にして、
//   明示的に扱いを決めたフィールドだけを上書きする」構造でなければならない。
//   全フィールド明示列挙だと、列挙から漏れたフィールド(実害: chromePath)が保存のたびに黙って消える。
//   同時に、従来の「null=既定に戻す(キーごと落とす)」規約と秘密フィールドの規約が不変であることも固定する。
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
const configPath = () => join(dir, '.jp225-monitor', 'config.json');
function readRaw(): Record<string, unknown> {
  return existsSync(configPath()) ? JSON.parse(readFileSync(configPath(), 'utf-8')) : {};
}
function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(obj, null, 2));
  resetConfigCache();
}

// 設定画面が実際に送る形に近い「ふつうの保存」ボディ(UIのある項目だけ)。
const FORM_BODY = {
  scalpLcFloorYen: 45, scalpLcCeilingYen: 65, scalpLcHardMaxYen: 150,
  scalpLcHardMaxEnabled: true, scalpBias: 'none',
  scalpTrendVetoYen: 100, scalpCooldownSec: 90,
  scalpRangeEnabled: false, dotenEnabled: false, rangeReevalEnabled: true,
  indicatorsEnabled: true, aiTechnicalEnabled: true, scalpChartFallbackText: true,
  pricePollMs: 2000, newsPollMs: 60_000, port: 3000, cooldownMin: 15,
};

describe('/api/settings 保存で未列挙フィールドを失わない', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-setkeep-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    delete process.env.MONITOR_VARIANT;   // full(monitor2)を既定にする
    resetConfigCache();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★chromePath(設定画面にUIが無い・手編集のみ)は保存しても消えない', () => {
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    writeConfig({ chromePath: chrome, geminiKey: 'AIza-secret' });
    expect(post(FORM_BODY).code).toBe(200);
    expect(readRaw().chromePath).toBe(chrome);
  });

  it('★UserConfig に足しただけで保存経路に載せ忘れたフィールドも消えない(構造の保証)', () => {
    // 「将来 UserConfig にフィールドを増やしたとき」の代理。既存 config にある未知キーは持ち越す。
    writeConfig({ chromePath: 'C:\\chrome.exe', futureKnobYen: 42, futureNested: { a: 1 } });
    expect(post(FORM_BODY).code).toBe(200);
    const raw = readRaw();
    expect(raw.futureKnobYen).toBe(42);
    expect(raw.futureNested).toEqual({ a: 1 });
  });

  it('★連続保存でも消えない(2回目・3回目で落ちないこと)', () => {
    writeConfig({ chromePath: 'C:\\chrome.exe' });
    post(FORM_BODY);
    post(FORM_BODY);
    post({ ...FORM_BODY, scalpLcFloorYen: 50 });
    expect(readRaw().chromePath).toBe('C:\\chrome.exe');
  });

  it('★400(範囲外)で拒否したときも config は一切書き換わらない', () => {
    writeConfig({ chromePath: 'C:\\chrome.exe', scalpLcFloorYen: 50 });
    const before = readRaw();
    expect(post({ ...FORM_BODY, scalpLcFloorYen: 5 }).code).toBe(400);   // min=20
    expect(readRaw()).toEqual(before);
  });

  it('既定値に戻す(null)は従来どおりキーごと落ちる=数値/真偽/委任source', () => {
    writeConfig({
      chromePath: 'C:\\chrome.exe',
      scalpLcFloorYen: 50, scalpTrendVetoYen: 120, cooldownMin: 30,
      dotenEnabled: true, scalpRangeEnabled: true, scalpLcHardMaxEnabled: false,
      scalpBiasSource: 'ai', scalpBias: 'long',
      basedataSaveDir: 'C:\\dl',
    });
    expect(post({
      scalpLcFloorYen: null, scalpTrendVetoYen: null, cooldownMin: null,
      dotenEnabled: null, scalpRangeEnabled: null, scalpLcHardMaxEnabled: null,
      scalpBiasSource: 'manual', scalpBias: 'none',
      basedataSaveDir: '',
    }).code).toBe(200);
    const raw = readRaw();
    // JSON 直列化で undefined はキーごと落ちる=resolver が組み込み既定へフォールバックする。
    for (const k of ['scalpLcFloorYen', 'scalpTrendVetoYen', 'cooldownMin', 'dotenEnabled',
      'scalpRangeEnabled', 'scalpLcHardMaxEnabled', 'scalpBiasSource', 'scalpBias', 'basedataSaveDir']) {
      expect(Object.prototype.hasOwnProperty.call(raw, k)).toBe(false);
    }
    // リセットの巻き添えで未列挙フィールドが消えないこと。
    expect(raw.chromePath).toBe('C:\\chrome.exe');
  });

  it('秘密フィールドの規約は不変(空欄=変更なし / 送らない=変更なし)', () => {
    writeConfig({
      chromePath: 'C:\\chrome.exe',
      geminiKey: 'AIza-1', openaiKey: 'sk-1', basedataPass: 'pw', githubToken: 'ghp_1',
    });
    expect(post({ ...FORM_BODY, geminiKey: '', openaiKey: 'sk-2' }).code).toBe(200);
    const raw = readRaw();
    expect(raw.geminiKey).toBe('AIza-1');     // 空欄=変更なし
    expect(raw.openaiKey).toBe('sk-2');       // 実値=上書き
    expect(raw.basedataPass).toBe('pw');      // 未送信=変更なし
    expect(raw.githubToken).toBe('ghp_1');
  });

  it('signalB / lite の名前空間は従来どおり(未送信=保持)', () => {
    writeConfig({
      chromePath: 'C:\\chrome.exe',
      signalB: { scalpLcFloorYen: 30, scalpBiasSource: 'ai' },
      lite: { scalpBias: 'short', scalpLcFloorYen: 30 },
    });
    expect(post(FORM_BODY).code).toBe(200);   // signalB 未送信 / full なので lite は触らない
    const raw = readRaw();
    expect(raw.signalB).toEqual({ scalpLcFloorYen: 30, scalpBiasSource: 'ai' });
    expect(raw.lite).toEqual({ scalpBias: 'short', scalpLcFloorYen: 30 });
    expect(raw.chromePath).toBe('C:\\chrome.exe');
  });

  it('★lite で保存しても chromePath を含む最上位キーは 1つも変わらない', () => {
    writeConfig({
      chromePath: 'C:\\chrome.exe', futureKnobYen: 7,
      scalpBias: 'long', scalpLcFloorYen: 50, scalpLcCeilingYen: 80,
      scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
      scalpTrendVetoYen: 120, scalpCooldownSec: 60,
    });
    const before = readRaw();
    process.env.MONITOR_VARIANT = 'lite';
    expect(post({
      scalpBias: 'short', scalpLcFloorYen: 55, scalpLcCeilingYen: 80,
      scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
      scalpTrendVetoYen: 120, scalpCooldownSec: 60,
    }).code).toBe(200);
    const after = readRaw();
    const { lite: liteAfter, ...topAfter } = after;
    expect(topAfter).toEqual(before);   // 最上位は完全据え置き(chromePath / 未知キーも含む)
    expect(liteAfter).toEqual({
      scalpBias: 'short', scalpLcFloorYen: 55, scalpLcCeilingYen: 80,
      scalpLcHardMaxEnabled: false, scalpLcHardMaxYen: 200,
    });
  });
});
