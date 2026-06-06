// 価格帯別出来高(ボリュームプロファイル)。厚い出来高帯(HVN)=需給が積み上がった durable な S/R、
// POC(最大出来高価格)=最も意識される価格。出来高はリアルタイムフィードに無く、基礎データ取り込み
// (週次更新)由来の volume>0 バーから算出する。
//
// ユーザー指定: 価格帯別出来高で需給が分かる/週次更新の基礎データで十分。

export interface VolBar { h: number; l: number; volume: number; }
export interface VolumeNode { price: number; rel: number; isPoc: boolean; }

/**
 * バー群(h/l/volume)から価格帯別出来高を集計し、高出来高ノード(局所極大かつ POC比 minRel 以上)を返す。
 * 各バーの出来高は high〜low のビンに均等配分する。返り値は出来高降順・最大 topN 件。
 */
export function computeVolumeProfile(bars: VolBar[], binYen = 50, topN = 8, minRel = 0.4): VolumeNode[] {
  if (bars.length === 0 || binYen <= 0) return [];
  const hist = new Map<number, number>();   // binIndex → volume
  for (const b of bars) {
    if (!(b.volume > 0) || !(b.h >= b.l) || b.l <= 0) continue;
    const loBin = Math.floor(b.l / binYen), hiBin = Math.floor(b.h / binYen);
    const n = hiBin - loBin + 1;
    const per = b.volume / n;
    for (let k = loBin; k <= hiBin; k++) hist.set(k, (hist.get(k) ?? 0) + per);
  }
  if (hist.size === 0) return [];
  const pocVol = Math.max(...hist.values());
  const nodes: VolumeNode[] = [];
  for (const [k, v] of hist) {
    const lo = hist.get(k - 1) ?? 0, hi = hist.get(k + 1) ?? 0;
    // 局所極大(両隣以上)かつ POC の minRel 以上を HVN とする。
    if (v >= lo && v >= hi && v >= pocVol * minRel) {
      nodes.push({ price: Math.round(k * binYen + binYen / 2), rel: v / pocVol, isPoc: v === pocVol });
    }
  }
  return nodes.sort((a, b) => b.rel - a.rel).slice(0, topN);
}
