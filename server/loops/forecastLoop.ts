import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getRecentBars } from '../db/store.js';
import { isSessionComplete } from '../levels.js';
import { computeADR, projectTargets, computeSeasonality, currentAndNextSlot,
  type ADR, type SlotStat } from '../forecast.js';
import { classifySession, inPollWindow } from '../../collector/session.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 120_000;
const ADR_SESSIONS = 20;
const SEAS_DAYS = 25;
const SLOT_MIN = 30;
const MIN_SAMPLES = 5;

export interface ForecastSnapshot {
  adr: ADR | null;
  targets: { projHigh: number; projLow: number } | null;
  seasonalityNow: SlotStat | null;
  seasonalityNext: SlotStat | null;
  asOf: number;
}

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: ForecastSnapshot = { adr: null, targets: null, seasonalityNow: null, seasonalityNext: null, asOf: 0 };

function tick(): void {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
  if (!db) return;
  try {
    const now = Date.now();
    const cs = classifySession(now);
    const sessions = getSessionOHLC(db, SYMBOL, ADR_SESSIONS + 6);
    const sessionType = cs?.session ?? sessions[0]?.session ?? 'Day';
    const adr = computeADR(sessions, ADR_SESSIONS, sessionType);
    const inProgress = cs ? sessions.find(s => s.sessionDate === cs.sessionDate && s.session === cs.session) ?? null : null;
    const targets = (inProgress && isSessionComplete(inProgress) && adr.samples >= MIN_SAMPLES)
      ? projectTargets(inProgress.open, adr) : null;
    const bars = getRecentBars(db, SYMBOL, now - SEAS_DAYS * 86400_000)
      .map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
    const stats = computeSeasonality(bars, SLOT_MIN);
    const { now: sNow, next: sNext } = currentAndNextSlot(stats, now, SLOT_MIN);
    last = {
      adr: adr.samples >= MIN_SAMPLES ? adr : null,
      targets,
      seasonalityNow: sNow && sNow.samples >= MIN_SAMPLES ? sNow : null,
      seasonalityNext: sNext && sNext.samples >= MIN_SAMPLES ? sNext : null,
      asOf: now,
    };
  } catch (err) {
    console.warn('[forecastLoop] tick failed:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => { tick(); schedule(); }, POLL_MS);
}

export function startForecastLoop(): void {
  if (running) return;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[forecastLoop] open db failed:', err instanceof Error ? err.message : err); return; }
  running = true;
  tick();
  schedule();
}
export function stopForecastLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}
export function getForecastSnapshot(): ForecastSnapshot { return last; }
