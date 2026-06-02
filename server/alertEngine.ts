import type { Bar } from './correlation.js';
import {
  computeContext,
  type DetectorParams,
} from './alertDetector.js';
import { detectGranvilleReversal, detectGranvilleContinuation } from './granville.js';
import { canFire, markFired } from './alertCooldown.js';
import { detectShock } from './shockDetector.js';
import { resolveShockParams, resolveShockCooldownBars } from './configStore.js';
import type { InstrumentMeta, AlertEventPayload } from './types.js';

export type AlertSink = (e: AlertEventPayload) => void;

// 急変専用のバー数クールダウン(直近ラベルの分インデックスから cooldownBars 本超で再発火可)。
// alertCooldown(共有・時間ベース)とは別系統。プロセスごとに独立。
const lastShockBar = new Map<string, number>();
function shockCanFire(symbol: string, bar: number): boolean {
  const prev = lastShockBar.get(symbol);
  return prev === undefined || bar - prev > resolveShockCooldownBars();
}
function shockMarkFired(symbol: string, bar: number): void { lastShockBar.set(symbol, bar); }
export function _resetShockCooldown(): void { lastShockBar.clear(); }

/** Bar-confirmed detection for NIY=F: Granville (reversal/continuation) first, then shock (完成1分足).
 *  Routes events to `sink`. */
export function evaluateBarsNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  if (!bars || bars.length < 65) return;
  const sym = 'NIY=F';

  // Granville (MA(75)) — evaluated first; shared cooldown suppresses same-dir re-fire.
  const closes = bars.map(b => b.close);
  const rev = detectGranvilleReversal(closes);
  const cont = detectGranvilleContinuation(closes);
  const g = rev
    ? { sig: rev, note: `グランビル${rev.dir === 'up' ? '買い' : '売り'}転換` }
    : cont
      ? { sig: cont, note: cont.dir === 'up' ? 'グランビル押し目買い' : 'グランビル戻り売り' }
      : null;
  const gPrice = bars[bars.length - 1]!.close;
  if (g && canFire(sym, g.sig.dir, gPrice, now)) {
    const ctx = computeContext(bars);
    markFired(sym, g.sig.dir, gPrice, now);
    console.log(`[alertEngine] ${sym} ${g.note} dev=${g.sig.deviation.toFixed(2)}%`);
    sink({
      symbol: sym, symbolLabel: meta.labelJa, changePercent: g.sig.deviation,
      windowSeconds: 75 * 60, detectionKind: 'granville', direction: g.sig.dir,
      triggeredAt: bars[bars.length - 1]!.t, change15min: ctx.change15min,
      pa15min: ctx.pa15min, range1h: ctx.range1h, zscore: 0, note: g.note,
    });
  }

  // 急変(価格変化スコア方式)。完成足のみ(末尾=進行中バーを除外)。バー数クールダウンで間引く。
  const completed = bars.slice(0, -1).map(b => b.close);
  const shock = detectShock(completed, resolveShockParams());
  if (shock) {
    const lastCompleted = bars[bars.length - 2]!;        // 評価対象の完成足
    const bar = Math.floor(lastCompleted.t / 60_000);    // 「バーインデックス」=分インデックス
    if (shockCanFire(sym, bar)) {
      shockMarkFired(sym, bar);
      const ctx = computeContext(bars);
      const prevClose = completed[completed.length - 2] ?? lastCompleted.close;
      console.log(`[alertEngine] ${sym} shock ${shock.dir} d1=${Math.round(shock.d1)}円 score=${shock.score}/6`);
      sink({
        symbol: sym, symbolLabel: meta.labelJa + ' (急変)',
        changePercent: prevClose > 0 ? (shock.d1 / prevClose) * 100 : 0,
        windowSeconds: 60, detectionKind: 'shock', direction: shock.dir,
        triggeredAt: lastCompleted.t,
        change15min: ctx.change15min, pa15min: ctx.pa15min, range1h: ctx.range1h,
        zscore: 0,
        note: `急変 ${shock.dir === 'up' ? '↑' : '↓'}${Math.round(shock.d1)}円 (1分) / 2分 ${Math.round(shock.d2)}円 / score ${shock.score}/6`,
      });
    }
  }
}
