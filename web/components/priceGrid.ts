import type { Price, AlertEvent } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

// v0.3.33: 日経カード用。アラート2階層に対応した直近の動きを、ラベル無しで値だけ描画する。
//   短期 = 変化率(%, 直近60秒) / 超短期 = 値幅(円, 5〜10秒) の順で「+0.20%  +50円」のように出す。
function momSpan(text: string, v: number | null): string {
  const cls = v === null ? 'flat' : v >= 0 ? 'up' : 'down';
  return `<span class="${cls}">${text}</span>`;
}
function renderMomentum(m: NonNullable<Price['momentum']>): string {
  const pct = momSpan(
    m.shortPct === null ? '—' : `${m.shortPct >= 0 ? '+' : ''}${m.shortPct.toFixed(2)}%`,
    m.shortPct,
  );
  const yen = momSpan(
    m.ultraShortYen === null ? '—' : `${m.ultraShortYen >= 0 ? '+' : ''}${Math.round(m.ultraShortYen)}円`,
    m.ultraShortYen,
  );
  return `<span class="change mom">${pct}${yen}</span>`;
}

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
      const mom = meta.symbol === 'NIY=F' ? p.momentum : undefined;
      // 日経は「短期(率)」の符号でカード方向を決める(日中の値動きと一致させる)。
      // それ以外/momentum 未取得時は従来どおり前日終値比で判定。
      const dirBasis = mom && mom.shortPct !== null ? mom.shortPct : p.changePercent;
      card.classList.add(dirBasis >= 0 ? 'up' : 'down');
      if (p.stale) card.classList.add('stale');
      const sourceBadge = p.stale ? '<span class="source-badge">INV</span>' : '';
      // 日経は値幅が大きく小数点以下は不要 → 整数表示。
      const decimals = meta.symbol === 'NIY=F' ? 0 : meta.unit === 'bp' ? 3 : 2;
      const sign = p.changePercent >= 0 ? '+' : '';
      const formattedPrice = p.price.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
      const changeHtml = mom
        ? renderMomentum(mom)
        : `<span class="change">${sign}${p.changePercent.toFixed(2)}%</span>`;
      // v0.3.34: 日経はラベルと同じ行に期間ラベル(1分=短期率 / 10秒=超短期値幅)をラベル色で。
      const periods = mom ? '<span class="periods">1分　10秒</span>' : '';
      card.innerHTML = `
        <div class="label"><span>${meta.labelJa}</span>${periods}${sourceBadge}</div>
        <div class="value">
          <span class="num">${formattedPrice}</span>
          ${changeHtml}
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
