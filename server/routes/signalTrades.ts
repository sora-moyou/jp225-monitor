import type { Request, Response } from 'express';
import { openDb, resolveDbPath, getSignalTrades, clearSignalTrades } from '../db/store.js';
import { equitySeries } from '../signalTrade/engine.js';

// トレードシグナル(表示専用・紙トラッキング)の履歴 + 収益曲線。発注系は持たない(表示/管理専用)。

/** GET /api/signal-trades → { ok, trades:[...], equity:[{t,pnl,cum}] }(履歴 + 累積損益点列)。 */
export function signalTradesHandler(req: Request, res: Response): void {
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  try {
    const db = openDb(resolveDbPath());
    try {
      const trades = getSignalTrades(db, limit);
      const equity = equitySeries(trades);
      res.json({ ok: true, trades, equity });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'signal-trades failed' });
  }
}

/** POST /api/signal-trades/clear → { ok, cleared:n }(全削除・設定から呼ぶ)。 */
export function signalTradesClearHandler(_req: Request, res: Response): void {
  try {
    const db = openDb(resolveDbPath());
    try {
      const cleared = clearSignalTrades(db);
      res.json({ ok: true, cleared });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'clear failed' });
  }
}
