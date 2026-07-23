// APIキーの実効性検証セクションの配線。settingsModal.ts から純粋に切り出したもの(挙動不変)。

import { apiUrl } from '../../lib/apiBase.js';
import { escapeHtml } from './util.js';
import { setKeyStatus } from './status.js';
import type { SettingsElements, KeyTestResponse } from './types.js';

export function wireKeyTestSection(el: SettingsElements): void {
  // --- APIキーの実効性検証(各プロバイダへ1トークンの ping。保存済みキーが対象) ---
  el.testKeysBtn.addEventListener('click', async () => {
    el.testKeysBtn.disabled = true;
    const originalText = el.testKeysBtn.textContent ?? 'キーを検証';
    el.testKeysBtn.textContent = '検証中…';
    el.testResult.className = 'update-result';
    el.testResult.innerHTML = '検証中…';
    try {
      const res = await fetch(apiUrl('/api/settings/test'));
      const data = await res.json() as KeyTestResponse;
      if (!res.ok || data.error) {
        el.testResult.className = 'update-result err';
        el.testResult.innerHTML = `❌ 検証失敗: ${escapeHtml(data.error ?? `HTTP ${res.status}`)}`;
        return;
      }
      const lines = (data.results ?? []).map(r => {
        // 各キー行の個別マークも検証結果(✅/❌/⚪)で更新する。
        if (r.notset) setKeyStatus(`key-${r.name}-status`, '⚪', '未設定');
        else if (r.ok) setKeyStatus(`key-${r.name}-status`, '✅', '検証OK(実際に通った)');
        else setKeyStatus(`key-${r.name}-status`, '❌', `無効: ${(r.error ?? 'エラー').slice(0, 80)}`);
        if (r.notset) return `<div>⚪ ${escapeHtml(r.name)}: 未設定</div>`;
        if (r.ok) return `<div>✅ ${escapeHtml(r.name)}: 有効</div>`;
        return `<div>❌ ${escapeHtml(r.name)}: ${escapeHtml(r.error ?? 'エラー')}</div>`;
      });
      el.testResult.className = 'update-result';
      el.testResult.innerHTML = lines.length > 0 ? lines.join('') : '(プロバイダなし)';
    } catch (err) {
      el.testResult.className = 'update-result err';
      el.testResult.innerHTML = `❌ 検証失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`;
    } finally {
      el.testKeysBtn.disabled = false;
      el.testKeysBtn.textContent = originalText;
    }
  });
}
