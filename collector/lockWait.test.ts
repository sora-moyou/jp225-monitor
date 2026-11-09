// collector の PID ロック待ち(collector/lock.ts waitForCollectorLock)。
//
// ★なぜ: 以前は「ロックが取れない → 即 return(exit 0)」だった。collector はアプリを閉じても生き残るので、
//   アプリを再起動すると新しい collector は exit 0 で抜け、Rust の監視は 0 を再起動しない。
//   そのあと古い collector(誰の監視下にも居ない)が落ちると誰も再起動しない = 2026-10-28 からの13日停止と同じ形。
// ★変更前の実装(1回目で取れなければ諦める)に戻すと、「保持者が消えたら取得する」が赤になる。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  waitForCollectorLock, COLLECTOR_PID_FILE, COLLECTOR_WAIT_PID_FILE, acquireLock, isCollectorAlive,
} from './lock.js';
import { pidLockPath } from '../server/pidLock.js';
import { GENERATOR_PID_LOCK_BLOCKED_MARK } from '../server/spawnLog.js';

describe('waitForCollectorLock — 取れなくても抜けずに待ち、保持者が消えたら取る', () => {
  let dir = '';
  const ORIG: Record<string, string | undefined> = {};
  let holder: ChildProcess | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-colock-'));
    for (const k of ['APPDATA', 'HOME']) ORIG[k] = process.env[k];
    process.env.APPDATA = dir; process.env.HOME = dir;
  });
  afterEach(() => {
    try { holder?.kill(); } catch { /* ignore */ }
    holder = null;
    for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★実プロセス: 保持者(生きている別の node)が居る間は待ち、保持者が消えたらロックを取って返る', async () => {
    // 保持者 = 実際に生きている別プロセス(イメージ名は自分と同じ node.exe = 生きている collector 扱い)。
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise(r => holder!.once('spawn', r));
    writeFileSync(pidLockPath(COLLECTOR_PID_FILE), String(holder.pid), 'utf-8');

    const lines: string[] = [];
    let waits = 0;
    const result = await waitForCollectorLock({
      retryMs: 10,
      report: l => { lines.push(l); },
      wait: async (ms) => {
        waits += 1;
        // 3回待ったところで保持者が落ちる(=古い collector が死んだ)。
        if (waits === 3) {
          const h = holder!;
          await new Promise<void>(r => { h.once('exit', () => r()); h.kill(); });
        }
        await new Promise(r => setTimeout(r, ms));
      },
      maxTries: 50,
    });

    expect(result).toEqual({ kind: 'acquired', tries: 3 });
    // ロックは自分のものになっている。
    expect(readFileSync(pidLockPath(COLLECTOR_PID_FILE), 'utf-8').trim()).toBe(String(process.pid));
    // 待機中であることは1回だけ、取れたときも1行。
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(GENERATOR_PID_LOCK_BLOCKED_MARK);
    expect(lines[0]).toContain(`保持者 pid=${holder.pid}`);
    expect(lines[0]).toContain('0秒ごとに再判定します');   // retryMs=10ms を秒に丸めた表示(本番は60秒)
    expect(lines[1]).toContain('収集を開始しました');
    // 待機者の印は取得時に片付く。
    expect(existsSync(pidLockPath(COLLECTOR_WAIT_PID_FILE))).toBe(false);
  });

  it('保持者が居なければ一度も待たずに取る(従来どおり)', async () => {
    const lines: string[] = [];
    const r = await waitForCollectorLock({ report: l => { lines.push(l); }, wait: async () => { throw new Error('待ってはいけない'); } });
    expect(r).toEqual({ kind: 'acquired', tries: 0 });
    expect(lines).toEqual([]);
  });

  it('★待機者は増えない: 後から来た待機者が勝ち、先に居た待機者は次の再判定で身を引く', async () => {
    // 保持者は生きたまま(どちらもロックは取れない)。pid と生存はテストで決める。
    const aliveSet = new Set([1111, 2222]);
    const common = {
      acquire: () => false,
      inspect: () => ({ path: 'x', pid: 999, probe: null, expectedImage: 'node.exe' }),
      alive: (p: number) => aliveSet.has(p),
      report: () => {},
      retryMs: 1,
    };
    // 待機者 A が来て1回待つ。待っている間に待機者 B が来て印を上書きする。
    let bStarted: Promise<unknown> | null = null;
    const a = await waitForCollectorLock({
      ...common, pid: 1111, maxTries: 5,
      wait: async () => {
        if (!bStarted) bStarted = waitForCollectorLock({ ...common, pid: 2222, maxTries: 1, wait: async () => {} });
        await bStarted;
      },
    });
    expect(a).toEqual({ kind: 'superseded', by: 2222, tries: 1 });
    expect(readFileSync(pidLockPath(COLLECTOR_WAIT_PID_FILE), 'utf-8').trim()).toBe('2222');
  });

  it('印が死んだ待機者を指していたら取り戻す(身を引かない)', async () => {
    writeFileSync(pidLockPath(COLLECTOR_WAIT_PID_FILE), '3333', 'utf-8');
    let n = 0;
    const r = await waitForCollectorLock({
      pid: 1111,
      acquire: () => n >= 2,
      inspect: () => ({ path: 'x', pid: 999, probe: null, expectedImage: 'node.exe' }),
      alive: () => false,
      report: () => {},
      retryMs: 1,
      wait: async () => {
        n += 1;
        // 待っている間に、別の(既に死んだ)pid が印に書かれた状態を作る。
        writeFileSync(pidLockPath(COLLECTOR_WAIT_PID_FILE), '3333', 'utf-8');
      },
    });
    expect(r.kind).toBe('acquired');
  });
});

