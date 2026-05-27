import type { Response } from 'express';
import type { SSEEvent } from '../types.js';

const clients = new Set<Response>();

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
