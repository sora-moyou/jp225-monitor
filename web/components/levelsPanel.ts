import type { LevelsResult, Level } from '../types.js';
import { apiUrl } from '../lib/apiBase.js';

let bodyEl: HTMLElement | null = null;
let latest: LevelsResult | null = null;
let currentPrice: number | null = null;
let priceStale = false;   // NIY=F の現値が取得不能(socket 停止/stale)か。true でも水準は出す。
let seasonalityHtml = '';

interface SlotStat { slot: string; avgReturn: number; upRate: number; avgRange: number; samples: number; }
interface ForecastResp { seasonalityNow: SlotStat | null; seasonalityNext: SlotStat | null; }

function fmtSlot(s: SlotStat): string {
  const sign = s.avgReturn >= 0 ? '+' : '';
  return `${s.slot}台: 平均${sign}${s.avgReturn.toFixed(2)}% / 上昇${Math.round(s.upRate * 100)}% / 値幅${s.avgRange.toFixed(2)}% (${s.samples}日)`;
}

async function refreshSeasonality(): Promise<void> {
  try {
    const res = await fetch(apiUrl('/api/forecast'));
    if (!res.ok) return;
    const f = await res.json() as ForecastResp;
    if (f.seasonalityNow) {
      seasonalityHtml = `<div class="levels-seasonality">🕒 ${fmtSlot(f.seasonalityNow)}</div>`;
    } else {
      seasonalityHtml = '';
    }
    render();
  } catch { /* ネット未準備時は無視 */ }
}

export function initLevelsPanel(body: HTMLElement): void {
  bodyEl = body;
  void refreshSeasonality();
  setInterval(() => void refreshSeasonality(), 180_000);
}
export function setLevels(r: LevelsResult): void { latest = r; render(); }
/** NIY=F 現値を反映。stale=true(socket 停止/取得不能)なら現値マーカーを「取得不能」に切替えるが、
 *  水準行そのものは(bars/履歴由来なので)描画し続ける。 */
export function setLevelsPrice(p: number, stale = false): void { currentPrice = p; priceStale = stale; render(); }

function round5(v: number): number { return Math.round(v / 5) * 5; }
function fmtPrice(v: number): string { return Math.round(v).toLocaleString('en-US'); }
function fmtDist(d: number): string { return `${d >= 0 ? '+' : ''}${d}`; }

function rowHtml(l: Level, cur: number): string {
  const dist = round5(l.price - cur);
  const cls = ['levels-row'];
  if (l.strong) cls.push('strong');
  if (l.tier === 2) cls.push('confluence');
  if (l.reversalLine) cls.push('reversal');
  const star = l.tier === 2 ? '★★ ' : l.tier === 1 ? '★ ' : '';
  const flag = l.reversalLine ? ' ⚑転換' : '';
  const labels = l.labels.join('・');
  return `<div class="${cls.join(' ')}">` +
    `<span class="lv-price">${star}${fmtPrice(l.price)}</span>` +
    `<span class="lv-dist">${fmtDist(dist)}</span>` +
    `<span class="lv-label">${labels}${flag}</span>` +
    `<span class="lv-score">${l.score.toFixed(1)}</span></div>`;
}

/**
 * 純関数: パネル本文の HTML を組み立てる(DOM 非依存=単体テスト可能)。
 *  - 水準が一つも無い/未受信 → 「蓄積中…」(本当に何も無い時だけ)。
 *  - 水準あり + 現値 stale/欠落 → 水準行は描画し、現値行だけ「現値 取得不能」に置換(価格カードと整合)。
 *    行の位置分けには「最後に判った現値(latest.current)」を基準に使う(空白化しない)。
 */
export function buildLevelsHtml(
  latest: LevelsResult | null,
  currentPrice: number | null,
  priceStale: boolean,
  seasonalityHtml: string,
): string {
  const hasLevels = !!latest && (latest.up.length > 0 || latest.down.length > 0);
  if (!hasLevels) {
    // 水準が本当に一度も来ていない時だけ「蓄積中…」。
    return seasonalityHtml + '<div class="levels-empty">蓄積中…</div>';
  }
  // 現値が fresh なら currentPrice、stale/欠落なら最後に計算した現値(latest!.current)を行分けに使う。
  const liveOk = currentPrice !== null && !priceStale;
  const splitAt = liveOk ? currentPrice! : (latest!.current || null);
  const all = [...latest!.up, ...latest!.down];
  // サーバの up/down 分割は計算時点の価格基準。行位置は splitAt(fresh 現値 or 最後の計算現値)で再分割。
  const above = splitAt !== null ? all.filter(l => l.price > splitAt).sort((a, b) => b.price - a.price) : [];
  const below = splitAt !== null ? all.filter(l => l.price <= splitAt).sort((a, b) => b.price - a.price) : all.sort((a, b) => b.price - a.price);
  const distBasis = splitAt ?? 0;
  const curLine = liveOk
    ? `<div class="levels-cur">― 現値 ${fmtPrice(currentPrice!)} ―</div>`
    : `<div class="levels-cur levels-cur-stale">― 現値 取得不能 ―</div>`;   // 停止中も水準は残す(価格カードと整合)。
  return seasonalityHtml
    + above.map(l => rowHtml(l, distBasis)).join('')
    + curLine
    + below.map(l => rowHtml(l, distBasis)).join('');
}

function render(): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = buildLevelsHtml(latest, currentPrice, priceStale, seasonalityHtml);
}
