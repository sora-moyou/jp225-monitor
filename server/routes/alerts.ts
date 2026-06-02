import type { Request, Response } from 'express';
import { openDb, resolveDbPath, getRecentAlerts } from '../db/store.js';
import { summarize, kindLabel } from '../alertHistory.js';

export function alertsHistoryHandler(req: Request, res: Response): void {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  try {
    const db = openDb(resolveDbPath());
    try {
      const rows = getRecentAlerts(db, limit);
      const alerts = rows.map(r => ({ ...r, kind: kindLabel(r.window_seconds) }));
      res.json({ ok: true, alerts, stats: summarize(rows) });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'history failed' });
  }
}
