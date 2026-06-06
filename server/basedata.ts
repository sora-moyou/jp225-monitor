import type { DatabaseSync } from 'node:sqlite';
import { upsertBar } from './db/store.js';
import { classifySession } from '../collector/session.js';
import type { BaseBar } from './basedataDate.js';

// xlsx の日付マッピング(rowToBar / 日付規約)は server/basedataDate.ts が唯一の正準実装(SSOT)。
// publish スクリプトと共有する。ここでは再エクスポートのみ(取り込みは publish 済み NDJSON の t を直接使う)。
export { rowToBar } from './basedataDate.js';
export type { BaseBar } from './basedataDate.js';

const SYMBOL = 'NIY=F';

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
  let applied = 0, skipped = 0, futureDropped = 0, latestFuture = 0, from = Infinity, to = -Infinity;
  const futureCutoff = Date.now() + 2 * 60_000;
  db.exec('BEGIN');
  try {
    for (const b of bars) {
      // 【未来=バグ方針 / 取り込み方法の基準実装】未来日時のバーは日付マッピングのバグなので DB に
      // 入れない。黙って捨てると原因が隠れるためドロップ件数をためて下でエラーログに残す(正しく
      // マッピングできていれば未来バーは存在しないはず)。publish 側(basedata-publish.mts)はこの方針に
      // 合わせて publish 自体を中止する。
      if (b.t > futureCutoff) { futureDropped++; if (b.t > latestFuture) latestFuture = b.t; continue; }
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
  if (futureDropped > 0) {
    console.error(`[basedata] ERROR: dropped ${futureDropped} future-dated bars on import `
      + `(latest ${new Date(latestFuture).toISOString()}, now ${new Date().toISOString()}). `
      + `日付バグ or ソースデータ異常の可能性。server/basedataDate.ts の日付マッピングを確認すること。`);
  }
  return { inserted: applied, updated: 0, skipped, from: from === Infinity ? 0 : from, to: to === -Infinity ? 0 : to, total: bars.length };
}
