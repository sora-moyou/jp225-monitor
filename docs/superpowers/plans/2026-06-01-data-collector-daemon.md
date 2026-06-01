# Data Collector Daemon + Local SQLite Persistence — Implementation Plan (Plan 1 of SP1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone always-on collector daemon (v0.3.00) that polls the nikkei225jp feed and persists ticks + 1-minute bars to a local SQLite database via Node's built-in `node:sqlite`.

**Architecture:** A shared DB layer (`server/db/store.ts`, used later by the monitor too) wraps `node:sqlite` with schema + `recordTick`/read helpers. A small collector entry (`collector/index.ts`) reuses the existing `fetchFeedPrices`/`fetchMinuteBars` to poll every 2 s and write to the DB, backfilling history on startup. It builds to a single exe the same way the monitor sidecar does (esbuild → CJS → Node SEA).

**Tech Stack:** TypeScript, `node:sqlite` (Node 22+ builtin, dev/build is Node v24 — no native module), esbuild, Node SEA, vitest.

**Scope note:** This plan = collector + persistence only. The monitor reading from the DB (warmup + live + ON/OFF) is **Plan 2** (separate, depends on this). Spec: `docs/superpowers/specs/2026-06-01-data-collector-and-persistence-design.md`.

---

### Task 1: DB store module (schema + recordTick + reads)

**Files:**
- Create: `server/db/store.ts`
- Test: `server/db/store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/db/store.test.ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, recordTick, getRecentBars, getRecentTicks, getLatestTick } from './store.js';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}
const M = 60_000;

describe('store', () => {
  it('recordTick inserts a tick and creates a 1m bar (o=h=l=c on first tick of minute)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000);
    expect(getRecentTicks(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', t: 10 * M + 1000, price: 67000 }]);
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', t: 10 * M, o: 67000, h: 67000, l: 67000, c: 67000 }]);
  });

  it('recordTick updates the same minute bar h/l/c, keeps o', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000);
    recordTick(db, 'NIY=F', 10 * M + 20000, 67080);
    recordTick(db, 'NIY=F', 10 * M + 40000, 66950);
    recordTick(db, 'NIY=F', 10 * M + 59000, 67010);
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([
      { symbol: 'NIY=F', t: 10 * M, o: 67000, h: 67080, l: 66950, c: 67010 },
    ]);
  });

  it('recordTick rolls to a new bar on minute change', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000);
    recordTick(db, 'NIY=F', 11 * M + 1000, 67100);
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars.map(b => [b.t, b.c])).toEqual([[10 * M, 67000], [11 * M, 67100]]);
  });

  it('duplicate tick (same symbol+t) is ignored, no throw', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000);
    recordTick(db, 'NIY=F', 10 * M, 67000);
    expect(getRecentTicks(db, 'NIY=F', 0)).toHaveLength(1);
  });

  it('getRecentBars filters by sinceT and is per-symbol, ascending t', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 9 * M, 100);
    recordTick(db, 'NIY=F', 10 * M, 200);
    recordTick(db, 'NQ=F', 10 * M, 300);
    expect(getRecentBars(db, 'NIY=F', 10 * M).map(b => b.t)).toEqual([10 * M]);
    expect(getRecentBars(db, 'NQ=F', 0)).toHaveLength(1);
  });

  it('getLatestTick returns the newest tick or null', () => {
    const db = memDb();
    expect(getLatestTick(db, 'NIY=F')).toBeNull();
    recordTick(db, 'NIY=F', 10 * M, 100);
    recordTick(db, 'NIY=F', 11 * M, 200);
    expect(getLatestTick(db, 'NIY=F')).toEqual({ symbol: 'NIY=F', t: 11 * M, price: 200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/store.test.ts`
Expected: FAIL — cannot find module `./store.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// server/db/store.ts
import { DatabaseSync } from 'node:sqlite';

export interface Tick { symbol: string; t: number; price: number; }
export interface Bar1m { symbol: string; t: number; o: number; h: number; l: number; c: number; }

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS bars_1m (
      symbol TEXT NOT NULL, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
}

// 生 tick を保存しつつ、その分の 1分足 OHLC を upsert する。
export function recordTick(db: DatabaseSync, symbol: string, t: number, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)').run(symbol, t, price);
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      h = max(h, excluded.h), l = min(l, excluded.l), c = excluded.c
  `).run(symbol, minute, price, price, price, price);
}

