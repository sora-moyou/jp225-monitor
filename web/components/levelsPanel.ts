import type { LevelsResult, Level } from '../types.js';

let bodyEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let latest: LevelsResult | null = null;
let currentPrice: number | null = null;

export function initLevelsPanel(body: HTMLElement, meta: HTMLElement): void {
  bodyEl = body; metaEl = meta;
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
  if (l.reversalLine) cls.push('reversal');
  const star = l.strong ? '★ ' : '';
  const flag = l.reversalLine ? ' ⚑転換' : '';
  const labels = l.labels.join('・');
  return `<div class="${cls.join(' ')}">` +
    `<span class="lv-price">${star}${fmtPrice(l.price)}</span>` +
    `<span class="lv-dist">${fmtDist(dist)}</span>` +
    `<span class="lv-label">${labels}${flag}</span></div>`;
}

function render(): void {
  if (!bodyEl) return;
  const cur = currentPrice ?? latest?.current ?? null;
  if (!latest || cur === null || (latest.up.length === 0 && latest.down.length === 0)) {
    bodyEl.innerHTML = '<div class="levels-empty">蓄積中…</div>';
    if (metaEl) metaEl.textContent = '';
    return;
  }
  const up = [...latest.up].sort((a, b) => b.price - a.price);
  const down = [...latest.down].sort((a, b) => b.price - a.price);
  const curLine = `<div class="levels-cur">― 現値 ${fmtPrice(cur)} ―</div>`;
  bodyEl.innerHTML =
    up.map(l => rowHtml(l, cur)).join('') + curLine + down.map(l => rowHtml(l, cur)).join('');
  if (metaEl) {
    metaEl.textContent = latest.swing
      ? `${latest.swing.leg === 'down' ? '下げ脚' : '上げ脚'} ${latest.reversalSatisfied ? '転換目安○' : '転換目安—'}`
      : '';
  }
}
