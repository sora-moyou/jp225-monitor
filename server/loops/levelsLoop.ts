import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick } from '../db/store.js';
import { computeLevels, LOOKBACK_SESSIONS, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 8_000;   // 当日H/Lをほぼリアルタイム化(従来60s)。NIY=Fのみで軽い。
const FETCH_SESSIONS = LOOKBACK_SESSIONS + 2;   // フィボ窓 + 余裕

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSig = '';

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

/** レベル集合(価格+swing)の署名。current は UI が price SSE でライブ追従するため除外。
 *  これが変わった時だけ SSE 配信し、8秒間隔でも無駄な配信をしない。 */
export function levelSignature(r: LevelsResult): string {
  const prices = [...r.up, ...r.down].map(l => l.price).sort((a, b) => a - b).join(',');
  return `${prices}#${r.swing ? `${r.swing.high}-${r.swing.low}-${r.swing.leg}` : ''}`;
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
    const sig = levelSignature(result);
    if (sig !== lastSig) {
      lastSig = sig;
      broadcast({ type: 'levels', payload: result });
    }
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
