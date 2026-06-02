import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getLatestTick, insertAlert, getAlertsNeedingFollowup,
  updateAlertReturns, getBarCloseAt, type AlertRow } from './db/store.js';
import { broadcast } from './sse/broker.js';
import { classifySession } from '../collector/session.js';
import type { AlertEventPayload } from './types.js';

const FOLLOWUP_MS = 30_000;
const HIT_PCT = 0.1;            // 的中判定(発火方向に +0.1% 以上)
const OFFSETS_MIN = [5, 15, 30] as const;

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** windowSeconds から検知種別の表示名。 */
export function kindLabel(windowSeconds: number | null): string {
  const w = windowSeconds ?? 0;
  if (w <= 15) return '超短期';
  if (w <= 90) return '短期';
  return '長期';
}

/** 履歴の種別ラベル。グランビルは検知種別で別扱い、それ以外は窓秒で 超短期/短期/長期。 */
export function rowKind(detectionKind: string | null, windowSeconds: number | null): string {
  if (detectionKind === 'granville') return 'グランビル';
  return kindLabel(windowSeconds);
}

/** payload と発火価格から alerts に1行記録。 */
export function recordAlert(database: DatabaseSync, p: AlertEventPayload, price: number): void {
  const s = classifySession(p.triggeredAt);
  insertAlert(database, {
    symbol: p.symbol, triggeredAt: p.triggeredAt, direction: p.direction,
    detectionKind: p.detectionKind, windowSeconds: p.windowSeconds, changePercent: p.changePercent,
    price, sessionDate: s?.sessionDate ?? null, session: s?.session ?? null,
  });
}

/** broadcast + DB記録。アラート発火箇所はこれを呼ぶ(記録漏れ防止の単一経路)。記録失敗してもUIは止めない。 */
export function emitAlert(p: AlertEventPayload): void {
  broadcast({ type: 'alert', payload: p });
  try {
    if (!db) db = openDb(resolveDbPath());
    const latest = getLatestTick(db, p.symbol);
    const price = latest ? latest.price : (p.pa15min ? p.pa15min.current : 0);
    if (price > 0) recordAlert(db, p, price);
  } catch (err) {
    console.warn('[alertHistory] record failed:', err instanceof Error ? err.message : err);
  }
}

/** ret30 未確定で30分経過したアラートの +5/15/30分リターンを bars_1m から埋める。 */
export function followupTick(database: DatabaseSync, now: number): void {
  const rows = getAlertsNeedingFollowup(database, now);
  for (const a of rows) {
    if (a.price == null || a.price <= 0) continue;
    const ret = (offMin: number): number | null => {
      const c = getBarCloseAt(database, a.symbol, a.triggered_at + offMin * 60_000);
      return c == null ? null : ((c - a.price!) / a.price!) * 100;
    };
    updateAlertReturns(database, a.id, ret(OFFSETS_MIN[0]), ret(OFFSETS_MIN[1]), ret(OFFSETS_MIN[2]));
  }
}

export interface KindStat { label: string; count: number; hitRate: number; avgRet5: number; avgRet15: number; avgRet30: number; }

/** 種別(超短期/短期/長期)ごとに、的中率(15分基準)と平均retを集計。ret15 確定分のみ対象。 */
export function summarize(rows: AlertRow[]): KindStat[] {
  const groups = new Map<string, AlertRow[]>();
  for (const r of rows) {
    const k = rowKind(r.detection_kind, r.window_seconds);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const avg = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const out: KindStat[] = [];
  for (const [label, rs] of groups) {
    const r15 = rs.filter(r => r.ret15 != null);
    const hits = r15.filter(r => r.direction === 'up' ? r.ret15! >= HIT_PCT : r.ret15! <= -HIT_PCT).length;
    out.push({
      label, count: rs.length,
      hitRate: r15.length ? hits / r15.length : 0,
      avgRet5: avg(rs.filter(r => r.ret5 != null).map(r => r.ret5!)),
      avgRet15: avg(r15.map(r => r.ret15!)),
      avgRet30: avg(rs.filter(r => r.ret30 != null).map(r => r.ret30!)),
    });
  }
  return out;
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => { if (db) { try { followupTick(db, Date.now()); } catch { /* ignore */ } } schedule(); }, FOLLOWUP_MS);
}

export function startAlertHistoryLoop(): void {
  if (running) return;
  try { if (!db) db = openDb(resolveDbPath()); } catch { return; }
  running = true;
  schedule();
}

export function stopAlertHistoryLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}
