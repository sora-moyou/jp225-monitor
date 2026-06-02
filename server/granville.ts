// グランビルの法則①(トレンド転換)の検知。
// 買い転換: 移動平均が下落 → 下げ止まり/上向きに転じ、価格が MA を下から上へ抜ける。
// 売り転換: 移動平均が上昇 → 頭打ち/下向きに転じ、価格が MA を上から下へ抜ける。
// 1分足の終値列に対して評価する。発火は共有クールダウンで間引く前提。

export interface GranvilleParams {
  maPeriod: number;   // 移動平均の本数(1分足)
  slopeBack: number;  // 傾きを測る本数
}
export const DEFAULT_GRANVILLE: GranvilleParams = { maPeriod: 75, slopeBack: 15 };

export interface GranvilleSignal {
  dir: 'up' | 'down';
  ma: number;            // 現在の移動平均
  deviation: number;     // 現値の MA からの乖離 %
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
  const cBack = closes[last - p.slopeBack]!;   // slopeBack 本前の終値(クロス前の位置確認用)
  const deviation = ((cNow - maNow) / maNow) * 100;

  // 買い転換: 下落していた MA が下げ止まり/上向き、かつ価格が MA を下(過去)→上(現在)へ抜けた。
  if (slopePrior < 0 && slopeRecent >= 0 && cBack < maMid && cNow > maNow) {
    return { dir: 'up', ma: maNow, deviation };
  }
  // 売り転換: 上昇していた MA が頭打ち/下向き、かつ価格が MA を上(過去)→下(現在)へ抜けた。
  if (slopePrior > 0 && slopeRecent <= 0 && cBack > maMid && cNow < maNow) {
    return { dir: 'down', ma: maNow, deviation };
  }
  return null;
}
