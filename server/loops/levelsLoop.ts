import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick } from '../db/store.js';
import { computeLevels, LOOKBACK_SESSIONS, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';
import { getForecastSnapshot } from './forecastLoop.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 8_000;   // 当日H/Lをほぼリアルタイム化(従来60s)。NIY=Fのみで軽い。
const FETCH_SESSIONS = Math.max(LOOKBACK_SESSIONS, 20) + 4;   // 20Sスイング + 長期高安 + 余裕

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSig = '';

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

/** レベル集合(価格+tier+丸めスコア+swing)の署名。current は UI が price SSE でライブ追従するため除外。
 *  価格が同じでも tier/score(強さ)が変わったら再配信されるよう、各 level の tier と
 *  0.5刻みに丸めた score も署名に含める。price 昇順ソートで決定性を保つ。
 *  これが変わった時だけ SSE 配信し、8秒間隔でも無駄な配信をしない。 */
export function levelSignature(r: LevelsResult): string {
  const prices = [...r.up, ...r.down]
    .sort((a, b) => a.price - b.price)
    .map(l => `${l.price}:${l.tier}:${Math.round(l.score * 2) / 2}`)
    .join(',');
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
    const fc = getForecastSnapshot();
    const extra = fc.targets
      ? [{ price: fc.targets.projHigh, label: 'ADR上限予測' }, { price: fc.targets.projLow, label: 'ADR下限予測' }]
      : [];
    const result = computeLevels(sessions, latest.price, now, cs, extra);
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
