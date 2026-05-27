import type { Price, AlertEvent } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

export function renderPriceGrid(container: HTMLElement, prices: Price[]): void {
  const priceMap = new Map(prices.map(p => [p.symbol, p]));
  container.innerHTML = '';
  for (const meta of INSTRUMENTS) {
    const p = priceMap.get(meta.symbol);
    const card = document.createElement('div');
    card.className = 'price-card';
    card.dataset.symbol = meta.symbol;
    if (p) {
      const dir = p.changePercent >= 0 ? 'up' : 'down';
      card.classList.add(dir);
      if (p.stale) card.classList.add('stale');
      const unit = meta.unit === 'bp' ? '' : '';
      card.innerHTML = `
        <div class="label">${meta.labelJa}</div>
        <div class="price">${p.price.toFixed(meta.unit === 'bp' ? 3 : 2)}${unit}</div>
        <div class="change">${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%</div>
      `;
    } else {
      card.innerHTML = `<div class="label">${meta.labelJa}</div><div class="price">---</div>`;
    }
    container.appendChild(card);
  }
  // 8銘柄で3×3、最後1枠空き
  const filler = document.createElement('div');
  filler.style.visibility = 'hidden';
  container.appendChild(filler);
}

export function flashCard(container: HTMLElement, alert: AlertEvent): void {
  const card = container.querySelector(`[data-symbol="${alert.symbol}"]`);
  if (!(card instanceof HTMLElement)) return;
  const cls = alert.direction === 'up' ? 'flash-up' : 'flash-down';
  card.classList.remove('flash-up', 'flash-down');
  void card.offsetWidth; // reflow でアニメ再実行
  card.classList.add(cls);
}