export function getRecentBars(db: DatabaseSync, symbol: string, sinceT: number): Bar1m[] {
  return db.prepare(
    'SELECT symbol, t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Bar1m[];
}

export function getRecentTicks(db: DatabaseSync, symbol: string, sinceT: number): Tick[] {
  return db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Tick[];
}

export function getLatestTick(db: DatabaseSync, symbol: string): Tick | null {
  const row = db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? ORDER BY t DESC LIMIT 1',
  ).get(symbol) as Tick | undefined;
  return row ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/store.test.ts`
Expected: PASS (6 tests). If it fails with "Cannot find module 'node:sqlite'" the Node version is < 22.5 — STOP and report (build env should be Node v24).

- [ ] **Step 5: Commit**

```bash
git add server/db/store.ts server/db/store.test.ts
git commit -m "feat(db): node:sqlite store — schema + recordTick + reads"
```

---

### Task 2: DB open helper (file path + WAL) and node:sqlite SEA verification

**Files:**
- Modify: `server/db/store.ts` (add `resolveDbPath`, `openDb`)
- Test: `server/db/store.test.ts` (add openDb file-roundtrip test)

- [ ] **Step 1: Write the failing test**

Append to `server/db/store.test.ts`:

```typescript
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb } from './store.js';

describe('openDb', () => {
  it('opens a file db with WAL and persists across reopen', () => {
    const path = join(tmpdir(), `jp225-test-${process.pid}.db`);
    rmSync(path, { force: true });
    const db1 = openDb(path);
    recordTick(db1, 'NIY=F', 10 * 60_000, 67000);
    db1.close();
    const db2 = openDb(path);
    expect(getRecentBars(db2, 'NIY=F', 0)).toHaveLength(1);
    db2.close();
    rmSync(path, { force: true });
    rmSync(path + '-wal', { force: true });
    rmSync(path + '-shm', { force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/store.test.ts`
Expected: FAIL — `openDb` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `server/db/store.ts`:

```typescript
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** 共有 DB ファイルのパス (%APPDATA%/jp225-monitor/jp225.db、無ければ cwd)。 */
export function resolveDbPath(): string {
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  const dir = join(base, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'jp225.db');
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initSchema(db);
  return db;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/store.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify node:sqlite works inside a Node SEA (the spec's key risk)**

Run these commands to build a throwaway SEA that opens an in-memory db and prints a row:

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(x)');d.prepare('insert into t values(1)').run();console.log(d.prepare('select x from t').get());"
```

Expected: `{ x: 1 }` (no `--experimental-sqlite` flag needed on Node v24). If it errors requiring a flag, note the flag — the collector/monitor launch must pass it (SEA passes process flags via the embedded `node` binary; record the exact flag in this plan and Task 5).

- [ ] **Step 6: Commit**

```bash
git add server/db/store.ts server/db/store.test.ts
git commit -m "feat(db): openDb (WAL, APPDATA path) + node:sqlite verification"
```

---

### Task 3: Collector tick-recording + backfill (pure functions, testable)

**Files:**
- Create: `collector/record.ts`
- Test: `collector/record.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// collector/record.test.ts
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentBars } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import type { Price } from '../server/types.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
function px(symbol: Price['symbol'], price: number, t: number): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale: false };
}
const M = 60_000;

describe('recordFeedPrices', () => {
  it('writes every feed price as a tick/bar (skips stale)', () => {
    const db = memDb();
    recordFeedPrices(db, [px('NIY=F', 67000, 10 * M), px('NQ=F', 30000, 10 * M)]);
    recordFeedPrices(db, [{ ...px('NIY=F', 99999, 11 * M), stale: true }]);  // stale → skip
    expect(getRecentBars(db, 'NIY=F', 0).map(b => b.c)).toEqual([67000]);
    expect(getRecentBars(db, 'NQ=F', 0)).toHaveLength(1);
  });
});

describe('backfillBars', () => {
  it('inserts only missing 1m bars from fetched history (idempotent)', () => {
    const db = memDb();
    const bars = [{ t: 10 * M, close: 67000 }, { t: 11 * M, close: 67100 }];
    backfillBars(db, 'NIY=F', bars);
    backfillBars(db, 'NIY=F', bars);   // 2回目は何も増えない
    const out = getRecentBars(db, 'NIY=F', 0);
    expect(out.map(b => [b.t, b.c])).toEqual([[10 * M, 67000], [11 * M, 67100]]);
    expect(out.every(b => b.o === b.h && b.h === b.l && b.l === b.c)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run collector/record.test.ts`
Expected: FAIL — cannot find `./record.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// collector/record.ts
import type { DatabaseSync } from 'node:sqlite';
import { recordTick } from '../server/db/store.js';
import type { Price } from '../server/types.js';
import type { Bar } from '../server/correlation.js';

/** feed のリアルタイム価格を tick/1分足として DB へ。stale はスキップ。 */
export function recordFeedPrices(db: DatabaseSync, prices: Price[]): void {
  for (const p of prices) {
    if (p.stale) continue;
    recordTick(db, p.symbol, p.timestamp, p.price);
  }
}

/** Yahoo 分足履歴を欠損のみ埋める (close を o=h=l=c として bars_1m に INSERT OR IGNORE 相当)。 */
export function backfillBars(db: DatabaseSync, symbol: string, bars: Bar[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO bars_1m (symbol, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const b of bars) {
    if (Number.isFinite(b.close) && b.close > 0) {
      stmt.run(symbol, b.t, b.close, b.close, b.close, b.close);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run collector/record.test.ts`
Expected: PASS (2 tests). If vitest reports "no test files found", the project's `vitest.config`/`package.json` `test` include is scoped — add `'collector/**/*.test.ts'` (and `'server/**/*.test.ts'`) to the `include` array so the full `npx vitest run` (Task 7) also picks up collector tests.

- [ ] **Step 5: Commit**

```bash
git add collector/record.ts collector/record.test.ts
git commit -m "feat(collector): recordFeedPrices + backfillBars (pure, tested)"
```

---

### Task 4: Collector entry (poll loop + startup backfill)

**Files:**
- Create: `collector/index.ts`

- [ ] **Step 1: Write the implementation (entry point; integration verified by manual run in Step 2)**

```typescript
// collector/index.ts
// 日経225 データ収集デーモン v0.3.00。feed を 2秒ごとに DB へ。起動時に Yahoo 分足で backfill。
import { openDb, resolveDbPath } from '../server/db/store.js';
import { recordFeedPrices, backfillBars } from './record.js';
import { fetchFeedPrices } from '../server/sources/nikkei225jpFeed.js';
import { fetchMinuteBars } from '../server/correlation.js';
import { INSTRUMENTS } from '../server/config.js';

export const COLLECTOR_VERSION = '0.3.00';
const POLL_MS = 2000;
const SYMBOLS = INSTRUMENTS.map(i => i.symbol as string);

async function main(): Promise<void> {
  const dbPath = resolveDbPath();
  const db = openDb(dbPath);
  console.log(`[collector ${COLLECTOR_VERSION}] db=${dbPath}`);

  // 起動時 backfill (Yahoo 分足で直近を埋める。失敗は無視)
  await Promise.all(SYMBOLS.map(async (sym) => {
    try { backfillBars(db, sym, await fetchMinuteBars(sym)); }
    catch (err) { console.warn(`[collector] backfill ${sym} failed:`, err instanceof Error ? err.message : err); }
  }));
  console.log('[collector] backfill done');

  let running = true;
  process.on('SIGINT', () => { running = false; });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    const start = Date.now();
    try {
      const prices = await fetchFeedPrices();
      recordFeedPrices(db, prices);
    } catch (err) {
      console.error('[collector] poll error:', err instanceof Error ? err.message : err);
    }
    const wait = Math.max(0, POLL_MS - (Date.now() - start));
    await new Promise(r => setTimeout(r, wait));
  }
  db.close();
  console.log('[collector] stopped');
}

void main();
```

- [ ] **Step 2: Run the collector against the live feed for ~12s and confirm the DB grows**

Run the collector in the background, wait, then inspect the shared DB:
```bash
npx tsx collector/index.ts &
sleep 12 && kill %1
npx tsx -e "import {openDb,resolveDbPath,getRecentBars,getLatestTick} from './server/db/store.js'; const db=openDb(resolveDbPath()); console.log('NIY=F latest tick:', getLatestTick(db,'NIY=F')); console.log('bars:', getRecentBars(db,'NIY=F',0).length);"
```
Expected: a recent NIY=F tick (price ~current) and `bars:` ≥ 1.

- [ ] **Step 3: Commit**

```bash
git add collector/index.ts
git commit -m "feat(collector): daemon entry — 2s poll loop + startup backfill (v0.3.00)"
```

---

### Task 5: Collector build (esbuild → CJS → SEA exe)

**Files:**
- Create: `scripts/build-collector.mjs`
- Modify: `package.json` (add `build:collector` + `package:collector` scripts)

- [ ] **Step 1: Write the build script**

```javascript
// scripts/build-collector.mjs
// collector/index.ts → dist/collector.cjs (esbuild, 単一CJS) → SEA exe (bin/jp225-collector.exe)
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { platform, execPath } from 'node:process';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['collector/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/collector.cjs',
  // node:sqlite はビルトイン → external 自動。他の node 依存も external。
});
console.log('✅ esbuild → dist/collector.cjs');

const BIN_DIR = 'bin';
const OUT = join(BIN_DIR, platform === 'win32' ? 'jp225-collector.exe' : 'jp225-collector');
const BLOB = 'dist/collector-sea.blob';
const CFG = 'dist/collector-sea-config.json';
mkdirSync(BIN_DIR, { recursive: true });
writeFileSync(CFG, JSON.stringify({ main: 'dist/collector.cjs', output: BLOB, disableExperimentalSEAWarning: true, useCodeCache: false }, null, 2));
execSync(`node --experimental-sea-config ${CFG}`, { stdio: 'inherit' });
if (existsSync(OUT)) rmSync(OUT);
copyFileSync(execPath, OUT);
execSync(`npx postject ${OUT} NODE_SEA_BLOB ${BLOB} --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`, { stdio: 'inherit' });
console.log(`✅ SEA → ${OUT}`);
```

(Mirror `scripts/package-sea.mjs` exactly for the postject sentinel/fuse and any code-signing step it does; copy that file's postject invocation verbatim if it differs.)

- [ ] **Step 2: Add package.json scripts**

In `package.json` `"scripts"`, add:
```json
"build:collector": "node scripts/build-collector.mjs",
```

- [ ] **Step 3: Build and smoke-run the exe**

Run:
```bash
npm run build:collector
```
Expected: `bin/jp225-collector.exe` created. Then:
```bash
./bin/jp225-collector.exe &
sleep 12 && kill %1
npx tsx -e "import {openDb,resolveDbPath,getLatestTick} from './server/db/store.js'; const db=openDb(resolveDbPath()); console.log(getLatestTick(db,'NIY=F'));"
```
Expected: a recent NIY=F tick (proves `node:sqlite` works **inside the SEA exe** — the spec's key risk). If the exe errors on `node:sqlite`, record the required flag and add it to the SEA config / launch.

- [ ] **Step 4: Commit**

```bash
git add scripts/build-collector.mjs package.json
git commit -m "build(collector): esbuild + SEA packaging → bin/jp225-collector.exe"
```

---

### Task 6: Tick retention pruning (keep DB lean)

**Files:**
- Modify: `server/db/store.ts` (add `pruneTicks`)
- Modify: `collector/index.ts` (call `pruneTicks` periodically)
- Test: `server/db/store.test.ts` (add prune test)

- [ ] **Step 1: Write the failing test**

Append to `server/db/store.test.ts`:
```typescript
import { pruneTicks } from './store.js';

describe('pruneTicks', () => {
  it('deletes ticks older than cutoff but keeps bars_1m', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 1 * 60_000, 100);   // old
    recordTick(db, 'NIY=F', 100 * 60_000, 200); // recent
    pruneTicks(db, 50 * 60_000);
    expect(getRecentTicks(db, 'NIY=F', 0).map(t => t.t)).toEqual([100 * 60_000]);
    expect(getRecentBars(db, 'NIY=F', 0)).toHaveLength(2);  // bars 保持
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/store.test.ts`
Expected: FAIL — `pruneTicks` not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `server/db/store.ts`:
```typescript
/** cutoff(epoch ms) より古い ticks を削除 (bars_1m は残す)。 */
export function pruneTicks(db: DatabaseSync, cutoff: number): void {
  db.prepare('DELETE FROM ticks WHERE t < ?').run(cutoff);
}
```

Add to `collector/index.ts` inside the while loop, after `recordFeedPrices`:
```typescript
    // 1分に1回、3日より古い tick を間引く (bars_1m は長期保持)
    if (Date.now() - lastPrune > 60_000) {
      pruneTicks(db, Date.now() - 3 * 24 * 60 * 60 * 1000);
      lastPrune = Date.now();
    }
```
And declare `let lastPrune = 0;` before the loop, plus add `pruneTicks` to the store import.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/store.test.ts`
Expected: PASS (8 tests). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add server/db/store.ts collector/index.ts server/db/store.test.ts
git commit -m "feat(collector): prune ticks older than 3 days (bars retained)"
```

---

### Task 7: Full suite + typecheck gate

- [ ] **Step 1: Run everything**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass (existing + store(8) + record(2)).

- [ ] **Step 2: Commit any fixes**

```bash
git add -A && git commit -m "test: green suite + typecheck after collector"
```

---

## Out of scope (next plans)
- **Plan 2 (SP1 cont.):** monitor reads warmup history + live ticks from the DB; collector-offline status; ON/OFF toggle pausing heavy processing.
- **SP2:** multi-timeframe 上値/下値メド module from `bars_1m` (any span) + UI/AI integration.
- **SP3:** alerts/outcomes tables + tuning analytics. **SP4:** predictive/backtesting.
