// 意識水準の「サポート/レジスタンス(支持/抵抗された)」検知 — 水準抜け(levelBreak)の補集合。
//
// ③(ユーザー指定): 予測でなく「反発した事実」を出す。水準にタッチ(髭が水準帯に到達)した後、
// reclaimYen 以上に跳ね返し、かつ水準を breakTol 超では割って/抜けていない時だけ「支持/抵抗された可能性」。
// 明確文例(⑤): 「セッション最安値65,000がサポートされた可能性」。
//
// support(サポート): 上から水準へ下落 → タッチ → 上へ反発(現値が L+reclaim 以上)。direction=up。
// resistance(レジスタンス): 下から水準へ上昇 → タッチ → 下へ反落(現値が L-reclaim 以下)。direction=down。

export interface HoldBar { t: number; h: number; l: number; }

export interface HoldParams {
  touchTol: number;     // 水準到達とみなす許容(円)
  reclaimYen: number;   // 反発確認: 水準からこの円数離れて初めて「支持/抵抗された」
  breakTol: number;     // 水準をこの円数超えて割った/抜けたら hold ではない(否定)
  crossBars: number;    // 直近何本で「タッチ→反発」を見るか
}
export const DEFAULT_HOLD_PARAMS: HoldParams = { touchTol: 5, reclaimYen: 10, breakTol: 2, crossBars: 5 };

export interface HoldSignal { kind: 'support' | 'resistance'; level: number; label: string; }

/**
 * 意識水準群に対し「支持/抵抗された可能性」を検知。bars は古い→新しい順の直近1分足(h/l)。
 * 直近 crossBars 本でのタッチ(髭が水準帯)+ 現値の反発 + 未ブレイク を要件とする。
 */
export function detectLevelHold(
  levels: { price: number; label: string }[],
  bars: HoldBar[],
  current: number,
  p: HoldParams = DEFAULT_HOLD_PARAMS,
): HoldSignal[] {
  if (!(current > 0) || bars.length < 2) return [];
  const recent = bars.slice(-p.crossBars);
  const recentLow = Math.min(...recent.map(b => b.l));
  const recentHigh = Math.max(...recent.map(b => b.h));
  const out: HoldSignal[] = [];
  for (const lv of levels) {
    const L = lv.price;
    if (!(L > 0)) continue;
    // サポート: 直近安値が水準帯 [L-breakTol, L+touchTol] に到達(=タッチ、かつ breakTol 超では割っていない)、
    //           現値が L+reclaim 以上へ反発。
    if (recentLow >= L - p.breakTol && recentLow <= L + p.touchTol && current >= L + p.reclaimYen) {
      out.push({ kind: 'support', level: L, label: lv.label });
    } else if (recentHigh <= L + p.breakTol && recentHigh >= L - p.touchTol && current <= L - p.reclaimYen) {
      // レジスタンス: 直近高値が水準帯 [L-touchTol, L+breakTol] に到達、現値が L-reclaim 以下へ反落。
      out.push({ kind: 'resistance', level: L, label: lv.label });
    }
  }
  return out;
}
