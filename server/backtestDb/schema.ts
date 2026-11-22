// バックテスト用DB(Desktop/backtest-multiyear.db)の「使いやすさ」のための表とビュー。
// ★既存の表 bars_1m の列・主キーは変えない(jp225-Trade の ReplayFeed が直接読む)。ここで足すのは
//   dataset_info(表)と bars_jst / sessions(ビュー)だけ。何度呼んでも同じ状態になる(冪等)。
// ★既存の meta 表は monitor(jp225.db)と同じスキーマの空表なので使わない(用途が混ざる)。
// 呼ぶ側: scripts/backtest-db/*.mts と scripts/append-backtest-db.mts。説明書: docs/backtest-db.md。
import type { DatabaseSync } from 'node:sqlite';

/** DatabaseSync の第2引数。readOnly は node 24 ランタイムにあるが @types/node@20 の型に無いため
 *  キャストで通す(server/db/generatorStore.ts・ledgerExport.ts と同じ作法)。 */
export function dbOpenOptions(readOnly: boolean): ConstructorParameters<typeof DatabaseSync>[1] {
  return { readOnly } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
}
import type { SessionSpan } from './holidayNights.js';

export const BACKTEST_DB_SCHEMA_VERSION = '1';
export const BACKTEST_SYMBOL = 'NIY=F';
const JST_MS = 9 * 3600_000;

/** epoch ms → 'YYYY-MM-DD HH:MM'(JST)。 */
export const jstMinute = (t: number): string => new Date(t + JST_MS).toISOString().replace('T', ' ').slice(0, 16);
/** epoch ms → 'YYYY-MM-DD HH:MM:SS'(JST)。記録の時刻用。 */
export const jstSecond = (t: number): string => new Date(t + JST_MS).toISOString().replace('T', ' ').slice(0, 19);

// t(UTC ms)→ JST 文字列。t/1000 は整数除算(t は分ちょうど)。+32400 秒 = +9h。
const JST_EXPR = (col: string) => `${col} / 1000 + 32400, 'unixepoch'`;

const STATIC_INFO: Record<string, string> = {
  schema_version: BACKTEST_DB_SCHEMA_VERSION,
  description: '日経225先物(mini)の1分足。バックテスト用。表 bars_1m(1行=1分足)。説明書は同じフォルダの backtest-multiyear.README.md',
  source: '225labo N225minif_YYYY.xlsx(1min シート)→ 2026-11-16 以降は GitHub release basedata-latest(同じ xlsx を変換したもの)から平日 08:30/16:00 に自動追記',
  symbol: BACKTEST_SYMBOL,
  time_convention: 't = 足の開始時刻・エポックms(UTC)。JST = t + 9h。session_date = セッションが始まった日(夜間 0:00-6:00 も前日の日付)',
};

/** dataset_info 表とビューを作る(冪等)。ビューは定義を更新できるよう DROP→CREATE。
 *  ★全体を1トランザクションで行う(DROP の後・CREATE の前に他の読み手が「ビューが無い」瞬間を見ない)。
 *    呼び手が既にトランザクション中(修復・補充の BEGIN IMMEDIATE の中)なら SAVEPOINT で入れ子にし、
 *    そうでなければ自分で BEGIN IMMEDIATE する。 */
export function ensureBacktestDbSchema(db: DatabaseSync): void {
  // isTransaction は node 24 ランタイムにあるが、このリポの node:sqlite 型宣言には無い
  const inTx = (db as unknown as { isTransaction?: boolean }).isTransaction === true;
  db.exec(inTx ? 'SAVEPOINT ensure_backtest_schema' : 'BEGIN IMMEDIATE');
  try {
    ensureSchemaBody(db);
    db.exec(inTx ? 'RELEASE ensure_backtest_schema' : 'COMMIT');
  } catch (e) {
    try {
      db.exec(inTx ? 'ROLLBACK TO ensure_backtest_schema; RELEASE ensure_backtest_schema' : 'ROLLBACK');
    } catch { /* 元の例外を優先 */ }
    throw e;
  }
}

