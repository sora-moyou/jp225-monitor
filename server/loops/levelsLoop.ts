import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick } from '../db/store.js';
import { computeLevels, LOOKBACK_SESSIONS, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 60_000;
const FETCH_SESSIONS = LOOKBACK_SESSIONS + 2;   // フィボ窓 + 余裕

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSessionKey = '';

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

function tick(): void {
  if (!db) return;
  try {
    const now = Date.now();
    const latest = getLatestTick(db, SYMBOL);
    if (!latest) { return; }
    const sessions = getSessionOHLC(db, SYMBOL, FETCH_SESSIONS);
    const cs = classifySession(now);
    const result = computeLevels(sessions, latest.price, now, cs);
    last = result;
    lastSessionKey = sessionKey(cs);
    broadcast({ type: 'levels', payload: result });
  } catch (err) {
    console.warn('[levelsLoop] tick failed:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => {
    tick();
    schedule();
  }, POLL_MS);
}

export function startLevelsLoop(): void {
  if (running) return;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[levelsLoop] open db failed:', err instanceof Error ? err.message : err); return; }
  running = true;
  tick();
  schedule();
}

export function stopLevelsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

export function getLevelsSnapshot(): LevelsResult { return last; }
