// Tauri updater 連携 (Tauri環境のみ動作、ブラウザ単体起動時は no-op)

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriGlobal);
}

export async function checkForUpdates(notifyEl: HTMLElement): Promise<void> {
  if (!isTauri()) return;
  try {
    // 動的importでブラウザモードでもバンドル時に解決可能
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update?.available) return;

    notifyEl.classList.add('update-available');
    notifyEl.textContent = `v${update.version} 利用可`;
    notifyEl.title = `現在 v${update.currentVersion} → v${update.version}\nクリックでダウンロード+再起動`;
    notifyEl.style.cursor = 'pointer';

    notifyEl.addEventListener('click', async () => {
      if (!confirm(`v${update.version} に更新します。ダウンロード+自動再起動。続行?`)) return;
      notifyEl.textContent = 'ダウンロード中...';
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) {
              const pct = Math.round((downloaded / total) * 100);
              notifyEl.textContent = `DL ${pct}%`;
            }
            break;
          case 'Finished':
            notifyEl.textContent = 'インストール中...';
            break;
        }
      });
      // 再起動
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    }, { once: true });
  } catch (err) {
    console.error('[updater] check failed:', err);
  }
}
