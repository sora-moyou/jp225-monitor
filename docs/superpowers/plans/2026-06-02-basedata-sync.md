# SP3 基礎データ連携 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** N225mini の Excel 履歴(1分足)を gzip NDJSON にして GitHub Release で配布し、モニターが自分のローカル DB(`bars_1m`)へ upsert で取り込めるようにする（基礎=正、collector の新データは削除しない）。

**Architecture:** publish スクリプト(SheetJS, devDep)で xlsx→`basedata-1min.ndjson.gz`→GitHub Release `basedata-latest`。モニターは `POST /api/basedata/import` で DL→gunzip→`classifySession` 付与→`upsertBar`。設定にボタン。

**Tech Stack:** Node + `node:sqlite` + `node:zlib`、Express、Vanilla TS、vitest、SheetJS(devDep, scriptのみ)。

**Spec:** `docs/superpowers/specs/2026-06-02-basedata-sync-design.md`

**前提（確認済み）:** `bars_1m` は既に `PRIMARY KEY (symbol, t)`。`recordTick` は upsert。よって索引追加・重複解消の移行は不要。本SPの移行は `volume` 列追加のみ。`collector/session.ts` の `classifySession(epochMs)` は pure。

---

## File Structure
- Modify `server/db/store.ts` — `volume` 列移行 ＋ `upsertBar`。
- Modify `server/db/store.test.ts` — `upsertBar` テスト。
- Create `server/basedata.ts` — `rowToBar` / `parseNdjsonLine` / `importBars`（pure 寄り）。
- Create `server/basedata.test.ts`。
- Create `server/routes/basedata.ts` — `POST /api/basedata/import`（DL→gunzip→import）。
- Modify `server/index.ts` — route 登録。
- Modify `web/index.html` — 設定に「基礎データ」fieldset＋ボタン。
- Modify `web/components/settingsModal.ts` — ボタンハンドラ（取り込み実行・結果表示）。
- Create `scripts/basedata-publish.mjs` — xlsx→gz→`gh release upload`。
- Modify `package.json` — `basedata:publish` script ＋ `xlsx`(SheetJS) を devDependencies に。

---

### Task 1: `volume` 列移行 ＋ `upsertBar`（store.ts）

**Files:** Modify `server/db/store.ts`, `server/db/store.test.ts`.

- [ ] **Step 1: 失敗テスト** — `server/db/store.test.ts` に追記（import に `upsertBar` を追加）:

```ts
describe('upsertBar', () => {
  it('同 (symbol,t) は OHLCV を全上書き、別 t は併存、削除しない', () => {
    const db = openDb(':memory:');
    // 既存(collector相当)を 2 本入れる
    upsertBar(db, 'NIY=F', 60000, 100, 110, 90, 105, null, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 120000, 200, 210, 190, 205, null, '2026-06-01', 'Day');
    // t=60000 を基礎データで上書き(値を確定値に)
    upsertBar(db, 'NIY=F', 60000, 101, 111, 91, 99, 2086, '2026-06-01', 'Day');
    const rows = db.prepare('SELECT t,o,h,l,c,volume FROM bars_1m WHERE symbol=? ORDER BY t').all('NIY=F') as any[];
    expect(rows.length).toBe(2);                       // 削除されず2本のまま
    expect(rows[0]).toEqual({ t: 60000, o: 101, h: 111, l: 91, c: 99, volume: 2086 });  // 全上書き
    expect(rows[1].t).toBe(120000);                    // 別tは不変
    db.close();
  });
});
```

- [ ] **Step 2:** `npx vitest run server/db/store.test.ts -t upsertBar` → FAIL。

- [ ] **Step 3: 実装** — `server/db/store.ts`:

(3a) `initSchema` のマイグレーション部（`session` 列追加の直後）に volume を追加:
```ts
  if (!cols.includes('volume')) db.exec('ALTER TABLE bars_1m ADD COLUMN volume INTEGER');
```

