// 主要レベルの「水準抜け」検知(純粋関数)。ダブルトップ/ボトム(反転)の補集合=ブレイク方向。
// DTB が「レベルに当てて反転(2山目接近)」を拾うのに対し、こちらは「反転せず抜けた/ネック未達で
// 再度抜けた」=レベルを跨いで現値が向こう側に滞在した状況を拾う。両者は現値の位置(手前 vs 越え)で
// 排他なので、同一レベルで同時に発火することはない。
export interface BrkBar { t: number; h: number; l: number; }

export interface BreakParams {
  breakTol: number;     // この円数を超えてレベルを越え、滞在したらブレイクとみなす
  lookbackBars: number; // レベルを「跨いだ」かを見る直近1分足の本数
}
export const DEFAULT_BREAK_PARAMS: BreakParams = { breakTol: 2, lookbackBars: 90 };

export interface BreakSignal { kind: 'up' | 'down'; level: number; label: string; }

/**
 * 主要レベル群に対し「水準抜けの可能性」を検知。
 * bars は古い→新しい順の直近1分足(h/l)。current は現値(最新tick)。
 *
 * 上抜け(レジ L): 現値が L+breakTol を超え、かつ直近窓で安値が L 以下まで届いていた
 *   (=窓内でレベルを下から上へ跨いだ新規ブレイク)。
 * 下抜け(サポート L): 現値が L-breakTol を下回り、かつ直近窓で高値が L 以上まで届いていた。
 *
 * 窓内にレベルを跨いだ痕跡が必要なので、ずっと前に抜けて以後ゾーンへ戻っていないレベルは拾わない。
 * 連発抑制は呼び出し側の per-level クールダウンで行う。
 */
export function detectLevelBreak(
  levels: { price: number; label: string }[],
  bars: BrkBar[],
  current: number,
  p: BreakParams = DEFAULT_BREAK_PARAMS,
): BreakSignal[] {
  if (!(current > 0) || bars.length < 3) return [];
  const win = bars.slice(-p.lookbackBars);
  const minLow = Math.min(...win.map(b => b.l));
  const maxHigh = Math.max(...win.map(b => b.h));
  const out: BreakSignal[] = [];
  for (const lv of levels) {
    const L = lv.price;
    if (!(L > 0)) continue;
    if (current > L + p.breakTol && minLow <= L) out.push({ kind: 'up', level: L, label: lv.label });
    else if (current < L - p.breakTol && maxHigh >= L) out.push({ kind: 'down', level: L, label: lv.label });
  }
  return out;
}
