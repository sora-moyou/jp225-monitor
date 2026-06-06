// もみ合い帯(時間滞在プロファイル)。出来高はリアルタイム/直近フィードに無いため、その「次善の指標」として
// 価格帯ごとの "時間滞在(在足数)" を集計する(マーケットプロファイル/TPO の発想)。よく止まった帯=需給が
// 厚い可能性。ただし「ゆっくり一方向に通過しただけ」の帯を除くため、別々に2回以上入り直した(往復した)帯に
// 限定する → 「停滞(滞在時間)+ 往復(再訪)」= 本当のもみ合いだけを節目化する。
//
// ユーザー指定: 直近は出来高が取れないので、もんだ(いったりきたりで停滞した)価格帯を次善の参考にする。

export interface CongestBar { t: number; h: number; l: number; }
export interface CongestionNode { price: number; rel: number; visits: number; }

const VISIT_GAP_MS = 2 * 60_000;   // これ以上の時間ギャップ(セッション境界等)後の再到達は「入り直し」と数える

/**
 * バー群(t/h/l)から価格帯別の時間滞在を集計し、もみ合い帯(局所極大・ピーク比 minRel 以上・往復 visits≥2)を返す。
 * 各 1分足はその high〜low が掛かる全ビンに 1 在足を加算。visits は各ビンへの別々の入場回数。
 * 返り値は滞在(rel)降順・最大 topN 件。
 */
export function computeCongestionProfile(bars: CongestBar[], binYen = 50, topN = 8, minRel = 0.4): CongestionNode[] {
  if (bars.length === 0 || binYen <= 0) return [];
  const sorted = [...bars].sort((a, b) => a.t - b.t);
  const dwell = new Map<number, number>();    // binIndex → 在足数(滞在)
  const visits = new Map<number, number>();   // binIndex → 別々に入り直した回数(往復)
  let prev = new Set<number>();
  let prevT = -Infinity;
  for (const b of sorted) {
    if (!(b.h >= b.l) || b.l <= 0) continue;
    const loBin = Math.floor(b.l / binYen), hiBin = Math.floor(b.h / binYen);
    const gap = b.t - prevT > VISIT_GAP_MS;
    const cur = new Set<number>();
    for (let k = loBin; k <= hiBin; k++) {
      dwell.set(k, (dwell.get(k) ?? 0) + 1);
      if (gap || !prev.has(k)) visits.set(k, (visits.get(k) ?? 0) + 1);   // 立ち上がり(未在→在)=入場
      cur.add(k);
    }
    prev = cur; prevT = b.t;
  }
  if (dwell.size === 0) return [];
  const peak = Math.max(...dwell.values());
  const nodes: CongestionNode[] = [];
  for (const [k, d] of dwell) {
    const lo = dwell.get(k - 1) ?? 0, hi = dwell.get(k + 1) ?? 0;
    const vis = visits.get(k) ?? 0;
    // 局所極大(両隣以上)かつピーク比 minRel 以上かつ往復2回以上。
    if (d >= lo && d >= hi && d >= peak * minRel && vis >= 2) {
      nodes.push({ price: Math.round(k * binYen + binYen / 2), rel: d / peak, visits: vis });
    }
  }
  return nodes.sort((a, b) => b.rel - a.rel).slice(0, topN);
}
