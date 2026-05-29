# 設定画面バージョンチェック Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定モーダルから手動で「現在動作中のバージョンが最新か」を確認し、更新があればその場でインストールできるようにする。

**Architecture:** Tauri updater を唯一の接点とする `web/lib/updater.ts` に状態を区別する `getUpdateStatus()` を追加し、`web/components/settingsModal.ts` がその結果を描画する。サーバ側の変更は無し(現在バージョンは既存 `/api/version` を流用)。

**Tech Stack:** Vanilla TypeScript + Vite, Tauri v2 updater/process plugins, vitest。

---

## File Structure

- `web/lib/updater.ts` (Modify): `UpdateStatus` 型と `getUpdateStatus()` を追加。`checkForUpdate()` は `getUpdateStatus()` へ委譲。Tauri との唯一の接点。DOM を知らない。
- `web/lib/updater.test.ts` (Create): 非 Tauri 環境で `getUpdateStatus()` が `unsupported` を返すことを検証。
- `web/index.html` (Modify): 設定モーダルに「バージョン」fieldset を追加。
- `web/styles.css` (Modify): 更新結果エリア・ボタンのスタイル。
- `web/components/settingsModal.ts` (Modify): 要素追加・現在バージョン表示・チェック/更新ハンドラ。`updater.ts` の結果を描画するだけで Tauri API を直接触らない。
- `web/main.ts` (Modify): 新規 3 要素を `initSettingsModal` に配線。

依存方向: `settingsModal.ts → updater.ts`(一方向、循環なし)。

---

### Task 1: `getUpdateStatus()` と `UpdateStatus` 型を追加

**Files:**
- Modify: `web/lib/updater.ts`
- Test: `web/lib/updater.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `web/lib/updater.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getUpdateStatus } from './updater.js';

