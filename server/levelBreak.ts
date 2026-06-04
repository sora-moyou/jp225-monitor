// 主要レベルの「水準抜け」検知(純粋関数)。ダブルトップ/ボトムの“失敗版”=構造化された水準の突破。
//
// 原則(ユーザー指定): 走っている端(更新中のセッション高安など)を素通りで割っても無意味。
// その水準が「山/谷を形成した既成の構造」(= 一度到達 → reclaim円 離れて山/谷を作った)であり、
// その水準を改めて割った時だけ発火する。下落継続でセッション安値を初回更新するケースは出さない。
//
// 例(下抜け): 安値Lに到達 → 戻って山(L+reclaim 以上)を形成 → 再下落してLを割る。
// DTB が「タッチ→山/谷→再接近(反転狙い)」で終わるのに対し、break は同じ構造が「割って抜けた」で終わる。
export interface BrkBar { t: number; h: number; l: number; }

export interface BreakParams {
  breakTol: number;     // L をこの円数超えて越えたらブレイク成立
  crossBars: number;    // 「今まさに跨いだ」新規クロスを見る直近1分足の本数(古い抜けの再通知を防ぐ)
  touchTol: number;     // レベル到達(山/谷の頂点)許容円
  reclaimYen: number;   // 山/谷が L からこの円数離れたら「構造形成済み」とみなす
  lookbackBars: number; // 山/谷構造を探す窓(本)
}
// crossBars=新規性, touchTol/reclaimYen=構造(DTB の touchTol/pullbackYen と整合)。
export const DEFAULT_BREAK_PARAMS: BreakParams = {
  breakTol: 2, crossBars: 3, touchTol: 5, reclaimYen: 10, lookbackBars: 90,
};

export interface BreakSignal { kind: 'up' | 'down'; level: number; label: string; }

/**
 * 主要レベル群に対し「水準抜けの可能性」を検知。
 * bars は古い→新しい順の直近1分足(h/l)。current は現値(最新tick)。
 *
 * 上抜け(レジ L): 現値が L+breakTol 超 かつ 直近 crossBars で L を下→上に新規クロス(freshMinLow≤L)、
 *   かつ 窓内に「L へ到達(高値≥L-touchTol)→その後 L-reclaim 以下まで谷形成」の構造がある。
 * 下抜け(サポート L): 現値が L-breakTol 未満 かつ 直近 crossBars で L を上→下に新規クロス(freshMaxHigh≥L)、
 *   かつ 窓内に「L へ到達(安値≤L+touchTol)→その後 L+reclaim 以上まで山形成」の構造がある。
 *
 * 構造(タッチ→離れ)を要求することで、走っている端を素通りで割る無意味な継続ブレイクを除外する。
 * 連発抑制は呼び出し側の per-level クールダウンで行う。
 */
export function detectLevelBreak(
  levels: { price: number; label: string }[],
  bars: BrkBar[],
  current: number,
  p: BreakParams = DEFAULT_BREAK_PARAMS,
): BreakSignal[] {
  if (!(current > 0) || bars.length < 3) return [];
  const fresh = bars.slice(-p.crossBars);
  const freshMinLow = Math.min(...fresh.map(b => b.l));
  const freshMaxHigh = Math.max(...fresh.map(b => b.h));
  const win = bars.slice(-p.lookbackBars);
  const out: BreakSignal[] = [];
  for (const lv of levels) {
    const L = lv.price;
    if (!(L > 0)) continue;

    // 上抜け: 新規クロス + 「L到達 → 谷形成」構造
    if (current > L + p.breakTol && freshMinLow <= L) {
      const peakIdx = win.findIndex(b => b.h >= L - p.touchTol);                          // L へ到達(レジ試し)
      if (peakIdx >= 0) {
        const valleyIdx = win.findIndex((b, i) => i > peakIdx && b.l <= L - p.reclaimYen); // L から離れて谷形成
        if (valleyIdx > peakIdx) out.push({ kind: 'up', level: L, label: lv.label });
      }
    } else if (current < L - p.breakTol && freshMaxHigh >= L) {
      // 下抜け: 新規クロス + 「L到達 → 山形成」構造
      const troughIdx = win.findIndex(b => b.l <= L + p.touchTol);                         // L へ到達(サポート試し)
      if (troughIdx >= 0) {
        const peakIdx = win.findIndex((b, i) => i > troughIdx && b.h >= L + p.reclaimYen);  // L から離れて山形成
        if (peakIdx > troughIdx) out.push({ kind: 'down', level: L, label: lv.label });
      }
    }
  }
  return out;
}
