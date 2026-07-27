// console.log/warn/error をリングバッファに蓄積し、フロントへ /api/logs で配信する。
// 元の stdout/stderr 出力は維持する。
// ★さらに setLogFile(path) が設定されていれば、各行をファイルへも追記する(書き出しに同梱=post-mortem用・
//   リングバッファ200行では足りない過去区間を残す)。上限超過で server.log.1 へローテーション。

import { format } from 'node:util';
import { appendFileSync, statSync, renameSync } from 'node:fs';

export interface LogEntry {
  ts: number;
  level: 'log' | 'warn' | 'error';
  msg: string;
}

export const BUFFER_SIZE = 200;
// ファイルログの上限(超えたら .1 へ退避して新規)。8MB×2で最大~16MB。
const LOG_FILE_MAX_BYTES = 8 * 1024 * 1024;

let buffer: LogEntry[] = [];
let installed = false;
// ★ファイルシンク先(未設定=ファイル出力しない=テスト等で副作用なし)。index.ts が起動時に設定する。
let logFilePath: string | null = null;
let sinceRotateCheck = 0;

/** ファイルログの出力先を設定(null で無効)。index.ts が %APPDATA%/jp225-monitor/server.log を渡す。 */
export function setLogFile(path: string | null): void { logFilePath = path; }

function appendToFile(e: LogEntry): void {
  if (!logFilePath) return;
  try {
    // 200行ごとにサイズ確認し、上限超なら server.log.1 へローテーション。
    if (++sinceRotateCheck >= 200) {
      sinceRotateCheck = 0;
      try {
        if (statSync(logFilePath).size > LOG_FILE_MAX_BYTES) renameSync(logFilePath, logFilePath + '.1');
      } catch { /* 無ければ無視 */ }
    }
    const ts = new Date(e.ts).toISOString();
    appendFileSync(logFilePath, `${ts} [${e.level}] ${e.msg}\n`, 'utf-8');
  } catch { /* ログ書き込み失敗はサーバを壊さない */ }
}

interface Originals {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
}
let originals: Originals | null = null;

function push(level: LogEntry['level'], args: unknown[]): void {
  const msg = format(...args);
  const e: LogEntry = { ts: Date.now(), level, msg };
  buffer.push(e);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
  appendToFile(e);
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => { push('log', args); originals!.log(...args); };
  console.warn = (...args: unknown[]) => { push('warn', args); originals!.warn(...args); };
  console.error = (...args: unknown[]) => { push('error', args); originals!.error(...args); };
}

export function getLogs(since?: number): LogEntry[] {
  if (typeof since !== 'number') return [...buffer];
  return buffer.filter(e => e.ts > since);
}

// テスト用
export function resetLogBuffer(): void {
  buffer = [];
  logFilePath = null;
  sinceRotateCheck = 0;
  if (installed && originals) {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  installed = false;
  originals = null;
}
