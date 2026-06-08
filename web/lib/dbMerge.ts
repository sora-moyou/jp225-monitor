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

/** 保存ダイアログ。保存先パス or null(非Tauri/キャンセル)。既定名 jp225-YYYYMMDD.db。 */
export async function saveDbFile(): Promise<string | null> {
  if (!inTauri()) return null;
  const dialog = await import('@tauri-apps/plugin-dialog');
  const d = new Date();
  const name = `jp225-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.db`;
  const sel = await dialog.save({ defaultPath: name, filters: [{ name: 'SQLite DB', extensions: ['db'] }] });
  return typeof sel === 'string' ? sel : null;
}

export interface ExportResp { ok: boolean; dest?: string; size?: number; error?: string; }

/** このPCのライブ DB を dest へエクスポート(VACUUM INTO)。停止・再起動なし。 */
export async function exportDbToFile(dest: string): Promise<ExportResp> {
  const r = await fetch(apiUrl('/api/export'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dest }) });
  return r.json() as Promise<ExportResp>;
}

export interface ReplaceResp { ok: boolean; replaced?: { alerts: number; bars_1m: number; ticks: number }; backup?: string; error?: string; note?: string; }

/** 現在のDBの中身を source の内容で置き換える(破壊的・バックアップ後)。collector/trade 停止→置換。 */
export async function replaceDbFromFile(source: string): Promise<ReplaceResp> {
  const r = await fetch(apiUrl('/api/replace'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source }) });
  return r.json() as Promise<ReplaceResp>;
}

export function isTauri(): boolean { return inTauri(); }
