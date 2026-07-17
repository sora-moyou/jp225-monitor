// レジーム/勢いの数値化(純関数・テスト可能)。
// 実データ診断: AI が「少し前のトレンド像」を語って直近の値動きに逆張りする(強トレンドを「レンジ」と
// 誤読して両側フェード / 転換後も古いトレンド観を引きずる)。対策として、直近の勢いを数値で持ち、
// scalp-plan の技術文脈へ注入(A)+コードの trend veto(B・openai.ts enforcePlanConstraints)へ同じ値を渡す。
//
// このモジュールは時計/IO を持たない完全な純関数。`now` は呼び出し側が与える。

export interface Regime {
  ret10: number | null;      // close(now) − close(now−10分)。足不足は null。
  ret30: number | null;      // close(now) − close(now−30分)。足不足は null。
  ma20Slope: number | null;  // MA20(now) − MA20(now−5分)。どちらか 20 本未満は null。
  swingHigh: number | null;  // 直近30分の高値。窓に足が無ければ null。
  swingLow: number | null;   // 直近30分の安値。窓に足が無ければ null。
  posPct: number | null;     // レンジ内位置(%)。レンジ幅0/足不足は null。
  dir: 'up' | 'down' | 'flat';
  strong: boolean;           // dir !== 'flat'。ret10 が閾値未満/null なら false(=veto しない)。
}

/** 1分足(OHLC)。リアルタイム足は close のみなので呼び出し側で o/h/l/c=close にマップして渡す。 */
export interface RegimeBar { t: number; o: number; h: number; l: number; c: number; }

const MIN = 60_000;

/** t<=time のうち最大 t を持つバーの close(c)。該当なしは null(=その時点のデータ不足)。 */
function closeAtOrBefore(bars: RegimeBar[], time: number): number | null {
  let bestT = -Infinity;
  let bestC: number | null = null;
  for (const b of bars) {
    if (b.t <= time && b.t >= bestT) { bestT = b.t; bestC = b.c; }
  }
  return bestC;
}

/** t<=time で終わる直近 20 本 close の単純平均(MA20)。20 本未満は null。 */
function ma20At(bars: RegimeBar[], time: number): number | null {
  const upto = bars.filter(b => b.t <= time).sort((a, b) => a.t - b.t);
  if (upto.length < 20) return null;
  const last20 = upto.slice(-20);
  let sum = 0;
  for (const b of last20) sum += b.c;
  return sum / 20;
}

/** 直近の勢い/レジームを算出する純関数。
 *  - ret10/ret30: now と now−N分の「その時点以前で最後」の close の差。どちらか欠落は null。
 *  - ma20Slope: MA20(now)−MA20(now−5分)。どちらか 20 本未満は null。
 *  - swingHigh/Low: 直近30分の高安。posPct: (close−安)/(高−安)×100(レンジ0/足不足は null)。
 *  - dir: ret10≥+T→'up' / ret10≤−T→'down' / それ以外(null 含む)→'flat'。strong=(dir≠'flat')。
 *  堅牢: 入力欠落はそのフィールドを null にし、ret10 が null なら dir='flat'・strong=false(=veto しない)。 */
export function computeRegime(bars: RegimeBar[], now: number, thresholdYen = 100): Regime {
  const safe = Array.isArray(bars)
    ? bars.filter(b => b && Number.isFinite(b.t) && Number.isFinite(b.c))
    : [];

  // ret10 / ret30: close(now) − close(now−N分)。どちらかの時点にデータが無ければ null。
  const cNow = closeAtOrBefore(safe, now);
  const c10 = closeAtOrBefore(safe, now - 10 * MIN);
  const c30 = closeAtOrBefore(safe, now - 30 * MIN);
  const ret10 = cNow !== null && c10 !== null ? cNow - c10 : null;
  const ret30 = cNow !== null && c30 !== null ? cNow - c30 : null;

  // ma20Slope: MA20(now) − MA20(now−5分)。どちらか 20 本未満は null。
  const maNow = ma20At(safe, now);
  const maPrev = ma20At(safe, now - 5 * MIN);
  const ma20Slope = maNow !== null && maPrev !== null ? maNow - maPrev : null;

  // swingHigh/Low: 直近30分の高安(h の最大 / l の最小)。posPct: レンジ内位置。
  const win = safe.filter(b =>
    b.t <= now && b.t >= now - 30 * MIN && Number.isFinite(b.h) && Number.isFinite(b.l));
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (const b of win) {
    if (swingHigh === null || b.h > swingHigh) swingHigh = b.h;
    if (swingLow === null || b.l < swingLow) swingLow = b.l;
  }
  let posPct: number | null = null;
  if (swingHigh !== null && swingLow !== null && cNow !== null && swingHigh > swingLow) {
    posPct = ((cNow - swingLow) / (swingHigh - swingLow)) * 100;
  }

  // dir/strong: ret10 が閾値以上で up/down。ret10 が null(足不足)なら flat=veto しない。
  let dir: 'up' | 'down' | 'flat' = 'flat';
  if (ret10 !== null) {
    if (ret10 >= thresholdYen) dir = 'up';
    else if (ret10 <= -thresholdYen) dir = 'down';
  }
  const strong = dir !== 'flat';

  return { ret10, ret30, ma20Slope, swingHigh, swingLow, posPct, dir, strong };
}

/** Regime を scalp-plan の技術文脈へ注入する日本語 1 行に整形する(純関数)。
 *  null フィールドは「—」で表示。format:
 *  `直近の勢い: 10分{±X}円 / 30分{±Y}円 / MA20傾き{±Z} / 直近30分高安[{L}-{H}]内{pos}% → {ラベル}({強|弱})` */
export function formatMomentumLine(r: Regime): string {
  const yen = (v: number | null): string =>
    v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}円`;
  const slope = r.ma20Slope === null || !Number.isFinite(r.ma20Slope)
    ? '—' : `${r.ma20Slope >= 0 ? '+' : ''}${r.ma20Slope.toFixed(1)}`;
  const lo = r.swingLow === null || !Number.isFinite(r.swingLow) ? '—' : String(Math.round(r.swingLow));
  const hi = r.swingHigh === null || !Number.isFinite(r.swingHigh) ? '—' : String(Math.round(r.swingHigh));
  const pos = r.posPct === null || !Number.isFinite(r.posPct) ? '—' : String(Math.round(r.posPct));
  const label = r.dir === 'up' ? '上昇トレンド' : r.dir === 'down' ? '下降トレンド' : '横ばい(レンジ可)';
  const strength = r.strong ? '強' : '弱';
  return `直近の勢い: 10分${yen(r.ret10)} / 30分${yen(r.ret30)} / MA20傾き${slope} / `
    + `直近30分高安[${lo}-${hi}]内${pos}% → ${label}(${strength})`;
}
