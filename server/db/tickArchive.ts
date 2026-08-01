// ティックの長期保管(将来の分析用・RECORD-ONLY)。
//
// ■ なぜ専用 DB に分けるか
//   共有 DB(%APPDATA%/jp225-monitor/jp225.db)は trade2 の priceSnapshotWorker が **DB 全体を
//   `VACUUM INTO`** して 30 分ごとに prices_<host>.db へ書き出す。実測で 102MB の VACUUM INTO は
//   **約1.3秒の同期ブロック**になる(trade2 側のコメント)。ティックを長期に溜めるほどこの複製が
//   重くなり、実弾トレードのフィード処理/発注/約定検知を止めるリスクが増す。
//   → 長期ティックは **別ファイル** に置き、30分スナップショットの対象から外す。
//     (trade2 は %APPDATA%/jp225-monitor を列挙せず jp225.db と server.log しか見ないため、
//      別ファイルを置くだけで自動的に対象外になる。相手側の変更は不要。)
//
// ■ ★自動削除の規則を置かない
//   「3日で自動削除」という規則が、まさに今回の欠損の原因だった。それを「400日で自動削除」に
//   置き換えるのは同じ地雷を先送りするだけで、無音のデータ破壊であることは変わらない。
//   → **このモジュールは削除関数を一切公開しない**。不要になったら人間が明示的にファイルを消す。
//   実測 NIY=F は 35,860 件/日 ≒ 300MB/年。運用機の空きは 250GB なので容量監視も置かない。
//
// ■ 保持対象は NIY=F だけ
//   分析対象(保有時間の中央値=1分足2本・同一バー内の順序が結果を決める)は日経先物のみ。
//   他3銘柄(YM=F / NQ=F / JPY=X)は共有 DB で従来どおり3日 prune のまま(ここには書かない)。

import { DatabaseSync } from 'node:sqlite';
import { join, isAbsolute } from 'node:path';
import { mkdirSync, existsSync, rmSync, renameSync, readFileSync, statSync } from 'node:fs';
import { classifySession } from '../../core/session.js';
import type { Price } from '../types.js';
import type { Tick } from './store.js';

/** 長期保管する銘柄。ここに無い銘柄は archive DB に一切書かない。 */
export const ARCHIVED_SYMBOLS: readonly string[] = ['NIY=F'];

/** 長期ティック DB のパス(%APPDATA%/jp225-monitor/ticks_archive.db)。
 *  共有 DB(jp225.db)と同じフォルダに置くが **別ファイル**なので trade2 の VACUUM INTO 対象外。
 *  JP225_TICK_ARCHIVE_DB で上書きできる(隔離テスト/検証用)。 */
export function resolveTickArchiveDbPath(): string {
  const env = process.env.JP225_TICK_ARCHIVE_DB;
  if (env && env.trim()) return env.trim();
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  const dir = join(base, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'ticks_archive.db');
}

/** archive DB のスキーマ。共有 DB の ticks と **同一の列**(symbol,t,price)にしてある:
 *  既存の解析スクリプト(ticks を読むもの)がそのまま動き、prices_<host>.db の ticks とも直接突合できる。
 *  session_date/session は t の純関数(classifySession)なので列に持たない(9M行×文字列は無駄に重い)。 */
export function initTickArchiveSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
}

export function openTickArchiveDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initTickArchiveSchema(db);
  return db;
}

export function getArchiveMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setArchiveMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

/** fresh(非 stale)かつ場中の **ARCHIVED_SYMBOLS のみ** を archive DB へ追記する。書いた件数を返す。
 *  共有 DB への記録(collector/record.ts の recordFeedPrices)とは独立=既存の記録経路は不変。 */
export function archiveTicks(db: DatabaseSync, prices: readonly Price[]): number {
  const stmt = db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)');
  let n = 0;
  for (const p of prices) {
    if (p.stale) continue;
    if (!ARCHIVED_SYMBOLS.includes(p.symbol)) continue;
    if (!Number.isFinite(p.price) || p.price <= 0) continue;
    if (!classifySession(p.timestamp)) continue;   // 場外tickは共有DBと同じく破棄
    stmt.run(p.symbol, p.timestamp, p.price);
    n++;
  }
  return n;
}

export function getArchiveTicks(db: DatabaseSync, symbol: string, fromT: number, toT: number): Tick[] {
  return db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? AND t >= ? AND t < ? ORDER BY t ASC',
  ).all(symbol, fromT, toT) as unknown as Tick[];
}

