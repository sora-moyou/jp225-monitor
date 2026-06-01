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
// 直近アラートを最大10件まで保持（11件目で最古を1件削除）。
const MAX_BANNERS = 10;
// 当面、再起動後もアラートを残す。localStorage に {alert, explanation} を保存し、
// 起動時に restoreSavedBanners で復元する（LLM 再取得はしない）。
const STORAGE_KEY = 'jp225-alerts';

interface SavedAlert { alert: AlertEvent; explanation: string; }

function persist(): void {
  try {
    const arr: SavedAlert[] = [...items.values()].map(i => ({
      alert: i.alert,
      explanation: i.explanationEl.textContent ?? '',
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(arr.slice(-MAX_BANNERS)));
  } catch { /* localStorage 不可環境は無視 */ }
}

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

  persist();
  return item;
}

export function setExplanation(item: BannerItem, text: string): void {
  item.explanationEl.textContent = text;
  persist();
}

function removeBanner(id: string): void {
  const item = items.get(id);
  if (!item) return;
  item.el.remove();
  items.delete(id);
  persist();
}

/** 起動時に呼ぶ。localStorage に保存済みのアラートを復元する（LLM 再取得はしない）。 */
export function restoreSavedBanners(container: HTMLElement): void {
  let saved: SavedAlert[];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    saved = JSON.parse(raw) as SavedAlert[];
  } catch { return; }
  if (!Array.isArray(saved)) return;
  for (const s of saved) {
    if (!s?.alert?.symbol || typeof s.alert.triggeredAt !== 'number') continue;
    const item = addBanner(container, s.alert);
    if (s.explanation) setExplanation(item, s.explanation);
  }
}
