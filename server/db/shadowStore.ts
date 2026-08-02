// 影(決済パラメータを振った模擬)の記録先。**専用 DB ファイル**。
//
// ■ なぜ共有 DB(jp225.db)に入れないか
//   trade2 の priceSnapshotWorker が 30分ごとに **DB 全体を `VACUUM INTO`** して prices_<host>.db を作る。
//   実測 102MB で約1.3秒の同期ブロック。ここを太らせるほど実弾トレードのフィード/発注/約定検知を
//   止めるリスクが増える。→ ティック保管(db/tickArchive.ts)と同じ判断で **別ファイル** に置く。
//   (trade2 は %APPDATA%/jp225-monitor を列挙せず jp225.db と server.log しか見ないので、
//    別ファイルを置くだけで自動的に VACUUM INTO の対象外になる。相手側の変更は不要。)
//
// ■ 書き込みは必ず「まとめて・取引経路の外で」
//   SQLite の書き込みは WAL チェックポイントやディスクの詰まりでブロックしうる。例外の隔離だけでは足りない。
//   → 模擬(ShadowSim)は行をメモリに積むだけで、この store には触らない。フラッシュは別の呼び出し元が行う。
//
// ■ 列は最初から全部持たせる(後から足すと期の境界が曖昧になる)
//   epoch / param_class / censored / source / concurrent は、後続作業ではなく **今** 作る。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ShadowRow } from '../signalTrade/shadow/sim.js';

/** 影の記録 DB のパス(%APPDATA%/jp225-monitor/shadow_exits.db)。
 *  JP225_SHADOW_DB で上書きできる(隔離テスト/オフライン再生の検証用)。 */
export function resolveShadowDbPath(): string {
  const env = process.env.JP225_SHADOW_DB;
  if (env && env.trim()) return env.trim();
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  const dir = join(base, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'shadow_exits.db');
}

/** 影の記録スキーマ。
 *  ★UNIQUE(epoch, source, proposal_id, spec): 同じ提案 × 同じ決済仕様の影は1行だけ。
 *    再生を2回流しても二重計上しない(INSERT OR IGNORE と対で効く)。 */
export function initShadowSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_exits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch        TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      proposal_id  TEXT    NOT NULL,
      spec         TEXT    NOT NULL,
      param_class  TEXT    NOT NULL,
      dir          TEXT    NOT NULL,
      armed_t      INTEGER NOT NULL,
      armed_price  REAL,
      entry_t      INTEGER,
      entry_price  REAL,
      entry_leg    TEXT,
      initial_stop REAL,
      exit_t       INTEGER,
      exit_price   REAL,
      exit_reason  TEXT,
      pnl          REAL,
      outcome      TEXT    NOT NULL,
      censored     INTEGER NOT NULL,
      censor_reason TEXT,
      unrealized   REAL,
      mfe          REAL,
      mae          REAL,
      peak_profit  REAL,
      hold_ms      INTEGER,
      elapsed_ms   INTEGER NOT NULL,
      horizon_ms   INTEGER NOT NULL,
      concurrent   INTEGER NOT NULL,
      ticks        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      UNIQUE (epoch, source, proposal_id, spec)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_proposal ON shadow_exits (proposal_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_spec ON shadow_exits (epoch, spec);
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
}

export function openShadowDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initShadowSchema(db);
  return db;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO shadow_exits (
    epoch, source, proposal_id, spec, param_class, dir,
    armed_t, armed_price, entry_t, entry_price, entry_leg, initial_stop,
    exit_t, exit_price, exit_reason, pnl,
    outcome, censored, censor_reason, unrealized, mfe, mae, peak_profit,
    hold_ms, elapsed_ms, horizon_ms, concurrent, ticks, created_at
  ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?)
`;

/** 数値は非有限なら NULL(NaN/Infinity を DB に置かない)。 */
function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** 影の行をまとめて追記する(1トランザクション)。挿入できた件数を返す。
 *  ★重複(同 epoch/source/proposal/spec)は静かに無視ではなく、戻り値の差で分かるようにする。 */
export function insertShadowRows(db: DatabaseSync, rows: readonly ShadowRow[]): { inserted: number; skipped: number } {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(INSERT_SQL);
  const before = countShadowRows(db);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.epoch, r.source, r.proposalId, r.spec, r.paramClass, r.dir,
        r.armedT, num(r.armedPrice), num(r.entryT), num(r.entryPrice), r.entryLeg, num(r.initialStop),
        num(r.exitT), num(r.exitPrice), r.exitReason, num(r.pnl),
        r.outcome, r.censored ? 1 : 0, r.censorReason, num(r.unrealized), num(r.mfe), num(r.mae), num(r.peakProfit),
        num(r.holdMs), r.elapsedMs, r.horizonMs, r.concurrent, r.ticks, r.createdAt,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const inserted = countShadowRows(db) - before;
  return { inserted, skipped: rows.length - inserted };
}

export function countShadowRows(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM shadow_exits').get() as { n: number }).n;
}

/** 集計の入口(分析用)。**打ち切りは決済と混ぜない** ので outcome 別に数える。 */
export function shadowOutcomeCounts(db: DatabaseSync, epoch?: string): Array<{ spec: string; outcome: string; n: number }> {
  const sql = epoch
    ? 'SELECT spec, outcome, COUNT(*) AS n FROM shadow_exits WHERE epoch = ? GROUP BY spec, outcome ORDER BY spec, outcome'
    : 'SELECT spec, outcome, COUNT(*) AS n FROM shadow_exits GROUP BY spec, outcome ORDER BY spec, outcome';
  const stmt = db.prepare(sql);
  const rows = (epoch ? stmt.all(epoch) : stmt.all()) as unknown as Array<{ spec: string; outcome: string; n: number }>;
  return rows;
}
