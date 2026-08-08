import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appDataBase, guardAppDataBase, isInsideTmp, isTestRuntime, resolveAppDataDir } from './appDataDir.js';
import { resolveDbPath } from './db/store.js';

// ★このファイルが守っているもの:
//   「テストが実ユーザーの %APPDATA%/jp225-monitor(= 実 DB jp225.db)を選べない」という **構造** そのもの。
//   実測(2026-08-04〜08-08)で実 DB の signal_plans 689行中 688行がテストの書き込みだった事故の再発防止。
//   個々のテストの afterEach を直すのではなく、パス解決の1点で塞いでいるので、新しいテストが増えても穴は開かない。

const REAL_LIKE = process.platform === 'win32'
  ? 'C:\\Users\\__jp225_fake__\\AppData\\Roaming'
  : '/home/__jp225_fake__/.config';

const ORIG = process.env.APPDATA;
afterEach(() => { if (ORIG !== undefined) process.env.APPDATA = ORIG; else delete process.env.APPDATA; });

describe('appDataDir: テスト中は実パスを物理的に選べない', () => {
  it('vitest 実行中である(= 以下の検証が意味を持つ前提)', () => {
    expect(isTestRuntime()).toBe(true);
  });

  it('tmpdir の外を指したら隔離先(tmpdir 配下)へ差し替わる', () => {
    const got = guardAppDataBase(REAL_LIKE);
    expect(got).not.toBe(REAL_LIKE);
    expect(isInsideTmp(got)).toBe(true);
  });

  it('★実ユーザーの %APPDATA% を指しても、実 DB のパスは返らない', () => {
    process.env.APPDATA = REAL_LIKE;
    const p = resolveDbPath();
    expect(p.startsWith(resolve(REAL_LIKE))).toBe(false);
    expect(isInsideTmp(p)).toBe(true);
    // 実ベース配下にフォルダを作ってすらいないこと(mkdirSync が実環境に落ちない)。
    expect(existsSync(join(REAL_LIKE, 'jp225-monitor'))).toBe(false);
  });

  it('★環境変数を「実値へ戻した後の遅れた書き込み」でも実 DB を指さない(今回の事故の再現形)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp225-guard-'));
    process.env.APPDATA = dir;                       // テスト中は temp
    const late = new Promise<string>((r) => setTimeout(() => r(resolveDbPath()), 5));
    process.env.APPDATA = REAL_LIKE;                 // ← afterEach が実値へ戻した状態を再現
    const p = await late;                            // ← 遅れて到着した書き込み
    expect(isInsideTmp(p)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('テストが自分で用意した一時ディレクトリはそのまま通す(既存テストの前提を壊さない)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp225-guard-'));
    process.env.APPDATA = dir;
    expect(resolveDbPath()).toBe(join(dir, 'jp225-monitor', 'jp225.db'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('★本番(vitest 以外)は素通し = 従来と同一のパス', () => {
    const prod = {} as NodeJS.ProcessEnv;             // VITEST 系が無い env = 本番相当
    expect(isTestRuntime(prod)).toBe(false);
    expect(guardAppDataBase(REAL_LIKE, prod)).toBe(REAL_LIKE);
    // 従来式(APPDATA → HOME → cwd)が保たれている
    expect(appDataBase({ APPDATA: 'A', HOME: 'H' } as NodeJS.ProcessEnv)).toBe('A');
    expect(appDataBase({ HOME: 'H' } as NodeJS.ProcessEnv)).toBe('H');
    expect(appDataBase({} as NodeJS.ProcessEnv)).toBe(process.cwd());
  });

  it('resolveAppDataDir はディレクトリを作らない(作る責務は呼び出し側のまま)', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'jp225-guard-')), 'nested');
    expect(resolveAppDataDir(dir)).toBe(join(dir, 'jp225-monitor'));
    expect(existsSync(join(dir, 'jp225-monitor'))).toBe(false);
  });
});
