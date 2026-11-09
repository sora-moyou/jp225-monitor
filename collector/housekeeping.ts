// collector の while ループのうち **poll の try の外で DB に書く** 処理(心拍・ティックの間引き)。
//
// ■ なぜ切り出したか(2026-10-27/28 の実事故)
//   以前は index.ts のループで `writeHeartbeat(db, start)` と `pruneTicks(...)` を **try の外** で呼んでいた。
//   基礎データの自動公開(server/basedata.ts の importBars)が DB の書き込みロックを 5秒以上持った朝、
//   writeHeartbeat → setMeta が `database is locked` を投げ、それが async main の unhandledRejection になって
//   collector は exit code=1 で終了した(server/processLog.ts の規約: 記録したうえで落とす)。
//   アプリは collector を起動時に1回 spawn するだけだったので、そのまま13日間止まった。
//
// ■ 方針: 1回の失敗では周回を止めない。ただし **無音にしない**
//   poll の失敗と同じ流儀(pollErrorStreak / shouldReportStreak / appendSpawnLog)で、
//   連続失敗を sidecar-spawn.log に残し、復帰したらそれも残す
//   (monitor が meta に載せ、既存の同期で別PCまで届く)。
//
// ■ ここに置く理由: index.ts は import した瞬間に main() が走るのでテストから呼べない。
//   失敗を握る部分をここに集め、テストで「ロックされた DB でも例外を外へ出さない」を実際の SQLite で確かめる。

import type { DatabaseSync } from 'node:sqlite';
import { pruneTicks } from '../server/db/store.js';
import { writeHeartbeat } from '../server/collectorHeartbeat.js';
import { appendSpawnLog, shouldReportStreak } from '../server/spawnLog.js';

/** ティックの間引き周期(従来どおり1分に1回)。 */
export const PRUNE_EVERY_MS = 60_000;
/** 共有DB(jp225.db)のティック保持期間(従来どおり3日)。 */
export const TICK_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export interface HousekeepingState {
  /** 最後に間引きを **試みた** 時刻(失敗しても進める=ロック中に2秒ごとに5秒待つのを繰り返さない)。 */
  lastPrune: number;
  /** 心拍の連続失敗回数。 */
  heartbeatStreak: number;
  /** 間引きの連続失敗回数。 */
  pruneStreak: number;
}

export function createHousekeepingState(): HousekeepingState {
  return { lastPrune: 0, heartbeatStreak: 0, pruneStreak: 0 };
}

/** 共用ログへの書き手(テストで差し替える)。 */
export type Reporter = (line: string) => void;

/** 1つの書き込みを「失敗しても投げない・続いたら共用ログに出す・戻ったら出す」で包む。
 *  @returns 成功したら true。 */
function guarded(
  label: string, streak: number, setStreak: (n: number) => void, fn: () => void, report: Reporter,
): boolean {
  try {
    fn();
    if (streak > 0) {
      const line = `[collector] ${label} が復帰しました(直前まで ${streak} 回連続で失敗)`;
      console.log(line);
      report(line);
      setStreak(0);
    }
    return true;
  } catch (err) {
    const n = streak + 1;
    setStreak(n);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[collector] ${label} error(連続 ${n} 回):`, message);
    if (shouldReportStreak(n)) {
      report(`[collector] ★${label} が ${n} 回連続で失敗しています(プロセスは生存・周回は継続): ${message}`);
    }
    return false;
  }
}

/** 心拍を打つ(毎周回・inPollWindow の外でも)。**例外を外へ出さない**。 */
export function runHeartbeatStep(
  db: DatabaseSync, now: number, st: HousekeepingState, report: Reporter = appendSpawnLog,
): boolean {
  return guarded('心拍(writeHeartbeat)', st.heartbeatStreak, n => { st.heartbeatStreak = n; },
    () => writeHeartbeat(db, now), report);
}

/** 1分に1回、3日より古い tick を間引く(bars_1m は長期保持)。**例外を外へ出さない**。
 *  @returns 実行した(=周期が来ていた)かどうかではなく、実行して成功したら true / 失敗 false / 周期外 null。 */
export function runPruneStep(
  db: DatabaseSync, now: number, st: HousekeepingState, report: Reporter = appendSpawnLog,
): boolean | null {
  if (now - st.lastPrune <= PRUNE_EVERY_MS) return null;
  st.lastPrune = now;
  return guarded('ティック間引き(pruneTicks)', st.pruneStreak, n => { st.pruneStreak = n; },
    () => pruneTicks(db, now - TICK_RETENTION_MS), report);
}
