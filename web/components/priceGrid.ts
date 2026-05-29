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
      // USD 建ては JPY 換算 % で色判定 + 表示 (jpyChangePercent あれば優先)。
      // ¥ バッジで「これは円換算後の値」と明示する。
      const isJpyConverted = typeof p.jpyChangePercent === 'number';
      const displayChange = isJpyConverted ? p.jpyChangePercent! : p.changePercent;
      const dir = displayChange >= 0 ? 'up' : 'down';
      card.classList.add(dir);
      if (p.stale) card.classList.add('stale');
      const sourceBadge = p.stale ? '<span class="source-badge">INV</span>' : '';
      const jpyBadge = isJpyConverted ? '<span class="jpy-badge" title="USD建て銘柄を JPY=X で円換算した値動き">¥</span>' : '';
      const decimals = meta.unit === 'bp' ? 3 : 2;
      const sign = displayChange >= 0 ? '+' : '';
      const formattedPrice = p.price.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      card.innerHTML = `
        <div class="label"><span>${meta.labelJa}</span>${sourceBadge}${jpyBadge}</div>
        <div class="value">
          <span class="num">${formattedPrice}</span>
          <span class="change">${sign}${displayChange.toFixed(2)}%</span>
        </div>
      `;
    } else {
      card.innerHTML = `<div class="label"><span>${meta.labelJa}</span></div><div class="value"><span class="num">---</span></div>`;
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
