import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './db/store.js';

export const HEARTBEAT_KEY = 'collector_heartbeat';
// Collector polls every 2s (and stamps every loop incl. idle 30s). Allow >1 idle cycle of slack.
export const HEARTBEAT_FRESH_MS = 45_000;

// ★心拍の実際の打ち方(collector/index.ts の while ループ)。ここは **判定の根拠** なので、
//   読み手(死活監視)が推測しないで済むように定数として明示する。
//   ・writeHeartbeat は inPollWindow の判定より **前** で毎周回まわされる = 取引時間外でも必ず打つ。
//   ・周期は場中 2 秒 / 場外 30 秒(idle)。つまり「打っていない」は時間帯では説明できない。
/** 場中の心拍間隔(collector の POLL_MS)。 */
export const HEARTBEAT_POLL_MS = 2_000;
/** 場外(idle)の心拍間隔(collector の IDLE_MS)。**時間外でも心拍は止まらない**。 */
export const HEARTBEAT_IDLE_MS = 30_000;

export function writeHeartbeat(db: DatabaseSync, now: number = Date.now()): void {
  setMeta(db, HEARTBEAT_KEY, String(now));
}

export function isCollectorAlive(db: DatabaseSync, now: number = Date.now()): boolean {
  const raw = getMeta(db, HEARTBEAT_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  return Number.isFinite(ts) && now - ts < HEARTBEAT_FRESH_MS;
}

/** 最後の心拍の時刻[epoch ms]。無い/壊れていれば null。
 *  ★`isCollectorAlive` は **アラートの単一書き手の調停** に使われている判定(45秒)で、
 *    ここは表示・書き出し用の別判定(server/collectorWatch.ts)が使う生の材料。
 *    調停側の閾値を表示の都合で動かすと取引/記録の挙動が変わるので、**分けておく**。 */
export function readHeartbeatAt(db: DatabaseSync): number | null {
  const raw = getMeta(db, HEARTBEAT_KEY);
  if (!raw) return null;
  const ts = Number(raw);
  return Number.isFinite(ts) ? ts : null;
}
