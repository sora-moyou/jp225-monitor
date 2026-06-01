import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getRecentBars, getRecentTicks, getLatestTick } from './db/store.js';
import type { Bar } from './correlation.js';
import { INSTRUMENTS } from './config.js';
import { seedBars, seedSamples } from './feedBars.js';
import { seedBuffer } from './tickDetector.js';

const FRESH_MS = 2 * 60_000;                 // 収集が現在進行中とみなす許容遅れ
const BARS_LOOKBACK_MS = 8 * 60 * 60_000;    // 8時間ぶんの1分足を種付け
const TICKS_LOOKBACK_MS = 6 * 60_000;        // 6分ぶんの生tick

export interface WarmupData {
  barsBySymbol: Map<string, Bar[]>;   // close 化済み
  niyTicks: { t: number; price: number }[];
}

/** DB から種付けデータを選ぶ純粋関数。収集が stale(最新NIY tickが2分超古い)なら null。 */
export function selectWarmup(db: DatabaseSync, now: number): WarmupData | null {
  const latest = getLatestTick(db, 'NIY=F');
  if (!latest || now - latest.t > FRESH_MS) return null;
  const barsBySymbol = new Map<string, Bar[]>();
  for (const inst of INSTRUMENTS) {
    const sym = inst.symbol as string;
    const bars = getRecentBars(db, sym, now - BARS_LOOKBACK_MS).map(b => ({ t: b.t, close: b.c }));
    if (bars.length > 0) barsBySymbol.set(sym, bars);
  }
  const niyTicks = getRecentTicks(db, 'NIY=F', now - TICKS_LOOKBACK_MS).map(t => ({ t: t.t, price: t.price }));
  return { barsBySymbol, niyTicks };
}

/** 起動時に呼ぶ。DB が現在進行中なら feedBars / tickDetector を種付け。stale/不在なら no-op。 */
export function warmFromDb(): void {
  let db: DatabaseSync;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[warmup] open db failed:', err instanceof Error ? err.message : err); return; }
  try {
    const w = selectWarmup(db, Date.now());
    if (!w) { console.log('[warmup] collector data not current — skipping (fresh warmup)'); return; }
    for (const [sym, bars] of w.barsBySymbol) seedBars(sym, bars);
    if (w.niyTicks.length > 0) { seedSamples('NIY=F', w.niyTicks); seedBuffer('NIY=F', w.niyTicks); }
    console.log(`[warmup] seeded from DB: ${w.barsBySymbol.size} symbols, ${w.niyTicks.length} NIY ticks`);
  } catch (err) {
    console.warn('[warmup] failed:', err instanceof Error ? err.message : err);
  } finally {
    db.close();
  }
}