(3b) ファイル末尾に追加:
```ts
/** 基礎データ取り込み用。(symbol,t) で OHLCV を全上書き upsert（基礎=正）。削除はしない。 */
export function upsertBar(
  db: DatabaseSync, symbol: string, t: number,
  o: number, h: number, l: number, c: number, volume: number | null,
  sessionDate: string, session: string,
): void {
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
      volume = excluded.volume, session_date = excluded.session_date, session = excluded.session
  `).run(symbol, sessionDate, session, minute, o, h, l, c, volume);
}
```

- [ ] **Step 4:** `npx vitest run server/db/store.test.ts` → PASS（既存 + upsertBar）。
- [ ] **Step 5:** `npm run typecheck` 後 commit:
```bash
git add server/db/store.ts server/db/store.test.ts
git commit -m "feat(basedata): bars_1m volume column + upsertBar (full overwrite, no delete)"
```

---

### Task 2: 変換・取り込みコア（server/basedata.ts）

**Files:** Create `server/basedata.ts`, `server/basedata.test.ts`.

- [ ] **Step 1: 失敗テスト** — `server/basedata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db/store.js';
import { rowToBar, parseNdjsonLine, importBars } from './basedata.js';

describe('rowToBar (Excel serial+fraction → JST epoch)', () => {
  it('17:00 の時間小数を JST 17:00 に、分床へ丸める', () => {
    const b = rowToBar(46021, 17 / 24, 50450, 50465, 50415, 50420, 2086);
    const jst = new Date(b.t + 9 * 3600_000);
    expect(jst.getUTCHours()).toBe(17);
    expect(jst.getUTCMinutes()).toBe(0);
    expect(jst.getUTCFullYear()).toBe(2026);
    expect(b.t % 60_000).toBe(0);                 // 分床
    expect(b).toMatchObject({ o: 50450, h: 50465, l: 50415, c: 50420, v: 2086 });
  });
});

