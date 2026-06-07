import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function kill(args: string[]): void {
  try { execFileSync('taskkill', args, { stdio: 'ignore' }); } catch { /* 未起動など無視 */ }
}

/** collector を停止(collector.pid を taskkill し pid ファイル削除)。 */
export function stopCollector(): void {
  const pidPath = join(process.env.APPDATA ?? '', 'jp225-monitor', 'collector.pid');
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim();
    if (pid) kill(['/PID', pid, '/T', '/F']);
    try { rmSync(pidPath); } catch { /* ignore */ }
  }
}

/** jp225-Trade(アプリ+sidecar)を停止。未起動は無視。 */
export function stopTrade(): void {
  kill(['/IM', 'jp225-trade.exe', '/T', '/F']);
  kill(['/IM', 'jp225-trade-sidecar.exe', '/T', '/F']);
}
