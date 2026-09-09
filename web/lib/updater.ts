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

// ★checkForUpdate() は撤去した(v0.9.111)。
//   失敗('error')と「更新なし」('latest')と Tauri 外('unsupported')を **同じ null に潰して**
//   いたため、起動時トースト経路では失敗が完全に無音になっていた。2026-09-09 の事故で
//   「画面がそう言った」以外の証拠が1つも残らなかった原因の一つがこれ。
//   呼び出し側は getUpdateStatus() を使い、4状態を自分で場合分けすること
//   (潰したい場合も、潰す前に reportUpdateCheck() で記録に残してから潰す)。

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