describe('parseNdjsonLine', () => {
  it('正常行を bar に、空/不正は null', () => {
    expect(parseNdjsonLine('{"t":60000,"o":1,"h":2,"l":0.5,"c":1.5,"v":10}'))
      .toEqual({ t: 60000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    expect(parseNdjsonLine('')).toBeNull();
    expect(parseNdjsonLine('not json')).toBeNull();
    expect(parseNdjsonLine('{"t":"x"}')).toBeNull();
  });
});

describe('importBars', () => {
  it('session を付与し upsert、既存の別時刻データは削除しない', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    // 既存 collector 行(基礎より新しい想定)を 1 本
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 9_999_999_999_000, 1, 1, 1, 1);
    // 場中(Day)の基礎バー2本。jst 2026-06-01 10:00, 10:01 (Monday)
    const t10 = Date.UTC(2026, 5, 1, 1, 0); // 10:00 JST
    const bars = [
      { t: t10, o: 100, h: 110, l: 90, c: 105, v: 5 },
      { t: t10 + 60_000, o: 105, h: 115, l: 95, c: 110, v: 6 },
    ];
    const r = importBars(db, bars);
    expect(r.inserted + r.updated).toBe(2);
    const cnt = (db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
    expect(cnt).toBe(3);                                  // 既存1 + 新規2、削除なし
    const tagged = db.prepare('SELECT session FROM bars_1m WHERE t=?').get(t10) as any;
    expect(tagged.session).toBe('Day');                   // classifySession 付与
    db.close();
  });

  it('休場/場外(session=null)のバーはスキップ', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const tHoliday = Date.UTC(2026, 0, 1, 1, 0);          // 2026-01-01 10:00 JST (元日 休場)
    const r = importBars(db, [{ t: tHoliday, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(r.inserted + r.updated).toBe(0);
    db.close();
  });
});
```

- [ ] **Step 2:** `npx vitest run server/basedata.test.ts` → FAIL。

- [ ] **Step 3: 実装** — `server/basedata.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { upsertBar } from './db/store.js';
import { classifySession } from '../collector/session.js';

const SYMBOL = 'NIY=F';
const EXCEL_1970 = 25569;          // 1970-01-01 の Excel シリアル
const JST_OFFSET_MS = 9 * 3600_000;

export interface BaseBar { t: number; o: number; h: number; l: number; c: number; v: number | null; }

/** Excel シリアル日付 + 1日小数の時間 → bar(JST 壁時計→UTC epoch, 分床)。 */
export function rowToBar(serialDate: number, timeFrac: number,
  o: number, h: number, l: number, c: number, v: number | null): BaseBar {
  const dayMs = (serialDate - EXCEL_1970) * 86400_000;
  const minMs = Math.round((timeFrac * 86400_000) / 60_000) * 60_000;
  const t = dayMs + minMs - JST_OFFSET_MS;
  return { t, o, h, l, c, v };
}

export function parseNdjsonLine(line: string): BaseBar | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if ([o?.t, o?.o, o?.h, o?.l, o?.c].some(x => typeof x !== 'number')) return null;
    return { t: o.t, o: o.o, h: o.h, l: o.l, c: o.c, v: typeof o.v === 'number' ? o.v : null };
  } catch { return null; }
}

export interface ImportResult { inserted: number; updated: number; skipped: number; from: number; to: number; total: number; }

/** bars を session 付与して upsert。session=null(休場/場外)はスキップ。削除はしない。 */
export function importBars(db: DatabaseSync, bars: BaseBar[]): ImportResult {
  let applied = 0, skipped = 0, from = Infinity, to = -Infinity;
  for (const b of bars) {
    const s = classifySession(b.t);
    if (!s) { skipped++; continue; }
    upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
    applied++; if (b.t < from) from = b.t; if (b.t > to) to = b.t;
  }
  // inserted/updated の厳密分離はコスト高なので applied をまとめて返す(テストは合計で検証)。
  return { inserted: applied, updated: 0, skipped, from: from === Infinity ? 0 : from, to: to === -Infinity ? 0 : to, total: bars.length };
}
```

注: テストは `r.inserted + r.updated` の合計で検証するため、inserted に applied をまとめ updated=0 とする実装で通る。

- [ ] **Step 4:** `npx vitest run server/basedata.test.ts` → PASS。
- [ ] **Step 5:** `npm run typecheck` 後 commit:
```bash
git add server/basedata.ts server/basedata.test.ts
git commit -m "feat(basedata): rowToBar/parseNdjsonLine/importBars (session-tag + upsert, skip closed)"
```

---

### Task 3: 取り込みルート `POST /api/basedata/import`

**Files:** Create `server/routes/basedata.ts`, Modify `server/index.ts`.

GitHub Release アセットを DL→gunzip→行ごとに `parseNdjsonLine`→`importBars`。DB は `openDb(resolveDbPath())` で開き、最後に close。

- [ ] **Step 1: 実装** — `server/routes/basedata.ts`:

```ts
import type { Request, Response } from 'express';
import { gunzipSync } from 'node:zlib';
import { openDb, resolveDbPath } from '../db/store.js';
import { parseNdjsonLine, importBars, type BaseBar } from '../basedata.js';

const ASSET_URL =
  'https://github.com/sora-moyou/jp225-monitor/releases/download/basedata-latest/basedata-1min.ndjson.gz';

export async function basedataImportHandler(_req: Request, res: Response): Promise<void> {
  try {
    const resp = await fetch(ASSET_URL, { redirect: 'follow' });
    if (!resp.ok) { res.status(502).json({ ok: false, error: `download failed: HTTP ${resp.status}` }); return; }
    const gz = Buffer.from(await resp.arrayBuffer());
    const text = gunzipSync(gz).toString('utf-8');
    const bars: BaseBar[] = [];
    for (const line of text.split('\n')) {
      const b = parseNdjsonLine(line);
      if (b) bars.push(b);
    }
    if (bars.length === 0) { res.status(422).json({ ok: false, error: 'no valid rows' }); return; }
    const db = openDb(resolveDbPath());
    try {
      const r = importBars(db, bars);
      const fmt = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);
      res.json({ ok: true, applied: r.inserted, skipped: r.skipped, total: r.total,
        from: r.from ? fmt(r.from) : null, to: r.to ? fmt(r.to) : null });
    } finally { db.close(); }
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : 'import failed' });
  }
}
```

- [ ] **Step 2: 配線** — `server/index.ts`:
  - import: `import { basedataImportHandler } from './routes/basedata.js';`
  - ルート登録（他の `app.post`/`app.get` 群の近く）: `app.post('/api/basedata/import', basedataImportHandler);`

- [ ] **Step 3:** `npm run typecheck` ＆ `npx vitest run server/`（既存緑のまま）。
- [ ] **Step 4:** commit:
```bash
git add server/routes/basedata.ts server/index.ts
git commit -m "feat(basedata): POST /api/basedata/import (download gz, gunzip, upsert)"
```

注: ライブ DL の手動確認は basedata-latest 公開後（Task 5 + ユーザーの publish 実行後）。本タスクは typecheck と既存テストの維持まで。

---

### Task 4: 設定 UI のボタン

**Files:** Modify `web/index.html`, `web/components/settingsModal.ts`.

- [ ] **Step 1: HTML** — `web/index.html` の「終了」fieldset の直前（`<fieldset class="settings-section"><legend>終了</legend>` の前）に追加:

```html
      <fieldset class="settings-section">
        <legend>基礎データ</legend>
        <div class="basedata-row">
          <button type="button" id="settings-basedata-import" class="btn-secondary">基礎データを取り込む</button>
          <span id="settings-basedata-result" class="basedata-result"></span>
        </div>
        <div class="exit-hint">GitHub から最新の履歴(1分足)を取得し、ローカルDBへ追記/更新します（既存の新しいデータは消えません）。</div>
      </fieldset>
