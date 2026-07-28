// シグナル集約: 重複排除 → コンフルエンス統合 → スコアしきい値。
//
// 目的(④精度・③乱発抑制): 同じ局面(同方向・近接基準)で複数の検知器が鳴ると、従来は別アラートが
// 乱発した。ここで1本に統合し、整合本数でスコアを加点する(例: 水準サポ+MAサポ+大底 → 1本・高スコア)。
// スコアがしきい値未満のものは「②が否定/弱い」とみなし出さない。

import type { AlertSignal, SignalType } from './types.js';
import { SIGNAL_LABEL } from './types.js';

export interface AggregateParams {
  refTolYen: number;        // 同一基準とみなす価格許容(円)
  minScore: number;         // これ未満は emit しない(非イベント抑制)
  confluenceBonus: number;  // 整合シグナル1本追加ごとの加点
  slopeConfluenceBonus?: number;  // ★40日ライブ: slope(唯一の順行アルファ +52pt)と同方向の直近モメンタムに
                                  //   一致したクラスタへ加点。未指定/0=加点なし(=従来と完全一致)。
}
export const DEFAULT_AGGREGATE: AggregateParams = { refTolYen: 15, minScore: 1, confluenceBonus: 0.5 };

/**
 * 直近1分足から超短期モメンタムの向きを返す(純関数)。slope 方向一致ボーナスの判定に使う。
 * close[末尾] − close[約 lookbackMin 分前] の符号。|変化| < minYen または基準足が無い(データ不足)は null。
 */
export function recentMomentumDir(
  bars: { t: number; c: number }[],
  lookbackMin = 10,
  minYen = 50,
): 'up' | 'down' | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1]!;
  const cutoff = last.t - lookbackMin * 60_000;
  // cutoff 以前で最も新しいバー(=約 lookbackMin 前)。無ければデータ不足=null。
  let ref: { t: number; c: number } | null = null;
  for (let i = bars.length - 2; i >= 0; i--) {
    if (bars[i]!.t <= cutoff) { ref = bars[i]!; break; }
  }
  if (!ref) return null;
  const move = last.c - ref.c;
  if (Math.abs(move) < minYen) return null;
  return move > 0 ? 'up' : 'down';
}

export interface AggregatedSignal extends AlertSignal {
  members: AlertSignal[];   // 統合された元シグナル(内訳表示・履歴用)
  types: SignalType[];      // 含まれる種別(重複なし、score降順)
}

/**
 * 同方向・近接基準のシグナルを1本に統合する。
 * - クラスタ化: direction ごとに reference.price 昇順で並べ、隣接が refTolYen 以内なら同一局面とみなし束ねる。
 * - 代表(primary): クラスタ内で score 最大のシグナル(その text/reference/type/stage を採用)。
 * - 統合スコア = primary.score + confluenceBonus × (整合した「異なる種別」数 − 1)。同種の重複は加点しない。
 * - text: primary.text に、他種別があれば「(＋{種別}…も整合)」を付す。
 * - minScore 未満は除外。返り値は score 降順。
 */
export function aggregateSignals(
  signals: AlertSignal[],
  p: AggregateParams = DEFAULT_AGGREGATE,
  momentumDir: 'up' | 'down' | null = null,
): AggregatedSignal[] {
  if (signals.length === 0) return [];
  const out: AggregatedSignal[] = [];

  for (const dir of ['up', 'down'] as const) {
    const group = signals.filter(s => s.direction === dir).sort((a, b) => a.reference.price - b.reference.price);
    let cluster: AlertSignal[] = [];
    const flush = (): void => {
      if (cluster.length === 0) return;
      const primary = cluster.reduce((a, b) => (b.score > a.score ? b : a));
      // 異なる種別数でコンフルエンス加点(同種の重複は数えない)
      const distinctTypes = [...new Set(cluster.map(s => s.type))];
      // ★slope 方向一致ボーナス: 直近モメンタム(momentumDir)と同方向のクラスタにのみ加点。
      //   momentumDir=null または slopeConfluenceBonus 未指定/0 のときは加点0=従来と完全一致。
      const slopeBonus = (momentumDir && dir === momentumDir) ? (p.slopeConfluenceBonus ?? 0) : 0;
      const score = primary.score + p.confluenceBonus * Math.max(0, distinctTypes.length - 1) + slopeBonus;
      // 種別を score 合計の降順に(primary を先頭寄りに)
      const typeScore = new Map<SignalType, number>();
      for (const s of cluster) typeScore.set(s.type, (typeScore.get(s.type) ?? 0) + s.score);
      const types = [...typeScore.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
      const others = types.filter(t => t !== primary.type);
      const text = others.length
        ? `${primary.text}(＋${others.map(t => SIGNAL_LABEL[t]).join('・')} も整合)`
        : primary.text;
      const scoreParts = [...new Set(cluster.flatMap(s => s.scoreParts ?? []))];
      out.push({
        ...primary, score, text, members: [...cluster], types,
        scoreParts: scoreParts.length ? scoreParts : undefined,
      });
      cluster = [];
    };
    for (const s of group) {
      if (cluster.length && s.reference.price - cluster[cluster.length - 1]!.reference.price > p.refTolYen) flush();
      cluster.push(s);
    }
    flush();
  }

  return out.filter(s => s.score >= p.minScore).sort((a, b) => b.score - a.score);
}
