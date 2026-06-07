# 設定からの DB マージ機能 — 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。各 Task を TDD で。設計: `docs/superpowers/specs/2026-06-07-settings-db-merge-design.md`

**Goal:** monitor 設定画面から別PCの jp225.db をファイル選択→collector/trade停止→マージ→自動再起動できるようにする(案A: sidecar in-process マージ)。

**Architecture:** マージ処理は純粋 DB モジュール `server/db/mergeDb.ts`(INSERT OR IGNORE・v0.6.17 の UNIQUE 索引前提)。server の `POST /api/merge` が collector/trade 停止→VACUUM INTO バックアップ→同期マージ→件数返却。web 設定が Tauri dialog でファイル選択→/api/merge→成功で `@tauri-apps/plugin-process` relaunch。

**Tech Stack:** TypeScript / Express / node:sqlite(同期)/ Tauri v2(plugin-dialog 追加・plugin-process 既存)/ vitest。

参照パターン: ルート登録=`server/index.ts:67-82`、Tauri非対応ガード+動的import=`web/lib/updater.ts`、既存スキーマ/`openDb`/`resolveDbPath`=`server/db/store.ts`。

---

### Task 1: マージ・モジュール `server/db/mergeDb.ts`

**Files:** Create `server/db/mergeDb.ts`, Test `server/db/mergeDb.test.ts`

- [ ] **Step 1: 失敗するテスト** — `server/db/mergeDb.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertAlert, getRecentAlerts, recordTick } from './store.js';
import { mergeFrom } from './mergeDb.js';

function db(): DatabaseSync { const d = new DatabaseSync(':memory:'); initSchema(d); return d; }

describe('mergeFrom', () => {
  it('other の alerts/bars/ticks を OR IGNORE で統合し件数を返す', () => {
    const main = db();
    const other = db();
    // main: 1 alert / other: 同一1 + 別1
    const a = { symbol: 'NIY=F', triggeredAt: 1000, direction: 'down', detectionKind: 'break', windowSeconds: 60, changePercent: 0, price: 67000, sessionDate: '2026-06-05', session: 'Day', referenceKind: null, referencePrice: null };
    insertAlert(main, a);
    insertAlert(other, a);                                   // main と完全一致
    insertAlert(other, { ...a, triggeredAt: 2000 });         // 別
    recordTick(other, 'NIY=F', 60_000, 67010, '2026-06-05', 'Day');
    const res = mergeFrom(main, ':memory:no');               // ← パスではなく接続を渡す版にするなら下記実装に合わせる
    expect(true).toBe(true);
  });
});
```
注: `:memory:` の other を ATTACH するのは難しいため、実装は **ファイルパス**を受ける。テストは一時ファイル DB で行う(下の Step 3 のテストに差し替える)。

- [ ] **Step 1改: 一時ファイルでの実テスト** — 上書きで:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { initSchema, insertAlert, getRecentAlerts, recordTick, getRecentTicks, openDb } from './store.js';
import { mergeFrom } from './mergeDb.js';

const tmp: string[] = [];
function fileDb(): { db: DatabaseSync; path: string } {
  const path = join(tmpdir(), `mtest-${Math.random().toString(36).slice(2)}.db`);
  tmp.push(path);
  return { db: openDb(path), path };
}
afterEach(() => { for (const p of tmp.splice(0)) { try { rmSync(p); } catch {} try { rmSync(p + '-wal'); } catch {} try { rmSync(p + '-shm'); } catch {} } });

const A = { symbol: 'NIY=F', triggeredAt: 1000, direction: 'down', detectionKind: 'break', windowSeconds: 60, changePercent: 0, price: 67000, sessionDate: '2026-06-05', session: 'Day', referenceKind: null as string | null, referencePrice: null as number | null };

describe('mergeFrom', () => {
  it('alerts は OR IGNORE で重複せず統合(完全一致は無視・別は追加)', () => {
    const m = fileDb(); const o = fileDb();
    insertAlert(m.db, A);
    insertAlert(o.db, A);                       // 完全一致(無視される)
    insertAlert(o.db, { ...A, triggeredAt: 2000 });  // 別(追加)
    const res = mergeFrom(m.db, o.path);
    expect(getRecentAlerts(m.db, 10).length).toBe(2);
    expect(res.alerts).toBe(1);                 // 追加できたのは1
  });
  it('別水準(reference_price 違い)は保持される', () => {
    const m = fileDb(); const o = fileDb();
    insertAlert(o.db, { ...A, referenceKind: 'level', referencePrice: 67100 });
    insertAlert(o.db, { ...A, referenceKind: 'level', referencePrice: 67200 });
    mergeFrom(m.db, o.path);
    expect(getRecentAlerts(m.db, 10).length).toBe(2);
  });
  it('ticks は PK(symbol,t)で OR IGNORE', () => {
    const m = fileDb(); const o = fileDb();
    recordTick(m.db, 'NIY=F', 60_000, 67000, '2026-06-05', 'Day');
    recordTick(o.db, 'NIY=F', 60_000, 67000, '2026-06-05', 'Day');   // 同一 PK
    recordTick(o.db, 'NIY=F', 120_000, 67010, '2026-06-05', 'Day');  // 別
    const res = mergeFrom(m.db, o.path);
    expect(getRecentTicks(m.db, 'NIY=F', 0).length).toBe(2);
    expect(res.ticks).toBe(1);
  });
});
```

- [ ] **Step 2: 落ちる確認** — Run: `npx vitest run server/db/mergeDb.test.ts` → FAIL(mergeDb 無し)

- [ ] **Step 3: 実装** — `server/db/mergeDb.ts`:
```ts
import type { DatabaseSync } from 'node:sqlite';

