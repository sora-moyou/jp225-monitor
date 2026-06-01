import { apiUrl } from '../lib/apiBase.js';
import { getUpdateStatus, installUpdate } from '../lib/updater.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

interface SettingsResponse {
  geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  pricePollMs: number; newsPollMs: number; port: number; cooldownMin: number;
  providers: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  configFile: string;
}

interface SaveResponse {
  ok: boolean;
  portRequiresRestart?: boolean;
}

async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const res = await fetch(apiUrl('/api/settings'));
    if (!res.ok) return null;
    return await res.json() as SettingsResponse;
  } catch { return null; }
}

interface SavePayload {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
}

async function saveSettings(body: SavePayload): Promise<{ ok: boolean; error?: string; portRequiresRestart?: boolean }> {
  try {
    const res = await fetch(apiUrl('/api/settings/keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as SaveResponse & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, portRequiresRestart: data.portRequiresRestart };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

function renderStatus(s: SettingsResponse | null): string {
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

export interface SettingsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  inputGemini: HTMLInputElement;
  inputGroq: HTMLInputElement;
  inputOpenai: HTMLInputElement;
  statusArea: HTMLElement;
  backdrop: HTMLElement;
  checkUpdateBtn: HTMLButtonElement;
  updateResult: HTMLElement;
  currentVersion: HTMLElement;
  basedataCheckBtn: HTMLButtonElement;
  basedataResult: HTMLElement;
}

export function initSettingsModal(el: SettingsElements): void {
  let current: SettingsResponse | null = null;

  async function refresh() {
    current = await fetchSettings();
    el.statusArea.innerHTML = renderStatus(current);
    el.inputGemini.placeholder = current?.geminiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.geminiFromEnv ? '環境変数から読込中 (上書きするにはここに入力)' : 'AIza...';
    el.inputGroq.placeholder = current?.groqSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.groqFromEnv ? '環境変数から読込中' : 'gsk_...';
    el.inputOpenai.placeholder = current?.openaiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.openaiFromEnv ? '環境変数から読込中' : 'sk-...';
  }

  async function loadCurrentVersion() {
    el.currentVersion.textContent = '…';
    try {
      const res = await fetch(apiUrl('/api/version'));
      const data = await res.json() as { version: string };
      el.currentVersion.textContent = `v${data.version}`;
    } catch {
      el.currentVersion.textContent = 'v?';
    }
  }

  function renderUpdateResult(html: string, cls: '' | 'ok' | 'warn' | 'err') {
    el.updateResult.className = `update-result${cls ? ' ' + cls : ''}`;
    el.updateResult.innerHTML = html;
  }

  function wireInstallButton() {
    const btn = el.updateResult.querySelector<HTMLButtonElement>('.update-now-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const label = el.updateResult.querySelector<HTMLElement>('.update-progress');
      try {
        await installUpdate((dl, total) => {
          if (label) {
            label.textContent = total && total > 0
              ? `ダウンロード中… ${Math.round((dl / total) * 100)}%`
              : 'ダウンロード中…';
          }
        });
        // installUpdate 内で relaunch されるため通常ここには来ない。
      } catch (err) {
        renderUpdateResult(`❌ 更新失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`, 'err');
      }
    });
  }

  async function checkUpdate() {
    el.checkUpdateBtn.disabled = true;
    const originalText = el.checkUpdateBtn.textContent ?? '最新かチェック';
    el.checkUpdateBtn.textContent = 'チェック中...';
    renderUpdateResult('確認中...', '');
    try {
      const status = await getUpdateStatus();
      const current = el.currentVersion.textContent ?? '';
      if (status.state === 'latest') {
        renderUpdateResult(`✅ 最新です (${escapeHtml(current)})`, 'ok');
      } else if (status.state === 'available') {
        const notes = status.info.notes
          ? `<span class="update-notes">${escapeHtml(status.info.notes)}</span>` : '';
        renderUpdateResult(
          `🆙 新しいバージョン v${escapeHtml(status.info.version)} があります`
          + `<button type="button" class="update-now-btn">更新</button>`
          + `<span class="update-progress"></span>${notes}`,
          'ok',
        );
        wireInstallButton();
      } else if (status.state === 'unsupported') {
        renderUpdateResult('⚠️ 開発モードのためチェックできません(パッケージ版でのみ動作)', 'warn');
      } else {
        renderUpdateResult(`❌ チェック失敗: ${escapeHtml(status.message)}`, 'err');
      }
    } finally {
      el.checkUpdateBtn.disabled = false;
      el.checkUpdateBtn.textContent = originalText;
    }
  }

  el.checkUpdateBtn.addEventListener('click', () => { void checkUpdate(); });

  // 基礎データ: アップデートと同じ流れ。「新着をチェック」→ 結果に「取り込み」ボタンを出す。
  function wireBasedataImport() {
    const btn = el.basedataResult.querySelector<HTMLButtonElement>('.basedata-import-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const prog = el.basedataResult.querySelector<HTMLElement>('.basedata-progress');
      if (prog) prog.textContent = ' 取り込み中…';
      try {
        const res = await fetch(apiUrl('/api/basedata/import'), { method: 'POST' });
        const d = await res.json() as { ok: boolean; applied?: number; skipped?: number; from?: string; to?: string; error?: string };
        el.basedataResult.className = `update-result ${d.ok ? 'ok' : 'err'}`;
        el.basedataResult.textContent = d.ok
          ? `✅ ${d.applied}件取り込み (${d.from ?? '?'}〜${d.to ?? '?'})${d.skipped ? ` / 休場スキップ${d.skipped}` : ''}`
          : `❌ ${d.error ?? '失敗'}`;
      } catch (err) {
        el.basedataResult.className = 'update-result err';
        el.basedataResult.textContent = `❌ ${err instanceof Error ? err.message : 'failed'}`;
      }
    });
  }

  async function checkBasedata() {
    el.basedataCheckBtn.disabled = true;
    const orig = el.basedataCheckBtn.textContent ?? '新着をチェック';
    el.basedataCheckBtn.textContent = 'チェック中...';
    el.basedataResult.className = 'update-result';
    el.basedataResult.textContent = '確認中...';
    try {
      const res = await fetch(apiUrl('/api/basedata/status'));
      const s = await res.json() as { ok: boolean; published?: boolean; available?: boolean; lastBar?: string | null; count?: number | null; error?: string };
      if (!s.ok) {
        el.basedataResult.className = 'update-result err';
        el.basedataResult.textContent = `❌ ${escapeHtml(s.error ?? 'チェック失敗')}`;
      } else if (!s.published) {
        el.basedataResult.className = 'update-result warn';
        el.basedataResult.textContent = '⚠️ 基礎データ未公開（先に publish が必要）';
      } else {
        const label = s.available
          ? `🆙 新しい基礎データ（${escapeHtml(s.lastBar ?? '?')}まで・${s.count ?? '?'}件）`
          : `✅ 取り込み済み（最新・${escapeHtml(s.lastBar ?? '?')}まで）`;
        const btnText = s.available ? '取り込み' : '再取り込み';
        el.basedataResult.className = 'update-result ok';
        el.basedataResult.innerHTML =
          `${label}<button type="button" class="update-now-btn basedata-import-btn">${btnText}</button>`
          + `<span class="basedata-progress"></span>`;
        wireBasedataImport();
      }
    } catch (err) {
      el.basedataResult.className = 'update-result err';
      el.basedataResult.textContent = `❌ ${err instanceof Error ? err.message : 'failed'}`;
    } finally {
      el.basedataCheckBtn.disabled = false;
      el.basedataCheckBtn.textContent = orig;
    }
  }

  el.basedataCheckBtn.addEventListener('click', () => { void checkBasedata(); });

  async function open() {
    el.modal.classList.remove('hidden');
    await refresh();
    renderUpdateResult('', '');
    void loadCurrentVersion();
    el.inputGemini.focus();
  }
  function close() {
    el.modal.classList.add('hidden');
    el.inputGemini.value = '';
    el.inputGroq.value = '';
    el.inputOpenai.value = '';
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.modal.classList.contains('hidden')) close();
  });

  el.saveBtn.addEventListener('click', async () => {
    el.saveBtn.disabled = true;
    const originalText = el.saveBtn.textContent ?? '保存';
    el.saveBtn.textContent = '保存中...';
    try {
      const body: SavePayload = {};
      const gv = el.inputGemini.value.trim();
      const grv = el.inputGroq.value.trim();
      const ov = el.inputOpenai.value.trim();
      if (gv) body.geminiKey = gv;
      if (grv) body.groqKey = grv;
      if (ov) body.openaiKey = ov;

      const result = await saveSettings(body);
      if (!result.ok) {
        el.statusArea.innerHTML = `<div class="settings-status err">${result.error ?? '保存失敗'}</div>`;
        return;
      }
      el.inputGemini.value = '';
      el.inputGroq.value = '';
      el.inputOpenai.value = '';
      await refresh();
    } finally {
      el.saveBtn.disabled = false;
      el.saveBtn.textContent = originalText;
    }
  });

  // 初回起動時にプロバイダ未設定なら自動オープン
  void (async () => {
    const s = await fetchSettings();
    if (s && !s.providers.some(p => p.enabled)) {
      void open();
    }
  })();
}
