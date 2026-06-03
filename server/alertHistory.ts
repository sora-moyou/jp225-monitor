import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getLatestTick, insertAlert, getAlertsNeedingFollowup,
  updateAlertReturns, getBarCloseNear, type AlertRow } from './db/store.js';
import { broadcast } from './sse/broker.js';
import { isCollectorAlive } from './collectorHeartbeat.js';
import { classifySession, isWithinOpenGuard } from '../collector/session.js';
import { resolveOpenGuardBars } from './configStore.js';
import type { AlertEventPayload } from './types.js';

const FOLLOWUP_MS = 30_000;
const HIT_PCT = 0.1;            // 的中判定(発火方向に +0.1% 以上)
const OFFSETS_MIN = [5, 15, 30] as const;
const FOLLOWUP_TOL_MS = 3 * 60_000;   // +N分の足は target±この範囲(手前)で探す。無ければ null=集計除外。

/** 順行符号: アラート方向に進んだら +、戻ったら −(down は ret の符号反転)。継続/戻りの比較用。 */
function favor(direction: string | null, ret: number): number {
  return direction === 'down' ? -ret : ret;
}

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
  if (detectionKind === 'shock') return '急変';
  if (detectionKind === 'dtb') return 'Wトップ/ボトム';
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
  // 未来日時のアラートは出さない(UI・記録とも)。基礎データ取り込み等で未来バーが feed に混じると
  // triggeredAt が未来になる。現在より2分以上未来なら破棄。
  if (p.triggeredAt > Date.now() + 2 * 60_000) {
    console.error(`[alertHistory] ERROR: future-dated alert dropped: ${new Date(p.triggeredAt).toISOString()} `
      + `(${p.detectionKind} ${p.symbol}), now ${new Date().toISOString()}. 基礎データ取り込みの未来バー由来の可能性。`);
    return;
  }
  if (isWithinOpenGuard(p.triggeredAt, resolveOpenGuardBars())) return;   // 寄りから3本は全アラート抑制(UIバナーも記録も出さない)
  broadcast({ type: 'alert', payload: p });
  try {
    if (!db) db = openDb(resolveDbPath());
    if (isCollectorAlive(db, Date.now())) return;   // collector is the authoritative writer
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
      // +N分の足を target±許容で取得(セッション切れ目/欠損で遠い足へ張り付かないよう近傍限定)。
      const c = getBarCloseNear(database, a.symbol, a.triggered_at + offMin * 60_000, FOLLOWUP_TOL_MS);
      return c == null ? null : ((c - a.price!) / a.price!) * 100;
    };
    updateAlertReturns(database, a.id, ret(OFFSETS_MIN[0]), ret(OFFSETS_MIN[1]), ret(OFFSETS_MIN[2]));
  }
}

// avgRet5/15/30 は「順行%」(発火方向に進めば +、戻れば −)。上げ/下げが相殺しないよう方向正規化。
export interface KindStat { label: string; count: number; hitRate: number; revertRate: number; avgRet5: number; avgRet15: number; avgRet30: number; }

/** 種別ごとに、継続率(hitRate=順行+0.1%超)・戻り率(revertRate=逆行0.1%超)・順行平均ret を集計。
 *  すべて 15分基準の確定分(hit/revert)。avgRet は各オフセットの確定分。「急落後にさらに下げたか
 *  /戻ったか」を方向正規化して測り、戻り率が高ければ閾値見直しの判断材料にする。 */
export function summarize(rows: AlertRow[]): KindStat[] {
  const groups = new Map<string, AlertRow[]>();
  for (const r of rows) {
    const k = rowKind(r.detection_kind, r.window_seconds);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const avg = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const favAvg = (rs: AlertRow[], get: (r: AlertRow) => number | null): number =>
    avg(rs.map(r => { const v = get(r); return v == null ? null : favor(r.direction, v); })
          .filter((x): x is number => x != null));
  const out: KindStat[] = [];
  for (const [label, rs] of groups) {
    const r15 = rs.filter(r => r.ret15 != null);
    const fav15 = r15.map(r => favor(r.direction, r.ret15!));
    const hits = fav15.filter(f => f >= HIT_PCT).length;        // 継続(順行 ≥ +0.1%)
    const reverts = fav15.filter(f => f <= -HIT_PCT).length;    // 戻り(逆行 ≥ 0.1%)
    out.push({
      label, count: rs.length,
      hitRate: r15.length ? hits / r15.length : 0,
      revertRate: r15.length ? reverts / r15.length : 0,
      avgRet5: favAvg(rs, r => r.ret5),
      avgRet15: favAvg(rs, r => r.ret15),
      avgRet30: favAvg(rs, r => r.ret30),
    });
  }
  return out;
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => {
    if (db && !isCollectorAlive(db, Date.now())) {
      try { followupTick(db, Date.now()); } catch { /* ignore */ }
    }
    schedule();
  }, FOLLOWUP_MS);
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
