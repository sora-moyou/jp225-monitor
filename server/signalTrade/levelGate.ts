// トレードシグナルの「見送り後・再計画ゲート」の純関数。
//
// AI が direction:'none'(見送り)を返したら、そのときの価格を「アンカー」として記録し、
// 価格が主要な節目(レベル)を跨ぐまで再計画を抑止する(固定間隔で見送りを繰り返さない)。
// アンカーの直近上側節目(anchor より上で最小)と下側節目(anchor より下で最大)を境界にし、
// 価格が上側節目以上 or 下側節目以下になったら再武装(=再計画可)する。
//
// ★節目が片側でも欠けたら、詰まり防止のため両側とも従来の ±fallbackYen 円にフォールバックする。
// ★このモジュールは DB/LLM/レベル計算に依存しない純関数(単体テスト対象)。levels は呼び出し側が注入する。

/** 再武装判定に使うレベル集合(levelsLoop の LevelsResult から up/down の price だけを注入)。 */
export interface RearmLevels {
  up: { price: number }[];    // 現値より上側の節目
  down: { price: number }[];  // 現値より下側の節目
}

export interface RearmBounds {
  upper: number | null;   // アンカーより上で最も近い節目(無ければ null)
  lower: number | null;   // アンカーより下で最も近い節目(無ければ null)
  usedFallback: boolean;  // 両側の節目が揃わず ±fallbackYen を使ったか
  upperTrigger: number;   // 実際の上側トリガ価格(節目 or anchor+fallbackYen)
  lowerTrigger: number;   // 実際の下側トリガ価格(節目 or anchor-fallbackYen)
}

/** アンカー基準の再武装境界を求める。up/down を混ぜてアンカーとの相対で上下に振り分ける
 *  (levels は「現値」基準の up/down なので、アンカー≠現値でも正しく振り分けるため相対で判定する)。 */
export function rearmBounds(
  anchor: number,
  levels: RearmLevels | null | undefined,
  fallbackYen = 50,
): RearmBounds {
  const prices = levels
    ? [...levels.up, ...levels.down].map(l => l.price).filter(p => Number.isFinite(p))
    : [];
  const above = prices.filter(p => p > anchor);
  const below = prices.filter(p => p < anchor);
  const upper = above.length ? Math.min(...above) : null;
  const lower = below.length ? Math.max(...below) : null;
  // 片側でも節目が無ければ、詰まり防止のため両側 ±fallbackYen にフォールバック。
  const usedFallback = upper === null || lower === null;
  const upperTrigger = usedFallback ? anchor + fallbackYen : upper as number;
  const lowerTrigger = usedFallback ? anchor - fallbackYen : lower as number;
  return { upper, lower, usedFallback, upperTrigger, lowerTrigger };
}

/** 見送りアンカーに対し、現在値が節目(または ±fallbackYen)を跨いだら再武装(=再計画可)。
 *  anchor/price が非有限な異常時は詰まらせないため true(再武装)を返す。 */
export function shouldRearmOnLevel(
  anchor: number,
  price: number,
  levels: RearmLevels | null | undefined,
  fallbackYen = 50,
): boolean {
  if (!Number.isFinite(anchor) || !Number.isFinite(price)) return true;
  const b = rearmBounds(anchor, levels, fallbackYen);
  return price >= b.upperTrigger || price <= b.lowerTrigger;
}