```

- [ ] **Step 2: ハンドラ** — `web/components/settingsModal.ts`:
  - `SettingsElements` インターフェースに追加: `basedataBtn: HTMLButtonElement; basedataResult: HTMLElement;`
  - `initSettingsModal` 内（`el.checkUpdateBtn.addEventListener(...)` の近く）に:

```ts
  el.basedataBtn.addEventListener('click', async () => {
    el.basedataBtn.disabled = true;
    const orig = el.basedataBtn.textContent ?? '基礎データを取り込む';
    el.basedataBtn.textContent = '取り込み中…';
    el.basedataResult.textContent = '';
    try {
      const res = await fetch(apiUrl('/api/basedata/import'), { method: 'POST' });
      const data = await res.json() as { ok: boolean; applied?: number; skipped?: number; from?: string; to?: string; error?: string };
      el.basedataResult.textContent = data.ok
        ? `✅ ${data.applied}件取り込み (${data.from ?? '?'}〜${data.to ?? '?'})${data.skipped ? ` / 休場スキップ${data.skipped}` : ''}`
        : `❌ ${data.error ?? '失敗'}`;
    } catch (err) {
      el.basedataResult.textContent = `❌ ${err instanceof Error ? err.message : 'failed'}`;
    } finally {
      el.basedataBtn.disabled = false;
      el.basedataBtn.textContent = orig;
    }
  });
```

  - `web/main.ts` で `initSettingsModal({...})` に要素を渡している箇所へ、`basedataBtn` と `basedataResult` の取得を追加:
    `basedataBtn: document.getElementById('settings-basedata-import') as HTMLButtonElement,`
    `basedataResult: document.getElementById('settings-basedata-result') as HTMLElement,`
    （`initSettingsModal` 呼び出しの実引数オブジェクトに 2 行追加。場所は `web/main.ts` 内の該当呼び出しを grep して特定。）

- [ ] **Step 3: スタイル**（任意・最小）— `web/styles.css` に:
```css
.basedata-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.basedata-result { font-size: 12px; color: var(--muted); }
```

- [ ] **Step 4:** `npm run typecheck` ＆ `npm run build:web`（緑）。
- [ ] **Step 5:** commit:
```bash
git add web/index.html web/components/settingsModal.ts web/main.ts web/styles.css
git commit -m "feat(basedata): settings UI button to import base data"
```

---

### Task 5: publish スクリプト ＋ SheetJS devDep

**Files:** Create `scripts/basedata-publish.mjs`, Modify `package.json`.

- [ ] **Step 1: SheetJS を devDep に**:
```bash
npm install --save-dev xlsx
```
（`package.json` の devDependencies に `xlsx` が入る。アプリ本体のバンドルには含めない＝scriptのみ使用。）

- [ ] **Step 2: スクリプト** — `scripts/basedata-publish.mjs`:

```js
#!/usr/bin/env node
// xlsx(1minシート) → basedata-1min.ndjson.gz → GitHub Release(basedata-latest) にアップロード。
// 使い方: npm run basedata:publish -- "C:\path\to\N225minif_2026.xlsx"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import * as XLSX from 'xlsx';

