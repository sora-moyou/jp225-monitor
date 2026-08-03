import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shouldAcquire, readPidFile, acquirePidLock, releasePidLock, pidLockPath, isAlive,
} from './pidLock.js';

describe('shouldAcquire', () => {
  it('取得できる: 既存 pid が無い', () => {
    expect(shouldAcquire(null, () => true)).toBe(true);
  });
  it('取得しない: 既存 pid が生きている', () => {
    expect(shouldAcquire(1234, (pid) => pid === 1234)).toBe(false);
  });
  it('取得できる: 既存 pid が死んでいる(stale)', () => {
    expect(shouldAcquire(1234, () => false)).toBe(true);
  });
});

describe('readPidFile', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pidlock-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('無いファイルは null', () => {
    expect(readPidFile(join(dir, 'nope.pid'))).toBeNull();
  });
  it('壊れた中身は null(ロック無し扱い=起動を止めない)', () => {
    const p = join(dir, 'broken.pid');
    writeFileSync(p, 'not-a-number', 'utf-8');
    expect(readPidFile(p)).toBeNull();
  });
  it('数字は読める(前後の空白込み)', () => {
    const p = join(dir, 'ok.pid');
    writeFileSync(p, ' 4321\n', 'utf-8');
    expect(readPidFile(p)).toBe(4321);
  });
});

describe('isAlive', () => {
  it('自分自身は生きている', () => {
    expect(isAlive(process.pid)).toBe(true);
  });
});

describe('acquirePidLock / releasePidLock (実ファイル)', () => {
  const NAME = 'jp225-pidlock-test.pid';
  let saved: string | undefined;
  let dir: string;

  beforeEach(() => {
    // pid ファイルの置き場は %APPDATA%/jp225-monitor(= resolveDbPath の親)。テスト中だけ隔離する。
    saved = process.env.APPDATA;
    dir = mkdtempSync(join(tmpdir(), 'pidlock-appdata-'));
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('取得すると pid が実際にファイルへ残る', () => {
    expect(acquirePidLock(NAME)).toBe(true);
    const p = pidLockPath(NAME);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toBe(String(process.pid));
  });

  it('生きているインスタンスが居れば取得できない', () => {
    expect(acquirePidLock(NAME, process.pid)).toBe(true);
    expect(acquirePidLock(NAME, process.pid)).toBe(false);   // 自分が生きている=2本目は起動しない
  });

  it('stale(死んだ pid)なら引き継げる', () => {
    writeFileSync(pidLockPath(NAME), '999999999', 'utf-8');   // 存在しない pid
    expect(acquirePidLock(NAME)).toBe(true);
    expect(readFileSync(pidLockPath(NAME), 'utf-8')).toBe(String(process.pid));
  });

  it('解放するとファイルが消える(二重解放でも落ちない)', () => {
    acquirePidLock(NAME);
    releasePidLock(NAME);
    expect(existsSync(pidLockPath(NAME))).toBe(false);
    expect(() => releasePidLock(NAME)).not.toThrow();
  });
});
