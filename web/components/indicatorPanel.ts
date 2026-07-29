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

const LABEL = `<span class="ind-label">テクニカル(5分)</span>`;
const BAR_MINUTES = 5;   // 1本=5分足。残り本数から待ち時間を出す(「あと13本」だけでは何分待ちか分からない)。

/** 主指標が出せないときの文言(progress で理由を切り分ける・画面だけで自己診断できるように)。
 *   no-bars  → 「足データ未取得」= データ供給そのものが無い(フィード停止/収集デーモン未稼働)。
 *   warming  → 「蓄積中… あと○本(約○分)」= 残り本数と所要時間を明示。
 *   closed   → 「取引時間外」= ドーマント化で算出していない(異常ではない)。
 *   disabled → 設定で機能OFF。
 *   progress が無い(旧世代の配信/未接続)は従来どおり「蓄積中…」。 */
function emptyHtml(snap: IndicatorSnapshot | null): string {
  const p = snap?.progress;
  if (p?.state === 'no-bars') {
    return `${LABEL}<span class="ind-empty">足データ未取得(価格フィード停止 or 収集デーモン未稼働の可能性)</span>`;
  }
  if (p?.state === 'closed') {
    return `${LABEL}<span class="ind-empty">取引時間外(次の取引時間に再開します)</span>`;
  }
  if (p?.state === 'disabled') {
    return `${LABEL}<span class="ind-empty">OFF(設定「テクニカル指標」で有効にできます)</span>`;
  }
  const rest = p?.state === 'warming' && p.remaining > 0
    ? ` あと${p.remaining}本(約${p.remaining * BAR_MINUTES}分)`
    : '';
  return `${LABEL}<span class="ind-empty">蓄積中…${rest}</span>`;
}

/** 指標スナップショットからパネル HTML を組み立てる純関数(DOM 非依存・テスト容易化)。
 *  主指標が全て null(未算出)なら蓄積状況(足0本 / 残り本数)を出す。 */
export function buildIndicatorHtml(snap: IndicatorSnapshot | null): string {
  if (!snap || (snap.rsi == null && snap.sma == null && snap.bbUpper == null)) {
    return emptyHtml(snap);
  }
  const rsiTxt = snap.rsi == null ? '—' : String(Math.round(snap.rsi));
  const bb = (snap.bbLower != null && snap.bbUpper != null)
    ? `${yen(snap.bbLower)}〜${yen(snap.bbUpper)}`
    : '—';
  const pos = pctBLabel(snap.pctB);
  const pctBTxt = snap.pctB == null ? '' : `(%B ${snap.pctB.toFixed(2)})`;
  const priceCell = pos ? `価格 ${pos}${pctBTxt}` : `価格 ${yen(snap.price)}`;
  // 更新が止まっている理由は「印」として末尾に付ける(値は消さない=引け後にセッション最終値を読める)。
  const mark = snap.progress?.state === 'closed' ? '取引時間外'
    : snap.progress?.state === 'disabled' ? 'OFF(更新停止)' : '';
  const markCell = mark
    ? `<span class="ind-sep">・</span><span class="ind-empty">${mark}</span>`
    : '';
  return [
    `<span class="ind-label">テクニカル(5分)</span>`,
    `<span class="ind-item"><span class="ind-key">RSI</span> <span class="${rsiClass(snap.rsi)}">${rsiTxt}</span></span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item"><span class="ind-key">SMA</span> ${yen(snap.sma)}</span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item"><span class="ind-key">BB[±1.5σ]</span> ${bb}</span>`,
    `<span class="ind-sep">・</span>`,
    `<span class="ind-item">${priceCell}</span>`,
    markCell,
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
