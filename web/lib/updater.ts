// Tauri runtime のみで動作。Tauri 外 (npm run dev / web) では null/no-op。

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriGlobal);
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!inTauri()) return null;
  try {
    const mod = await import('@tauri-apps/plugin-updater');
    const update = await mod.check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? undefined,
      date: update.date ?? undefined,
    };
  } catch (err) {
    console.warn('[updater] check failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ダウンロード+インストール (再起動含む)。進捗コールバック可。
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  if (!inTauri()) throw new Error('Tauri runtime not available');
  const updaterMod = await import('@tauri-apps/plugin-updater');
  const processMod = await import('@tauri-apps/plugin-process');
  const update = await updaterMod.check();
  if (!update) throw new Error('no update available');
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? null;
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength ?? 0;
      onProgress?.(downloaded, total);
    }
  });
  await processMod.relaunch();
}
