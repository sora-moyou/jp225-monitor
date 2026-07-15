import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { classifySession } from '../../collector/session.js';

/** 共有 DB ファイルのパス (%APPDATA%/jp225-monitor/jp225.db、無ければ HOME/cwd)。 */
export function resolveDbPath(): string {
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  const dir = join(base, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'jp225.db');
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initSchema(db);
  return db;
}

export interface Tick { symbol: string; t: number; price: number; }
export interface Bar1m { symbol: string; session_date: string | null; session: string | null; t: number; o: number; h: number; l: number; c: number; }

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS bars_1m (
      symbol TEXT NOT NULL, session_date TEXT, session TEXT, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL, triggered_at INTEGER NOT NULL,
      direction TEXT, detection_kind TEXT, window_seconds INTEGER,
      change_percent REAL, price REAL,
      session_date TEXT, session TEXT,
      ret5 REAL, ret15 REAL, ret30 REAL,
      reference_kind TEXT, reference_price REAL
    );
    CREATE TABLE IF NOT EXISTS signal_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, dir TEXT NOT NULL,
      exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
      qty INTEGER NOT NULL, rationale TEXT, meta TEXT
    );
  `);
  const cols = (db.prepare('PRAGMA table_info(bars_1m)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('session_date')) db.exec('ALTER TABLE bars_1m ADD COLUMN session_date TEXT');
  if (!cols.includes('session')) db.exec('ALTER TABLE bars_1m ADD COLUMN session TEXT');
  if (!cols.includes('volume')) db.exec('ALTER TABLE bars_1m ADD COLUMN volume INTEGER');
  // v0.6.0: アラートに基準(reference)を記録。既存DBへ後付けマイグレーション。
  const aCols = (db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).map(c => c.name);
  if (!aCols.includes('reference_kind')) db.exec('ALTER TABLE alerts ADD COLUMN reference_kind TEXT');
  if (!aCols.includes('reference_price')) db.exec('ALTER TABLE alerts ADD COLUMN reference_price REAL');
  // v0.6.17: アラートの同一性に UNIQUE インデックスを張り、二重書き込み(collector×monitor の
  // ハートビート陳腐化窓・monitor 二重起動など)による完全一致重複を DB レベルで物理的に禁止する。
  // NULL-safe: SQLite は UNIQUE 索引で NULL を相異と見なす(NULL同士は衝突しない)ため、COALESCE で
  // 既定値に正規化して NULL の reference_price 等も正しく重複判定する。reference_* を含めるので
  // 「同時刻・同種別・別水準」の正当に異なるアラートは衝突せず保持される。
  // 既存DBに重複があると UNIQUE 索引を張れないため、先に id 最小を残して重複を除去(自己修復)。
  const ALERT_IDENTITY = `symbol, triggered_at, COALESCE(detection_kind,''), COALESCE(direction,''), `
    + `COALESCE(window_seconds,-1), COALESCE(reference_kind,''), COALESCE(reference_price,-1)`;
  // 索引が未作成のときだけ重複除去(初回マイグレーションのみ)。以後は UNIQUE 索引が重複を防ぐため、
  // 起動毎の全表スキャン DELETE は不要。
  const hasIdentityIdx = (db.prepare('PRAGMA index_list(alerts)').all() as Array<{ name: string }>)
    .some(i => i.name === 'idx_alerts_identity');
  if (!hasIdentityIdx) {
    db.exec(`DELETE FROM alerts WHERE id NOT IN (SELECT MIN(id) FROM alerts GROUP BY ${ALERT_IDENTITY})`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_identity ON alerts(${ALERT_IDENTITY})`);
  }
  // bars_1m の読み取りはすべて PRIMARY KEY(symbol, t) のレンジで賄える(getSessionOHLC は t 範囲を
  // 読んで JS 側でセッション集計、getRecentBars/getBarClose* も symbol+t)。session_date/session で
  // 絞る索引はもう不要なため作らない(旧 idx_bars_session は書き込み増だけで読みに使われていなかった)。
}

