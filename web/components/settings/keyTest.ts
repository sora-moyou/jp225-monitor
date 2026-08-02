// APIキーの実効性検証セクションの配線。settingsModal.ts から純粋に切り出したもの(挙動不変)。
// ★プール別: 既存の「キーを検証」は default プール(=実弾 A のキー・URL も文言も従来どおり)。
//   「生成器のキーを検証」は generator プール(=専用キー、無ければ共通キーへフォールバックした結果)。
//   検証は実際に外部へリクエストを送るので、**プールごとに正しいキーで送る**ことをサーバ側で担保している
//   (/api/settings/test?pool=… → testAllProviders(pool) → resolveApiKeyForPool)。

import { apiUrl } from '../../lib/apiBase.js';
import { escapeHtml } from './util.js';
import { setKeyStatus } from './status.js';
import type { SettingsElements, KeyTestResponse } from './types.js';

// 1つの検証ボタンを配線する。markPrefix は各キー行のマーク id の前置き
// ('key-' = 既存の共通キー行 / 'genkey-' = 生成器キー行)。
function wireOne(opts: {
  btn: HTMLButtonElement;
  result: HTMLElement;
  url: string;
  defaultLabel: string;
  markPrefix: string;
}): void {
  const { btn, result, url, defaultLabel, markPrefix } = opts;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const originalText = btn.textContent ?? defaultLabel;
    btn.textContent = '検証中…';
    result.className = 'update-result';
    result.innerHTML = '検証中…';
    try {
      const res = await fetch(apiUrl(url));
      const data = await res.json() as KeyTestResponse;
      if (!res.ok || data.error) {
        result.className = 'update-result err';
        result.innerHTML = `❌ 検証失敗: ${escapeHtml(data.error ?? `HTTP ${res.status}`)}`;
        return;
      }
      const lines = (data.results ?? []).map(r => {
        // 各キー行の個別マークも検証結果(✅/❌/⚪)で更新する。
        if (r.notset) setKeyStatus(`${markPrefix}${r.name}-status`, '⚪', '未設定');
        else if (r.ok) setKeyStatus(`${markPrefix}${r.name}-status`, '✅', '検証OK(実際に通った)');
        else setKeyStatus(`${markPrefix}${r.name}-status`, '❌', `無効: ${(r.error ?? 'エラー').slice(0, 80)}`);
        if (r.notset) return `<div>⚪ ${escapeHtml(r.name)}: 未設定</div>`;
        if (r.ok) return `<div>✅ ${escapeHtml(r.name)}: 有効</div>`;
        return `<div>❌ ${escapeHtml(r.name)}: ${escapeHtml(r.error ?? 'エラー')}</div>`;
      });
      result.className = 'update-result';
      result.innerHTML = lines.length > 0 ? lines.join('') : '(プロバイダなし)';
    } catch (err) {
      result.className = 'update-result err';
      result.innerHTML = `❌ 検証失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`;
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

export function wireKeyTestSection(el: SettingsElements): void {
  // --- APIキーの実効性検証(各プロバイダへ1トークンの ping。保存済みキーが対象) ---
  wireOne({
    btn: el.testKeysBtn, result: el.testResult,
    url: '/api/settings/test', defaultLabel: 'キーを検証', markPrefix: 'key-',
  });
  // --- ★提案生成器プールの検証(専用キー、無ければ共通キーへフォールバックした結果で ping) ---
  wireOne({
    btn: el.testGenKeysBtn, result: el.testGenResult,
    url: '/api/settings/test?pool=generator', defaultLabel: '生成器のキーを検証', markPrefix: 'genkey-',
  });
}
