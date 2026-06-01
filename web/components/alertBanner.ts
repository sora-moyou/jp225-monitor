import type { AlertEvent } from '../types.js';
import { UI } from '../lib/i18n.js';

export interface BannerItem {
  alert: AlertEvent;
  el: HTMLElement;
  explanationEl: HTMLElement;
  /** 手動更新ハンドラ — 作成側で .refresh = ... を設定 */
  refresh: () => void;
}

const items = new Map<string, BannerItem>();
// 直近アラートを最大10件まで保持（11件目で最古を1件削除）。再起動時はページリロードで
// この Map が空に戻るため自動的に全クリア（サーバは alert をリプレイしない）。
const MAX_BANNERS = 10;

export function addBanner(container: HTMLElement, alert: AlertEvent): BannerItem {
  const id = `${alert.symbol}-${alert.triggeredAt}`;
  if (items.has(id)) return items.get(id)!;

  const el = document.createElement('div');
  el.className = `alert ${alert.direction}`;
  const kindLabel = alert.detectionKind === 'slope' ? UI.ja.flash : UI.ja.trend;
  const arrow = alert.direction === 'up' ? '▲' : '▼';
  // 直近15分コンテキスト（参考、発火窓と分離）
  const ctx15 = alert.change15min !== null
    ? `<span class="ctx-15min">15分: ${alert.change15min >= 0 ? '+' : ''}${alert.change15min.toFixed(2)}%</span>`
    : '';
  const time = new Date(alert.triggeredAt).toLocaleTimeString('ja-JP', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const main = document.createElement('div');
  main.innerHTML =
    `<span class="alert-time">${time}</span> ` +
    `<strong>⚡ ${alert.symbolLabel}</strong> ` +
    `${arrow} ${alert.changePercent.toFixed(2)}% / ${alert.windowSeconds}秒 ` +
    `<span class="kind-tag">[${kindLabel}]</span> ` +
    `${ctx15} ` +
    `<span class="explanation">${UI.ja.explanationLoading}</span>`;
  const btnGroup = document.createElement('div');
  btnGroup.className = 'btn-group';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'refresh-btn';
  refreshBtn.textContent = '🔄';
  refreshBtn.title = 'LLM説明を即時更新（5分制限を無視）';
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.onclick = () => removeBanner(id);
  btnGroup.appendChild(refreshBtn);
  btnGroup.appendChild(close);
  el.appendChild(main);
  el.appendChild(btnGroup);
  container.prepend(el);

  const item: BannerItem = {
    alert,
    el,
    explanationEl: main.querySelector('.explanation') as HTMLElement,
    refresh: () => {},  // 呼び出し側が後で差し替える
  };
  refreshBtn.onclick = (e) => { e.preventDefault(); item.refresh(); };
  items.set(id, item);

  // 上限超え時は古いものを削除
  if (items.size > MAX_BANNERS) {
    const oldest = [...items.keys()][0];
    if (oldest) removeBanner(oldest);
  }

  return item;
}

export function setExplanation(item: BannerItem, text: string): void {
  item.explanationEl.textContent = text;
}

function removeBanner(id: string): void {
  const item = items.get(id);
  if (!item) return;
  item.el.remove();
  items.delete(id);
}
