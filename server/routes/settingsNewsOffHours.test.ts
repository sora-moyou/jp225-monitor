import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfigCache, resolveNewsOffHoursEnabled, resolveScalpChartVisionMode } from '../configStore.js';
import { getSettingsHandler, postSettingsHandler } from './settings.js';

// ★「取引時間外もニュースを取得」設定の往復を守る。
//   ① 既定は OFF(未設定=現行挙動)。
//   ② 保存すると **実ファイル**(config.json)に載り、読み直し(=再起動相当)でも残る。
//   ③ ★lite で保存しても効く。lite の保存は applyLiteTopLevelGuard が最上位キーを既定で捨てるので、
//      許可一覧に入れ忘れると **チェックしたのに効かない** という無言の失敗になる(この案件の実際の罠)。
//   ④ 解決は variant で分岐しない = lite でも full でも同じ値を読む。

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
/** プロセス再起動の相当物: キャッシュを捨てて実ファイルから読み直す。 */
const restart = (): void => resetConfigCache();
const asLite = () => { process.env.MONITOR_VARIANT = 'lite'; resetConfigCache(); };
const asFull = () => { delete process.env.MONITOR_VARIANT; resetConfigCache(); };

describe('newsOffHoursEnabled(取引時間外もニュースを取得)の保存と解決', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-newsoff-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    asFull();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★既定は OFF(設定ファイルが無くても false)', () => {
    expect(resolveNewsOffHoursEnabled()).toBe(false);
    expect(get().newsOffHoursEnabled).toBe(false);
  });

  it('非boolean が書かれていても false に倒す(冪等・現行挙動を守る)', () => {
    expect(post({ newsOffHoursEnabled: 'true' }).code).toBe(200);   // 文字列は無視=既存(未設定)のまま
    expect(resolveNewsOffHoursEnabled()).toBe(false);
  });

  it('★full: ON を保存 → 実ファイルに載り、再起動しても残る', () => {
    expect(post({ newsOffHoursEnabled: true }).code).toBe(200);
    expect(readRaw().newsOffHoursEnabled).toBe(true);
    restart();
    expect(resolveNewsOffHoursEnabled()).toBe(true);
    expect(get().newsOffHoursEnabled).toBe(true);
  });

  it('OFF に戻せて、再起動後も OFF(false は明示保存 / null は未設定に戻す)', () => {
    post({ newsOffHoursEnabled: true });
    post({ newsOffHoursEnabled: false });
    expect(readRaw().newsOffHoursEnabled).toBe(false);   // 他の boolean トグルと同じ扱い
    restart();
    expect(resolveNewsOffHoursEnabled()).toBe(false);
    post({ newsOffHoursEnabled: null });                 // null=未設定に戻す
    expect('newsOffHoursEnabled' in readRaw()).toBe(false);
    restart();
    expect(resolveNewsOffHoursEnabled()).toBe(false);
  });

  it('★lite: ON を保存 → 実ファイルに載る(lite の最上位ガードに捨てられない)', () => {
    asLite();
    expect(post({ newsOffHoursEnabled: true }).code).toBe(200);
    expect(readRaw().newsOffHoursEnabled).toBe(true);
    restart();
    expect(resolveNewsOffHoursEnabled()).toBe(true);
    expect(get().newsOffHoursEnabled).toBe(true);
  });

  it('★lite で保存した値は full でも同じに読める(解決経路が variant で分岐しない)', () => {
    asLite();
    post({ newsOffHoursEnabled: true });
    asFull();
    expect(resolveNewsOffHoursEnabled()).toBe(true);
    asLite();
    expect(resolveNewsOffHoursEnabled()).toBe(true);
  });

  it('lite で OFF に戻せる(片道切符にしない)', () => {
    asLite();
    post({ newsOffHoursEnabled: true });
    post({ newsOffHoursEnabled: false });
    restart();
    expect(resolveNewsOffHoursEnabled()).toBe(false);
  });

  it('★lite からこの1項目だけ送っても、他の最上位設定は巻き添えで消えない', () => {
    asFull();
    post({ geminiKey: 'AIza-secret', newsPollMs: 30_000, scalpTrendVetoYen: 120 });
    asLite();
    post({ newsOffHoursEnabled: true });
    const raw = readRaw();
    expect(raw.geminiKey).toBe('AIza-secret');
    expect(raw.newsPollMs).toBe(30_000);
    expect(raw.scalpTrendVetoYen).toBe(120);
    expect(raw.newsOffHoursEnabled).toBe(true);
  });
});

// ─── ★v0.9.70: 「AIにチャート画像を送る」(scalpChartVisionMode)の保存と解決 ──────────────
//
//  ★同じ罠(lite の最上位ガード)を踏まないことを、**実ファイルの往復** で固定する。
//   この設定は lite の画面にも出しており、しかも直接お金(有料プロバイダの課金)に効くので、
//   「変えて保存したのに無音で元へ戻る」が最悪の失敗になる。
//  ★既定は必ず off(送らない)。未設定/不正値でも off に倒れること=課金は fail-safe でなければならない。
describe('scalpChartVisionMode(AIにチャート画像を送る)の保存と解決', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-chartvision-'));
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    asFull();
  });
  afterEach(() => {
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_VARIANT !== undefined) process.env.MONITOR_VARIANT = ORIG_VARIANT; else delete process.env.MONITOR_VARIANT;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★既定は off(設定ファイルが無くても送らない)', () => {
    expect(resolveScalpChartVisionMode()).toBe('off');
    expect(get().scalpChartVisionMode).toBe('off');
  });

  it("'ab' を保存 → 実ファイルに載り、再読込でも残る", () => {
    expect(post({ scalpChartVisionMode: 'ab' }).code).toBe(200);
    expect(readRaw().scalpChartVisionMode).toBe('ab');
    restart();
    expect(resolveScalpChartVisionMode()).toBe('ab');
  });

  it("'off' に戻すと未設定で保存される(既定へ戻る)", () => {
    post({ scalpChartVisionMode: 'ab' });
    expect(post({ scalpChartVisionMode: 'off' }).code).toBe(200);
    expect(readRaw().scalpChartVisionMode).toBeUndefined();
    restart();
    expect(resolveScalpChartVisionMode()).toBe('off');
  });

  it('★知らない値は off に倒れる(課金が発生する側へ倒れる既定を作らない)', () => {
    post({ scalpChartVisionMode: 'full' });
    restart();
    expect(resolveScalpChartVisionMode()).toBe('off');
    post({ scalpChartVisionMode: 'AB' });   // 大文字は受理する(寛容)
    restart();
    expect(resolveScalpChartVisionMode()).toBe('ab');
  });

  it('★lite: 保存が最上位ガードに捨てられない(画面に出している以上、書けなければ無音の失敗)', () => {
    asLite();
    expect(post({ scalpChartVisionMode: 'ab' }).code).toBe(200);
    expect(readRaw().scalpChartVisionMode).toBe('ab');
    restart();
    expect(resolveScalpChartVisionMode()).toBe('ab');
    expect(get().scalpChartVisionMode).toBe('ab');
  });
});
