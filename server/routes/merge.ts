import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { mergeFrom, backupViaVacuum, isValidSourceDb } from '../db/mergeDb.js';
import { stopCollector, stopTrade } from '../processControl.js';

function ts(): string {
  // YYYYMMDD-HHMMSS。Date は実行時に使用(server プロセス内・Workflow 制約は無関係)。
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

export function mergeHandler(req: Request, res: Response): void {
  const source = (req.body as { source?: unknown })?.source;
  if (typeof source !== 'string' || !source) { res.status(400).json({ ok: false, error: 'source path required' }); return; }
  if (!existsSync(source)) { res.status(400).json({ ok: false, error: `source not found: ${source}` }); return; }
  if (!isValidSourceDb(DatabaseSync, source)) { res.status(400).json({ ok: false, error: 'not a jp225 DB (alerts/bars_1m/ticks 必須)' }); return; }

  // 外部書き手を停止
  stopCollector();
  stopTrade();

  const dbPath = resolveDbPath();
  const backup = join(dbPath, '..', `jp225.db.bak-merge-${ts()}`);
  const db = openDb(dbPath);   // 専用接続
  try {
    backupViaVacuum(db, backup);
    const inserted = mergeFrom(db, source);   // 同期=原子的
    db.close();
    res.json({ ok: true, inserted, backup });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e),
      note: 'collector/jp225-Trade は停止済み。バックアップから復旧可: ' + backup });
  }
}
