// 有効トレンドライン(3点以上接触)。スイングピボットから、安値を結ぶ上昇支持線 / 高値を結ぶ下降抵抗線を
// 引く。ユーザー指定: ①3点以上が「接する」こと(接触の許容はほぼ0=線に実際に届いた点のみ) ②一度見つけたら
// 価格が線をブレイクするまで有効(古くても割れるまで保持)。現在時刻へ延長した「今のライン価格」を返す。

import type { SwingPivot } from './swingPivots.js';

export interface TrendLine {
  kind: 'support' | 'resistance';   // support=安値結びの上昇線 / resistance=高値結びの下降線
  slope: number;                    // 円/ms
  touches: number;                  // 接触したスイング点の数(≥minTouches)
  firstT: number;                   // 最初の接触時刻
  lastT: number;                    // 最後の接触時刻
  priceNow: number;                 // 線を now へ延長した価格(丸め)
}

export interface TrendLineParams {
  tolPct: number;       // 接触許容(価格比)。ほぼ0(線に届いた点のみ)。
  breakPct: number;     // ブレイク判定(価格比)。これを超えて線の逆側に出たら破断。
  minTouches: number;   // 有効に必要な接触点数(=3)
  maxLines: number;     // side ごと採用上限
  maxDistPct: number;   // 今のライン価格が現値からこの比率以内のみ採用(実戦性フィルタ)
}

export const DEFAULT_TRENDLINE: TrendLineParams = {
  tolPct: 0.0004,    // ≒±0.04%(66,000円で約±26円)。0 まで詰め可。
  breakPct: 0.003,   // ≒±0.30%。バックテストで識別力が出た設定(0.12%は厳しすぎて寿命が不自然に短かった)。
  minTouches: 3,
  maxLines: 3,
  maxDistPct: 0.04,  // 現値±4%以内
};

/**
 * スイングピボット列から有効トレンドライン(接触≥minTouches・未ブレイク)を抽出し、now へ延長して返す。
 * support は安値(切り上がり slope>0)、resistance は高値(切り下がり slope<0)のみ。
 * 接触=ピボット価格が線と ±tolPct 以内。破断=同種ピボット or 現値が線の逆側へ breakPct 超で出る。
 */
export function computeTrendLines(pivots: SwingPivot[], current: number, now: number,
  p: TrendLineParams = DEFAULT_TRENDLINE): TrendLine[] {
  const out: TrendLine[] = [];
  for (const side of ['support', 'resistance'] as const) {
    const want = side === 'support' ? 'low' : 'high';
    const pts = pivots.filter(v => v.kind === want && v.t < now && v.price > 0).sort((a, b) => a.t - b.t);
    if (pts.length < p.minTouches) continue;

    const found: TrendLine[] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        if (!a || !b || b.t === a.t) continue;
        const slope = (b.price - a.price) / (b.t - a.t);
        if (side === 'support' && !(slope > 0)) continue;     // 上昇支持線のみ
        if (side === 'resistance' && !(slope < 0)) continue;  // 下降抵抗線のみ
        const lineAt = (t: number): number => a.price + slope * (t - a.t);

        let touches = 0, firstT = Infinity, lastT = -Infinity, broken = false;
        for (const q of pts) {
          const L = lineAt(q.t);
          if (L <= 0) continue;
          const diff = q.price - L;            // support: 負=線より下(割れ側) / resistance: 正=線より上(割れ側)
          if (Math.abs(diff) <= L * p.tolPct) {
            touches++; if (q.t < firstT) firstT = q.t; if (q.t > lastT) lastT = q.t;
          } else if (side === 'support' && diff < -L * p.breakPct) {
            broken = true;
          } else if (side === 'resistance' && diff > L * p.breakPct) {
            broken = true;
          }
        }
        if (broken || touches < p.minTouches) continue;

        const Lnow = lineAt(now);
        if (Lnow <= 0) continue;
        // 現値が線をブレイク済みなら無効(=割れるまで有効、の裏返し)。
        if (side === 'support' && current < Lnow - Lnow * p.breakPct) continue;
        if (side === 'resistance' && current > Lnow + Lnow * p.breakPct) continue;
        // 実戦性: 今のライン価格が現値から離れすぎは除外。
        if (Math.abs(Lnow - current) > current * p.maxDistPct) continue;

        found.push({ kind: side, slope, touches, firstT, lastT, priceNow: Math.round(Lnow) });
      }
    }
    // 重複(同種で今のライン価格が近い)を集約。接触数→期間の長さ優先。
    found.sort((x, y) => y.touches - x.touches || (y.lastT - y.firstT) - (x.lastT - x.firstT));
    const dedup: TrendLine[] = [];
    for (const l of found) {
      if (dedup.some(k => Math.abs(k.priceNow - l.priceNow) <= l.priceNow * p.tolPct * 3)) continue;
      dedup.push(l);
      if (dedup.length >= p.maxLines) break;
    }
    out.push(...dedup);
  }
  return out;
}
