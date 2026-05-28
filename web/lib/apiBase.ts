// Tauri 配布版では Webview origin (tauri://) と sidecar (localhost:port) が
// 異なるため、相対パス /api/* では sidecar に届かない。dev では Vite proxy が
// 同 origin /api/* を 3000 に転送するため空文字で OK。
//
// 制約: port は config.json で変更可能だが、フロントは起動時に固定値 3000 を
// 使う。port を変更した場合、Tauri 配布版では「再起動が必要」(既存挙動と整合)。

interface TauriGlobal {
  __TAURI_INTERNALS__?: unknown;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as TauriGlobal);

export const API_BASE = isTauri ? 'http://localhost:3000' : '';

export function apiUrl(path: string): string {
  return API_BASE + path;
}
