import type { IndicatorSnapshot } from '../types.js';

// テクニカル指標(RSI/SMA/BB)のコンパクトな読み取り表示。価格グリッド脇に置き、
// SSE 'indicators' で更新する。RSI≥70=買われすぎ / ≤30=売られすぎ を色で示す。
// データ未到達(null / 未算出)は「蓄積中…」を出す(検知ではなく表示専用)。

/** 整数 + 桁区切り(円価格用)。null は '—'。 */
function yen(v: number | null): string {
  return v == null ? '—' : Math.round(v).toLocaleString('en-US');
}

/** %B の位置ラベル(上寄り/中央/下寄り)。null は空。 */
function pctBLabel(pctB: number | null): string {
  if (pctB == null) return '';
  if (pctB >= 0.8) return '上寄り';
  if (pctB <= 0.2) return '下寄り';
  return '中央';
}

/** RSI の色分類(overbought/oversold/neutral)。 */
export function rsiClass(rsi: number | null): 'ind-rsi-ob' | 'ind-rsi-os' | 'ind-rsi-neutral' {
  if (rsi == null) return 'ind-rsi-neutral';
  if (rsi >= 70) return 'ind-rsi-ob';
  if (rsi <= 30) return 'ind-rsi-os';
  return 'ind-rsi-neutral';
}

/** 指標スナップショットからパネル HTML を組み立てる純関数(DOM 非依存・テスト容易化)。
 *  主指標が全て null(蓄積中)なら「蓄積中…」を返す。 */
export function buildIndicatorHtml(snap: IndicatorSnapshot | null): string {
  if (!snap || (snap.rsi == null && snap.sma == null && snap.bbUpper == null)) {
    return `<span class="ind-label">テクニカル(5分)</span><span class="ind-empty">蓄積中…</span>`;
  }
  const rsiTxt = snap.rsi == null ? '—' : String(Math.round(snap.rsi));
  const bb = (snap.bbLower != null && snap.bbUpper != null)
    ? `${yen(snap.bbLower)}〜${yen(snap.bbUpper)}`
    : '—';
  const pos = pctBLabel(snap.pctB);
  const pctBTxt = snap.pctB == null ? '' : `(%B ${snap.pctB.toFixed(2)})`;
  const priceCell = pos ? `価格 ${pos}${pctBTxt}` : `価格 ${yen(snap.price)}`;
  return [
    `<span class="ind-label">テクニカル(5分)</span>`,
    `<span class="ind-item"><span class="ind-key">RSI</span> <span class="${rsiClass(snap.rsi)}">${rsiTxt}</span></span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item"><span class="ind-key">SMA</span> ${yen(snap.sma)}</span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item"><span class="ind-key">BB[±1.5σ]</span> ${bb}</span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item">${priceCell}</span>`,
  ].join('');
}

let mounted: HTMLElement | null = null;

/** パネル要素を登録し、初期表示(蓄積中…)を描く。 */
export function initIndicatorPanel(el: HTMLElement): void {
  mounted = el;
  el.innerHTML = buildIndicatorHtml(null);
}

/** SSE 'indicators' を受けてパネルを更新する。 */
export function setIndicators(snap: IndicatorSnapshot): void {
  if (mounted) mounted.innerHTML = buildIndicatorHtml(snap);
}
