// ダブルトップ/ボトム検知(純粋関数)。主要レベルに対し「髭タッチ→押し戻し→手前10円で2山目」を判定。
// 仕様: 左=髭タッチ(レベル到達)、右=手前10円まで接近(未到達)、髭で超えたら不成立、ネック割れ不要。
export interface DBar { t: number; h: number; l: number; }

export interface DoubleParams {
  zoneYen: number;      // 2山目の接近ゾーン(レベルの手前◯円、未到達)
  touchTol: number;     // 髭タッチ到達許容(L にこれ以内まで到達でタッチ成立)
  breakTol: number;     // 超過(ブレイク)許容。髭がこれを超えてレベルを抜けたら不成立
  pullbackYen: number;  // 山谷の分離(ゾーン外へこの幅押し戻したら谷成立)
  lookbackBars: number; // 1山目を探す直近本数
}
export const DEFAULT_DOUBLE_PARAMS: DoubleParams = {
  zoneYen: 10, touchTol: 5, breakTol: 2, pullbackYen: 10, lookbackBars: 90,
};

export interface DoubleSignal { kind: 'top' | 'bottom'; level: number; label: string; }

/**
 * 主要レベル群に対しダブルトップ/ボトムを検知。
 * bars は古い→新しい順の直近1分足(h/l)。current は現値(最新tick)。
 * 戻り: 成立したレベルのシグナル配列(通常 0〜1件)。
 *
 * ダブルトップ(レジ L, 現値が L の手前):
 *   - exceeded: 窓内に high が L+breakTol を超えた足があれば不成立(レベルをブレイク)。
 *   - touchIdx: 最古の「髭タッチ」足(high >= L-touchTol)。未ブレイクなので high<=L+breakTol。
 *   - valleyIdx: タッチ後に low < L-pullbackYen へ押し戻した足(谷)。タッチ→谷の時系列を担保。
 *   - 現値が [L-zoneYen, L) に再接近(手前10円、未到達)= 2山目形成中 → 発火。
 *     現値は常に窓内足より後なので「谷の後にゾーンへ戻った=2山目」が時系列上保証される。
 * ダブルボトムは上下対称。
 */
export function detectDoubleTopBottom(
  levels: { price: number; label: string }[],
  bars: DBar[],
  current: number,
  p: DoubleParams = DEFAULT_DOUBLE_PARAMS,
): DoubleSignal[] {
  if (!(current > 0) || bars.length < 3) return [];
  const win = bars.slice(-p.lookbackBars);
  const out: DoubleSignal[] = [];

  for (const lv of levels) {
    const L = lv.price;
    if (!(L > 0)) continue;

    // ── ダブルトップ(レジスタンス): 現値が L の手前 zoneYen 円以内(下、未到達) ──
    if (current >= L - p.zoneYen && current < L) {
      const exceeded = win.some(b => b.h > L + p.breakTol);
      const touchIdx = win.findIndex(b => b.h >= L - p.touchTol);
      if (!exceeded && touchIdx >= 0) {
        const valleyIdx = win.findIndex((b, i) => i > touchIdx && b.l < L - p.pullbackYen);
        if (valleyIdx > touchIdx) out.push({ kind: 'top', level: L, label: lv.label });
      }
    }

    // ── ダブルボトム(サポート): 現値が L の手前 zoneYen 円以内(上、未到達) ──
    if (current <= L + p.zoneYen && current > L) {
      const exceeded = win.some(b => b.l < L - p.breakTol);
      const troughIdx = win.findIndex(b => b.l <= L + p.touchTol);
      if (!exceeded && troughIdx >= 0) {
        const peakIdx = win.findIndex((b, i) => i > troughIdx && b.h > L + p.pullbackYen);
        if (peakIdx > troughIdx) out.push({ kind: 'bottom', level: L, label: lv.label });
      }
    }
  }
  return out;
}
