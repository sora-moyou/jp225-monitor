// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  砂箱 — 「実 DB に1バイトも書かない」を **お願いではなく仕組みで** 守るための層
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// 本番の各所は `resolveAppDataDir()`(= `%APPDATA%/jp225-monitor`)経由で DB を開く。
// openDb() は WAL 設定 + initSchema(CREATE TABLE IF NOT EXISTS / ALTER)を走らせるので、
// 「読むだけのつもり」でも書き込み経路に乗る。levelsLoop に至っては emitAlert で行を足す。
//
// そこで **どのモジュールを import するよりも先に** `process.env.APPDATA` を砂箱へ差し替え、
// 実データの DB は **砂箱へコピーしたもの** を開かせる。
// → 実 DB のパスはこのプロセスから解決できない = 触りようがない。
//
// ★API キーの置き場は `~/.jp225-monitor/config.json`(homedir 基準)で APPDATA とは無関係。
//   よってキー解決は本番の仕組みがそのまま効く(このコードはキーの値を読まない・出さない)。

import { mkdirSync, copyFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** 砂箱の場所(= このプロセスの %APPDATA% 相当)。 */
export const SANDBOX_BASE = join(tmpdir(), 'jp225-labtest', 'appdata');

export interface SandboxInfo {
  /** 種にした実データの DB(**読むだけ**)。 */
  srcDb: string;
  /** 砂箱側の DB(このプロセスが開く唯一の DB)。 */
  sandboxDb: string;
  srcMtime: number;
  srcBytes: number;
  /** 候補の一覧(選ばれなかったものも残す = なぜそれを選んだかが後から分かる)。 */
  candidates: { path: string; exists: boolean; mtime: number | null }[];
  copiedAt: number;
}

let sandbox: SandboxInfo | null = null;
/** ★差し替える **前** の本物の %APPDATA%。種 DB を探すためだけに1度控える。 */
let realAppDataBase = '';

export function rememberRealAppData(base: string): void { realAppDataBase = base; }

/** 実データの DB 候補。**名前ではなく更新時刻で選ぶ**(稼働機の同期スナップショットの方が新しい)。
 *  ・Documents/trade/prices_kabu.db … 実弾ホスト(kabu-)の monitor DB の VACUUM INTO スナップショット
 *  ・%APPDATA%/jp225-monitor/jp225.db … この PC のローカル monitor DB */
function dbCandidates(): string[] {
  return [
    join(homedir(), 'Documents', 'trade', 'prices_kabu.db'),
    join(realAppDataBase || (process.env.APPDATA ?? homedir()), 'jp225-monitor', 'jp225.db'),
  ];
}

/** 砂箱の DB を種 DB から作り直す(起動時と、実行ボタンのたびに呼ぶ)。 */
export function refreshSandbox(): SandboxInfo {
  const explicit = process.env.LABTEST_SRC_DB;
  const cands = explicit ? [explicit] : dbCandidates();
  const stats = cands.map(p => {
    let mtime: number | null = null;
    try { mtime = existsSync(p) ? statSync(p).mtimeMs : null; } catch { mtime = null; }
    return { path: p, exists: mtime !== null, mtime };
  });
  const best = stats.filter(s => s.mtime !== null).sort((a, b) => b.mtime! - a.mtime!)[0];
  if (!best) throw new Error(`種にできる DB が1つも見つかりません: ${cands.join(' / ')}`);

  const dir = join(SANDBOX_BASE, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, 'jp225.db');
  // 前世代の WAL/SHM を新しい本体に被せない。
  for (const suffix of ['-wal', '-shm']) {
    try { rmSync(dest + suffix, { force: true }); } catch { /* 無ければ良い */ }
  }
  copyFileSync(best.path, dest);
  const st = statSync(best.path);
  sandbox = {
    srcDb: best.path, sandboxDb: dest, srcMtime: st.mtimeMs, srcBytes: st.size,
    candidates: stats, copiedAt: Date.now(),
  };
  return sandbox;
}

export function getSandbox(): SandboxInfo {
  if (!sandbox) throw new Error('砂箱が未作成です(bootstrap が走っていません)');
  return sandbox;
}
