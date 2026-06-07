import type { Request, Response } from 'express';
import { existsSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { openDb, resolveDbPath } from '../db/store.js';
import { backupViaVacuum } from '../db/mergeDb.js';

/** このPCのライブ DB を dest へエクスポート(VACUUM INTO で一貫スナップショット)。
 *  DB は変更しない(読み取りのみ)。停止・再起動は不要。 */
export function exportHandler(req: Request, res: Response): void {
  const dest = (req.body as { dest?: unknown })?.dest;
  if (typeof dest !== 'string' || !dest) { res.status(400).json({ ok: false, error: 'dest path required' }); return; }
  if (!existsSync(dirname(dest))) { res.status(400).json({ ok: false, error: `保存先フォルダがありません: ${dirname(dest)}` }); return; }

  const db = openDb(resolveDbPath());
  try {
    // VACUUM INTO は既存ファイルへ書けない。保存ダイアログで上書き選択された場合に備え、先に削除する。
    for (const p of [dest, dest + '-wal', dest + '-shm']) { try { if (existsSync(p)) rmSync(p); } catch { /* ignore */ } }
    backupViaVacuum(db, dest);
    db.close();
    const size = existsSync(dest) ? statSync(dest).size : 0;
    res.json({ ok: true, dest, size });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}
