import type { DatabaseSync } from 'node:sqlite';
import { recordTick } from '../server/db/store.js';
import type { Price } from '../server/types.js';
import type { Bar } from '../server/correlation.js';
import { classifySession } from './session.js';

/** feed のリアルタイム価格を tick/1分足として DB へ。stale・場外(セッション外)はスキップ。 */
export function recordFeedPrices(db: DatabaseSync, prices: Price[]): void {
  for (const p of prices) {
    if (p.stale) continue;
    const s = classifySession(p.timestamp);
    if (!s) continue;   // 場外tickは破棄
    recordTick(db, p.symbol, p.timestamp, p.price, s.sessionDate, s.session);
  }
}

/** Yahoo 分足履歴を欠損のみ埋める。各足を OPEN時刻でセッション分類し、場外足はスキップ。
 *  bars のみ書き込む(ticks は汚さない) — INSERT OR IGNORE で冪等。 */
export function backfillBars(db: DatabaseSync, symbol: string, bars: Bar[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const b of bars) {
    if (!(Number.isFinite(b.close) && b.close > 0)) continue;
    const s = classifySession(b.t);
    if (!s) continue;
    stmt.run(symbol, s.sessionDate, s.session, b.t, b.close, b.close, b.close, b.close);
  }
}
