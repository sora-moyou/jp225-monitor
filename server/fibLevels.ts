import type { SessionOHLC } from './sessionOHLC.js';
import { isSessionComplete } from './sessionOHLC.js';

export const DEFAULT_RETR = [0.236, 0.382, 0.5, 0.618, 0.786];
export const DEFAULT_EXT = [1.272, 1.618];
export const DEFAULT_SWING_WINDOWS = [5, 10, 20];   // 完了セッション窓(=基準スケール)

export interface Swing { high: number; low: number; leg: 'up' | 'down'; scaleLabel: string; }
export interface FibLevel { price: number; ratio: number; reversalLine: boolean; scaleLabel: string; kind: 'retr' | 'ext'; }

/** 完了(寄り揃い)セッション先頭 n 本の極大→極小スイング。脚= newer 極値の向き。n 本未満は null。 */
export function deriveSwing(completed: SessionOHLC[], n: number): Swing | null {
  const use = completed.filter(isSessionComplete).slice(0, n);
  if (use.length < n) return null;                          // 窓を満たすスケールのみ出す(20S は20本揃ってから)
  const hi = use.reduce((a, b) => (b.high > a.high ? b : a));
  const lo = use.reduce((a, b) => (b.low < a.low ? b : a));
  if (!(hi.high > lo.low)) return null;
  const leg: 'up' | 'down' = lo.lowT > hi.highT ? 'down' : 'up';   // 安値が新しい→down脚
  return { high: hi.high, low: lo.low, leg, scaleLabel: `${n}S` };
}

/** スイングから戻し+拡張のフィボ価格群。up脚=戻しは高値から下、拡張は高値より上。down脚は反転。 */
export function fibLevelsForSwing(sw: Swing, retr: number[] = DEFAULT_RETR, ext: number[] = DEFAULT_EXT): FibLevel[] {
  const range = sw.high - sw.low;
  if (!(range > 0)) return [];
  const out: FibLevel[] = [];
  for (const r of retr) {
    const price = sw.leg === 'up' ? sw.high - r * range : sw.low + r * range;
    out.push({ price, ratio: r, reversalLine: r === 0.5, scaleLabel: sw.scaleLabel, kind: 'retr' });
  }
  for (const e of ext) {
    const price = sw.leg === 'up' ? sw.high + (e - 1) * range : sw.low - (e - 1) * range;
    out.push({ price, ratio: e, reversalLine: false, scaleLabel: sw.scaleLabel, kind: 'ext' });
  }
  return out;
}

/** 当日(進行中)セッションのスイング(today H/L)。今日が寄り揃いの時のみ。 */
export function currentSessionSwing(inProgress: SessionOHLC | null, current: number): Swing | null {
  if (!inProgress || !isSessionComplete(inProgress)) return null;
  const high = Math.max(inProgress.high, current);
  const low = Math.min(inProgress.low, current);
  if (!(high > low)) return null;
  // ライブ現値が新高値/新安値を作った場合、その時刻が最新 → 脚向きを現値で決める。
  // どちらも更新していなければ保存済みの highT/lowT(新しい極値)で決定。
  let leg: 'up' | 'down';
  if (current >= inProgress.high) leg = 'up';
  else if (current <= inProgress.low) leg = 'down';
  else leg = inProgress.lowT > inProgress.highT ? 'down' : 'up';
  return { high, low, leg, scaleLabel: '当日' };
}
