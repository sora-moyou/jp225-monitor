import type { IndicatorSnapshot } from '../types.js';
import { BB_UPPER_LABEL, BB_LOWER_LABEL } from '../../core/indicatorSpec.js';

// テクニカル指標(RSI/SMA/BB)のコンパクトな読み取り表示。価格ボードの右隣(旧・相関カードの空き枠)に
// 価格カードと同じ見た目のカードとして置き、SSE 'indicators' で更新する。
// 表示はユーザー指定の「ヘッダ1行 + データ1行」の4列表(見出し行や %B は出さない):
//   RSI   0.7σ    14MA    -0.7σ
//   64.1  72,310  72,010  71,810
// ★列の並びは「上バンド → 中央(14MA) → 下バンド」= 値の大小と並びが一致する(ユーザー指定)。
// ★σ の倍率と列名は core/indicatorSpec.ts が唯一の定義(計算側 server/indicators.ts と同じ真実)。
// RSI≥70=買われすぎ / ≤30=売られすぎ は色で示す(既存仕様を維持)。
// データ未到達(null / 未算出)は「蓄積中…」を出す(検知ではなく表示専用)。

/** 整数 + 桁区切り(円価格用)。null は '—'。 */
function yen(v: number | null): string {
  return v == null ? '—' : Math.round(v).toLocaleString('en-US');
}

/** RSI の色分類(overbought/oversold/neutral)。 */
export function rsiClass(rsi: number | null): 'ind-rsi-ob' | 'ind-rsi-os' | 'ind-rsi-neutral' {
  if (rsi == null) return 'ind-rsi-neutral';
  if (rsi >= 70) return 'ind-rsi-ob';
  if (rsi <= 30) return 'ind-rsi-os';
  return 'ind-rsi-neutral';
}

const BAR_MINUTES = 5;   // 1本=5分足。残り本数から待ち時間を出す(「あと13本」だけでは何分待ちか分からない)。
// 列名(ユーザー指定の並び: RSI / 上バンド / 14MA / 下バンド)。σ 表記は core/indicatorSpec.ts が SSOT。
const COLS = ['RSI', BB_UPPER_LABEL, '14MA', BB_LOWER_LABEL] as const;

/** ヘッダ行の4セル。mark(取引時間外 / OFF)は左端セルの空きに置く=行数を増やさない。 */
function headerCells(mark = ''): string {
  const markHtml = mark ? `<span class="ind-mark">${mark}</span>` : '';
  return COLS
    .map((c, i) => `<div class="ind-th">${i === 0 ? markHtml : ''}<span>${c}</span></div>`)
    .join('');
}

/** ヘッダとデータを同じグリッドに入れる(列位置を一致させるため2行を分けない)。 */
function grid(inner: string): string {
  return `<div class="ind-grid">${inner}</div>`;
}

/** 列をまたぐ注記行(値が無いときの理由)。 */
function note(text: string): string {
  return `<div class="ind-note">${text}</div>`;
}

/** 主指標が出せないときの文言(progress で理由を切り分ける・画面だけで自己診断できるように)。
 *   no-bars  → 「足データ未取得」= データ供給そのものが無い(フィード停止/収集デーモン未稼働)。
 *   warming  → 「蓄積中… あと○本(約○分)」= 残り本数と所要時間を明示。
 *   closed   → 「取引時間外」= ドーマント化で算出していない(異常ではない)。
 *   disabled → 設定で機能OFF。
 *   progress が無い(旧世代の配信/未接続)は従来どおり「蓄積中…」。 */
function emptyHtml(snap: IndicatorSnapshot | null): string {
  const p = snap?.progress;
  if (p?.state === 'no-bars') {
    return grid(headerCells() + note('足データ未取得(価格フィード停止 or 収集デーモン未稼働の可能性)'));
  }
  if (p?.state === 'closed') {
    return grid(headerCells() + note('取引時間外(次の取引時間に再開します)'));
  }
  if (p?.state === 'disabled') {
    return grid(headerCells() + note('OFF(設定「テクニカル指標」で有効にできます)'));
  }
  const rest = p?.state === 'warming' && p.remaining > 0
    ? ` あと${p.remaining}本(約${p.remaining * BAR_MINUTES}分)`
    : '';
  return grid(headerCells() + note(`蓄積中…${rest}`));
}

/** 指標スナップショットからパネル HTML を組み立てる純関数(DOM 非依存・テスト容易化)。
 *  主指標が全て null(未算出)なら蓄積状況(足0本 / 残り本数)を出す。 */
export function buildIndicatorHtml(snap: IndicatorSnapshot | null): string {
  if (!snap || (snap.rsi == null && snap.sma == null && snap.bbUpper == null)) {
    return emptyHtml(snap);
  }
  // 更新が止まっている理由は「印」としてヘッダ行に付ける(値は消さない=引け後にセッション最終値を読める)。
  const mark = snap.progress?.state === 'closed' ? '取引時間外'
    : snap.progress?.state === 'disabled' ? 'OFF' : '';
  // ★セルの並びは COLS と同じ(RSI / 上バンド / 14MA / 下バンド)。片方だけ入れ替えると列名と値がずれる。
  const dataCells = [
    `<div class="ind-td ${rsiClass(snap.rsi)}">${snap.rsi == null ? '—' : snap.rsi.toFixed(1)}</div>`,
    `<div class="ind-td">${yen(snap.bbUpper)}</div>`,
    `<div class="ind-td">${yen(snap.sma)}</div>`,
    `<div class="ind-td">${yen(snap.bbLower)}</div>`,
  ].join('');
  return grid(headerCells(mark) + dataCells);
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
