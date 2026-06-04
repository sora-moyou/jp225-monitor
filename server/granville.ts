// グランビルの法則①(トレンド転換)の検知。
// 買い転換: 移動平均が下落 → 下げ止まり/上向きに転じ、価格が MA を下から上へ抜ける。
// 売り転換: 移動平均が上昇 → 頭打ち/下向きに転じ、価格が MA を上から下へ抜ける。
// 1分足の終値列に対して評価する。発火は共有クールダウンで間引く前提。

export interface GranvilleParams {
  maPeriod: number;   // 移動平均の本数(1分足)
  slopeBack: number;  // 傾きを測る本数
}
export const DEFAULT_GRANVILLE: GranvilleParams = { maPeriod: 25, slopeBack: 15 };

export interface GranvilleSignal {
  dir: 'up' | 'down';
  ma: number;            // 現在の移動平均
  deviation: number;     // 現値の MA からの乖離 %
  origin: number;        // 起点価格(1つ以上前の足): 転換=クロス前(slopeBack本前)、継続=押し安値/戻り高値
}

function sma(closes: number[], end: number, period: number): number {
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) sum += closes[i]!;
  return sum / period;
}

/** グランビル①(トレンド転換)を判定。該当なしは null。closes は古い→新しい順。 */
export function detectGranvilleReversal(closes: number[], p: GranvilleParams = DEFAULT_GRANVILLE): GranvilleSignal | null {
  const need = p.maPeriod + 2 * p.slopeBack + 1;
  if (closes.length < need) return null;
  const last = closes.length - 1;
  const maNow = sma(closes, last, p.maPeriod);
  const maMid = sma(closes, last - p.slopeBack, p.maPeriod);
  const maOld = sma(closes, last - 2 * p.slopeBack, p.maPeriod);
  const slopePrior = maMid - maOld;     // 以前の傾き
  const slopeRecent = maNow - maMid;    // 直近の傾き
  const cNow = closes[last]!;
  const cBack = closes[last - p.slopeBack]!;   // slopeBack 本前の終値(クロス前の位置確認 + 起点表示)
  const deviation = ((cNow - maNow) / maNow) * 100;

  // 買い転換: 下落していた MA が「下げ渋り(減速)」に転じ、かつ価格が MA を下→上へ抜けた。
  // cBack(slopeBack本前=クロス前)を基準にするのは、リアルタイム足は末尾が進行中で、エッジ判定だと
  // 60秒ポーリングがクロスの瞬間を外して取りこぼすため。エコー(クロス後も出続ける)は呼び出し側
  // (alertEngine のエッジ抑制)で1回化する。
  if (slopePrior < 0 && slopeRecent > slopePrior && cBack < maMid && cNow > maNow) {
    return { dir: 'up', ma: maNow, deviation, origin: cBack };
  }
  // 売り転換: 上昇していた MA が「上げ渋り(減速)」に転じ、かつ価格が MA を上→下へ抜けた。
  if (slopePrior > 0 && slopeRecent < slopePrior && cBack > maMid && cNow < maNow) {
    return { dir: 'down', ma: maNow, deviation, origin: cBack };
  }
  return null;
}

export interface MaCrossSignal {
  dir: 'up' | 'down';
  ma: number;        // 現在の移動平均
  period: number;    // MA 本数(表示用: 「25MA抜け」)
  deviation: number; // 現値の MA からの乖離 %
}

/**
 * 価格が移動平均を上下に「新規クロス」したかを検知。グランビルの傾き/構造条件は課さない素のクロス。
 * 用途: トレンドで固定水準を次々抜ける「水準抜け」連発とは別に、MA という“固定価格を持たない基準”の
 *   抜けを「25MA抜けの可能性あり」(価格非表示)として出す(ユーザー指定)。
 * 60秒ポーリングでクロス足を外さないよう、直近 lookback 本以内の「反対側→現在側」遷移を許容する。
 * 直前足が既に現在側なら新規クロスでない(null)→ 呼び出し側のエッジ抑制と併せ1回化する。closes は古い→新しい順。
 */
