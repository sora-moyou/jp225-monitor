// オフライン再生の **記録側**(覆えた範囲・覆えなかった理由・再開カーソル)。
// 影の行と同じ専用DB(shadow_exits.db)に置く: 行と覆域が別ファイルに散ると、1年後に
// 「件数が思ったより少ない」の答え合わせができない(片方だけコピーされる事故も起きる)。
//
// ■ ★何度走らせても記録が増えないこと
//   影の行は UNIQUE(epoch, source, proposal_id, spec) + INSERT OR IGNORE で二重計上しない。
//   ここの2表も同じ規律にする(UNIQUE + INSERT OR IGNORE)。時刻の列は UNIQUE に **入れない**
//   (入れると走らせるたびに行が増え、冪等性が壊れる)。
//
// ■ ★再開カーソルを「日」にする理由
//   影は提案をまたいで重なる(2分ごとに提案が来るのに地平は480分)ので、途中の任意の tick で
//   中断・再開すると同時生存本数(concurrent)が通しの結果と食い違う。
//   → 再生の単位を **取引日(session_date)** にし、日ごとに ShadowSim を作り直す。
//     日は独立に計算できるので「通しで走らせた結果」と「途中で止めて再開した結果」が一致する。
//
// ■ ★何を書かないか
//   決済の実数値は書かない(載るのは epoch と不透明な spec 名・件数・理由だけ)。

import { DatabaseSync } from 'node:sqlite';

/** 覆域の理由(提案1件がどう扱われたか)。★語彙は既存のものに揃える:
 *  門の名前は engine.ts のログ(reason=refstale / stale / recheck)と ArmGateName、
 *  打ち切りの語は ShadowCensorReason('ticks_exhausted')。 */
export type CoverageReason =
  | 'replayed'                // 影を作った(=覆えた)
  | 'not-directional'         // レンジ提案(対象外)
  | 'not-armable'             // planToArmed が null
  | 'sanity' | 'refstale' | 'stale' | 'recheck'   // A と同じ門で落ちた
  | 'bad-plan'                // 台帳の plan_json が壊れている/無い
  | 'no-live-price'           // ARM 時点の価格をティックから復元できない(門を忠実に適用できない)
  | 'no-ticks'                // ARM 以後のティックが1本も無い(観測できる区間が無い)
  | 'ticks_exhausted'         // 影の途中でティックが切れた(打ち切りで終わった提案)
  | 'armed-outside-session'   // 武装時刻がどの取引日にも属さない
  | 'sim-rejected';           // ShadowSim が拒否(上限超過など・詳細は detail)

export interface CoverageRow {
  sessionDate: string;
  /** 影ラダーの版(= 影の行の epoch)。 */
  ladderEpoch: string;
  /** ★提案の epoch(生成器の版)。影の epoch とは別物なので両方持つ。 */
  epoch: string;
  reason: CoverageReason;
  n: number;
  detail: string | null;
}

export interface ReplayDayRow {
  sessionDate: string;
  ladderEpoch: string;
  /** 再生に使ったティックの区間 [windowFrom, windowTo)。 */
  windowFrom: number;
  windowTo: number;
  ticks: number;
  proposals: number;
  opened: number;
  rowsWritten: number;
  doneAt: number;
}

export function initReplaySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS replay_days (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT    NOT NULL,
      ladder_epoch TEXT    NOT NULL,
      window_from  INTEGER NOT NULL,
      window_to    INTEGER NOT NULL,
      ticks        INTEGER NOT NULL,
      proposals    INTEGER NOT NULL,
      opened       INTEGER NOT NULL,
      rows_written INTEGER NOT NULL,
      done_at      INTEGER NOT NULL,
      UNIQUE (session_date, ladder_epoch)
    );
    CREATE TABLE IF NOT EXISTS replay_coverage (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_date TEXT    NOT NULL,
      ladder_epoch TEXT    NOT NULL,
      epoch        TEXT    NOT NULL,
      reason       TEXT    NOT NULL,
      n            INTEGER NOT NULL,
      detail       TEXT,
      created_at   INTEGER NOT NULL,
      UNIQUE (session_date, ladder_epoch, epoch, reason)
    );
    CREATE INDEX IF NOT EXISTS idx_replay_cov_day ON replay_coverage (session_date);
  `);
}

/** その取引日を、その影ラダーの版で既に再生し終えているか(=再開時に飛ばしてよいか)。
 *  ★ラダーの版が変われば spec の中身が変わりうるので、同じ日でももう一度再生する。 */
export function isDayReplayed(db: DatabaseSync, sessionDate: string, ladderEpoch: string): boolean {
  const r = db.prepare('SELECT 1 AS x FROM replay_days WHERE session_date = ? AND ladder_epoch = ?')
    .get(sessionDate, ladderEpoch) as { x: number } | undefined;
  return r != null;
}

/** 取引日1件ぶんの完了印を **追記** する。既にあれば false(=二重に書かない)。 */
export function recordReplayDay(db: DatabaseSync, r: ReplayDayRow): boolean {
  const before = countReplayDays(db);
  db.prepare(`INSERT OR IGNORE INTO replay_days
    (session_date, ladder_epoch, window_from, window_to, ticks, proposals, opened, rows_written, done_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(
    r.sessionDate, r.ladderEpoch, r.windowFrom, r.windowTo, r.ticks, r.proposals, r.opened, r.rowsWritten, r.doneAt,
  );
  return countReplayDays(db) > before;
}

/** 覆域(理由ごとの件数)を **追記** する。挿入できた件数を返す(重複は無視=冪等)。 */
export function recordCoverage(db: DatabaseSync, rows: readonly CoverageRow[], now: number): { inserted: number; skipped: number } {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const before = countCoverage(db);
  const stmt = db.prepare(`INSERT OR IGNORE INTO replay_coverage
    (session_date, ladder_epoch, epoch, reason, n, detail, created_at) VALUES (?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const r of rows) stmt.run(r.sessionDate, r.ladderEpoch, r.epoch, r.reason, r.n, r.detail, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const inserted = countCoverage(db) - before;
  return { inserted, skipped: rows.length - inserted };
}

export function countReplayDays(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM replay_days').get() as { n: number }).n;
}
export function countCoverage(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM replay_coverage').get() as { n: number }).n;
}

/** 覆域の集計(分析/報告の入口)。理由ごとの合計。 */
export function coverageTotals(db: DatabaseSync, ladderEpoch?: string): Array<{ reason: string; n: number }> {
  const sql = ladderEpoch
    ? 'SELECT reason, SUM(n) AS n FROM replay_coverage WHERE ladder_epoch = ? GROUP BY reason ORDER BY n DESC, reason'
    : 'SELECT reason, SUM(n) AS n FROM replay_coverage GROUP BY reason ORDER BY n DESC, reason';
  const st = db.prepare(sql);
  return (ladderEpoch ? st.all(ladderEpoch) : st.all()) as unknown as Array<{ reason: string; n: number }>;
}
