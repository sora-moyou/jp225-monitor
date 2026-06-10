// 長周期スイング・ダブルボトム/トップ検知(純粋関数)。
//
// 複数セッションをまたぐ大きな W/M 反転を捉える(旧 90分窓 micro ダブルは v0.6.0 で廃止)。
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
  lowTolRatio: number;    // |谷1 − 谷2| ≤ lowTolRatio × 突出(ネック高さ)。2つの脚が「同じ高さ」と認識できる近さを担保
  breakTol: number;       // ネック突破マージン(円)
  breakoutExtensionRatio: number;  // 現値がネックから「突出 × この比率」を超えて離れたら決着済み→出さない(1.0=測定移動の目標)
}
// lowTolRatio: 旧 lowTol(固定2000円)は緩すぎ、谷64,455→63,755(差700=切り下げ)のような
// 「ダブルでない下降の底」を誤検知していた(人間の認識と乖離)。ダブルは2つの脚が「ほぼ同じ高さ」で
// なければならない。それを**突出(ネックの高さ)に対する比率**で判定(スケール不変)。0.08=谷差は突出の
// 8%まで(ユーザー指定・厳格)。実データ二極化: 良品=比率0.04 / 不良=0.45以上(実例=1.10)。
// 突出635円の例なら許容谷差 ≈ 51円。
// breakoutExtensionRatio: 強トレンドで0.8%押しが入らないと古い [谷山谷] が末尾に残り続け、価格が
// ネックを大きく抜けて決着した後も「成立」を延々再発火する(チャート上では現値近傍にダブルが無く
// 「認識できない」)。測定移動の目標(ネック±突出)に到達したら setup 終了とみなし打ち切る。
export const DEFAULT_SWING_DOUBLE: SwingDoubleParams = { minProminence: 150, lowTolRatio: 0.08, breakTol: 5, breakoutExtensionRatio: 1.0 };

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
    const prom = neck - shallow;
    if (prom >= p.minProminence && Math.abs(L1 - L2) <= prom * p.lowTolRatio && current > Math.min(L1, L2)) {
      // 決着済み: 価格がネック+突出×ratio(=測定移動の目標)以上に伸びたら古いブレイク→出さない。
      if (current >= neck + prom * p.breakoutExtensionRatio) return null;
      const stage: SwingDoubleSignal['stage'] = current > neck + p.breakTol ? 'breakout' : 'forming';
      return { kind: 'bottom', stage, neck, legs: [L1, L2], target: neck + prom };
    }
  }
  // ダブルトップ: 山 → 谷(ネック) → 山、最後のピボットが山(=現在は山2からの下落レグ)
  if (a.kind === 'high' && neckP.kind === 'low' && b.kind === 'high') {
    const neck = neckP.price, H1 = a.price, H2 = b.price;
    const shallow = Math.min(H1, H2);                 // 浅い方の山(低い方)
    const prom = shallow - neck;
    if (prom >= p.minProminence && Math.abs(H1 - H2) <= prom * p.lowTolRatio && current < Math.max(H1, H2)) {
      // 決着済み: 価格がネック−突出×ratio(=測定移動の目標)以下に伸びたら古いブレイク→出さない。
      if (current <= neck - prom * p.breakoutExtensionRatio) return null;
      const stage: SwingDoubleSignal['stage'] = current < neck - p.breakTol ? 'breakout' : 'forming';
      return { kind: 'top', stage, neck, legs: [H1, H2], target: neck - prom };
    }
  }
  return null;
}
