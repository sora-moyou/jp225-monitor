import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getLatestTick, insertAlert, getAlertsNeedingFollowup,
  updateAlertReturns, getBarCloseNear, getRecentAlerts, type AlertRow } from './db/store.js';
import { broadcast } from './sse/broker.js';
import { isCollectorAlive } from './collectorHeartbeat.js';
import { classifySession, isWithinOpenGuard } from '../collector/session.js';
import { resolveOpenGuardBars, resolveHitThreshold } from './configStore.js';
import { noteShock } from './shockWindow.js';
import type { AlertEventPayload } from './types.js';

const FOLLOWUP_MS = 30_000;
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
  // v0.6.0 現行種別
  if (detectionKind === 'shock') return '急変';
  if (detectionKind === 'double') return 'ダブル天底';
  if (detectionKind === 'ma_sr') return 'MAサポレジ';
  if (detectionKind === 'level_sr') return '水準サポレジ';
  if (detectionKind === 'break') return '水準ブレイク';
  if (detectionKind === 'pivot') return 'スイング形成';
  if (detectionKind === 'trend') return 'トレンド転換';
  // 後方互換(過去履歴の旧種別)
  if (detectionKind === 'granville') return 'グランビル';
  if (detectionKind === 'dtb') return 'Wトップ/ボトム';
  if (detectionKind === 'ma') return 'MA抜け';
  if (detectionKind === 'swingdtb') return 'ダブル(大)';
  return kindLabel(windowSeconds);
}

// collector が検知しない(=monitor だけが発火する)種別。collector が authoritative writer でも
// これらは collector が一切 alerts に書かないため、monitor が単独で記録する必要がある。
// levelsLoop 由来(double/level_sr/break/pivot)+ slope は monitor 専用(collector は levelsLoop を回さない)。
// shock/ma_sr/trend は alertEngine 由来で collector も検知 → monitor-only ではない。
// 旧 dtb/swingdtb も levelsLoop 由来だったため後方互換で残す。
const MONITOR_ONLY_KINDS = new Set(['slope', 'break', 'double', 'level_sr', 'pivot', 'dtb', 'swingdtb']);

/** monitor 側で alerts に記録すべきか。collector 非稼働なら全種別記録。
 *  collector 稼働中でも monitor 専用種別(slope/dtb/break)は collector が書かないため記録する
 *  (二重書き込みにはならない: collector はこれらを一切検知・記録しない)。 */
export function shouldPersistInMonitor(detectionKind: string | null, collectorAlive: boolean): boolean {
  return !collectorAlive || MONITOR_ONLY_KINDS.has(detectionKind ?? '');
}

// L2(テクニカル状態)種別。①のテクニカル判定時に「直近の状況」を併記するために使う。
const L2_KINDS = new Set(['double', 'ma_sr', 'level_sr', 'break', 'pivot', 'trend', 'dtb', 'swingdtb', 'granville', 'ma']);

/** 直近 withinMs 以内の最新 L2 アラートを「{種別} {価格} ▲/▼」で要約。無ければ null。①の併記用。 */
export function getRecentL2Summary(now: number, withinMs = 30 * 60_000): string | null {
  try {
    if (!db) db = openDb(resolveDbPath());
    const r = getRecentAlerts(db, 20).find(a =>
      L2_KINDS.has(a.detection_kind ?? '') && now - a.triggered_at <= withinMs);
    if (!r) return null;
    const arrow = r.direction === 'up' ? '▲' : '▼';
    return `${rowKind(r.detection_kind, r.window_seconds)} ${Math.round(r.price ?? 0).toLocaleString('ja-JP')} ${arrow}`;
  } catch { return null; }
}

/** payload と発火価格から alerts に1行記録。 */
export function recordAlert(database: DatabaseSync, p: AlertEventPayload, price: number): void {
  const s = classifySession(p.triggeredAt);
  insertAlert(database, {
    symbol: p.symbol, triggeredAt: p.triggeredAt, direction: p.direction,
    detectionKind: p.detectionKind, windowSeconds: p.windowSeconds, changePercent: p.changePercent,
    price, sessionDate: s?.sessionDate ?? null, session: s?.session ?? null,
    referenceKind: p.referenceKind ?? null, referencePrice: p.referencePrice ?? null,
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
  // 診断: バー時刻から大きく遅れて配信されたアラート(=検知/フィードの遅延)を可視化する。
  // 鮮度ゲート(alertLoop)で本来は抑止されるが、抜けた場合に原因追跡できるようログに残す。
  const lagMs = Date.now() - p.triggeredAt;
  if (lagMs > 90_000) {
    console.warn(`[alertHistory] 遅延配信: バー時刻の ${Math.round(lagMs / 1000)}s 後に発火 `
      + `(${p.detectionKind} ${p.symbol} @${new Date(p.triggeredAt).toISOString()}) — フィード/検知の遅延の可能性。`);
  }
  if (p.detectionKind === 'shock') noteShock(p.triggeredAt);   // ①判定のニュース窓(直前の急変以降)に使う
  broadcast({ type: 'alert', payload: p });
  try {
    if (!db) db = openDb(resolveDbPath());
    // collector が authoritative writer だが、collector は shock/granville しか検知しない。
    // slope/dtb/break は monitor 専用なので collector 稼働中でも monitor が記録しないと
    // alerts に一切残らない(検証シートに出ない)。monitor 専用種別は collector-alive ゲートを抜ける。
    if (!shouldPersistInMonitor(p.detectionKind, isCollectorAlive(db, Date.now()))) return;
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
    // 成功しきい値はシグナル種別ごと(既定同値、config で変更可)。direction が期待方向なので
    // favor≥th が「支持/抵抗が効いた/ブレイク・転換が継続した」=各シグナル共通の成功定義になる。
    const th = resolveHitThreshold(rs[0]?.detection_kind ?? null);
    const r15 = rs.filter(r => r.ret15 != null);
    const fav15 = r15.map(r => favor(r.direction, r.ret15!));
    const hits = fav15.filter(f => f >= th).length;        // 成功(順行 ≥ th%)
    const reverts = fav15.filter(f => f <= -th).length;    // 逆行(≥ th%)
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