// ★エバリュエーター指摘の欠陥: 生存判定を「自分と同じイメージ名か」にすると、配布版(jp225-collector.exe)が
//   動いている PC で開発版(node.exe)を起動したとき(逆も)、保持者を死んだとみなしてロックを奪い、
//   2つの collector が同時に書き込む。以前の kill(pid,0) なら奪わなかった。
//   ★旧実装 `isAliveAsImage(pid, ownImageName())` に戻すと、下の実プロセスの1件目が赤になる。
describe('isCollectorAlive / acquireLock — 自分と違うイメージ名の collector からロックを奪わない', () => {
  let dir = '';
  const ORIG: Record<string, string | undefined> = {};
  let holder: ChildProcess | null = null;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-colock2-'));
    for (const k of ['APPDATA', 'HOME']) ORIG[k] = process.env[k];
    process.env.APPDATA = dir; process.env.HOME = dir;
  });
  afterEach(() => {
    try { holder?.kill(); } catch { /* ignore */ }
    holder = null;
    for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★実プロセス: 保持者が node.exe(開発版)・自分が jp225-collector.exe(配布版)でも奪わない', async () => {
    holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    await new Promise(r => holder!.once('spawn', r));
    writeFileSync(pidLockPath(COLLECTOR_PID_FILE), String(holder.pid), 'utf-8');
    expect(acquireLock('jp225-collector.exe')).toBe(false);
    expect(readFileSync(pidLockPath(COLLECTOR_PID_FILE), 'utf-8').trim()).toBe(String(holder.pid));
  });

  it('逆: 保持者が jp225-collector.exe・自分が node.exe でも奪わない', () => {
    writeFileSync(pidLockPath(COLLECTOR_PID_FILE), '4242', 'utf-8');
    const probe = () => ({ ok: true as const, image: 'jp225-collector.exe' });
    expect(acquireLock('node.exe', probe)).toBe(false);
    expect(readFileSync(pidLockPath(COLLECTOR_PID_FILE), 'utf-8').trim()).toBe('4242');
  });

  it('pid 再利用対策は残す: collector になりえないイメージ名・居ない pid は死んだとみなす(奪う)', () => {
    writeFileSync(pidLockPath(COLLECTOR_PID_FILE), '4242', 'utf-8');
    expect(acquireLock('node.exe', () => ({ ok: true, image: 'notepad.exe' }))).toBe(true);
    expect(isCollectorAlive(4242, 'node.exe', () => ({ ok: true, image: null }))).toBe(false);
    expect(isCollectorAlive(4242, 'node.exe', () => ({ ok: true, image: 'JP225-Collector.exe' }))).toBe(true);
  });

  it('問い合わせできないときは kill(pid,0) に戻す(保護側)', () => {
    expect(isCollectorAlive(process.pid, 'x.exe', () => ({ ok: false, error: 'no tasklist' }))).toBe(true);
  });
});
