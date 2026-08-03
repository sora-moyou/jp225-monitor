import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendProcessLog, rotateProcessLog, resolveProcessLogPath, PROCESS_LOG_MAX_BYTES } from './processLog.js';
import {
  appendSpawnLog, readSpawnLogTail, trimSpawnLog, SPAWN_LOG_KEEP_LINES, SPAWN_LOG_MAX_LINE,
} from './spawnLog.js';

// ★このテストが守る契約(死因の手がかり ④):
//   collector の出力は Rust のコンソール止まりで、異常終了は痕跡ゼロで消えていた。
//   ・全出力が **ファイル** に残ること(同期フォルダ→別PCから読める)。
//   ・起動/終了/例外の節目が、Rust が spawn の成否を書いているのと **同じ** 1行ログに相乗りすること
//     (新しい配管を増やさない / 「起動された → いつ落ちた」が1ファイルで時系列に並ぶ)。
//
// ★否定対照: git show HEAD:collector/index.ts > <tmp> — ログの導入が1行も無く、
//   落ちても何も残らない(= 今回の「なぜ死んだか分からない」状態そのもの)。

describe('サイドカーのファイルログ', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'proclog-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('1行追記でき、JST の時刻が付く', () => {
    const p = join(dir, 'collector.log');
    appendProcessLog(p, '★uncaughtException: boom', Date.UTC(2026, 5, 3, 1, 0, 0));
    const body = readFileSync(p, 'utf-8');
    expect(body).toContain('2026-06-03 10:00:00');
    expect(body).toContain('★uncaughtException: boom');
  });

  it('書けない場所でも **throw しない**(ログのためにプロセスを落とさない)', () => {
    // ファイルをディレクトリ扱いさせる = 必ず失敗する経路。
    const f = join(dir, 'notadir');
    writeFileSync(f, 'x');
    expect(() => appendProcessLog(join(f, 'deep', 'a.log'), 'x')).not.toThrow();
  });

  it('肥大したら1世代だけ退避する(同期フォルダを太らせない)', () => {
    const p = join(dir, 'collector.log');
    writeFileSync(p, 'x'.repeat(PROCESS_LOG_MAX_BYTES + 1));
    rotateProcessLog(p);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(existsSync(p)).toBe(false);
  });

  it('書き出しフォルダが未設定なら %APPDATA%/jp225-monitor に落とす(何も残らないを作らない)', () => {
    const saved = process.env.JP225_TICK_EXPORT_DIR;
    delete process.env.JP225_TICK_EXPORT_DIR;
    try {
      const p = resolveProcessLogPath('collector');
      expect(p.replace(/\\/g, '/')).toMatch(/jp225-monitor\/collector\.log$|collector_[a-z0-9-]+\.log$/);
    } finally {
      if (saved === undefined) delete process.env.JP225_TICK_EXPORT_DIR;
      else process.env.JP225_TICK_EXPORT_DIR = saved;
    }
  });

  it('書き出しフォルダがあればそこへ(ホスト名つき=複数PCで衝突しない)', () => {
    const saved = process.env.JP225_TICK_EXPORT_DIR;
    process.env.JP225_TICK_EXPORT_DIR = dir;
    try {
      const p = resolveProcessLogPath('collector').replace(/\\/g, '/');
      expect(p.startsWith(dir.replace(/\\/g, '/'))).toBe(true);
      expect(p).toMatch(/collector_[a-z0-9-]+\.log$/);
    } finally {
      if (saved === undefined) delete process.env.JP225_TICK_EXPORT_DIR;
      else process.env.JP225_TICK_EXPORT_DIR = saved;
    }
  });
});

describe('spawn ログへの相乗り(Rust と同じ1行ログ)', () => {
  let dir = '';
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'spawnlog-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('Rust と同じ形式(<epoch> <line>)で追記され、読み戻せる', () => {
    const p = join(dir, 'sidecar-spawn.log');
    appendSpawnLog('[collector] 起動 pid=123', 1_700_000_000_000, p);
    appendSpawnLog('[collector] ─── 終了 code=1', 1_700_000_060_000, p);
    const lines = readSpawnLogTail(p);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('1700000000000 [collector] 起動 pid=123');
    expect(lines[1]).toContain('終了 code=1');
  });

  it('Rust が書いた行を消さない(追記のみ = read-modify-write をしない)', () => {
    const p = join(dir, 'sidecar-spawn.log');
    writeFileSync(p, '1 [collector] spawned pid=4224\n', 'utf-8');
    appendSpawnLog('[collector-watch] dead: 心拍が凍結', 2, p);
    const lines = readSpawnLogTail(p);
    expect(lines[0]).toContain('spawned pid=4224');
    expect(lines[1]).toContain('dead');
  });

  it('肥大したときだけ末尾に切り詰める', () => {
    const p = join(dir, 'sidecar-spawn.log');
    writeFileSync(p, Array.from({ length: 5_000 }, (_, i) => `${i} line-${i}`).join('\n') + '\n', 'utf-8');
    const before = statSync(p).size;
    trimSpawnLog(p, 1_000);
    const lines = readSpawnLogTail(p, 10_000);
    expect(lines).toHaveLength(SPAWN_LOG_KEEP_LINES);
    expect(lines[lines.length - 1]).toContain('line-4999');
    expect(statSync(p).size).toBeLessThan(before);
  });

  it('★スタックトレースでも1レコード=1行を保つ(tail が断片で埋まらない)', () => {
    const p = join(dir, 'sidecar-spawn.log');
    appendSpawnLog('[collector] ★uncaughtException: Error: boom\n    at a()\n    at b()', 1, p);
    const lines = readSpawnLogTail(p);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Error: boom');
    expect(lines[0]).toContain('at a()');
  });

  it('長すぎる行は切り詰める(全文は各プロセスのファイルログ側に残る)', () => {
    const p = join(dir, 'sidecar-spawn.log');
    appendSpawnLog('x'.repeat(SPAWN_LOG_MAX_LINE + 500), 1, p);
    const line = readSpawnLogTail(p)[0] ?? '';
    expect(line.length).toBeLessThan(SPAWN_LOG_MAX_LINE + 60);
    expect(line).toContain('以下略');
  });

  it('書けなくても throw しない', () => {
    const f = join(dir, 'notadir');
    writeFileSync(f, 'x');
    expect(() => appendSpawnLog('x', 1, join(f, 'deep', 'spawn.log'))).not.toThrow();
  });
});
