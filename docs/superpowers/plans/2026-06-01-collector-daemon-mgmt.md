# Collector Daemon Management + Exit Options — Plan 3b

**Goal:** The monitor launches the collector as a **detached** background process that survives "通常終了" (monitor closes, collector keeps collecting) and is stopped by "完全終了". Single-instance enforced via a PID lock.

**Key mechanism:** Tauri's `app.shell().sidecar(...).spawn()` child SURVIVES if we never call `.kill()` (per lib.rs comment: "Drop 任せだと Tauri 終了後も子プロセスが残る"). So we spawn the collector via the sidecar API but do NOT auto-kill it on exit. The collector self-deduplicates via a PID lock, so spawning on every monitor start is safe. "完全終了" reads the PID file and `taskkill`s it.

**Verification note:** Rust/Tauri/bundling parts are written + `cargo check`ed here; full runtime verification (detach survival, kill, no-duplicate) is done by the user via `npm run tauri:build` + launching the app.

---

### Task 1: Collector single-instance PID lock (TS)

**Files:** Create `collector/lock.ts` + `collector/lock.test.ts`; Modify `collector/index.ts`

PID file: `%APPDATA%/jp225-monitor/collector.pid` (same dir as the DB; reuse `resolveDbPath`'s dir).

- [ ] **Test (`collector/lock.test.ts`)** — pure decision fn:
```typescript
import { describe, it, expect } from 'vitest';
import { shouldAcquire } from './lock.js';

describe('shouldAcquire', () => {
  it('acquires when no existing pid', () => {
    expect(shouldAcquire(null, () => true)).toBe(true);
  });
  it('refuses when existing pid is alive', () => {
    expect(shouldAcquire(1234, (pid) => pid === 1234)).toBe(false);
  });
  it('acquires (takes over) when existing pid is stale (dead)', () => {
    expect(shouldAcquire(1234, () => false)).toBe(true);
  });
});
```
- [ ] **Implement `collector/lock.ts`:**
```typescript
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolveDbPath } from '../server/db/store.js';

function pidPath(): string {
  const dir = dirname(resolveDbPath());   // %APPDATA%/jp225-monitor
  mkdirSync(dir, { recursive: true });
  return join(dir, 'collector.pid');
}

/** プロセスが生存しているか (kill(pid,0))。存在しなければ false。 */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }  // EPERM=存在するが権限なし→生存
}

/** 既存pidと生存判定から「自分が取得してよいか」。純粋関数(テスト用)。 */
export function shouldAcquire(existingPid: number | null, alive: (pid: number) => boolean): boolean {
  if (existingPid === null) return true;
  return !alive(existingPid);
}

/** ロック取得を試みる。別の生存インスタンスがあれば false。成功時は自分のpidを書く。 */
export function acquireLock(): boolean {
  const p = pidPath();
  let existing: number | null = null;
  try { const n = parseInt(readFileSync(p, 'utf-8').trim(), 10); existing = Number.isInteger(n) ? n : null; }
  catch { existing = null; }
  if (!shouldAcquire(existing, isAlive)) return false;
  writeFileSync(p, String(process.pid), 'utf-8');
  return true;
}

/** 自分のロックを解放 (pidファイル削除)。 */
export function releaseLock(): void {
  try { rmSync(pidPath(), { force: true }); } catch { /* ignore */ }
}
```
- [ ] **Wire into `collector/index.ts`** — at the very start of `main()` (before opening the DB):
```typescript
  if (!acquireLock()) { console.log('[collector] another instance is running — exiting'); return; }
```
  and in the SIGINT/SIGTERM handlers and after the loop, call `releaseLock()` (e.g. before `db.close()` and on signal set `running=false` then release in the finally/after-loop). Import `acquireLock, releaseLock` from `./lock.js`.
- [ ] Run `npx vitest run collector/lock.test.ts` (3 pass), `npm run typecheck`, full suite. Commit.

---

### Task 2: Bundle the collector with the monitor

**Files:** Create `scripts/copy-collector.mjs` (mirror `copy-sidecar.mjs` but `bin/jp225-collector.exe` → `src-tauri/binaries/jp225-collector-<triple>.exe`); Modify `src-tauri/tauri.conf.json` (`externalBin`: add `"binaries/jp225-collector"`); Modify `package.json` (a `package:collector` = `build:collector` already exists; add a `collector:copy` script + fold collector build+copy into the `tauri:build`/`tauri:dev` pipeline so the bundled binary is fresh).

- [ ] `copy-collector.mjs`: copy of `copy-sidecar.mjs` with `src='bin/jp225-collector.exe'`, `dst=binaries/jp225-collector-${triple}${ext}`.
- [ ] `tauri.conf.json` `bundle.externalBin`: `["binaries/jp225-sidecar", "binaries/jp225-collector"]`.
- [ ] `package.json` scripts: add `"collector:copy": "node scripts/copy-collector.mjs"`, and update `tauri:build`/`tauri:dev` to also run `npm run build:collector && npm run collector:copy` before `tauri build`/`tauri dev`.
- [ ] Verify `npm run build:collector && npm run collector:copy` produces `src-tauri/binaries/jp225-collector-x86_64-pc-windows-msvc.exe`. Commit.

---

### Task 3: Rust — spawn collector detached + stop_collector command

**Files:** Modify `src-tauri/src/lib.rs`

- [ ] In `setup`, AFTER the existing server-sidecar spawn, spawn the collector via the sidecar API but do NOT track it for auto-kill (so it survives). Read its events for logging only:
```rust
            // 収集デーモンをデタッチ起動 (kill しない → モニター終了後も生存)。
            // collector 側が PID ロックで単一インスタンスを保証するので毎回 spawn して良い。
            match app.shell().sidecar("jp225-collector") {
                Ok(cmd) => match cmd.spawn() {
                    Ok((mut crx, _child)) => {
                        // _child は kill せず drop に任せる (=生存)。ログのみ読む。
                        tauri::async_runtime::spawn(async move {
                            while let Some(event) = crx.recv().await {
                                if let CommandEvent::Stderr(line) = event {
                                    eprintln!("[collector:err] {}", String::from_utf8_lossy(&line).trim_end());
                                }
                            }
                        });
                    }
                    Err(e) => eprintln!("[collector] spawn failed: {e}"),
                },
                Err(e) => eprintln!("[collector] sidecar resolve failed: {e}"),
            }
```
  IMPORTANT: do NOT store the collector child in a state that the `RunEvent::Exit` handler kills. The existing handler only kills `SidecarState` (the server) — leave that as-is; the collector is intentionally not in it.

- [ ] Add a `stop_collector` command that reads the PID file and `taskkill`s it (Windows):
```rust
#[tauri::command]
fn stop_collector() -> Result<(), String> {
    let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
    let pid_path = std::path::Path::new(&appdata).join("jp225-monitor").join("collector.pid");
    let pid = std::fs::read_to_string(&pid_path).map_err(|e| e.to_string())?;
    let pid = pid.trim();
    if pid.is_empty() { return Ok(()); }
    let _ = std::process::Command::new("taskkill").args(["/PID", pid, "/F", "/T"]).output();
    let _ = std::fs::remove_file(&pid_path);
    Ok(())
}
```
- [ ] Register it: `.invoke_handler(tauri::generate_handler![stop_collector])` on the Builder.
- [ ] `cargo check` (run `cargo check --manifest-path src-tauri/Cargo.toml`) → compiles. Commit. (Full runtime verification by the user.)

---

### Task 4: Frontend — two exit options in settings

**Files:** Modify `web/components/settingsModal.ts` (add a "終了" section with two buttons + handlers)

- [ ] Add a section to the settings modal markup:
```html
<div class="settings-section">
  <div class="settings-section-title">終了</div>
  <button class="exit-normal">通常終了（収集は継続）</button>
  <button class="exit-full">完全終了（収集も停止）</button>
  <div class="exit-hint">急変感知が不要なときは「通常終了」。バックグラウンドで価格収集だけ続きます。</div>
</div>
```
- [ ] Wire handlers (use dynamic import of the process plugin, matching `web/lib/updater.ts`'s pattern; `invoke` from `@tauri-apps/api/core` for the Rust command):
```typescript
async function normalExit(): Promise<void> {
  const p = await import('@tauri-apps/plugin-process');
  await p.exit(0);   // モニターのみ終了。collector はデタッチ済みで生存。
}
async function fullExit(): Promise<void> {
  try { const { invoke } = await import('@tauri-apps/api/core'); await invoke('stop_collector'); }
  catch (err) { console.warn('stop_collector failed:', err); }
  const p = await import('@tauri-apps/plugin-process');
  await p.exit(0);
}
```
  Attach to `.exit-normal` / `.exit-full` click. (If running in a plain browser (non-Tauri), the dynamic import fails → catch and no-op / disable the buttons; mirror how updater.ts guards Tauri-only APIs.)
- [ ] `npm run typecheck` + `npm run build:web` → clean. Commit.

---

### Task 5: Gate
- [ ] `npm run typecheck && npx vitest run && npm run build:web` green; `cargo check` (src-tauri) compiles. Commit. Hand off to user for `npm run tauri:build` runtime verification.
