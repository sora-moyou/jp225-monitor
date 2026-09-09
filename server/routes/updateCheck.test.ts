import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseUpdateCheckRequest, recordUpdateCheck } from './updateCheck.js';
import { UPDATE_CHECK_KEY, UPDATE_CHECK_STATUS_KEY } from '../db/updateCheckHeartbeat.js';
import { getMeta } from '../db/store.js';
import type { UpdaterProbe } from '../updater/probe.js';

// POST /api/update-check — 更新チェックの結末の記録。
// ★実ファイル SQLite で通す(:memory: だと「本当にファイルに残るか」を見ていない)。

const URL_ = 'https://github.com/sora-moyou/jp225-monitor2-releases/releases/latest/download/latest.json';
const probeOk = (version: string): UpdaterProbe => ({ url: URL_, ok: true, httpStatus: 200, version, error: null, ms: 250 });
const probeFail = (error: string): UpdaterProbe => ({ url: URL_, ok: false, httpStatus: null, version: null, error, ms: 90 });

describe('parseUpdateCheckRequest(★未知を黙って既定に倒さない)', () => {
  const ok = { source: 'settings', verdict: 'latest', clientVersion: '0.9.109' };

  it('正しい報告を通す', () => {
    const r = parseUpdateCheckRequest(ok);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report).toEqual({ source: 'settings', verdict: 'latest', pluginVersion: null, message: null, clientVersion: '0.9.109' });
  });

  it('4つの verdict と 2つの source をすべて受ける', () => {
    for (const source of ['startup', 'settings']) {
      for (const verdict of ['available', 'latest', 'error', 'unsupported']) {
        expect(parseUpdateCheckRequest({ source, verdict }).ok).toBe(true);
      }
    }
  });

  it('★未知/欠落は必ずエラー(黙って latest として記録しない)', () => {
    for (const bad of [
      null, 'x', 42, {},
      { source: 'settings' },
      { verdict: 'latest' },
      { source: 'toast', verdict: 'latest' },        // 別表記は受けない
      { source: 'settings', verdict: 'ok' },
    ]) {
      expect(parseUpdateCheckRequest(bad).ok).toBe(false);
    }
  });

  it('長すぎるエラー文言は切り詰める(meta を汚さない)', () => {
    const r = parseUpdateCheckRequest({ source: 'startup', verdict: 'error', message: 'x'.repeat(2000) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.report.message).toHaveLength(500);
  });
});

