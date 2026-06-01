import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

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
  `);
  const cols = (db.prepare('PRAGMA table_info(bars_1m)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('session_date')) db.exec('ALTER TABLE bars_1m ADD COLUMN session_date TEXT');
  if (!cols.includes('session')) db.exec('ALTER TABLE bars_1m ADD COLUMN session TEXT');
  if (!cols.includes('volume')) db.exec('ALTER TABLE bars_1m ADD COLUMN volume INTEGER');
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

export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number;
}

/** セッション(session_date+session)別の OHLC と H/L 発生時刻。新しい順(直近が先)、最大 limit 件。 */
export function getSessionOHLC(db: DatabaseSync, symbol: string, limit: number): SessionOHLC[] {
  const rows = db.prepare(`
    SELECT session_date AS sessionDate, session,
           MAX(h) AS high, MIN(l) AS low,
           (SELECT o FROM bars_1m b2 WHERE b2.symbol=b.symbol AND b2.session_date=b.session_date
              AND b2.session=b.session ORDER BY t ASC  LIMIT 1) AS open,
           (SELECT c FROM bars_1m b3 WHERE b3.symbol=b.symbol AND b3.session_date=b.session_date
              AND b3.session=b.session ORDER BY t DESC LIMIT 1) AS close,
           (SELECT t FROM bars_1m b4 WHERE b4.symbol=b.symbol AND b4.session_date=b.session_date
              AND b4.session=b.session ORDER BY h DESC, t ASC LIMIT 1) AS highT,
           (SELECT t FROM bars_1m b5 WHERE b5.symbol=b.symbol AND b5.session_date=b.session_date
              AND b5.session=b.session ORDER BY l ASC,  t ASC LIMIT 1) AS lowT
    FROM bars_1m b
    WHERE symbol = ? AND session_date IS NOT NULL AND session IS NOT NULL
    GROUP BY session_date, session
    ORDER BY MIN(t) DESC
    LIMIT ?
  `).all(symbol, limit) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    sessionDate: r.sessionDate as string,
    session: r.session as 'Day' | 'Night',
    open: r.open as number, high: r.high as number, low: r.low as number, close: r.close as number,
    highT: r.highT as number, lowT: r.lowT as number,
  }));
}
