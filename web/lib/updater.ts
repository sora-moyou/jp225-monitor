// Tauri runtime のみで動作。Tauri 外 (npm run dev / web) では null/no-op。

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

export type UpdateStatus =
  | { state: 'unsupported' }                  // Tauri 外 (npm run dev のブラウザ)
  | { state: 'latest' }                       // 最新
  | { state: 'available'; info: UpdateInfo }  // 更新あり
  | { state: 'error'; message: string };      // チェック失敗 (ネットワーク等)

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriGlobal);
}

export async function getUpdateStatus(): Promise<UpdateStatus> {
  if (!inTauri()) return { state: 'unsupported' };
  try {
    const mod = await import('@tauri-apps/plugin-updater');
    const update = await mod.check();
    if (!update) return { state: 'latest' };
    return {
      state: 'available',
      info: {
        version: update.version,
        notes: update.body ?? undefined,
        date: update.date ?? undefined,
      },
    };
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// 後方互換: トースト用。更新がある時だけ UpdateInfo を返す。
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const status = await getUpdateStatus();
  if (status.state === 'available') return status.info;
  if (status.state === 'error') {
    console.warn('[updater] check failed:', status.message);
  }
  return null;
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
