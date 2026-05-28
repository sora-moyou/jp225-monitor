import type { Price, AlertEvent } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

export function renderPriceGrid(container: HTMLElement, prices: Price[], showOnly?: Set<string>): void {
  const priceMap = new Map(prices.map(p => [p.symbol, p]));
  container.innerHTML = '';
  const visible = showOnly
    ? INSTRUMENTS.filter(i => showOnly.has(i.symbol))
    : INSTRUMENTS;
  for (const meta of visible) {
    const p = priceMap.get(meta.symbol);
    const card = document.createElement('div');
    card.className = 'price-card';
    card.dataset.symbol = meta.symbol;
    if (p) {
      const dir = p.changePercent >= 0 ? 'up' : 'down';
      card.classList.add(dir);
      if (p.stale) card.classList.add('stale');
      const sourceBadge = p.stale ? '<span class="source-badge">INV</span>' : '';
      const decimals = meta.unit === 'bp' ? 3 : 2;
      const sign = p.changePercent >= 0 ? '+' : '';
      card.innerHTML = `
        <div class="label"><span>${meta.labelJa}</span>${sourceBadge}</div>
        <div class="price">${p.price.toFixed(decimals)}</div>
        <div class="change">${sign}${p.changePercent.toFixed(2)}%</div>
      `;
    } else {
      card.innerHTML = `<div class="label"><span>${meta.labelJa}</span></div><div class="price">---</div>`;
    }
    container.appendChild(card);
  }
}

export function flashCard(container: HTMLElement, alert: AlertEvent): void {
  const card = container.querySelector(`[data-symbol="${alert.symbol}"]`);
  if (!(card instanceof HTMLElement)) return;
  const cls = alert.direction === 'up' ? 'flash-up' : 'flash-down';
  card.classList.remove('flash-up', 'flash-down');
  void card.offsetWidth; // reflow でアニメ再実行
  card.classList.add(cls);
}
