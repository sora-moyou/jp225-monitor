import type { Request, Response } from 'express';
import { openDb, resolveDbPath, getSignalTrades, clearSignalTradesAudited, type SignalSystemFilter } from '../db/store.js';
import { equitySeries, resetSignalEngineArmedTimeouts } from '../signalTrade/engine.js';

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

/** POST /api/signal-trades/clear?system=A|B
 *   → { ok, system, cleared:n, orphanExitStops:n, maxSignalIdBefore:n|null }(その系統のみ削除・設定/履歴から呼ぶ)。
 *  ★signalId カウンタは巻き戻さない(番号は単調増加=消しても結合キーが壊れない)。
 *  ★signal_exit_stops は消さない(従来どおり)。裏付けを失った件数を数えて返し、監査行にも残す。 */
export function signalTradesClearHandler(req: Request, res: Response): void {
  const raw = req.query.system;
  const system = parseSystemQuery(raw);
  // 監査には「要求された生の値」も残す: 素の POST(system 未指定)は既定 A に正規化され A 全消去になるため、
  // 後から「明示 A だったのか未指定だったのか」を読み分けられるようにする。
  const systemRequested = raw == null ? null : String(raw);
  try {
    const db = openDb(resolveDbPath());
    try {
      const r = clearSignalTradesAudited(db, { system, systemRequested });
      resetSignalEngineArmedTimeouts(system);   // in-memory の未約定失効カウンタも履歴に追随(signalId は据え置き)。
      res.json({ ok: true, system, cleared: r.deleted, orphanExitStops: r.orphanExitStops, maxSignalIdBefore: r.maxSignalIdBefore });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'clear failed' });
  }
}