export function detectMaCross(closes: number[], period: number, lookback = 3): MaCrossSignal | null {
  if (closes.length < period + lookback + 1) return null;
  const last = closes.length - 1;
  const maNow = sma(closes, last, period);
  const cNow = closes[last]!;
  const sideNow = cNow > maNow ? 1 : cNow < maNow ? -1 : 0;
  if (sideNow === 0) return null;
  for (let k = 1; k <= lookback; k++) {
    const i = last - k;
    const maI = sma(closes, i, period);
    const cI = closes[i]!;
    const sideI = cI > maI ? 1 : cI < maI ? -1 : 0;
    if (sideI === sideNow) return null;     // 直前(off-MA)が同じ側 → 新規クロスでない(エコー)
    if (sideI !== 0) {                       // 反対側 → 現在側へ遷移=クロス成立
      return { dir: sideNow > 0 ? 'up' : 'down', ma: maNow, period, deviation: ((cNow - maNow) / maNow) * 100 };
    }
    // sideI === 0(ちょうど MA 上)は判定保留して1本さかのぼる
  }
  return null;
}

export interface GranvilleContParams extends GranvilleParams {
  retestBack: number;   // 「戻り/押し」を見る直近本数
  touchBand: number;    // MA に「接近した」とみなす乖離(±比率)
}
export const DEFAULT_GRANVILLE_CONT: GranvilleContParams = { maPeriod: 25, slopeBack: 15, retestBack: 10, touchBand: 0.005 };

/** グランビル②③(トレンド継続)。下降MAで戻りがMA手前で否定→売り継続、上昇MAで押しがMA手前で支持→買い継続。
 *  ユーザー指定の流れ: 価格がMAを割る→傾きが鈍る→戻りでMAを超えられない→MAが下向き→下降継続。 */
export function detectGranvilleContinuation(closes: number[], p: GranvilleContParams = DEFAULT_GRANVILLE_CONT): GranvilleSignal | null {
  const need = p.maPeriod + 2 * p.slopeBack + 1;
  if (closes.length < need) return null;
  const last = closes.length - 1;
  const maNow = sma(closes, last, p.maPeriod);
  const maOld = sma(closes, last - 2 * p.slopeBack, p.maPeriod);   // トレンド方向(直近の戻りに影響されにくい)
  const cNow = closes[last]!;
  const cPrev = closes[last - 1]!;
  const window = closes.slice(last - p.retestBack, last);   // 直近 retestBack 本(現在は含まない)
  const recentHigh = Math.max(...window);
  const recentLow = Math.min(...window);
  const idxHigh = window.indexOf(recentHigh);
  const idxLow = window.indexOf(recentLow);
  const deviation = ((cNow - maNow) / maNow) * 100;
  const nearMA = (x: number): boolean => x >= maNow * (1 - p.touchBand) && x <= maNow * (1 + p.touchBand);

  // 売り継続(戻り売り): 下降トレンド(maNow<maOld)、現値はMA下で下落、直近に「戻り(安値→高値の上昇)」が
  // あってその高値がMA手前で否定された(単調下落=常にMA近接 を除くため安値が高値より前にあることを要求)。
  if (maNow < maOld && cNow < maNow && cNow < cPrev && idxLow < idxHigh && nearMA(recentHigh) && recentHigh > cNow) {
    return { dir: 'down', ma: maNow, deviation, origin: recentHigh };   // 起点=戻りの高値
  }
  // 買い継続(押し目買い): 上昇トレンド(maNow>maOld)、現値はMA上で上昇、直近に「押し(高値→安値の下落)」が
  // あってその安値がMA手前で支持された。
  if (maNow > maOld && cNow > maNow && cNow > cPrev && idxHigh < idxLow && nearMA(recentLow) && recentLow < cNow) {
    return { dir: 'up', ma: maNow, deviation, origin: recentLow };   // 起点=押しの安値
  }
  return null;
}
