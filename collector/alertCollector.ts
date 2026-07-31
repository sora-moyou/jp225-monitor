import type { DatabaseSync } from 'node:sqlite';
import { feedRealtimePrice, getRealtimeBars } from '../server/feedBars.js';
import { type AlertSink } from '../server/alertEngine.js';
import { INSTRUMENTS } from '../server/config.js';
import { getLatestTick, insertAlertIfNew, getSessionOHLC, type AlertInsert } from '../server/db/store.js';
import { followupTick, MONITOR_ONLY_KINDS, nearDuplicateWindowMs } from '../server/alertHistory.js';
import { crashDrawdown, CRASH_DRAWDOWN_PCT, CRASH_HYSTERESIS_PCT } from '../server/crash.js';
import { classifySession, isWithinOpenGuard } from '../core/session.js';
import { resolveOpenGuardBars } from '../server/configStore.js';
import {
  runBarDetectors, computeLevelAnalytics, runLevelDetectors,
  createBarDetectState, createLevelDetectState, DETECT_FRESH_MS,
  type BarDetectState, type LevelDetectState,
} from '../server/detect/registry.js';
import type { Bar } from '../server/correlation.js';
import type { AlertEventPayload } from '../server/types.js';

const NIY = 'NIY=F';
const META = INSTRUMENTS.find(i => i.symbol === NIY)!;

/** level 検知(break/level_sr/pivot/double/dailyband/nwave)のサンプリング周期。
 *  ★monitor の levelsLoop(server/loops/levelsLoop.ts の POLL_MS)と同じ 8秒。記録の主体が collector に
 *    一本化されたので、ここが粗いとそのまま「記録される検知の解像度」が粗くなる。
 *    実測(実 tick 102,853件・本番検知器のリプレイ・72時間): 60秒格子は 8秒格子の 0.86 倍しか発火せず、
 *    内訳は break 0.88 / level_sr 0.83 / dailyband 0.80(pivot 1.05・nwave 1.04 は誤差)。
 *    真に 8秒感度を持つのは「毎サンプル評価する検知器」= break / level_sr / dailyband。
 *    内部に CHECK_MS=60_000 を持つ double / nwave は外格子を上げても頻度が変わらない(位相が変わるだけ)。
 *  ★コスト: 1サンプル ≈110ms(実測)→ 8秒周期でデューティ ≈1.4%。同一マシンで monitor が同じ処理を
 *    既に 8秒で回しているので新規リスクは無い。
 *  ★bar 検知(shock/trend/ma_sr)と crash はこの周期に巻き込まない(下の onMinute / checkCrash のまま)。 */
const LEVEL_TICK_MS = 8_000;

/** Collector-side alert driver. One per process; holds the DB handle and a DB-only sink.
 *  Detection runs ONLY from the per-process feedBars realtime buffer (always a continuous,
 *  live-built or freshness-seeded series) — never from raw DB bars, which may contain a gap
 *  across collector downtime and would otherwise read as a false one-bar burst. Seeding is
 *  done by the existing freshness-gated `warmFromDb()` in collector/index.ts before the loop. */
export class AlertCollector {
  private lastMinute = -1;
  private lastLevelSlot = -1;
  // Near-duplicate guard window. Shared SSOT with the monitor's fallback path
  // (server/alertHistory.ts `nearDuplicateWindowMs`) so the two writers can never end up with
  // different (or one-sided) de-duplication again. Kept under the configured cooldown so it can
  // NEVER suppress a legitimate same-direction re-fire (which requires the full cooldown, ≥60s).
  private readonly dedupWindowMs = nearDuplicateWindowMs();
  // 暴落(crash)検知の状態。collector も検知して 24/7 記録する(夜間に監視アプリを閉じていても拾う)。
  private crashSessionKey = '';
  private crashSessionHigh = 0;
  private crashFired = false;
  // この consumer(collector)専用の検知状態。server(levelsLoop/alertLoop)と別インスタンスを持ち、
  // 同一プロセスで走っても相互に発火を抑制し合わない(registry の per-consumer state)。
  private readonly barState: BarDetectState = createBarDetectState();
  private readonly levelState: LevelDetectState = createLevelDetectState();
  constructor(private readonly db: DatabaseSync) {}

  /** DB-only sink: persist the alert with a near-duplicate guard. No SSE (collector has no UI). */
  private sink: AlertSink = (e: AlertEventPayload) => {
    if (e.triggeredAt > Date.now() + 2 * 60_000) {   // 未来日時のアラートは記録しない。黙殺せず必ずログに残す
      console.error(`[alertCollector] ERROR: future-dated alert dropped: ${new Date(e.triggeredAt).toISOString()} `
        + `(${e.detectionKind} ${e.symbol}), now ${new Date().toISOString()}. 基礎データ取り込みの未来バー由来の可能性。`);
      return;
    }
    if (isWithinOpenGuard(e.triggeredAt, resolveOpenGuardBars())) return;   // 寄りから3本は collector 側記録も抑制
    // ★二重記録ドリフトの再発ガード。MONITOR_ONLY_KINDS(server/alertHistory.ts)は「monitor が
    //   collector 稼働中でも無条件で書く」種別。そこへ collector が書くと、両者の壁時計が違うため
    //   idx_alerts_identity で衝突せず二重行になる(= v0.6.0 以降ずっと起きていた欠陥そのもの)。
    //   黙って重複させるより、記録せず大声で落とす(無言の失敗は欠陥)。
    if (MONITOR_ONLY_KINDS.has(e.detectionKind ?? '')) {
      console.error(`[alertCollector] ERROR: monitor 専用種別 '${e.detectionKind}' を collector が emit した `
        + `— 二重記録になるため記録しない。server/alertHistory.ts の MONITOR_ONLY_KINDS と `
        + `collector の検知器のどちらかが古い(要修正)。`);
      return;
    }
    const latest = getLatestTick(this.db, e.symbol);
    const price = latest ? latest.price : (e.pa15min ? e.pa15min.current : 0);
    if (!(price > 0)) return;
    const s = classifySession(e.triggeredAt);
    const row: AlertInsert = {
      symbol: e.symbol, triggeredAt: e.triggeredAt, direction: e.direction,
      detectionKind: e.detectionKind, windowSeconds: e.windowSeconds,
      changePercent: e.changePercent, price,
      sessionDate: s?.sessionDate ?? null, session: s?.session ?? null,
      referenceKind: e.referenceKind ?? null, referencePrice: e.referencePrice ?? null,   // v0.6.0: 基準を記録(collectorも)
    };
    insertAlertIfNew(this.db, row, this.dedupWindowMs);
  };

