import type { DatabaseSync } from 'node:sqlite';

export interface MergeResult { alerts: number; bars_1m: number; ticks: number; }

/** sourcePath の jp225 DB を db へ統合(OR IGNORE)。db は v0.6.17 の UNIQUE 同一性索引を持つ前提。
 *  純粋に DB 操作のみ(停止・バックアップ・再起動は呼び出し側)。 */
export function mergeFrom(db: DatabaseSync, sourcePath: string): MergeResult {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
  const src = sourcePath.replace(/\\/g, '/');
  db.exec(`ATTACH DATABASE '${src}' AS src`);
  db.exec('BEGIN');
  try {
    // alerts: id 以外の全列。UNIQUE 同一性索引が重複を弾く。
    const aCols = cols('alerts').filter(n => n !== 'id').join(', ');
    const a = db.prepare(`INSERT OR IGNORE INTO main.alerts (${aCols}) SELECT ${aCols} FROM src.alerts`).run();
    // bars_1m / ticks: PK(symbol,t)。列名明示で列順差を吸収。
    const bCols = cols('bars_1m').join(', ');
    const b = db.prepare(`INSERT OR IGNORE INTO main.bars_1m (${bCols}) SELECT ${bCols} FROM src.bars_1m`).run();
    const tCols = cols('ticks').join(', ');
    const t = db.prepare(`INSERT OR IGNORE INTO main.ticks (${tCols}) SELECT ${tCols} FROM src.ticks`).run();
    db.exec('COMMIT');
    db.exec('DETACH DATABASE src');
    return { alerts: Number(a.changes), bars_1m: Number(b.changes), ticks: Number(t.changes) };
  } catch (e) {
    db.exec('ROLLBACK');
    try { db.exec('DETACH DATABASE src'); } catch { /* ignore */ }
    throw e;
  }
}

/** ライブ(WAL)DB を安全に複製。VACUUM INTO は一貫スナップショットを作る(ファイルコピーは WAL 取りこぼし)。 */
export function backupViaVacuum(db: DatabaseSync, destPath: string): void {
  const dest = destPath.replace(/\\/g, '/');
  db.exec(`VACUUM INTO '${dest}'`);
}

/** source が jp225 DB として妥当か(alerts/bars_1m/ticks を持つ)。開けて確認。 */
export function isValidSourceDb(DatabaseSyncCtor: typeof DatabaseSync, sourcePath: string): boolean {
  try {
    // readOnly は node 24 ランタイムにあるが @types/node@20 の型に無いためキャストで通す。
    const opts = { readOnly: true } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
    const d = new DatabaseSyncCtor(sourcePath, opts);
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    d.close();
    return ['alerts', 'bars_1m', 'ticks'].every(t => names.includes(t));
  } catch { return false; }
}
