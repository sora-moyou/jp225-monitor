// プロバイダ状態表示 + 各キー行の状態マーク。settingsModal.ts から純粋に切り出したもの(挙動不変)。

import type { SettingsResponse } from './types.js';

export function renderStatus(s: SettingsResponse | null): string {
  if (!s) return '<div class="settings-status err">設定取得失敗</div>';
  const items = s.providers.map(p => {
    const dot = p.enabled
      ? (p.paused ? '🟡' : '🟢')
      : '⚪';
    const note = p.paused
      ? ` (${Math.max(0, Math.round((p.pausedUntil - Date.now()) / 1000))}秒待機中)`
      : p.enabled ? '' : ' 未設定';
    return `<div>${dot} ${p.name}${note}</div>`;
  }).join('');
  return `<div class="settings-status">${items}</div>`;
}

// 各キー行の左に付く状態マークを更新する(id は index.html の key-<name>-status)。
export function setKeyStatus(id: string, mark: string, title: string): void {
  const node = document.getElementById(id);
  if (node) { node.textContent = mark; node.title = `キー状態: ${title}`; }
}

// プロバイダ状態(providers)→ マーク。🟢有効 / 🟡待機中(429) / ⚪未設定。
export function providerMark(p: { enabled: boolean; paused: boolean } | undefined): { mark: string; title: string } {
  if (!p || !p.enabled) return { mark: '⚪', title: '未設定' };
  if (p.paused) return { mark: '🟡', title: '待機中(429=枠切れで一時休止・自動フォールバック中)' };
  return { mark: '🟢', title: '有効(設定済)' };
}