describe('recordUpdateCheck — ★実ファイル SQLite に残る', () => {
  let dir: string;
  let dbPath: string;
  const logs: string[] = [];
  const warns: string[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-updcheck-'));
    dbPath = join(dir, 'jp225.db');
    logs.length = 0; warns.length = 0;
  });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  const run = (report: Parameters<typeof recordUpdateCheck>[0], probe: UpdaterProbe, appVersion = '0.9.109') =>
    recordUpdateCheck(report, {
      dbPath, endpoint: URL_, appVersion,
      probe: async () => probe,
      log: l => { logs.push(l); }, warn: l => { warns.push(l); },
    });

  /** 実ファイルを開き直して meta を読む(書いた側の変数ではなく **ファイルの中身** を見る)。 */
  function readMeta(): { status: string | null; json: string | null } {
    const db = new DatabaseSync(dbPath);
    try {
      return { status: getMeta(db, UPDATE_CHECK_STATUS_KEY), json: getMeta(db, UPDATE_CHECK_KEY) };
    } finally { db.close(); }
  }

  it('更新あり: 実ファイルに update_check_status と update_check が入る', async () => {
    await run({ source: 'startup', verdict: 'available', pluginVersion: '0.9.110', message: null, clientVersion: '0.9.109' }, probeOk('0.9.110'));
    const m = readMeta();
    expect(m.status).toContain('UPDATE-AVAILABLE');
    expect(m.status).toContain('0.9.110');
    expect(JSON.parse(m.json!)).toMatchObject({ verdict: 'available', mismatch: false, probe: { httpStatus: 200, version: '0.9.110' } });
    expect(logs).toHaveLength(1);
    expect(warns).toHaveLength(0);
  });

  it('更新なし: LATEST として残り、probe の版も一緒に残る', async () => {
    await run({ source: 'settings', verdict: 'latest', pluginVersion: null, message: null, clientVersion: '0.9.109' }, probeOk('0.9.109'));
    const m = readMeta();
    expect(m.status).toContain('LATEST');
    expect(m.status).toContain('version=0.9.109');
    expect(JSON.parse(m.json!)).toMatchObject({ verdict: 'latest', mismatch: false });
  });

  it('失敗: 理由が消えずに残り、serverlog は warn(★見落とさない)', async () => {
    await run({ source: 'startup', verdict: 'error', pluginVersion: null, message: 'Could not fetch a valid release JSON', clientVersion: '0.9.109' }, probeFail('getaddrinfo ENOTFOUND github.com'));
    const m = readMeta();
    expect(m.status).toContain('CHECK-FAILED');
    expect(m.status).toContain('Could not fetch a valid release JSON');
    expect(m.status).toContain('ENOTFOUND');
    expect(warns).toHaveLength(1);
    expect(logs).toHaveLength(0);
  });

  it('★否定対照(2026-09-09 の事故の再現): アプリは「最新」・probe は新しい版 → 記録だけで食い違いが読める', async () => {
    const r = await run({ source: 'settings', verdict: 'latest', pluginVersion: null, message: null, clientVersion: '0.9.109' }, probeOk('0.9.111'));
    expect(r.mismatch).toBe(true);
    const m = readMeta();
    expect(m.status).toContain('★MISMATCH');
    expect(m.status).toContain('アプリは「最新(0.9.109)」');
    expect(m.status).toContain('0.9.111 が返る');
    expect(m.status).toContain('HTTP 200');
    expect(warns[0]).toContain('★MISMATCH');           // serverlog にも同じ1行が出る
  });

  it('startup と settings の両方が同じ形で残る(片方だけの経路になっていない)', async () => {
    for (const source of ['startup', 'settings'] as const) {
      await run({ source, verdict: 'latest', pluginVersion: null, message: null, clientVersion: '0.9.109' }, probeOk('0.9.109'));
      expect(readMeta().status).toContain(`source=${source}`);
    }
  });

  it('★probe は endpoints の URL をそのまま叩く(別 URL を叩いたら証拠にならない)', async () => {
    const seen: string[] = [];
    await recordUpdateCheck(
      { source: 'settings', verdict: 'latest', pluginVersion: null, message: null, clientVersion: null },
      { dbPath, appVersion: '0.9.109', probe: async (u) => { seen.push(u); return probeOk('0.9.109'); }, log: () => {}, warn: () => {} },
    );
    // endpoint 未指定 = 本番と同じ resolveUpdaterEndpoint() が使われる。
    const { resolveUpdaterEndpoint } = await import('../updater/endpoints.js');
    expect(seen).toEqual([resolveUpdaterEndpoint()]);
  });
});

describe('★(C) Tauri 外(unsupported)ではサーバも配信先を叩かない', () => {
  let dir: string; let dbPath: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'jp225-updcheck-c-')); dbPath = join(dir, 'jp225.db'); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('unsupported: probe 関数が一度も呼ばれず、記録は残る', async () => {
    let called = 0;
    const r = await recordUpdateCheck(
      { source: 'startup', verdict: 'unsupported', pluginVersion: null, message: null, clientVersion: null },
      { dbPath, endpoint: URL_, appVersion: '0.9.111', probe: async (u) => { called++; return probeOk('0.9.111'); }, log: () => {}, warn: () => {} },
    );
    expect(called).toBe(0);                       // ★外向き通信ゼロ
    expect(r.probe).toBeNull();
    const db = new DatabaseSync(dbPath);
    const status = getMeta(db, UPDATE_CHECK_STATUS_KEY);
    db.close();
    expect(status).toContain('NOT-TAURI');
    expect(status).toContain('probe=未実施');
  });

  it('★否定対照: 他の3つの verdict では必ず叩く(省きすぎていない)', async () => {
    for (const verdict of ['available', 'latest', 'error'] as const) {
      let called = 0;
      await recordUpdateCheck(
        { source: 'settings', verdict, pluginVersion: '0.9.111', message: 'x', clientVersion: null },
        { dbPath, endpoint: URL_, appVersion: '0.9.110', probe: async () => { called++; return probeOk('0.9.111'); }, log: () => {}, warn: () => {} },
      );
      expect(called).toBe(1);
    }
  });
});
