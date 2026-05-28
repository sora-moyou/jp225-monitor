// 直近 WINDOW_MS の価格スナップショットから、ANCHOR (NK=F) との相関が最も
// 高い銘柄を選び続ける。再評価は REEVAL_MS ごと。
//
// 起動直後で履歴が足りない間は INITIAL_LEADER を返す。
// 値がさ株 (heavyweight) は NK の構成要素なので候補から除外。

import type { Price } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

const WINDOW_MS = 60 * 60 * 1000;     // 1時間のスナップショットを保持
const REEVAL_MS = 5 * 60 * 1000;      // 5分ごとに再評価
const MIN_SAMPLES = 60;               // 最低60サンプル (=約2分相当) で再評価開始
const ANCHOR: string = 'NK=F';
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

export interface LeaderChange {
  prevLeader: string;
  newLeader: string;
  absCorrelation: number;
}

/** SSE で届いた全銘柄スナップショットを記録し、必要なら再評価して切替を返す */
export function feedSnapshot(prices: Price[]): LeaderChange | null {
  const now = Date.now();
  const map = new Map<string, number>();
  for (const p of prices) map.set(p.symbol, p.price);
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

function reevaluate(now: number): LeaderChange | null {
  lastReeval = now;

  // ANCHOR の return 列を作る
  const anchorReturns = returnsFor(ANCHOR);
  if (anchorReturns.length < MIN_SAMPLES - 1) return null;

  // 候補銘柄ごとに相関を計算（値がさ株は除外）
  let bestSym: string | null = null;
  let bestAbs = -1;
  for (const sym of ELIGIBLE_CANDIDATES) {
    const r = returnsFor(sym);
    const minLen = Math.min(r.length, anchorReturns.length);
    if (minLen < MIN_SAMPLES - 1) continue;
    const corr = pearson(anchorReturns.slice(-minLen), r.slice(-minLen));
    if (Math.abs(corr) > bestAbs) {
      bestAbs = Math.abs(corr);
      bestSym = sym;
    }
  }

  if (!bestSym) return null;
  lastCorrelation = bestAbs;
  if (bestSym === currentLeader) return null;
  const prev = currentLeader;
  currentLeader = bestSym;
  return { prevLeader: prev, newLeader: bestSym, absCorrelation: bestAbs };
}

function returnsFor(symbol: string): number[] {
  const out: number[] = [];
  let prev: number | null = null;
  for (const snap of snapshots) {
    const v = snap.prices.get(symbol);
    if (v === undefined) { prev = null; continue; }
    if (prev !== null && prev !== 0) out.push((v - prev) / prev);
    prev = v;
  }
  return out;
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