// 生 tick を保存しつつ、その分の 1分足 OHLC を upsert する。
export function recordTick(db: DatabaseSync, symbol: string, t: number, price: number, sessionDate: string, session: string): void {
  if (!Number.isFinite(price) || price <= 0) return;
  db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)').run(symbol, t, price);
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      h = max(h, excluded.h), l = min(l, excluded.l), c = excluded.c
  `).run(symbol, sessionDate, session, minute, price, price, price, price);
}

export function getRecentBars(db: DatabaseSync, symbol: string, sinceT: number): Bar1m[] {
  return db.prepare(
    'SELECT symbol, session_date, session, t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Bar1m[];
}

/** 出来高(volume>0)のあるバーの h/l/volume。価格帯別出来高(ボリュームプロファイル)用。
 *  出来高はリアルタイムフィードに無く基礎データ(週次)由来のため、過去ぶんのみ返る。 */
export function getVolumeBars(db: DatabaseSync, symbol: string, sinceT: number): { h: number; l: number; volume: number }[] {
  return db.prepare(
    'SELECT h, l, volume FROM bars_1m WHERE symbol = ? AND t >= ? AND volume > 0 ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as { h: number; l: number; volume: number }[];
}

export function getRecentTicks(db: DatabaseSync, symbol: string, sinceT: number): Tick[] {
  return db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Tick[];
}

export function getLatestTick(db: DatabaseSync, symbol: string): Tick | null {
  const row = db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? ORDER BY t DESC LIMIT 1',
  ).get(symbol) as Tick | undefined;
  return row ?? null;
}

/** 基礎データ取り込み用。(symbol,t) で OHLCV を全上書き upsert（基礎=正）。削除はしない。 */
export function upsertBar(
  db: DatabaseSync, symbol: string, t: number,
  o: number, h: number, l: number, c: number, volume: number | null,
  sessionDate: string, session: string,
): void {
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
      volume = excluded.volume, session_date = excluded.session_date, session = excluded.session
  `).run(symbol, sessionDate, session, minute, o, h, l, c, volume);
}

/** cutoff(epoch ms) より古い ticks を削除 (bars_1m は残す)。 */
export function pruneTicks(db: DatabaseSync, cutoff: number): void {
  db.prepare('DELETE FROM ticks WHERE t < ?').run(cutoff);
}

/** meta(key/value) テーブルの読み書き。基礎データの取り込み版管理などに使う。 */
export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number; openT: number;   // openT = セッション最初のバー時刻(寄り欠け判定用)
}

export interface AlertRow {
  id: number; symbol: string; triggered_at: number; direction: string | null;
  detection_kind: string | null; window_seconds: number | null;
  change_percent: number | null; price: number | null;
  session_date: string | null; session: string | null;
  ret5: number | null; ret15: number | null; ret30: number | null;
  reference_kind: string | null; reference_price: number | null;
}
export interface AlertInsert {
  symbol: string; triggeredAt: number; direction: string; detectionKind: string;
  windowSeconds: number; changePercent: number; price: number;
  sessionDate: string | null; session: string | null;
  referenceKind?: string | null; referencePrice?: number | null;
}