function ensureSchemaBody(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dataset_info ( key TEXT PRIMARY KEY, value TEXT );
    DROP VIEW IF EXISTS bars_jst;
    CREATE VIEW bars_jst AS
      SELECT b.*,
        strftime('%Y-%m-%d %H:%M', ${JST_EXPR('b.t')}) AS ts_jst,
        date(${JST_EXPR('b.t')})                        AS date_jst,
        strftime('%H:%M', ${JST_EXPR('b.t')})          AS time_jst
      FROM bars_1m b;
    DROP VIEW IF EXISTS sessions;
    CREATE VIEW sessions AS
      SELECT g.symbol, g.session_date, g.session, g.start_t, g.end_t,
        strftime('%Y-%m-%d %H:%M', ${JST_EXPR('g.start_t')}) AS start_jst,
        strftime('%Y-%m-%d %H:%M', ${JST_EXPR('g.end_t')})   AS end_jst,
        (SELECT o FROM bars_1m x WHERE x.symbol = g.symbol AND x.t = g.start_t) AS open,
        g.high, g.low,
        (SELECT c FROM bars_1m x WHERE x.symbol = g.symbol AND x.t = g.end_t)   AS close,
        g.volume, g.bars
      FROM (
        SELECT symbol, session_date, session, MIN(t) AS start_t, MAX(t) AS end_t,
               MAX(h) AS high, MIN(l) AS low, SUM(volume) AS volume, COUNT(*) AS bars
        FROM bars_1m GROUP BY symbol, session_date, session
      ) g
      ORDER BY g.symbol, g.start_t;
  `);
  const up = db.prepare('INSERT INTO dataset_info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(STATIC_INFO)) up.run(k, v);
}

export function setDatasetInfo(db: DatabaseSync, entries: Record<string, string | number>): void {
  const up = db.prepare('INSERT INTO dataset_info(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(entries)) up.run(k, String(v));
}

export function getDatasetInfo(db: DatabaseSync): Record<string, string> {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dataset_info'").get();
  if (!has) return {};
  const out: Record<string, string> = {};
  for (const r of db.prepare('SELECT key, value FROM dataset_info').all() as { key: string; value: string }[]) out[r.key] = r.value;
  return out;
}

/** 件数・期間・セッション数を数えて dataset_info に書く(実測値)。 */
export function refreshDatasetStats(db: DatabaseSync, symbol = BACKTEST_SYMBOL): { bars: number; first: number; last: number; sessions: number } {
  const r = db.prepare(`SELECT COUNT(*) n, MIN(t) a, MAX(t) b, COUNT(DISTINCT session_date || '/' || session) s
    FROM bars_1m WHERE symbol = ?`).get(symbol) as { n: number; a: number; b: number; s: number };
  setDatasetInfo(db, {
    bar_count: r.n, session_count: r.s,
    first_bar_jst: jstMinute(r.a), last_bar_jst: jstMinute(r.b),
    first_bar_t: r.a, last_bar_t: r.b,
    stats_counted_at_jst: jstSecond(Date.now()),
  });
  return { bars: r.n, first: r.a, last: r.b, sessions: r.s };
}

/** (session_date, session) 単位の min/max(t)・本数。ビューを使わず直接集計(スキーマ準備前でも動く)。 */
export function loadSessionSpans(db: DatabaseSync, symbol = BACKTEST_SYMBOL): SessionSpan[] {
  return (db.prepare(`SELECT session_date sd, session s, MIN(t) a, MAX(t) b, COUNT(*) n
      FROM bars_1m WHERE symbol = ? GROUP BY session_date, session ORDER BY a`).all(symbol) as
      { sd: string; s: string; a: number; b: number; n: number }[])
    .map(r => ({ sessionDate: r.sd, session: r.s, startT: r.a, endT: r.b, bars: r.n }));
}
