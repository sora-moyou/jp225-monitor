// 長周期スイング・ダブルボトム/トップ検知(純粋関数)。
//
// 90分窓の micro ダブル(doublePattern.ts)とは別物。複数セッションをまたぐ大きな W/M 反転を捉える。
// 確定スイングピボット(extractSwingPivots を大きな reclaim で計算=主要スイングのみ)の列から、
// 直近の [谷→ネック(山)→谷](トップは [山→ネック(谷)→山])を探す。
//
// ユーザー指定: 「2つの谷の価格差は大きくてかまわない」。よって equal-lows(谷の高さ一致)は要求せず、
// 本物の W かどうかは **ネックの突出度**(ネック − 浅い方の谷 ≥ minProminence)だけで判定する。
//
// 2段で通知する:
//   forming  = 谷2を付け、現値がまだネック未満(上抜け待ち)
//   breakout = 現値がネックを breakTol 超で上抜け(=ダブルボトム成立)
// 連発抑制は呼び出し側の per-neck クールダウンで行う。

import type { SwingPivot } from './swingPivots.js';

export interface SwingDoubleParams {
  minProminence: number;  // ネック − max(谷1,谷2)(=浅い方の谷)がこれ以上で「本物のW」とみなす
  lowTol: number;         // |谷1 − 谷2| の許容(既定は実質不問の大きな値)
  breakTol: number;       // ネック突破マージン(円)
}
// lowTol は実質「不問」に近い大きな既定(ユーザー指定: 2つの脚の価格差は大きくてよい)。
// 「本物のW/M」かは reclaim(主要スイングのみ抽出)と minProminence(ネック突出)で担保する。
export const DEFAULT_SWING_DOUBLE: SwingDoubleParams = { minProminence: 150, lowTol: 2000, breakTol: 5 };

export interface SwingDoubleSignal {
  kind: 'bottom' | 'top';
  stage: 'forming' | 'breakout';
  neck: number;
  legs: [number, number];   // [谷1, 谷2](bottom) / [山1, 山2](top)
  target: number;           // 測定移動: ネック ±(ネック − 浅い方の脚)
}

/**
 * 確定スイングピボット列(古い→新しい)と現値から、直近の大スイング・ダブルを判定。該当なしは null。
 * 直近3ピボットが [low, high, low](=ダブルボトム形成中)/ [high, low, high](=ダブルトップ形成中)の時だけ
 * 評価する(=2つ目の脚を付けて現在ネックへ向かっている、最も actionable な局面)。
 */
export function detectSwingDouble(
  pivots: SwingPivot[], current: number, p: SwingDoubleParams = DEFAULT_SWING_DOUBLE,
): SwingDoubleSignal | null {
  if (!(current > 0) || pivots.length < 3) return null;
  const n = pivots.length;
  const a = pivots[n - 3]!, neckP = pivots[n - 2]!, b = pivots[n - 1]!;

  // ダブルボトム: 谷 → 山(ネック) → 谷、最後のピボットが谷(=現在は谷2からの上昇レグ)
  if (a.kind === 'low' && neckP.kind === 'high' && b.kind === 'low') {
    const neck = neckP.price, L1 = a.price, L2 = b.price;
    const shallow = Math.max(L1, L2);                 // 浅い方の谷(高い方)
    if (neck - shallow >= p.minProminence && Math.abs(L1 - L2) <= p.lowTol && current > Math.min(L1, L2)) {
      const stage: SwingDoubleSignal['stage'] = current > neck + p.breakTol ? 'breakout' : 'forming';
      return { kind: 'bottom', stage, neck, legs: [L1, L2], target: neck + (neck - shallow) };
    }
  }
  // ダブルトップ: 山 → 谷(ネック) → 山、最後のピボットが山(=現在は山2からの下落レグ)
  if (a.kind === 'high' && neckP.kind === 'low' && b.kind === 'high') {
    const neck = neckP.price, H1 = a.price, H2 = b.price;
    const shallow = Math.min(H1, H2);                 // 浅い方の山(低い方)
    if (shallow - neck >= p.minProminence && Math.abs(H1 - H2) <= p.lowTol && current < Math.max(H1, H2)) {
      const stage: SwingDoubleSignal['stage'] = current < neck - p.breakTol ? 'breakout' : 'forming';
      return { kind: 'top', stage, neck, legs: [H1, H2], target: neck - (shallow - neck) };
    }
  }
  return null;
}
