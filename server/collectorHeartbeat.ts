import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './db/store.js';

const HEARTBEAT_KEY = 'collector_heartbeat';
// Collector polls every 2s (and stamps every loop incl. idle 30s). Allow >1 idle cycle of slack.
export const HEARTBEAT_FRESH_MS = 45_000;

export function writeHeartbeat(db: DatabaseSync, now: number = Date.now()): void {
  setMeta(db, HEARTBEAT_KEY, String(now));
}

export function isCollectorAlive(db: DatabaseSync, now: number = Date.now()): boolean {
  const raw = getMeta(db, HEARTBEAT_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  return Number.isFinite(ts) && now - ts < HEARTBEAT_FRESH_MS;
}
