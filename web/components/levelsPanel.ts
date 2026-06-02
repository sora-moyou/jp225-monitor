import type { LevelsResult, Level } from '../types.js';
import { apiUrl } from '../lib/apiBase.js';

let bodyEl: HTMLElement | null = null;
let latest: LevelsResult | null = null;
let currentPrice: number | null = null;
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
export function setLevelsPrice(p: number): void { currentPrice = p; render(); }

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

function render(): void {
  if (!bodyEl) return;
  const cur = currentPrice ?? latest?.current ?? null;
  if (!latest || cur === null || (latest.up.length === 0 && latest.down.length === 0)) {
    bodyEl.innerHTML = seasonalityHtml + '<div class="levels-empty">蓄積中…</div>';
    return;
  }
  // サーバの up/down 分割は計算時点(最大60秒前)の価格基準。ライブ現値が動くと、
  // 例「+15 当日安」が現値線の下に出る等のズレが起きるため、ここで全レベルを
  // ライブ現値で再分割し、価格と現値線の位置を常に一致させる。
  const all = [...latest.up, ...latest.down];
  const above = all.filter(l => l.price > cur).sort((a, b) => b.price - a.price);   // 上値 (高い順)
  const below = all.filter(l => l.price <= cur).sort((a, b) => b.price - a.price);  // 下値 (高い順)
  const curLine = `<div class="levels-cur">― 現値 ${fmtPrice(cur)} ―</div>`;
  bodyEl.innerHTML =
    seasonalityHtml + above.map(l => rowHtml(l, cur)).join('') + curLine + below.map(l => rowHtml(l, cur)).join('');
}