// ─── セッション日 → 実時刻レンジ ───────────────────────────────
// session_date=D の ticks は必ず [D 08:45 JST, D+1 06:00 JST) に入る(core/session.ts の規約:
// Day=D 08:45–15:45 / Night=D 17:00→D+1 06:00・翌朝の続きも sessionDate=D)。
// 15:45–17:00 の空白帯に tick は無く(場外は記録しない)、D+1 00:00–06:00 は sessionDate=D なので
// このレンジは **過不足なく** D のティックだけを含む。

const JST_OFFSET = 9 * 60 * 60_000;

/** 'YYYY-MM-DD' のセッション日が占める実時刻レンジ [start, end)(epoch ms)。 */
export function sessionDateRange(sessionDate: string): { start: number; end: number } {
  const [y, m, d] = sessionDate.split('-').map(Number) as [number, number, number];
  const start = Date.UTC(y, m - 1, d, 8, 45) - JST_OFFSET;
  const end = Date.UTC(y, m - 1, d + 1, 6, 0) - JST_OFFSET;
  return { start, end };
}

/** セッション日が確定(=以後そのセッション日の tick は増えない)とみなすまでの猶予。
 *  D+1 06:00 JST の終了から更に1時間待って書き出す(遅延到着・時計ずれの保険)。 */
export const EXPORT_SETTLE_MS = 60 * 60_000;

/** その session_date のティックがもう増えないか。 */
export function isSessionDateFinalized(sessionDate: string, now: number): boolean {
  return now >= sessionDateRange(sessionDate).end + EXPORT_SETTLE_MS;
}

/** 書き出し済みカーソル(この日まで書き出した)の meta キー。 */
const exportCursorKey = (symbol: string): string => `export:lastSessionDate:${symbol}`;

/** まだ書き出していない **確定済み** セッション日を古い順に返す(最大 max 件)。
 *  カーソル(meta)以降の最小 t を PK 索引で拾い、その t のセッション日を採る、を繰り返す
 *  (DISTINCT 全表スキャンを避ける = 900万行でも O(log n) × 日数)。 */
export function pendingExportDates(db: DatabaseSync, symbol: string, now: number, max = 32): string[] {
  const cursor = getArchiveMeta(db, exportCursorKey(symbol));
  let fromT = cursor ? sessionDateRange(cursor).end : 0;
  const out: string[] = [];
  const minStmt = db.prepare('SELECT MIN(t) AS m FROM ticks WHERE symbol = ? AND t >= ?');
  while (out.length < max) {
    const m = (minStmt.get(symbol, fromT) as { m: number | null }).m;
    if (m == null) break;
    const s = classifySession(m);
    if (!s) { fromT = m + 1; continue; }   // 理論上来ないが、来ても止まらない
    const { end } = sessionDateRange(s.sessionDate);
    if (now < end + EXPORT_SETTLE_MS) break;   // まだ確定していない=書き出さない
    out.push(s.sessionDate);
    fromT = end;
  }
  return out;
}

/** 書き出しファイル名の銘柄ラベル('NIY=F' → 'NIY')。 */
export function symbolLabel(symbol: string): string {
  return symbol.replace(/=F$/, '').replace(/[^A-Za-z0-9]/g, '_');
}

/** 日次書き出しのファイル名 `ticks_NIY_YYYY-MM-DD.db`。 */
export function dailyExportFileName(symbol: string, sessionDate: string): string {
  return `ticks_${symbolLabel(symbol)}_${sessionDate}.db`;
}

/** sessionDate を結果に持たせるのは、健全性ハートビート(tickArchiveHeartbeat.ts)が
 *  「最後に書き出した日」を記録するため。ファイル名から逆パースするより壊れにくい。 */
export interface DailyExportResult { file: string; sessionDate: string; rows: number; bytes: number; skipped: boolean; }

/** 確定済みセッション日1日分の ticks を単独 DB ファイルへ書き出す(append-only・冪等)。
 *  - 既にファイルが在れば **一切触らない**(skipped=true)。過去日は不変なので上書きしない。
 *  - 一時ファイルへ書いてから rename(部分書き込みのファイルを同期フォルダに置かない)。
 *  - 行が0件なら null(その日はデータ無し=ファイルを作らない)。 */
