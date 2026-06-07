import { apiUrl } from './apiBase.js';

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriGlobal);
}

/** ファイル選択ダイアログ。選ばれたパス or null(非Tauri/キャンセル)。 */
export async function pickDbFile(): Promise<string | null> {
  if (!inTauri()) return null;
  const dialog = await import('@tauri-apps/plugin-dialog');
  const sel = await dialog.open({ multiple: false, directory: false, filters: [{ name: 'SQLite DB', extensions: ['db'] }] });
  return typeof sel === 'string' ? sel : null;
}

export interface MergeResp { ok: boolean; inserted?: { alerts: number; bars_1m: number; ticks: number }; backup?: string; error?: string; note?: string; }

export async function mergeDbFromFile(source: string): Promise<MergeResp> {
  const r = await fetch(apiUrl('/api/merge'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
  return r.json() as Promise<MergeResp>;
}

export async function relaunchApp(): Promise<void> {
  if (!inTauri()) return;
  const proc = await import('@tauri-apps/plugin-process');
  await proc.relaunch();
}

export function isTauri(): boolean { return inTauri(); }
