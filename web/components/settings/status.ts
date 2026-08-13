// プロバイダ状態表示 + 各キー行の状態マーク。settingsModal.ts から純粋に切り出したもの(挙動不変)。

import type { SettingsResponse, GeneratorKeySource } from './types.js';

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

// ★分析用の「どのキーが効いているか」表示(純関数)。
//   この画面の一番の仕事は **専用キーが効いているのか共通キーに落ちているのかが一目で分かること**。
//   共通キーへのフォールバックを「未設定」と書くと「使われていない」と誤読される。実際には使われていて、
//   しかも実取引(A)と同じ上流クォータを消費する=「分離したつもりで分離できていない」状態になる。
//   だから 'shared' は必ず **「共通キーを使用中」** と書き、分離できていないことを明示する。
export function generatorKeyLabel(src: GeneratorKeySource | undefined): {
  mark: string; text: string; title: string; shared: boolean;
} {
  switch (src) {
    case 'own':
      return { mark: '🟢', text: '専用キー設定済み', shared: false,
        title: '分析用は専用キーで動きます(実取引 A のキーとは別)' };
    case 'env':
      return { mark: '🟢', text: '専用キー設定済み（環境変数）', shared: false,
        title: '環境変数 GENERATOR_*_API_KEY の専用キーで動きます' };
    case 'shared':
      return { mark: '🔁', text: '共通キーを使用中', shared: true,
        title: '専用キーが無いため実取引(A)と同じ共通キーで動きます。ローカルのポーズは分離されますが、'
          + '提供元側のクォータは共有されたままです(分析用が枠を食えば A が 429 を踏みます)' };
    case 'none':
      return { mark: '⚪', text: 'キー未設定（このプロバイダは使えません）', shared: false,
        title: '専用キーも共通キーも無いので、分析用はこのプロバイダを使いません' };
    default:
      return { mark: '⚪', text: '—', shared: false, title: '状態不明(設定の取得に失敗)' };
  }
}

// 分析用キー行の「どのキーを使うか」テキストを DOM へ反映する(id は index.html の genkey-<name>-src)。
export function setKeySourceLabel(id: string, text: string, title: string, shared: boolean): void {
  const node = document.getElementById(id);
  if (!node) return;
  node.textContent = text;
  node.title = title;
  node.className = shared ? 'gen-key-src gen-key-shared' : 'gen-key-src';
}

// プロバイダ状態(providers)→ マーク。🟢有効 / 🟡待機中(429) / ⚪未設定。
export function providerMark(p: { enabled: boolean; paused: boolean } | undefined): { mark: string; title: string } {
  if (!p || !p.enabled) return { mark: '⚪', title: '未設定' };
  if (p.paused) return { mark: '🟡', title: '待機中(429=枠切れで一時休止・自動フォールバック中)' };
  return { mark: '🟢', title: '有効(設定済)' };
}
