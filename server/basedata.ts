import type { DatabaseSync } from 'node:sqlite';
import { upsertBar } from './db/store.js';
import { classifySession } from '../collector/session.js';

const SYMBOL = 'NIY=F';
const EXCEL_1970 = 25569;          // 1970-01-01 の Excel シリアル(1900日付系)。(serial-25569)*86400_000 = UTC epoch ms
const JST_OFFSET_MS = 9 * 3600_000;

export interface BaseBar { t: number; o: number; h: number; l: number; c: number; v: number | null; }

/** Excel シリアル日付 + 1日小数の時間 → bar(JST 壁時計→UTC epoch, 分床)。
 *  日付列(A)は「実カレンダー日付」(セッション開始日ではない)。夜間立会の翌朝(00:00-06:00)の
 *  バーも実日付=翌日のシリアルでラベルされる。よって日付シフト補正は一切不要で、
 *  serial(日付)+ frac(時刻)を JST として UTC epoch に変換するだけでよい。
 *  早朝portionの Night セッション帰属は classifySession が前日始まりとして正しく処理する。
 *  (旧実装は A列をセッション日と誤認し早朝(<7:00)に+1日していたため夜間バーが翌日=未来へずれていた) */
export function rowToBar(serialDate: number, timeFrac: number,
  o: number, h: number, l: number, c: number, v: number | null): BaseBar {
  const dayMs = (serialDate - EXCEL_1970) * 86400_000;
  const minMs = Math.round((timeFrac * 86400_000) / 60_000) * 60_000;
  const t = dayMs + minMs - JST_OFFSET_MS;
  return { t, o, h, l, c, v };
}

export function parseNdjsonLine(line: string): BaseBar | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if ([o?.t, o?.o, o?.h, o?.l, o?.c].some(x => typeof x !== 'number')) return null;
    return { t: o.t, o: o.o, h: o.h, l: o.l, c: o.c, v: typeof o.v === 'number' ? o.v : null };
  } catch { return null; }
}

export interface ImportResult { inserted: number; updated: number; skipped: number; from: number; to: number; total: number; }

/** bars を session 付与して upsert。session=null(休場/場外)はスキップ。削除はしない。
 *  ~13万行を1トランザクションで一括コミット(行ごとの autocommit だと WAL の fsync で激遅)。 */
export function importBars(db: DatabaseSync, bars: BaseBar[]): ImportResult {
  let applied = 0, skipped = 0, from = Infinity, to = -Infinity;
  db.exec('BEGIN');
  try {
    for (const b of bars) {
      const s = classifySession(b.t);
      if (!s) { skipped++; continue; }
      upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
      applied++; if (b.t < from) from = b.t; if (b.t > to) to = b.t;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { inserted: applied, updated: 0, skipped, from: from === Infinity ? 0 : from, to: to === -Infinity ? 0 : to, total: bars.length };
}
