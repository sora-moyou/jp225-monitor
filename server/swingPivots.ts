// 確定スイングピボット(zigzag)。dtb/水準抜けの「固定水準」を供給する。
//
// 背景: 当日高安を現値追従(min/max(extreme, current))で水準にすると、価格が新安値を更新するたびに
// 水準が下方へ動き、同じ局面で「ダブルボトムの可能性」が次々と乱発する(左の山が固定されない)。
// 正しくは「固定された局所安値/高値」を水準とし、再接近→ダブル、割れ→水準抜け、と推移させたい。
//
// ここでは reclaimYen 以上の戻りで“確定”した極値だけを返す(末尾の未確定 leg は含めない=値が動かない)。

export interface SwingBar { t: number; h: number; l: number; }
export interface SwingPivot { price: number; kind: 'low' | 'high'; t: number; }

/**
 * 確定スイングピボットを古い→新しい順で返す。
 * curLow/curHigh を走査で追跡し、安値から reclaimYen 戻したら直前の curLow を「押し安値」、
 * 高値から reclaimYen 押したら直前の curHigh を「戻り高値」として確定する。
 * 直近の未確定 leg(まだ reclaim 戻していない現在進行中の極値)は返さないので、返る値は固定。
 */
export function extractSwingPivots(bars: SwingBar[], reclaimYen: number): SwingPivot[] {
  if (bars.length < 2 || !(reclaimYen > 0)) return [];
  const out: SwingPivot[] = [];
  let lastType: 'low' | 'high' | null = null;
  let curLow = bars[0]!.l, curLowT = bars[0]!.t;
  let curHigh = bars[0]!.h, curHighT = bars[0]!.t;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]!;
    if (b.l < curLow) { curLow = b.l; curLowT = b.t; }
    if (b.h > curHigh) { curHigh = b.h; curHighT = b.t; }
    // 確定は「極値を付けた足より後の足」で reclaim 戻した時のみ(b.t > 極値の足時刻)。
    // これが無いと、1分足のバー内レンジ(高安幅)が reclaim を超えるだけで同一バー誤確定してしまう。
    if (lastType !== 'low' && b.t > curLowT && b.h >= curLow + reclaimYen) {
      // 下げの底(curLow)から reclaim 戻した → 押し安値を確定。以後は上げの頂点を追跡。
      out.push({ price: curLow, kind: 'low', t: curLowT });
      lastType = 'low';
      curHigh = b.h; curHighT = b.t;
    } else if (lastType !== 'high' && b.t > curHighT && b.l <= curHigh - reclaimYen) {
      // 上げの天井(curHigh)から reclaim 押した → 戻り高値を確定。以後は下げの底を追跡。
      out.push({ price: curHigh, kind: 'high', t: curHighT });
      lastType = 'high';
      curLow = b.l; curLowT = b.t;
    }
  }
  return out;
}
