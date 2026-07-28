// 一目均衡表・値幅観測論(N波動)の値幅目標を算出する純粋モジュール。
//
// N波動 = スイング A→B→C の 3 点で相場の「ひと山」を捉え、B(直前の到達点)を抜けた瞬間(=D)に
// 次の到達目標(N値/V値/E値)を投影する古典的手法。上昇と下降を鏡像で扱う。
//
//   上昇: A(安値) → B(高値) → C(押し安値・A<C<B の higher-low)。現値が B を上抜けたら確認。
//     N値 = C + (B − A)   … 最初の押し幅を足した最小目標(一段上げ)
//     V値 = 2B − C        … 倍返し(B までの上げ幅を C から再度乗せる)
//     E値 = 2B − A        … A→B の上げ幅を B から倍にした最大目標
//   下降: A(高値) → B(安値) → C(戻り高値・B<C<A の lower-high)。現値が B を下抜けたら確認。
//     N値 = C − (A − B)   V値 = 2B − C   E値 = 2B − A   (全て B より下)
//
// 使う所: ①未到達の目標だけを「意識される節目」として供給(到達済みは節目価値なし=方向×未到達で絞る)。
//         ②B 抜けの確認時に nwave アラート(目標=V値)を出す。
// 連発抑制/クールダウンは呼び出し側(registry)が方向×B で行う。ここは値幅計算のみ(状態を持たない)。

import type { SwingPivot } from './swingPivots.js';

export interface NWave {
  direction: 'up' | 'down';
  a: number;   // 起点(上昇=安値 / 下降=高値)
  b: number;   // 到達点(上昇=高値 / 下降=安値)。抜けたら確認。
  c: number;   // 押し/戻り(上昇=押し安値 / 下降=戻り高値)
  bT: number;  // B ピボットの時刻(方向×B のクールダウンキー用)
  targets: { N: number; V: number; E: number };   // 円(整数丸め)。上昇=全て B より上/下降=全て B より下。
}

// 目標は既存の節目と同じく円単位に丸める(levels.ts の representativePrice は round5 だが、
// 候補段階では reaction 水準等と同様 Math.round(整数円)で供給し、クラスタ代表選抜で round5 に揃う)。
const yen = (v: number): number => Math.round(v);

/**
 * 確定スイングピボット列(古い→新しい)と現値から、直近の N 波動(確認済み=B 抜け)を判定。該当なしは null。
 * detectSwingDouble と同じく末尾3ピボット [a, b, c] だけを評価する(最も actionable な最新の波)。
 * minSwingYen = |B − A|(第1波の値幅)がこれ未満の浅い波は雑音として捨てる。
 */
export function detectNWave(pivots: SwingPivot[], current: number, minSwingYen: number): NWave | null {
  if (!(current > 0) || pivots.length < 3 || !(minSwingYen > 0)) return null;
  const n = pivots.length;
  const a = pivots[n - 3]!, b = pivots[n - 2]!, c = pivots[n - 1]!;

  // 上昇N波: 安値(A) → 高値(B) → 押し安値(C)。A<C<B(C は本物の higher-low の押し)、|B−A|≥minSwing、
  //   かつ現値が B を上抜け(=D 発生)で確認。目標は全て B より上。
  if (a.kind === 'low' && b.kind === 'high' && c.kind === 'low') {
    const A = a.price, B = b.price, C = c.price;
    if (A < C && C < B && (B - A) >= minSwingYen && current > B) {
      return {
        direction: 'up', a: A, b: B, c: C, bT: b.t,
        targets: { N: yen(C + (B - A)), V: yen(2 * B - C), E: yen(2 * B - A) },
      };
    }
  }
  // 下降N波: 高値(A) → 安値(B) → 戻り高値(C)。B<C<A(C は本物の lower-high の戻り)、|A−B|≥minSwing、
  //   かつ現値が B を下抜けで確認。目標は全て B より下。
  if (a.kind === 'high' && b.kind === 'low' && c.kind === 'high') {
    const A = a.price, B = b.price, C = c.price;
    if (B < C && C < A && (A - B) >= minSwingYen && current < B) {
      return {
        direction: 'down', a: A, b: B, c: C, bT: b.t,
        targets: { N: yen(C - (A - B)), V: yen(2 * B - C), E: yen(2 * B - A) },
      };
    }
  }
  return null;
}

/**
 * N波動の目標のうち「未到達」だけを節目候補({price,label})で返す(到達済みは節目価値が無いので除外)。
 * 上昇=現値より上の目標 / 下降=現値より下の目標。ラベルは値名+方向(例: N値(上昇) / V値(下降))。
 */
export function nwaveLevelCandidates(nw: NWave, current: number): { price: number; label: string }[] {
  const dirWord = nw.direction === 'up' ? '上昇' : '下降';
  const unreached = (price: number): boolean =>
    nw.direction === 'up' ? price > current : price < current;
  const out: { price: number; label: string }[] = [];
  for (const [name, price] of [['N値', nw.targets.N], ['V値', nw.targets.V], ['E値', nw.targets.E]] as const) {
    if (price > 0 && unreached(price)) out.push({ price, label: `${name}(${dirWord})` });
  }
  return out;
}
