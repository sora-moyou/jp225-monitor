// 直近 WINDOW_MS の価格スナップショットから、ANCHOR (NIY=F) との相関が最も
// 高い銘柄を選び続ける。再評価は REEVAL_MS ごと。
//
// 起動直後で履歴が足りない間は INITIAL_LEADER を返す。
// 値がさ株 (heavyweight) は NIY の構成要素なので候補から除外。
//
// v0.3.11:
//   - WINDOW を 4h → 60min に短縮 (「いま」の連動性を反映)
//   - stale フラグ付き Price はスナップショットに格納しない (0 リターンノイズ除去)
//   - pairedReturns で ANCHOR と候補のリターンを時刻同期 (アライメント保証)
//   - getTopCorrelations(n) で Top-N を取得可能 (UI で併記表示)

import type { Price } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

const WINDOW_MS = 60 * 60 * 1000;     // 60分のスナップショットを保持
const REEVAL_MS = 5 * 60 * 1000;      // 5分ごとに再評価
const MIN_SAMPLES = 30;               // 最低30サンプル (=約1分相当) で再評価開始
const ANCHOR: string = 'NIY=F';
const INITIAL_LEADER = 'JPY=X';       // 履歴が足りない間の暫定リーダー

const ELIGIBLE_CANDIDATES = new Set<string>(
  INSTRUMENTS
    .filter(i => i.category !== 'heavyweight' && i.symbol !== ANCHOR)
    .map(i => i.symbol as string)
);

interface Snapshot { t: number; prices: Map<string, number>; }

const snapshots: Snapshot[] = [];
let currentLeader = INITIAL_LEADER;
let lastCorrelation = 0;
let lastReeval = 0;

export interface RankedSymbol { symbol: string; absCorr: number; corr: number; }
let lastRanked: RankedSymbol[] = [];

export interface LeaderChange {
  prevLeader: string;
  newLeader: string;
  absCorrelation: number;
}

/** SSE で届いた全銘柄スナップショットを記録し、必要なら再評価して切替を返す */
export function feedSnapshot(prices: Price[]): LeaderChange | null {
  const now = Date.now();
  const map = new Map<string, number>();
  for (const p of prices) {
    if (p.stale) continue;            // v0.3.11: stale は記録しない (0 ノイズ除去)
    map.set(p.symbol, p.price);
  }
  snapshots.push({ t: now, prices: map });

  // 古いスナップショットを破棄
  const cutoff = now - WINDOW_MS;
  while (snapshots.length > 0 && (snapshots[0]?.t ?? 0) < cutoff) snapshots.shift();

  if (snapshots.length < MIN_SAMPLES) return null;
  if (now - lastReeval < REEVAL_MS && lastReeval !== 0) return null;

  return reevaluate(now);
}

export function getLeader(): string { return currentLeader; }
export function getLastCorrelation(): number { return lastCorrelation; }
export function getTopCorrelations(n: number): RankedSymbol[] { return lastRanked.slice(0, n); }

function reevaluate(now: number): LeaderChange | null {
  lastReeval = now;

  const ranked: RankedSymbol[] = [];
  for (const sym of ELIGIBLE_CANDIDATES) {
    const { a, b } = pairedReturns(ANCHOR, sym);
    if (a.length < MIN_SAMPLES - 1) continue;
    const corr = pearson(a, b);
    ranked.push({ symbol: sym, absCorr: Math.abs(corr), corr });
  }
  ranked.sort((x, y) => y.absCorr - x.absCorr);
  lastRanked = ranked;

  const best = ranked[0];
  if (!best) return null;
  lastCorrelation = best.absCorr;
  if (best.symbol === currentLeader) return null;
  const prev = currentLeader;
  currentLeader = best.symbol;
  return { prevLeader: prev, newLeader: best.symbol, absCorrelation: best.absCorr };
}

/**
 * symA / symB のリターン列を時刻アライン取得。
 * 片方が欠落 (stale) しているスナップショットでは両方の prev をリセット — リターンを生成しない。
 * これにより両配列は同じ時刻範囲の同じインデックスでペアになり、ピアソンが正しく算出される。
 */
export function pairedReturns(symA: string, symB: string): { a: number[]; b: number[] } {
  const a: number[] = [];
  const b: number[] = [];
  let prevA: number | null = null;
  let prevB: number | null = null;
  for (const snap of snapshots) {
    const va = snap.prices.get(symA);
    const vb = snap.prices.get(symB);
    if (va === undefined || vb === undefined) {
      prevA = null;
      prevB = null;
      continue;
    }
    if (prevA !== null && prevB !== null && prevA !== 0 && prevB !== 0) {
      a.push((va - prevA) / prevA);
      b.push((vb - prevB) / prevB);
    }
    prevA = va;
    prevB = vb;
  }
  return { a, b };
}

function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
  for (let i = 0; i < n; i++) {
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;
    sx += xi; sy += yi; sxy += xi * yi;
    sx2 += xi * xi; sy2 += yi * yi;
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

export const ANCHOR_SYMBOL = ANCHOR;

// テスト用 internal access (vitest のみ使用想定)
export const _internals = {
  reset(): void {
    snapshots.length = 0;
    currentLeader = INITIAL_LEADER;
    lastCorrelation = 0;
    lastReeval = 0;
    lastRanked = [];
  },
  pushSnapshot(t: number, entries: Record<string, number | null>): void {
    const m = new Map<string, number>();
    for (const [sym, v] of Object.entries(entries)) if (v !== null) m.set(sym, v);
    snapshots.push({ t, prices: m });
  },
  pairedReturns,
};