describe('getUpdateStatus', () => {
  it('returns unsupported outside the Tauri runtime', async () => {
    // vitest の node 環境では window が無い (= Tauri 外) ため unsupported になる。
    const status = await getUpdateStatus();
    expect(status).toEqual({ state: 'unsupported' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- web/lib/updater.test.ts`
Expected: FAIL — `getUpdateStatus` is not exported / not a function.

- [ ] **Step 3: Implement `getUpdateStatus` and refactor `checkForUpdate`**

In `web/lib/updater.ts`, after the `UpdateInfo` interface add the status type:

```ts
export type UpdateStatus =
  | { state: 'unsupported' }                  // Tauri 外 (npm run dev のブラウザ)
  | { state: 'latest' }                       // 最新
  | { state: 'available'; info: UpdateInfo }  // 更新あり
  | { state: 'error'; message: string };      // チェック失敗 (ネットワーク等)
```

Replace the existing `checkForUpdate` function (lines 17-32) with:

```ts
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
```

`inTauri()`, `installUpdate()`, `UpdateInfo`, `TauriGlobal` は変更しない。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- web/lib/updater.test.ts`
Expected: PASS (1 passed).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/lib/updater.ts web/lib/updater.test.ts
git commit -m "feat(updater): add getUpdateStatus with explicit states"
```

---

### Task 2: 設定モーダルに「バージョン」セクションを追加 (HTML)

**Files:**
- Modify: `web/index.html`

- [ ] **Step 1: Insert the version fieldset**

In `web/index.html`, immediately after the closing `</fieldset>` of the polling section (line 74) and before the `<p class="modal-hint">空欄の…` line (line 76), insert:

```html
      <fieldset class="settings-section">
        <legend>バージョン</legend>
        <div class="version-row">
          現在のバージョン: <span id="settings-current-version">…</span>
          <button type="button" id="settings-check-update" class="btn-secondary">最新かチェック</button>
        </div>
        <div id="settings-update-result" class="update-result"></div>
      </fieldset>
```

- [ ] **Step 2: Verify markup**

Run: `npm run typecheck`
Expected: no errors (HTML change does not break TS, sanity gate).

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat(settings): add version section markup"
```

---

### Task 3: 更新結果エリアのスタイル (CSS)

**Files:**
- Modify: `web/styles.css`

- [ ] **Step 1: Append styles**

Append to the end of `web/styles.css`:

```css
.version-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.version-row #settings-current-version { font-weight: 600; }
.update-result { margin-top: 10px; font-size: 13px; line-height: 1.6; min-height: 1em; }
.update-result.ok   { color: var(--up); }
.update-result.warn { color: #c9a227; }
.update-result.err  { color: var(--down); }
.update-result .update-now-btn {
  margin-left: 8px;
  padding: 4px 12px;
  border: 1px solid var(--up);
  background: var(--up);
  color: black;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.update-result .update-now-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.update-result .update-notes { display: block; margin-top: 4px; opacity: 0.8; font-size: 12px; }
```

- [ ] **Step 2: Commit**

```bash
git add web/styles.css
git commit -m "style(settings): version check result styling"
```

---

### Task 4: チェック & 更新ハンドラ (settingsModal.ts + main.ts)

**Files:**
- Modify: `web/components/settingsModal.ts`
- Modify: `web/main.ts`

- [ ] **Step 1: Extend imports and the elements interface**

At the top of `web/components/settingsModal.ts`, add the updater import below the existing `apiUrl` import (line 1):

```ts
import { getUpdateStatus, installUpdate } from '../lib/updater.js';
```

Add three fields to the `SettingsElements` interface (after `backdrop: HTMLElement;`, line 75):

```ts
  checkUpdateBtn: HTMLButtonElement;
  updateResult: HTMLElement;
  currentVersion: HTMLElement;
```

- [ ] **Step 2: Add an escapeHtml helper**

In `web/components/settingsModal.ts`, add near the top of the file (after the imports, before `interface SettingsResponse`):

```ts
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}
```

- [ ] **Step 3: Add current-version fetch and a check handler inside `initSettingsModal`**

In `web/components/settingsModal.ts`, inside `initSettingsModal`, after the `refresh()` function definition (after line 99, before `async function open()`), add:

```ts
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
```

- [ ] **Step 4: Load version on open and clear result**

In `web/components/settingsModal.ts`, inside the `open()` function, after `await refresh();` (line 103), add:

```ts
    renderUpdateResult('', '');
    void loadCurrentVersion();
```

- [ ] **Step 5: Wire the new elements in main.ts**

In `web/main.ts`, inside the `initSettingsModal({...})` call, add after the `backdrop:` line (line 97):

```ts
  checkUpdateBtn: document.getElementById('settings-check-update') as HTMLButtonElement,
  updateResult:   document.getElementById('settings-update-result') as HTMLElement,
  currentVersion: document.getElementById('settings-current-version') as HTMLElement,
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Run the full test suite**

Run: `npm run test`
Expected: all pass (including `web/lib/updater.test.ts`).

- [ ] **Step 8: Manual check (browser dev mode)**

Run: `npm run dev`, open the app, click ⚙️, open settings.
Expected:
- 「現在のバージョン: v0.3.17」が表示される。
- 「最新かチェック」を押すと「⚠️ 開発モードのためチェックできません」が黄色で出る。

- [ ] **Step 9: Commit**

```bash
git add web/components/settingsModal.ts web/main.ts
git commit -m "feat(settings): manual version check with inline update button"
```

---

## Self-Review

- **Spec coverage:**
  - updater.ts 状態区別 → Task 1 ✓
  - HTML セクション → Task 2 ✓
  - settingsModal 制御(チェック/更新/現在バージョン)→ Task 4 ✓
  - main.ts 配線 → Task 4 Step 5 ✓
  - styles.css → Task 3 ✓
  - テスト方針(unsupported の vitest + 手動確認 + typecheck)→ Task 1 Step 1 / Task 4 Steps 6-8 ✓
- **Placeholder scan:** なし(全ステップに実コード/実コマンド)。
- **Type consistency:** `getUpdateStatus()` / `UpdateStatus` の `state` 値(`unsupported`/`latest`/`available`/`error`)は Task 1 定義と Task 4 利用で一致。`installUpdate(onProgress)` シグネチャは既存のまま。要素名 `checkUpdateBtn`/`updateResult`/`currentVersion` は interface・main.ts・ハンドラで一致。