  /** Feed one live price; build realtime bars. */
  onPrice(symbol: string, price: number, t: number): void {
    feedRealtimePrice(symbol, price, t);
    // 急変は確定足ベース(onMinute → evaluateBarsNiy)。realtime z-score は廃止。
    if (symbol === NIY) this.checkCrash(price, t);   // 暴落はライブ価格で即検知(monitor levelsLoop と同等)
  }

  /** 暴落(セッション高値から CRASH_DRAWDOWN_PCT 以上下落)を検知し記録。エッジ+ヒステリシス。
   *  セッション切替時は DB のセッション高値でシード(collector 再起動で下落途中でも高値を欠かさない)。 */
  private checkCrash(price: number, t: number): void {
    const cs = classifySession(t);
    const key = cs ? `${cs.sessionDate}/${cs.session}` : 'none';
    if (key !== this.crashSessionKey) {
      this.crashSessionKey = key;
      this.crashFired = false;
      this.crashSessionHigh = price;
      if (cs) {
        try {
          const ohlc = getSessionOHLC(this.db, NIY, 3)
            .find(s => s.sessionDate === cs.sessionDate && s.session === cs.session);
          if (ohlc) this.crashSessionHigh = Math.max(this.crashSessionHigh, ohlc.high);
        } catch { /* シード失敗時はライブ高値で続行 */ }
      }
    }
    if (key === 'none') return;
    this.crashSessionHigh = Math.max(this.crashSessionHigh, price);
    const dd = crashDrawdown(this.crashSessionHigh, price);
    if (dd >= CRASH_DRAWDOWN_PCT && !this.crashFired) {
      this.crashFired = true;
      const high = Math.round(this.crashSessionHigh), drop = Math.round(this.crashSessionHigh - price);
      const pct = (dd * 100).toFixed(1);
      console.log(`[alertCollector] 暴落 high=${high} now=${Math.round(price)} -${pct}%`);
      this.sink({
        symbol: NIY, symbolLabel: META.labelJa, changePercent: -dd * 100, windowSeconds: 6 * 3600,
        detectionKind: 'crash', direction: 'down', triggeredAt: t,
        change15min: null, pa15min: null, range1h: null, zscore: 0, level: high,
        note: `暴落: セッション高値${high.toLocaleString('ja-JP')}から -${pct}%(-${drop.toLocaleString('ja-JP')}円)`,
        referenceKind: 'sessionHigh', referencePrice: high,
      });
    } else if (dd < CRASH_DRAWDOWN_PCT - CRASH_HYSTERESIS_PCT) {
      this.crashFired = false;
    }
  }

  /** Run bar-confirmed detection (shock/trend/ma_sr) at most once per minute boundary.
   *  確定1分足からの検知なので分境界より細かく回す意味は無い(周期は据え置き)。
   *  ★level 検知はここから切り離してある(onLevelTick / 8秒)。crash は checkCrash(独自シード)。 */
  onMinute(now: number): void {
    const minute = Math.floor(now / 60_000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    runBarDetectors(this.barsForNiy(), META, now, this.sink, this.barState);
  }

  /** level 検知(break/level_sr/pivot/double/dailyband/nwave)を LEVEL_TICK_MS(8秒)ごとに1回実行する。
   *  呼び出し側はポーリング周期(2秒)ごとに毎回呼んでよい — 8秒スロットの重複実行はここで弾く。
   *  registry 経由で levelsLoop と同じロジック。stale 価格では発火しない(levelsLoop と同じ鮮度ゲート)。
   *  ★これらは monitor(levelsLoop)も検知するが、alerts に書くのは collector 稼働中は collector だけ
   *    (monitor 側は server/alertHistory.ts の monitorPersistMode が 'skip' を返す)。だからこの周期が
   *    そのまま「記録に残る検知の解像度」になる = monitor と同じ 8秒に揃える必要がある。 */
  onLevelTick(now: number): void {
    const slot = Math.floor(now / LEVEL_TICK_MS);
    if (slot === this.lastLevelSlot) return;
    this.lastLevelSlot = slot;
    try {
      const a = computeLevelAnalytics(this.db, now, this.levelState);
      if (a && now - a.latest.t <= DETECT_FRESH_MS) runLevelDetectors(this.db, a, now, this.levelState, this.sink);
    } catch (err) {
      console.warn('[alertCollector] level detect failed:', err instanceof Error ? err.message : err);
    }
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
