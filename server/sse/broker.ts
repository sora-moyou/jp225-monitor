import type { Response } from 'express';
import type { SSEEvent } from '../types.js';

const clients = new Set<Response>();

/** ハートビート間隔。15秒ごとに SSE コメント行を送って接続の生存を示す。 */
export const HEARTBEAT_MS = 15_000;

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

export function register(res: Response): void {
  clients.add(res);
}

export function unregister(res: Response): void {
  clients.delete(res);
}

export function broadcast(event: SSEEvent): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

export function clientCount(): number {
  return clients.size;
}

// SSE コメント行(':' 始まり)は SSE パーサに無視されイベント誤解釈されない。
// price loop はポーリング窓外で無音になるため、取引時間外でも接続に一定の
// トラフィックを流し「60秒無バイト=切断」判定の下流(jp225-Trade bot)の無駄な再接続を防ぐ。
export function startHeartbeat(): void {
  if (heartbeatTimer) return;   // 二重起動ガード
  heartbeatTimer = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        // 死んだソケットは掃除する(broadcast と同じく clients が真実の源)
        clients.delete(res);
      }
    }
  }, HEARTBEAT_MS);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}
