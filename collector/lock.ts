import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolveDbPath } from '../server/db/store.js';

function pidPath(): string {
  const dir = dirname(resolveDbPath());   // %APPDATA%/jp225-monitor
  mkdirSync(dir, { recursive: true });
  return join(dir, 'collector.pid');
}

/** プロセスが生存しているか (kill(pid,0))。存在しなければ false。EPERM は生存扱い。 */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** 既存pidと生存判定から「自分が取得してよいか」。純粋関数(テスト用)。 */
export function shouldAcquire(existingPid: number | null, alive: (pid: number) => boolean): boolean {
  if (existingPid === null) return true;
  return !alive(existingPid);
}

/** ロック取得を試みる。別の生存インスタンスがあれば false。成功時は自分のpidを書く。 */
export function acquireLock(): boolean {
  const p = pidPath();
  let existing: number | null = null;
  try { const n = parseInt(readFileSync(p, 'utf-8').trim(), 10); existing = Number.isInteger(n) ? n : null; }
  catch { existing = null; }
  if (!shouldAcquire(existing, isAlive)) return false;
  writeFileSync(p, String(process.pid), 'utf-8');
  return true;
}

/** 自分のロックを解放 (pidファイル削除)。 */
export function releaseLock(): void {
  try { rmSync(pidPath(), { force: true }); } catch { /* ignore */ }
}