export function insertAlert(db: DatabaseSync, a: AlertInsert): void {
  // INSERT OR IGNORE: alerts の同一性 UNIQUE インデックス(idx_alerts_identity)違反は黙って無視。
  // collector と monitor(あるいは monitor の二重起動)が同じ確定足アラートを書いても、DBレベルで
  // 完全一致重複が物理的に作られない(プロセス間レース・ハートビート陳腐化窓の最終防壁)。
  db.prepare(`
    INSERT OR IGNORE INTO alerts (symbol, triggered_at, direction, detection_kind, window_seconds,
      change_percent, price, session_date, session, reference_kind, reference_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(a.symbol, a.triggeredAt, a.direction, a.detectionKind, a.windowSeconds,
    a.changePercent, a.price, a.sessionDate, a.session,
    a.referenceKind ?? null, a.referencePrice ?? null);
}

/** Insert an alert only if no row with the same symbol+direction+detection_kind+window_seconds
 *  exists within [triggeredAt - dedupWindowMs, triggeredAt + dedupWindowMs]. Cross-process
 *  near-duplicate guard (monitor + collector overlap). Returns true if inserted. */
export function insertAlertIfNew(db: DatabaseSync, a: AlertInsert, dedupWindowMs: number): boolean {
  const dup = db.prepare(`
    SELECT 1 FROM alerts
    WHERE symbol = ? AND direction = ? AND detection_kind = ?
      AND (window_seconds IS ? OR window_seconds = ?)
      AND triggered_at >= ? AND triggered_at <= ?
    LIMIT 1
  `).get(
    a.symbol, a.direction, a.detectionKind,
    a.windowSeconds, a.windowSeconds,
    a.triggeredAt - dedupWindowMs, a.triggeredAt + dedupWindowMs,
  );
  if (dup) return false;
  insertAlert(db, a);
  return true;
}

/** t 以下で最も新しい bar の close。無ければ null。 */
export function getBarCloseAt(db: DatabaseSync, symbol: string, t: number): number | null {
  const row = db.prepare('SELECT c FROM bars_1m WHERE symbol = ? AND t <= ? ORDER BY t DESC LIMIT 1')
    .get(symbol, t) as { c: number } | undefined;
  return row ? row.c : null;
}

/** target 付近([target - tolBeforeMs, target])で最も新しい bar の close。範囲内に無ければ null。
 *  followup の +N分リターン用。セッション切れ目/収集欠損で +N分の足が無い時、遠い古い足(最悪は発火足)へ
 *  フォールバックして見かけ上 0% になるのを防ぐ(=データ未確定として null=集計除外にする)。 */
export function getBarCloseNear(db: DatabaseSync, symbol: string, t: number, tolBeforeMs: number): number | null {
  const row = db.prepare('SELECT c FROM bars_1m WHERE symbol = ? AND t <= ? AND t >= ? ORDER BY t DESC LIMIT 1')
    .get(symbol, t, t - tolBeforeMs) as { c: number } | undefined;
  return row ? row.c : null;
}

/** ret30 が未確定で、発火から30分以上経過したアラート(事後値動きを埋める対象)。 */
export function getAlertsNeedingFollowup(db: DatabaseSync, now: number): AlertRow[] {
  return db.prepare('SELECT * FROM alerts WHERE ret30 IS NULL AND triggered_at + ? <= ? ORDER BY triggered_at ASC')
    .all(30 * 60_000, now) as unknown as AlertRow[];
}

export function updateAlertReturns(db: DatabaseSync, id: number,
  ret5: number | null, ret15: number | null, ret30: number | null): void {
  db.prepare('UPDATE alerts SET ret5 = ?, ret15 = ?, ret30 = ? WHERE id = ?').run(ret5, ret15, ret30, id);
}

export function getRecentAlerts(db: DatabaseSync, limit: number): AlertRow[] {
  return db.prepare('SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ?')
    .all(limit) as unknown as AlertRow[];
}

/** セッション(session_date+session)別の OHLC と H/L 発生時刻。新しい順(直近が先)、最大 limit 件。 */
export function getSessionOHLC(db: DatabaseSync, symbol: string, limit: number): SessionOHLC[] {
  // セッションは t の純関数(classifySession)。保存列 session_date は collector のバージョン差で
  // null/stale になり得るため信頼せず、読み取り時に t から都度分類して集計する(=自己修復)。
  // 読み取り範囲は「本数」でなくカレンダー日数で決める: 平日は1日2セッション(Day+Night)なので
  // limit セッションは概ね limit/2 平日 ≒ limit*0.7 日に収まる。余裕を持って (limit+α) 日ぶん読めば
  // 取りこぼし無くカバーでき、巨大 lookback でも読み込み行数が際限なく膨らまない(上限 200 日)。
  const DAY_MS = 86_400_000;
  const latest = (db.prepare('SELECT MAX(t) AS m FROM bars_1m WHERE symbol = ?').get(symbol) as { m: number | null }).m;
  if (latest == null) return [];
  const spanDays = Math.min(Math.ceil(limit * 0.8) + 5, 200);
  const rows = db.prepare(
    'SELECT t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, latest - spanDays * DAY_MS) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
  // rows は古→新: open/openT は最初、close は最後、high/low は最初の極値で確定
  const map = new Map<string, SessionOHLC>();
  for (const b of rows) {
    const s = classifySession(b.t);
    if (!s) continue;   // 場外/休場は集計しない
    const key = `${s.sessionDate}|${s.session}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        sessionDate: s.sessionDate, session: s.session,
        open: b.o, high: b.h, low: b.l, close: b.c, highT: b.t, lowT: b.t, openT: b.t,
      });
    } else {
      if (b.h > cur.high) { cur.high = b.h; cur.highT = b.t; }   // 最初に最高値を付けた足
      if (b.l < cur.low) { cur.low = b.l; cur.lowT = b.t; }      // 最初に最安値を付けた足
      cur.close = b.c;                                            // 最後の足の close
    }
  }
  return [...map.values()].sort((a, b) => b.openT - a.openT).slice(0, limit);
}

// ─── トレードシグナル(表示専用・紙トラッキング)の決済履歴 ───
// エントリーは AI(scalp-plan)、決済は非公開 phase-exit。実発注はせず SSE 現在値で擬似約定した
// 1トレード(entry→exit)を決済確定ごとに1行記録する。既存テーブルとは独立(trade2 非干渉)。

export interface SignalTradeRow {
  id: number;
  entry_t: number; entry_price: number; dir: string;
  exit_t: number; exit_price: number; pnl: number; qty: number;
  rationale: string | null; meta: string | null;
}

export interface SignalTradeInsert {
  entryT: number; entryPrice: number; dir: 'buy' | 'sell';
  exitT: number; exitPrice: number; pnl: number; qty: number;
  rationale?: string | null; meta?: string | null;
}

export function insertSignalTrade(db: DatabaseSync, t: SignalTradeInsert): void {
  db.prepare(`
    INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty, rationale, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.entryT, t.entryPrice, t.dir, t.exitT, t.exitPrice, t.pnl, t.qty,
    t.rationale ?? null, t.meta ?? null);
}

/** 決済済みトレードを新しい順(直近が先)で最大 limit 件返す。 */
export function getSignalTrades(db: DatabaseSync, limit = 500): SignalTradeRow[] {
  return db.prepare('SELECT * FROM signal_trades ORDER BY exit_t DESC LIMIT ?')
    .all(Math.max(1, Math.min(2000, limit))) as unknown as SignalTradeRow[];
}

/** 全トレードを削除し、削除件数を返す(設定からの履歴消去用)。 */
export function clearSignalTrades(db: DatabaseSync): number {
  const before = (db.prepare('SELECT COUNT(*) AS n FROM signal_trades').get() as { n: number }).n;
  db.prepare('DELETE FROM signal_trades').run();
  return before;
}