export function exportDailyTicks(
  src: DatabaseSync, symbol: string, sessionDate: string, destDir: string,
): DailyExportResult | null {
  const file = join(destDir, dailyExportFileName(symbol, sessionDate));
  if (existsSync(file)) return { file, sessionDate, rows: 0, bytes: statSync(file).size, skipped: true };

  const { start, end } = sessionDateRange(sessionDate);
  const rows = getArchiveTicks(src, symbol, start, end);
  if (rows.length === 0) return null;

  mkdirSync(destDir, { recursive: true });
  const tmp = `${file}.tmp`;
  for (const p of [tmp, `${tmp}-wal`, `${tmp}-shm`]) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } }

  // 書き出し先は WAL にしない(単一ファイルでそのまま同期できるように)。
  const out = new DatabaseSync(tmp);
  try {
    initTickArchiveSchema(out);
    const ins = out.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)');
    out.exec('BEGIN');
    for (const r of rows) ins.run(r.symbol, r.t, r.price);
    out.exec('COMMIT');
    const meta = out.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    meta.run('symbol', symbol);
    meta.run('session_date', sessionDate);
    meta.run('rows', String(rows.length));
    meta.run('first_t', String(rows[0]!.t));
    meta.run('last_t', String(rows[rows.length - 1]!.t));
    meta.run('created_at', String(Date.now()));
  } finally {
    out.close();
  }
  renameSync(tmp, file);
  return { file, sessionDate, rows: rows.length, bytes: statSync(file).size, skipped: false };
}

// ─── 日次書き出しの置き場所(同期フォルダ) ──────────────────────
// 同期フォルダのパスは **trade2 の書き出し設定** が持っている(%APPDATA%/jp225-trade/export.json の
// exportDir・UI で設定する項目)。monitor 側に同じ設定をもう1つ作ると二重管理になり、片方だけ直して
// 無音でズレる。→ **同じ設定を読むだけ**にして相乗りする(trade2 のコードは変更しない)。
// 未設定/trade2 未導入なら書き出しをスキップするだけ(ティックは archive DB に溜まり続けるので損失ゼロ)。

/** Windows の「パスのコピー」が付ける前後の引用符を除去する(trade2 の cleanPathInput と同じ実害対策:
 *  引用符付きパスが相対扱いになり AppData 配下へ mkdir → 空エクスポートになる事故が実際に起きている)。 */
export function cleanPathInput(s: string): string {
  const t = s.trim();
  return (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1).trim() : t;
}

/** 日次書き出しの宛先フォルダ。'' = 未設定(=書き出さない)。
 *  優先順: ①JP225_TICK_EXPORT_DIR(隔離テスト/上書き) → ②trade2 の export.json の exportDir。
 *  絶対パスでないものは拒否する('' 扱い)。 */
export function resolveTickExportDir(): string {
  const env = process.env.JP225_TICK_EXPORT_DIR;
  if (env && cleanPathInput(env)) {
    const p = cleanPathInput(env);
    return isAbsolute(p) ? p : '';
  }
  try {
    const cfg = join(process.env.APPDATA ?? process.env.HOME ?? '', 'jp225-trade', 'export.json');
    if (!existsSync(cfg)) return '';
    const raw = JSON.parse(readFileSync(cfg, 'utf-8')) as { exportDir?: unknown };
    if (typeof raw.exportDir !== 'string') return '';
    const p = cleanPathInput(raw.exportDir);
    return p && isAbsolute(p) ? p : '';
  } catch {
    return '';
  }
}

/** 確定済みで未書き出しの日をすべて書き出し、カーソルを進める。書き出した結果の一覧を返す。
 *  destDir が '' なら何もしない(カーソルも進めない=設定後に遡って書き出せる)。 */
export function runDailyTickExport(
  db: DatabaseSync, now: number, destDir: string, symbols: readonly string[] = ARCHIVED_SYMBOLS,
): DailyExportResult[] {
  if (!destDir) return [];
  const done: DailyExportResult[] = [];
  for (const symbol of symbols) {
    for (const date of pendingExportDates(db, symbol, now)) {
      const r = exportDailyTicks(db, symbol, date, destDir);
      if (r) done.push(r);
      setArchiveMeta(db, exportCursorKey(symbol), date);   // 0件の日もカーソルは進める(再走査しない)
    }
  }
  return done;
}
