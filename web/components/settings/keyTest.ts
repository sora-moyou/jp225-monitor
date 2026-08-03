// APIキーの実効性検証セクションの配線。settingsModal.ts から純粋に切り出したもの(挙動不変)。
// ★プール別: 既存の「キーを検証」は default プール(=実弾 A のキー・URL も文言も従来どおり)。
//   「生成器のキーを検証」は generator プール(=専用キー、無ければ共通キーへフォールバックした結果)。
//   検証は実際に外部へリクエストを送るので、**プールごとに正しいキーで送る**ことをサーバ側で担保している
//   (/api/settings/test?pool=… → testAllProviders(pool) → resolveApiKeyForPool)。

import { apiUrl } from '../../lib/apiBase.js';
import { escapeHtml } from './util.js';
import { setKeyStatus } from './status.js';
import type { SettingsElements, KeyTestResponse, KeyTestResult } from './types.js';

// ★1件ぶんの表示(純関数=テスト可能)。
//   この関数の仕事は **「404」で終わらせないこと**。従来は ✅/❌ だけで、
//     kimi: 404 Not found the model kimi-latest or Permission denied
//   が「キーが無効」なのか「そのキーにそのモデルの権限が無い」のか画面から分からなかった。
//   いまはサーバがモデル一覧(GET /v1/models)で両者を区別するので、
//   区別して書き、モデルが使えない場合は **使えるモデルの一覧と次の一手** を出す。
export function formatKeyTestLine(r: KeyTestResult): { mark: string; title: string; html: string } {
  const name = escapeHtml(r.name);
  const model = r.model ? escapeHtml(r.model) : '';
  const modelNote = model ? ` <span class="model-list">モデル: <code>${model}</code>${r.isDefaultModel ? '（既定）' : ''}</span>` : '';
  if (r.notset) return { mark: '⚪', title: '未設定', html: `<div>⚪ ${name}: 未設定</div>` };
  // ★キーは有効・モデルだけが使えない: 一番大事な分岐。何を直せばよいかまで書く。
  if (r.reason === 'model') {
    const list = (r.models ?? []).map(m => `<li><code>${escapeHtml(m)}</code></li>`).join('');
    const total = r.modelsTotal ?? r.models?.length ?? 0;
    const more = r.models && total > r.models.length ? `<li>…他 ${total - r.models.length} 件</li>` : '';
    return {
      mark: '⚠️',
      title: `キーは有効。モデル "${r.model ?? ''}" が使えません`,
      html: `<div>⚠️ ${name}: <strong>キーは有効</strong>ですが、モデル <code>${model}</code> は<strong>このキーでは使えません</strong>。`
        + `上の「${name} のモデル」欄に下記のいずれかを入れて保存してください。`
        + `<details class="model-list"><summary>このキーで使えるモデル (${total}件)</summary><ul>${list}${more}</ul></details></div>`,
    };
  }
  if (r.ok) {
    const via = r.via === 'ping' ? '（モデル一覧に非対応のため 1トークンの ping で確認）' : '';
    return { mark: '✅', title: '検証OK(キー有効・モデル利用可)', html: `<div>✅ ${name}: 有効${modelNote}${via}</div>` };
  }
  const err = escapeHtml(r.error ?? 'エラー');
  if (r.reason === 'key') {
    return { mark: '❌', title: `キーが無効: ${(r.error ?? '').slice(0, 80)}`,
      html: `<div>❌ ${name}: <strong>キーが無効</strong>です（モデル以前の問題）。キーを入れ直してください。<br><span class="model-list">${err}</span></div>` };
  }
  return { mark: '❌', title: `無効: ${(r.error ?? 'エラー').slice(0, 80)}`,
    html: `<div>❌ ${name}: ${err}${modelNote}</div>` };
}

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
        // 各キー行の個別マークも検証結果(✅/⚠️/❌/⚪)で更新する。
        const line = formatKeyTestLine(r);
        setKeyStatus(`${markPrefix}${r.name}-status`, line.mark, line.title);
        return line.html;
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
