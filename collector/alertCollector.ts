import type { DatabaseSync } from 'node:sqlite';
import { feedRealtimePrice, getRealtimeBars } from '../server/feedBars.js';
import { evaluateBarsNiy, type AlertSink } from '../server/alertEngine.js';
import { DEFAULT_PARAMS } from '../server/alertDetector.js';
import { INSTRUMENTS } from '../server/config.js';
import { getLatestTick, insertAlertIfNew, type AlertInsert } from '../server/db/store.js';
import { followupTick } from '../server/alertHistory.js';
import { getCooldownMs } from '../server/alertCooldown.js';
import { classifySession, isWithinOpenGuard } from './session.js';
import { resolveOpenGuardBars } from '../server/configStore.js';
import type { Bar } from '../server/correlation.js';
import type { AlertEventPayload } from '../server/types.js';

const NIY = 'NIY=F';
const META = INSTRUMENTS.find(i => i.symbol === NIY)!;

/** Collector-side alert driver. One per process; holds the DB handle and a DB-only sink.
 *  Detection runs ONLY from the per-process feedBars realtime buffer (always a continuous,
 *  live-built or freshness-seeded series) — never from raw DB bars, which may contain a gap
 *  across collector downtime and would otherwise read as a false one-bar burst. Seeding is
 *  done by the existing freshness-gated `warmFromDb()` in collector/index.ts before the loop. */
export class AlertCollector {
  private lastMinute = -1;
  // Near-duplicate guard window. Kept under the configured cooldown so it can NEVER suppress a
  // legitimate same-direction re-fire (which requires the full cooldown, ≥60s, to elapse), while
  // still collapsing a realtime-vs-bar twin (≤60s apart) during a brief monitor/collector overlap.
  private readonly dedupWindowMs = Math.min(60_000, Math.max(0, getCooldownMs() - 1_000));
  constructor(private readonly db: DatabaseSync) {}

  /** DB-only sink: persist the alert with a near-duplicate guard. No SSE (collector has no UI). */
  private sink: AlertSink = (e: AlertEventPayload) => {
    if (e.triggeredAt > Date.now() + 2 * 60_000) return;   // 未来日時(基礎データ取り込みの未来バー由来)は記録しない
    if (isWithinOpenGuard(e.triggeredAt, resolveOpenGuardBars())) return;   // 寄りから3本は collector 側記録も抑制
    const latest = getLatestTick(this.db, e.symbol);
    const price = latest ? latest.price : (e.pa15min ? e.pa15min.current : 0);
    if (!(price > 0)) return;
    const s = classifySession(e.triggeredAt);
    const row: AlertInsert = {
      symbol: e.symbol, triggeredAt: e.triggeredAt, direction: e.direction,
      detectionKind: e.detectionKind, windowSeconds: e.windowSeconds,
      changePercent: e.changePercent, price,
      sessionDate: s?.sessionDate ?? null, session: s?.session ?? null,
    };
    insertAlertIfNew(this.db, row, this.dedupWindowMs);
  };

  /** Feed one live price; build realtime bars. */
  onPrice(symbol: string, price: number, t: number): void {
    feedRealtimePrice(symbol, price, t);
    // 急変は確定足ベース(onMinute → evaluateBarsNiy)。realtime z-score は廃止。
  }

  /** Run bar-confirmed detection at most once per minute boundary. */
  onMinute(now: number): void {
    const minute = Math.floor(now / 60_000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    evaluateBarsNiy(this.barsForNiy(), META, DEFAULT_PARAMS, now, this.sink);
  }

  /** Fill ret5/15/30 for matured alerts (DB-only, idempotent). */
  followup(now: number = Date.now()): void {
    followupTick(this.db, now);
  }

  /** Detection source: the continuous realtime buffer only. Empty until warmed → engine guards skip. */
  private barsForNiy(): Bar[] {
    return getRealtimeBars(NIY);
  }
}
