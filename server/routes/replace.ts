import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { replaceFrom, backupViaVacuum, isValidSourceDb } from '../db/mergeDb.js';
import { stopCollector, stopTrade } from '../processControl.js';

function ts(): string {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

/** 現在のDBの中身(alerts/bars_1m/ticks)を、source の jp225 DB と完全一致に置き換える。
 *  破壊的だが、置換前に必ず VACUUM INTO で自動バックアップを取る。停止→置換は同期実行。
 *  meta(ローカル設定/ハートビート)は残す。成功後はUIが自動再起動する。 */
export function replaceHandler(req: Request, res: Response): void {
  const source = (req.body as { source?: unknown })?.source;
  if (typeof source !== 'string' || !source) { res.status(400).json({ ok: false, error: 'source path required' }); return; }
  if (!existsSync(source)) { res.status(400).json({ ok: false, error: `source not found: ${source}` }); return; }
  if (!isValidSourceDb(DatabaseSync, source)) { res.status(400).json({ ok: false, error: 'not a jp225 DB (alerts/bars_1m/ticks 必須)' }); return; }

  // 外部書き手を停止(置換中の書き込みを防ぐ)。検証後に行う(不正リクエストでは止めない)。
  stopCollector();
  stopTrade();

  const dbPath = resolveDbPath();
  const backup = join(dbPath, '..', `jp225.db.bak-replace-${ts()}`);
  const db = openDb(dbPath);
  db.exec('PRAGMA busy_timeout=30000');
  try {
    backupViaVacuum(db, backup);
    const replaced = replaceFrom(db, source);   // 同期=原子的(DELETE→INSERT)
    db.close();
    res.json({ ok: true, replaced, backup });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e),
      note: 'collector/jp225-Trade は停止済み。元のDBはバックアップから復旧可: ' + backup });
  }
}
