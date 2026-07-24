import type { Request, Response } from 'express';
import { openDb, resolveDbPath, getSignalTrades, clearSignalTrades, type SignalSystemFilter } from '../db/store.js';
import { equitySeries, resetSignalEngineIdCounter } from '../signalTrade/engine.js';

// トレードシグナル(表示専用・紙トラッキング)の履歴 + 収益曲線。発注系は持たない(表示/管理専用)。
// ★v0.8.2: 系統 A(実売買)/ B(紙専用)を ?system= で切り替える。既定は A(後方互換=既存クライアントは A を見る)。

/** ?system= を 'A'|'B' に正規化(未指定/不明は 'A')。NULL 行は A 側にまとまる(store 側で吸収)。 */
export function parseSystemQuery(v: unknown): SignalSystemFilter {
  return v === 'B' || v === 'b' ? 'B' : 'A';
}

/** GET /api/signal-trades?system=A|B → { ok, system, trades:[...], equity:[{t,pnl,cum}] }(履歴 + 累積損益点列)。 */
export function signalTradesHandler(req: Request, res: Response): void {
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const system = parseSystemQuery(req.query.system);
  try {
    const db = openDb(resolveDbPath());
    try {
      const trades = getSignalTrades(db, limit, system);
      const equity = equitySeries(trades);
      res.json({ ok: true, system, trades, equity });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'signal-trades failed' });
  }
}

/** POST /api/signal-trades/clear?system=A|B → { ok, system, cleared:n }(その系統のみ削除・設定/履歴から呼ぶ)。 */
export function signalTradesClearHandler(req: Request, res: Response): void {
  const system = parseSystemQuery(req.query.system);
  try {
    const db = openDb(resolveDbPath());
    try {
      // 履歴消去=この系統の signalId をリセットする唯一の契機。永続カウンタ(signal_meta)は
      // clearSignalTrades が 0 化し、live エンジンの in-memory カウンタもここで 0 に戻す(次 ARM は 1 から)。
      const cleared = clearSignalTrades(db, system);
      resetSignalEngineIdCounter(system);
      res.json({ ok: true, system, cleared });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'clear failed' });
  }
}
