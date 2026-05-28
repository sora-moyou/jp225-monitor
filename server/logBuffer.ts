// console.log/warn/error をリングバッファに蓄積し、フロントへ /api/logs で配信する。
// 元の stdout/stderr 出力は維持する。

import { format } from 'node:util';

export interface LogEntry {
  ts: number;
  level: 'log' | 'warn' | 'error';
  msg: string;
}

export const BUFFER_SIZE = 200;

let buffer: LogEntry[] = [];
let installed = false;

interface Originals {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
}
let originals: Originals | null = null;

function push(level: LogEntry['level'], args: unknown[]): void {
  const msg = format(...args);
  buffer.push({ ts: Date.now(), level, msg });
  if (buffer.length > BUFFER_SIZE) buffer.shift();
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
  if (installed && originals) {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  installed = false;
  originals = null;
}