export interface MergeResult { alerts: number; bars_1m: number; ticks: number; }

/** sourcePath の jp225 DB を db へ統合(OR IGNORE)。db は v0.6.17 の UNIQUE 同一性索引を持つ前提。
 *  純粋に DB 操作のみ(停止・バックアップ・再起動は呼び出し側)。 */
export function mergeFrom(db: DatabaseSync, sourcePath: string): MergeResult {
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);
  const src = sourcePath.replace(/\\/g, '/');
  db.exec(`ATTACH DATABASE '${src}' AS src`);
  db.exec('BEGIN');
  try {
    // alerts: id 以外の全列。UNIQUE 同一性索引が重複を弾く。
    const aCols = cols('alerts').filter(n => n !== 'id').join(', ');
    const a = db.prepare(`INSERT OR IGNORE INTO main.alerts (${aCols}) SELECT ${aCols} FROM src.alerts`).run();
    // bars_1m / ticks: PK(symbol,t)。列名明示で列順差を吸収。
    const bCols = cols('bars_1m').join(', ');
    const b = db.prepare(`INSERT OR IGNORE INTO main.bars_1m (${bCols}) SELECT ${bCols} FROM src.bars_1m`).run();
    const tCols = cols('ticks').join(', ');
    const t = db.prepare(`INSERT OR IGNORE INTO main.ticks (${tCols}) SELECT ${tCols} FROM src.ticks`).run();
    db.exec('COMMIT');
    db.exec('DETACH DATABASE src');
    return { alerts: a.changes, bars_1m: b.changes, ticks: t.changes };
  } catch (e) {
    db.exec('ROLLBACK');
    try { db.exec('DETACH DATABASE src'); } catch { /* ignore */ }
    throw e;
  }
}

/** ライブ(WAL)DB を安全に複製。VACUUM INTO は一貫スナップショットを作る(ファイルコピーは WAL 取りこぼし)。 */
export function backupViaVacuum(db: DatabaseSync, destPath: string): void {
  const dest = destPath.replace(/\\/g, '/');
  db.exec(`VACUUM INTO '${dest}'`);
}

