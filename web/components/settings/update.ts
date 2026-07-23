// 更新(アプリ本体 + 基礎データ)セクションの配線。settingsModal.ts から純粋に切り出したもの(挙動不変)。

import { apiUrl } from '../../lib/apiBase.js';
import { getUpdateStatus, installUpdate } from '../../lib/updater.js';
import { escapeHtml } from './util.js';
import type { SettingsElements, BasedataStatus } from './types.js';

// 更新セクションを配線し、モーダル開閉から使う小ハンドラ(現バージョン読込 / 結果クリア)を返す。
export function wireUpdateSection(el: SettingsElements): {
  loadCurrentVersion: () => Promise<void>;
  clearUpdateResult: () => void;
} {
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

  function clearUpdateResult() {
    el.updateResult.className = 'update-result';
    el.updateResult.innerHTML = '';
  }

  // 統合された更新セクション: 1つの「更新をチェック」で アプリ本体 と 基礎データ を
  // 同時に確認し、行ごとにラベル付きの状態文 + それぞれに適切なアクションを出す。
  function setRow(rowId: 'upd-app-row' | 'upd-base-row', cls: 'ok' | 'warn' | 'err', html: string) {
    const row = el.updateResult.querySelector<HTMLElement>(`#${rowId}`);
    if (row) { row.className = `upd-row ${cls}`; row.innerHTML = html; }
  }

  // アプリ本体: 結果行内の「更新」ボタン → DL+再起動 (Tauri)。
  function wireInstallButton() {
    const btn = el.updateResult.querySelector<HTMLButtonElement>('.update-now-btn:not(.basedata-import-btn)');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const label = el.updateResult.querySelector<HTMLElement>('.update-progress');
      try {
        await installUpdate((dl, total) => {
          if (label) {
            label.textContent = total && total > 0
              ? ` ダウンロード中… ${Math.round((dl / total) * 100)}%`
              : ' ダウンロード中…';
          }
        });
        // installUpdate 内で relaunch されるため通常ここには来ない。
      } catch (err) {
        setRow('upd-app-row', 'err', `アプリ: ❌ 更新失敗: ${escapeHtml(err instanceof Error ? err.message : 'unknown')}`);
      }
    });
  }

  // 基礎データ: 結果行内の「取り込み」ボタン → DBへ追記/更新。
  function wireBasedataImport() {
    const btn = el.updateResult.querySelector<HTMLButtonElement>('.basedata-import-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const prog = el.updateResult.querySelector<HTMLElement>('.basedata-progress');
      if (prog) prog.textContent = ' 取り込み中…';
      try {
        const res = await fetch(apiUrl('/api/basedata/import'), { method: 'POST' });
        const d = await res.json() as { ok: boolean; applied?: number; skipped?: number; from?: string; to?: string; error?: string };
        setRow('upd-base-row', d.ok ? 'ok' : 'err', d.ok
          ? `基礎データ: ✅ ${d.applied}件取り込み (${escapeHtml(d.from ?? '?')}〜${escapeHtml(d.to ?? '?')})${d.skipped ? ` / 休場スキップ${d.skipped}` : ''}`
          : `基礎データ: ❌ ${escapeHtml(d.error ?? '失敗')}`);
      } catch (err) {
        setRow('upd-base-row', 'err', `基礎データ: ❌ ${escapeHtml(err instanceof Error ? err.message : 'failed')}`);
      }
    });
  }

  async function checkAll() {
    el.checkUpdateBtn.disabled = true;
    const originalText = el.checkUpdateBtn.textContent ?? '更新をチェック';
    el.checkUpdateBtn.textContent = 'チェック中...';
    el.updateResult.className = 'update-result';
    el.updateResult.innerHTML =
      `<div class="upd-row" id="upd-app-row">アプリ: 確認中…</div>`
      + `<div class="upd-row" id="upd-base-row">基礎データ: 確認中…</div>`;
    const current = el.currentVersion.textContent ?? '';
    try {
      const [appStatus, baseStatus] = await Promise.all([
        getUpdateStatus(),
        fetch(apiUrl('/api/basedata/status'))
          .then(r => r.json() as Promise<BasedataStatus>)
          .catch((err: unknown): BasedataStatus => ({ ok: false, error: err instanceof Error ? err.message : 'failed' })),
      ]);

      // --- アプリ本体 ---
      if (appStatus.state === 'latest') {
        setRow('upd-app-row', 'ok', `アプリ: ✅ 最新です (${escapeHtml(current)})`);
      } else if (appStatus.state === 'available') {
        const notes = appStatus.info.notes
          ? `<span class="update-notes">${escapeHtml(appStatus.info.notes)}</span>` : '';
        setRow('upd-app-row', 'ok',
          `アプリ: 🆙 v${escapeHtml(appStatus.info.version)} があります`
          + `<button type="button" class="update-now-btn">更新</button>`
          + `<span class="update-progress"></span>${notes}`);
        wireInstallButton();
      } else if (appStatus.state === 'unsupported') {
        setRow('upd-app-row', 'warn', 'アプリ: ⚠️ 開発モードのため確認できません（パッケージ版でのみ動作）');
      } else {
        setRow('upd-app-row', 'err', `アプリ: ❌ 確認失敗: ${escapeHtml(appStatus.message)}`);
      }

      // --- 基礎データ ---
      const s = baseStatus;
      if (!s.ok) {
        setRow('upd-base-row', 'err', `基礎データ: ❌ ${escapeHtml(s.error ?? '確認失敗')}`);
      } else if (!s.published) {
        setRow('upd-base-row', 'warn', '基礎データ: ⚠️ 未公開（先に publish が必要）');
      } else {
        const label = s.available
          ? `基礎データ: 🆙 新着（${escapeHtml(s.lastBar ?? '?')}まで・${s.count ?? '?'}件）`
          : `基礎データ: ✅ 取り込み済み（最新・${escapeHtml(s.lastBar ?? '?')}まで）`;
        const btnText = s.available ? '取り込み' : '再取り込み';
        // 取り込み済み(再取り込み)時は通常不要なので、ボタンを背面無色の控えめ表示にして
        // ユーザーが毎回反射的にクリックしないようにする。新着(取り込み)時は目立つ緑のまま。
        const btnClass = s.available
          ? 'update-now-btn basedata-import-btn'
          : 'update-now-btn basedata-import-btn muted';
        setRow('upd-base-row', 'ok',
          `${label}<button type="button" class="${btnClass}">${btnText}</button>`
          + `<span class="basedata-progress"></span>`);
        wireBasedataImport();
      }
    } finally {
      el.checkUpdateBtn.disabled = false;
      el.checkUpdateBtn.textContent = originalText;
    }
  }

  el.checkUpdateBtn.addEventListener('click', () => { void checkAll(); });

  return { loadCurrentVersion, clearUpdateResult };
}
