// 主要レベルの「水準抜け」検知(純粋関数)。ダブルトップ/ボトム(反転)の補集合=ブレイク方向。
// DTB が「レベルに当てて反転(2山目接近)」を拾うのに対し、こちらは「反転せず抜けた/ネック未達で
// 再度抜けた」=レベルを跨いで現値が向こう側に滞在した状況を拾う。両者は現値の位置(手前 vs 越え)で
// 排他なので、同一レベルで同時に発火することはない。
export interface BrkBar { t: number; h: number; l: number; }

export interface BreakParams {
  breakTol: number;   // この円数を超えてレベルを越え、滞在したらブレイクとみなす
  crossBars: number;  // 「今まさに跨いだ」かを見る直近1分足の本数(短く=新規クロス限定)
}
// クロス判定は直近 crossBars 分のみ。長くすると朝方に一瞬触れたレベルを価格が離れた後も誤発火する。
export const DEFAULT_BREAK_PARAMS: BreakParams = { breakTol: 2, crossBars: 3 };

export interface BreakSignal { kind: 'up' | 'down'; level: number; label: string; }

/**
 * 主要レベル群に対し「水準抜けの可能性」を検知。
 * bars は古い→新しい順の直近1分足(h/l)。current は現値(最新tick)。
 *
 * 上抜け(レジ L): 現値が L+breakTol を超え、かつ【直近 crossBars 本】で安値が L 以下まで届いていた
 *   (=ここ数分でレベルを下から上へ跨いだ新規ブレイク)。
 * 下抜け(サポート L): 現値が L-breakTol を下回り、かつ【直近 crossBars 本】で高値が L 以上まで届いていた。
 *
 * クロス痕跡を直近数分に限定することで、ずっと前に抜けて現値が遠ざかったレベル(=今は達していない)を
 * 拾わない。連発抑制は呼び出し側の per-level クールダウンで行う。
 */
export function detectLevelBreak(
  levels: { price: number; label: string }[],
  bars: BrkBar[],
  current: number,
  p: BreakParams = DEFAULT_BREAK_PARAMS,
): BreakSignal[] {
  if (!(current > 0) || bars.length < 3) return [];
  const win = bars.slice(-p.crossBars);
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
