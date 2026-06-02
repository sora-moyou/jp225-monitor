// 価格変化(円)のみで急変を検知。出来高/高安は使わず、完成1分足の終値列だけを使う。
// d1=1分変化, d2=2分変化, 加速度, 平均変化倍率, ブレイク, 同方向本数 の6条件スコア + 急変条件。

export interface ShockParams {
  move1: number; move2: number; shock1: number; shock2: number; accelTh: number;
  avgLen: number; avgMult: number; breakLen: number; sameDirLen: number; sameDirNeed: number;
  scoreNeed: number;   // 急変とみなす最小スコア(6条件中)
}
export const DEFAULT_SHOCK_PARAMS: ShockParams = {
  move1: 25, move2: 40, shock1: 50, shock2: 70, accelTh: 10,
  avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2, scoreNeed: 4,
};

export interface ShockSignal {
  dir: 'up' | 'down';
  d1: number;        // 1分変化(円)
  d2: number;        // 2分変化(円)
  score: number;     // 採用方向のスコア(0..6)
}

/** 完成1分足の終値列(古い→新しい)から、最新完成足で急変を判定。該当なし/データ不足は null。
 *  クールダウンは含まない(呼び出し側でバー数方式を適用)。 */
export function detectShock(closes: number[], p: ShockParams = DEFAULT_SHOCK_PARAMS): ShockSignal | null {
  const n = closes.length;
  const need = p.avgLen + 2;               // avgAbsMove(現在足を除く avgLen 本) + 現在足
  if (n < need) return null;
  const last = n - 1;
  const C0 = closes[last]!, C1 = closes[last - 1]!, C2 = closes[last - 2]!;
  const d1 = C0 - C1;
  const d2 = C0 - C2;
  const accel = d1 - (C1 - C2);

  // 現在足を除く直近 avgLen 本の1分変化幅の平均
  let sumAbs = 0;
  for (let i = 1; i <= p.avgLen; i++) sumAbs += Math.abs(closes[last - i]! - closes[last - i - 1]!);
  const avgAbsMove = sumAbs / p.avgLen;

  // 現在足を除く直近 breakLen 本の最高/最安終値
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i <= p.breakLen; i++) { const v = closes[last - i]!; if (v > hi) hi = v; if (v < lo) lo = v; }

  // 直近 sameDirLen 本の1分変化の符号本数
  let upCount = 0, dnCount = 0;
  for (let i = 0; i < p.sameDirLen; i++) {
    const diff = closes[last - i]! - closes[last - i - 1]!;
    if (diff > 0) upCount++; else if (diff < 0) dnCount++;
  }

  const aUp = d1 >= p.move1, bUp = avgAbsMove > 0 && d1 >= avgAbsMove * p.avgMult,
        cUp = d2 >= p.move2, dUp = upCount >= p.sameDirNeed, eUp = C0 > hi, fUp = accel >= p.accelTh;
  const aDn = d1 <= -p.move1, bDn = avgAbsMove > 0 && -d1 >= avgAbsMove * p.avgMult,
        cDn = d2 <= -p.move2, dDn = dnCount >= p.sameDirNeed, eDn = C0 < lo, fDn = accel <= -p.accelTh;
  const b = (x: boolean): number => x ? 1 : 0;
  const upScore = b(aUp) + b(bUp) + b(cUp) + b(dUp) + b(eUp) + b(fUp);
  const dnScore = b(aDn) + b(bDn) + b(cDn) + b(dDn) + b(eDn) + b(fDn);

  const upShockRaw = (d1 >= p.shock1 && (d2 >= p.shock2 || eUp)) || upScore >= p.scoreNeed;
  const dnShockRaw = (d1 <= -p.shock1 && (d2 <= -p.shock2 || eDn)) || dnScore >= p.scoreNeed;

  if (upScore > dnScore && upShockRaw) return { dir: 'up', d1, d2, score: upScore };
  if (dnScore > upScore && dnShockRaw) return { dir: 'down', d1, d2, score: dnScore };
  return null;
}
