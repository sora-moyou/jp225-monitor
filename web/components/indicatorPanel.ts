import type { IndicatorSnapshot } from '../types.js';

// テクニカル指標のコンパクトな読み取り表示。価格ボードの右隣(旧・相関カードの空き枠)に
// 価格カードと同じ見た目のカードとして置き、SSE 'indicators' で更新する。
// 表示は「ヘッダ1行 + データ1行」の4列表(見出し行は出さない):
//   RSI   %B    BW     BWhigh/low
//   52    0.83  1.42   2.10/0.61
// ★2026-08-15: 列を「バンドの価格3本(0.7σ / 14MA / -0.7σ)」から
//   「バンドの **形**(%B=バンド内の位置 / BW=バンド幅 / その125本の高安)」へ差し替えた。
//   価格そのものは左隣の価格ボードで読めるので、パネルは価格ボードに無い情報だけを持つ。
//   値の出どころは snap.squeeze(5分足20本/2σ = 既存の 14本/0.7σ とは **別系列**。
//   あちらはバンドウォーク判定と AI プロンプトが共有しているので触っていない)。
// ★%B と BW は **1本前と比較**して 増加=緑(.ind-up)/ 減少=橙(.ind-down)/ 同値=無印。
//   「今どちらへ動いているか」は数値だけでは読めず、スクイーズ/バルジは変化の向きが本体のため。
// RSI≥70=買われすぎ / ≤30=売られすぎ は色で示す(既存仕様を維持)。
// データ未到達(null / 未算出)は「蓄積中…」を出す(検知ではなく表示専用)。
// squeeze が無い旧世代の配信では %B / BW / BWhigh/low を従来どおりの空表示('—')にする(壊れない)。

/** 小数2桁。null / 非有限は '—'。%B・BW・BWhigh/low の共通書式。 */
function dec2(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

/** RSI の色分類(overbought/oversold/neutral)。 */
export function rsiClass(rsi: number | null): 'ind-rsi-ob' | 'ind-rsi-os' | 'ind-rsi-neutral' {
  if (rsi == null) return 'ind-rsi-neutral';
  if (rsi >= 70) return 'ind-rsi-ob';
  if (rsi <= 30) return 'ind-rsi-os';
  return 'ind-rsi-neutral';
}

const BAR_MINUTES = 5;   // 1本=5分足。残り本数から待ち時間を出す(「あと13本」だけでは何分待ちか分からない)。
// 列名(並び: RSI / %B / BW / BWhigh・low)。データセルの並びもこの順(片方だけ直すと列名と値がずれる)。
const COLS = ['RSI', '%B', 'BW', 'BWhigh/low'] as const;

/** 1本前との比較で付ける色クラス。増加=緑 / 減少=橙 / 同値・比較不能=無印(既定色)。
 *  ★「同値なら無印」は意図的: 変化していないものに色を付けると、目が拾うべき変化が埋もれる。 */
export function trendClass(cur: number | null | undefined, prev: number | null | undefined): '' | 'ind-up' | 'ind-down' {
  if (cur == null || prev == null || !Number.isFinite(cur) || !Number.isFinite(prev)) return '';
  if (cur > prev) return 'ind-up';
  if (cur < prev) return 'ind-down';
  return '';
}

/** BWhigh/low の1セル表記(例 '2.10/0.61')。片方でも欠ければ '—'(片側だけの数字は誤読を招く)。 */
function highLow(high: number | null | undefined, low: number | null | undefined): string {
  const h = dec2(high), l = dec2(low);
  return h === '—' || l === '—' ? '—' : `${h}/${l}`;
}

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
  // ★セルの並びは COLS と同じ(RSI / %B / BW / BWhigh・low)。片方だけ入れ替えると列名と値がずれる。
  //   sq が無い(旧世代の配信)ときは %B / BW / BWhigh・low は '—'(色も付けない)= 従来どおりの空表示。
  const sq = snap.squeeze;
  const cell = (cls: string, text: string): string =>
    `<div class="ind-td${cls ? ` ${cls}` : ''}">${text}</div>`;
  const dataCells = [
    cell(rsiClass(snap.rsi), snap.rsi == null ? '—' : snap.rsi.toFixed(1)),
    cell(trendClass(sq?.pctB, sq?.prevPctB), dec2(sq?.pctB)),
    cell(trendClass(sq?.bw, sq?.prevBw), dec2(sq?.bw)),
    cell('', highLow(sq?.bwHigh, sq?.bwLow)),
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