/** source が jp225 DB として妥当か(alerts/bars_1m/ticks を持つ)。開けて確認。 */
export function isValidSourceDb(DatabaseSyncCtor: typeof DatabaseSync, sourcePath: string): boolean {
  try {
    const d = new DatabaseSyncCtor(sourcePath, { readOnly: true });
    const names = (d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    d.close();
    return ['alerts', 'bars_1m', 'ticks'].every(t => names.includes(t));
  } catch { return false; }
}
```

- [ ] **Step 4: 通る確認** — Run: `npx vitest run server/db/mergeDb.test.ts` → PASS
- [ ] **Step 5: Commit** — `feat(db): mergeFrom/backupViaVacuum/isValidSourceDb(設定マージ用)`

---

### Task 2: プロセス停止 `server/processControl.ts`

**Files:** Create `server/processControl.ts`(Windows taskkill・ユニットテスト無し=副作用関数。tsc が通ることを確認)

- [ ] **Step 1: 実装** — `server/processControl.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function kill(args: string[]): void {
  try { execFileSync('taskkill', args, { stdio: 'ignore' }); } catch { /* 未起動など無視 */ }
}

/** collector を停止(collector.pid を taskkill し pid ファイル削除)。 */
export function stopCollector(): void {
  const pidPath = join(process.env.APPDATA ?? '', 'jp225-monitor', 'collector.pid');
  if (existsSync(pidPath)) {
    const pid = readFileSync(pidPath, 'utf-8').trim();
    if (pid) kill(['/PID', pid, '/T', '/F']);
    try { rmSync(pidPath); } catch { /* ignore */ }
  }
}

/** jp225-Trade(アプリ+sidecar)を停止。未起動は無視。 */
export function stopTrade(): void {
  kill(['/IM', 'jp225-trade.exe', '/T', '/F']);
  kill(['/IM', 'jp225-trade-sidecar.exe', '/T', '/F']);
}
```

- [ ] **Step 2: tsc** — Run: `npx tsc --noEmit` → エラー無し
- [ ] **Step 3: Commit** — `feat(server): processControl(collector/trade 停止)`

---

### Task 3: マージ・ルート `server/routes/merge.ts` + 登録

**Files:** Create `server/routes/merge.ts`, Modify `server/index.ts`, Test `server/routes/merge.test.ts`

- [ ] **Step 1: 失敗するテスト(検証分岐)** — `server/routes/merge.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { mergeHandler } from './merge.js';

function mockRes() {
  return { statusCode: 200, body: null as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
}

describe('mergeHandler 検証', () => {
  it('source が無ければ 400', () => {
    const res = mockRes();
    mergeHandler({ body: {} } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
  it('存在しない source は 400', () => {
    const res = mockRes();
    mergeHandler({ body: { source: 'C:/nope/none.db' } } as never, res as never);
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: 落ちる確認** — Run: `npx vitest run server/routes/merge.test.ts` → FAIL(merge.ts 無し)

- [ ] **Step 3: 実装** — `server/routes/merge.ts`:
```ts
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath } from '../db/store.js';
import { mergeFrom, backupViaVacuum, isValidSourceDb } from '../db/mergeDb.js';
import { stopCollector, stopTrade } from '../processControl.js';

function ts(): string {
  // YYYYMMDD-HHMMSS。Date は実行時に使用(server プロセス内・Workflow 制約は無関係)。
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
}

export function mergeHandler(req: Request, res: Response): void {
  const source = (req.body as { source?: unknown })?.source;
  if (typeof source !== 'string' || !source) { res.status(400).json({ ok: false, error: 'source path required' }); return; }
  if (!existsSync(source)) { res.status(400).json({ ok: false, error: `source not found: ${source}` }); return; }
  if (!isValidSourceDb(DatabaseSync, source)) { res.status(400).json({ ok: false, error: 'not a jp225 DB (alerts/bars_1m/ticks 必須)' }); return; }

  // 外部書き手を停止
  stopCollector();
  stopTrade();

  const dbPath = resolveDbPath();
  const backup = join(dbPath, '..', `jp225.db.bak-merge-${ts()}`);
  const db = openDb(dbPath);   // 専用接続
  try {
    backupViaVacuum(db, backup);
    const inserted = mergeFrom(db, source);   // 同期=原子的
    db.close();
    res.json({ ok: true, inserted, backup });
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e),
      note: 'collector/jp225-Trade は停止済み。バックアップから復旧可: ' + backup });
  }
}
```

- [ ] **Step 4: ルート登録** — `server/index.ts` に追加。import 群に `import { mergeHandler } from './routes/merge.js';`、ルート登録部(`app.post('/api/basedata/import', ...)` の近く)に `app.post('/api/merge', mergeHandler);`。

- [ ] **Step 5: 通る確認** — Run: `npx vitest run server/routes/merge.test.ts ; npx tsc --noEmit` → PASS / エラー無し
- [ ] **Step 6: Commit** — `feat(server): POST /api/merge(停止→バックアップ→マージ)`

---

### Task 4: Tauri dialog プラグイン

**Files:** Modify `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `package.json`(npm 依存)

- [ ] **Step 1: Cargo 依存** — `src-tauri/Cargo.toml` の `[dependencies]` に追加: `tauri-plugin-dialog = "2"`
- [ ] **Step 2: lib.rs プラグイン登録** — `src-tauri/src/lib.rs` の plugin チェーン(`.plugin(tauri_plugin_process::init())` の隣)に `.plugin(tauri_plugin_dialog::init())` を追加。
- [ ] **Step 3: capability** — `src-tauri/capabilities/default.json` の `permissions` 配列に `"dialog:default"` を追加。
- [ ] **Step 4: npm 依存** — `npm i @tauri-apps/plugin-dialog`
- [ ] **Step 5: ビルド確認(任意・重い)** — `npm run tauri:build` が通ること(Rust 依存追加のコンパイル)。dev で確認する場合は Task 6 とまとめて。
- [ ] **Step 6: Commit** — `build(tauri): dialog プラグイン追加(ファイル選択用)`

---

### Task 5: 設定UI(ファイル選択→マージ→再起動)

**Files:** Create `web/lib/dbMerge.ts`, Modify `web/components/settingsModal.ts` + `web/index.html`(設定モーダル)

- [ ] **Step 1: web ラッパ `web/lib/dbMerge.ts`**(Tauri 非対応ガード+動的 import。`web/lib/updater.ts` と同じ作法):
```ts
import { apiUrl } from './apiBase.js';   // 既存の API base ヘルパ(無ければ updater.ts の inTauri 判定を流用)

function inTauri(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as Record<string, unknown>); }

/** ファイル選択ダイアログ。選ばれたパス or null。 */
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
```
注: `apiUrl` の所在を確認。monitor web が相対 fetch なら `apiUrl = (p)=>p`、Tauri 絶対 URL を使っているなら既存ヘルパを使う(updater.ts / settingsModal.ts の fetch 方法に合わせる)。

- [ ] **Step 2: 設定モーダルにUI** — `web/index.html` の設定モーダル(バージョンチェックの近く)に「データ」セクションを追加:
  - ボタン `別PCのDBをマージ`(id 例 `settings-merge-db`)、結果表示 `<div id="settings-merge-result">`。
  `web/components/settingsModal.ts` に配線(`initSettingsModal` 等の既存パターンに合わせる):
  1. 非Tauri なら結果欄に「パッケージ版でのみ利用可」、ボタン無効。
  2. クリック: `pickDbFile()` → null ならreturn。
  3. `confirm('collector と jp225-Trade を停止してマージし、自動で再起動します。よろしいですか?')`(window.confirm でよい)。
  4. ボタン無効化・「マージ中…(数十秒かかる場合があります)」表示 → `mergeDbFromFile(path)`。
  5. ok: 「統合: alerts +{a} / bars +{b} / ticks +{t}。再起動します」表示 → `setTimeout(relaunchApp, 1500)`。
  6. !ok: 「失敗: {error}」表示(再起動しない)。ボタン再有効化。
  HTML はエスケープして埋め込む。

- [ ] **Step 3: typecheck** — Run: `npx tsc --noEmit`(web が tsconfig 対象なら)。対象外ならスキップし構文のみ注意。
- [ ] **Step 4: Commit** — `feat(ui): 設定から別PCのDBをマージ→自動再起動`

---

### Task 6: scripts/merge-db.mjs を mergeDb モジュールへ寄せる

**Files:** Modify `scripts/merge-db.mjs`

- [ ] **Step 1: 修正** — alerts の素の INSERT は v0.6.17 の UNIQUE 索引で制約違反になるため、`mergeFrom`(server/db/mergeDb.ts のロジック)に合わせ **alerts も `INSERT OR IGNORE`** にする。全列一致 DELETE は索引があれば不要(残すなら害は無いが、索引前提なら削除可)。バックアップ・停止チェックは CLI 側に残す。可能なら `mergeFrom` を import して再利用(CLI は .mjs なのでビルド済み js or tsx 経由。簡便には mergeFrom と同等の SQL を .mjs に持たせ、コメントで「server/db/mergeDb.ts と同ロジック」と明記)。
- [ ] **Step 2: 動作確認** — 既存 DB のコピーに対し `node scripts/merge-db.mjs <copy.db>` がエラー無く動く(UNIQUE 索引下で OR IGNORE)。
- [ ] **Step 3: Commit** — `refactor(scripts): merge-db を OR IGNORE に(v0.6.17 UNIQUE 索引対応)`

---

### Task 7: 回帰 + 手動確認

- [ ] **Step 1: 全テスト+型** — Run: `npx tsc --noEmit ; npx vitest run` → 全緑(既存288 + 追加分)。
- [ ] **Step 2: 手動(tauri:dev)** — `npm run tauri:dev` → 設定 → 「別PCのDBをマージ」→ ファイル選択ダイアログ→ .db 選択→確認→「マージ中」→件数トースト→自動再起動。再起動後に件数が増えていること、ブラウザが開かないこと。
  ※ GUI 操作はユーザー確認に委ねてよい(ヘッドレスでは `POST /api/merge` を curl で検証可能: サーバ起動→不正sourceで400、正DBコピーで200+件数)。
- [ ] **Step 3: 評価**(requesting-code-review)→ 修正 → リリース(版上げ・署名ビルド・GitHub Release は monitor 既存フロー)。

---

## Self-Review
- 仕様 §2.1 mergeDb → Task1。§2.2 backup(VACUUM INTO)→ Task1(backupViaVacuum)。§2.3 processControl → Task2。
  §2.4 /api/merge → Task3。§2.6 Tauri dialog → Task4。§2.5 設定UI → Task5。CLI 整合 → Task6。テスト/回帰 → Task1/3/7。
- placeholder: 各コード手順に実コードあり。Task5 の `apiUrl` 所在のみ実装時に既存に合わせる旨を明記(曖昧さは「updater.ts/settingsModal の fetch 方法に合わせる」で解消)。
- 型整合: `mergeFrom`/`backupViaVacuum`/`isValidSourceDb`/`MergeResult`/`mergeHandler`/`stopCollector`/`stopTrade`/`pickDbFile`/`mergeDbFromFile`/`relaunchApp` 一貫。
- 非対象(進捗バー/再起動後表示/複数選択/mac-linux/双方向)は含めない。