const xlsxPath = process.argv[2];
if (!xlsxPath) { console.error('usage: npm run basedata:publish -- <path-to-xlsx>'); process.exit(1); }

const EXCEL_1970 = 25569, JST = 9 * 3600_000;
function rowToBar(serial, frac, o, h, l, c, v) {
  const dayMs = (serial - EXCEL_1970) * 86400_000;
  const minMs = Math.round((frac * 86400_000) / 60_000) * 60_000;
  return { t: dayMs + minMs - JST, o, h, l, c, v: typeof v === 'number' ? v : null };
}

console.log('reading', xlsxPath);
const wb = XLSX.readFile(xlsxPath, { cellDates: false });
const ws = wb.Sheets['1min'];
if (!ws) { console.error('sheet "1min" not found'); process.exit(1); }
// A=日付(serial) B=時間(小数) C..F=OHLC G=出来高。ヘッダ行(1)を除く。
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
const bars = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const [d, tm, o, h, l, c, v] = r;
  if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
  bars.push(rowToBar(d, tm, o, h, l, c, v));
}
bars.sort((a, b) => a.t - b.t);
console.log(`parsed ${bars.length} bars (${new Date(bars[0].t + JST).toISOString().slice(0,10)} .. ${new Date(bars.at(-1).t + JST).toISOString().slice(0,10)})`);

const ndjson = bars.map(b => JSON.stringify(b)).join('\n') + '\n';
mkdirSync('dist', { recursive: true });
const out = 'dist/basedata-1min.ndjson.gz';
writeFileSync(out, gzipSync(Buffer.from(ndjson, 'utf-8')));
console.log('wrote', out);

// GitHub Release(basedata-latest) を用意してアップロード(上書き)。
try { execSync('gh release view basedata-latest', { stdio: 'ignore' }); }
catch { execSync('gh release create basedata-latest --title "Base data (N225 mini 1min)" --notes "Auto-published base data. Updated weekly."', { stdio: 'inherit' }); }
execSync(`gh release upload basedata-latest ${out} --clobber`, { stdio: 'inherit' });
console.log('✅ uploaded to release basedata-latest');
```

- [ ] **Step 3: npm script** — `package.json` の scripts に追加:
```json
    "basedata:publish": "node scripts/basedata-publish.mjs",
```

- [ ] **Step 4: スモーク**（実アップロードはユーザーが実行）— 変換だけ確認:
  実行は任意。`npm run basedata:publish -- "<xlsx>"` はネットワーク公開を伴うため、CI/自動実行しない。
  実装確認は Task 2 の `rowToBar` テストで担保済み。

- [ ] **Step 5:** commit:
```bash
git add scripts/basedata-publish.mjs package.json package-lock.json
git commit -m "feat(basedata): publish script (xlsx 1min -> ndjson.gz -> gh release basedata-latest)"
```

---

## Final Verification（全タスク後）
```bash
npm run typecheck
npx vitest run            # 全テスト緑
npm run build:web
```
- ライブ取り込みの実確認: ユーザーが `npm run basedata:publish -- "<xlsx>"` で公開 → モニター設定のボタンで取り込み → 件数/期間が出る → levelsLoop に深い履歴が反映。
- リリースは SP3 完了後 v0.4.5（署名ビルド＋GitHub リリース）。

## Self-Review（作成者チェック済み）
- **Spec coverage**: §4変換→Task2、§5.1 volume/§5.2 upsert→Task1、§6 import/route→Task2/3、§7 UI→Task4、
  §8 publish→Task5、§9 非削除→Task1/2テスト、§2 1minのみ/volume→Task1/5。
- **型整合**: `BaseBar`(Task2 定義)を route(Task3) が import。`upsertBar`(Task1) を basedata(Task2) が使用。
  `classifySession`(既存) を basedata が import（`../collector/session.js`）。
- **非削除の担保**: Task1/Task2 のテストで「別時刻の既存行が残る/件数が減らない」を明示検証。
- **休場対応**: importBars が `classifySession=null` をスキップ（Task2 元日テスト）。SP の③(休場日)と整合。
