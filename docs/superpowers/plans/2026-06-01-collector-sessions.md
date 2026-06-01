# Collector Session-Awareness + Session-Tagged OHLC — Implementation Plan (Plan 3a)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Make the collector poll only during OSE Nikkei trading sessions (Mon 8:45 → Sat 6:00, with margin), and tag every 1-minute bar with its session-start date + session (Day/Night), so downstream processing can group/export by session.

**Architecture:** A pure `collector/session.ts` classifies any epoch-ms timestamp (JST) into `{ sessionDate, session }` or `null` (closed). The store's `bars_1m` gains `session_date` + `session` columns; `recordTick` takes them. `recordFeedPrices` classifies each price and drops out-of-session ones. The daemon loop polls every 2 s only inside the poll window (session ± margin), idling otherwise.

**Tech Stack:** TypeScript, `node:sqlite`, vitest. Japan has no DST → JST = UTC+9 constant.

**Requirements (user, confirmed):**
- Week: **Mon 8:45 → Sat 6:00 (JST)**. Day = 8:45:00–15:45:00; Night = 17:00:00 → next-day 6:00:00.
- A timestamp's session:
  - Mon–Fri, 8:45:00 ≤ t < 15:45:00 → Day, sessionDate = that day.
  - Mon–Fri, 17:00:00 ≤ t ≤ 23:59:59 → Night, sessionDate = that day.
  - 00:00:00 ≤ t < 6:00:00 AND the previous JST day is Mon–Fri → Night, sessionDate = previous day.
  - otherwise → null (break 15:45–17:00 & 6:00–8:45; weekend Sat 6:00 → Mon 8:45).
- `sessionDate` = `'YYYY-MM-DD'` (JST) of the session start (8:45 or 17:00 day). `session` = `'Day' | 'Night'`.
- Bar `t` = the bar's actual OPEN epoch-ms (its own real date/time, sortable) — NOT the session date.
- **Margin:** poll from 5 min before open to 10 min after close; but **only write ticks whose strict session is non-null** (margin-only ticks are dropped).

---

### Task 1: session classification (pure)

**Files:** Create `collector/session.ts`; Test `collector/session.test.ts`

- [ ] **Step 1: Create `collector/session.test.ts`:**

```typescript
import { describe, it, expect } from 'vitest';
import { classifySession, inPollWindow } from './session.js';

// JST epoch helper: y-m-d h:mm (JST) → epoch ms.  (JST = UTC+9, no DST)
function jst(y: number, mo: number, d: number, h: number, mi: number): number {
  return Date.UTC(y, mo - 1, d, h - 9, mi, 0);
}
// 2026-06-01 is a Monday.
const MON = [2026, 6, 1] as const;
const TUE = [2026, 6, 2] as const;
const FRI = [2026, 6, 5] as const;
const SAT = [2026, 6, 6] as const;
const SUN = [2026, 5, 31] as const;

describe('classifySession', () => {
  it('Day session: Mon 08:45–15:44 inclusive of open, exclusive of 15:45', () => {
    expect(classifySession(jst(...MON, 8, 45))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 12, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 15, 44))).toEqual({ sessionDate: '2026-06-01', session: 'Day' });
    expect(classifySession(jst(...MON, 15, 45))).toBeNull();   // close is exclusive
    expect(classifySession(jst(...MON, 8, 44))).toBeNull();    // before open
  });

  it('Night evening: Mon 17:00–23:59 → sessionDate = Monday', () => {
    expect(classifySession(jst(...MON, 17, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...MON, 23, 59))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...MON, 16, 59))).toBeNull();   // break 15:45–17:00
  });

  it('Night morning: Tue 00:00–05:59 → sessionDate = Monday (prev day)', () => {
    expect(classifySession(jst(...TUE, 0, 0))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...TUE, 5, 59))).toEqual({ sessionDate: '2026-06-01', session: 'Night' });
    expect(classifySession(jst(...TUE, 6, 0))).toBeNull();     // night close exclusive
  });

  it('week edges: Sat early morning belongs to Fri night; Sat day / Mon pre-open / Sun are closed', () => {
    expect(classifySession(jst(...SAT, 3, 0))).toEqual({ sessionDate: '2026-06-05', session: 'Night' }); // Fri night
    expect(classifySession(jst(...SAT, 6, 0))).toBeNull();      // Sat 06:00 → closed (weekend)
    expect(classifySession(jst(...SAT, 10, 0))).toBeNull();     // Sat day → closed
    expect(classifySession(jst(...MON, 2, 0))).toBeNull();      // Mon 02:00 → prev day Sun → closed
    expect(classifySession(jst(...SUN, 12, 0))).toBeNull();     // Sunday → closed
    expect(classifySession(jst(...FRI, 17, 30))).toEqual({ sessionDate: '2026-06-05', session: 'Night' });
  });
});

describe('inPollWindow', () => {
  it('true inside a session', () => {
    expect(inPollWindow(jst(...MON, 9, 0))).toBe(true);
  });
  it('true 5 min before open and 10 min after close (margin)', () => {
    expect(inPollWindow(jst(...MON, 8, 41))).toBe(true);    // 4 min before Day open → within 5-min lead
    expect(inPollWindow(jst(...MON, 15, 54))).toBe(true);   // 9 min after Day close → within 10-min trail
  });
  it('false well outside any session (and its margins)', () => {
    expect(inPollWindow(jst(...MON, 16, 0))).toBe(false);   // mid-break
    expect(inPollWindow(jst(...SUN, 12, 0))).toBe(false);   // weekend
  });
});
```

- [ ] **Step 2: Run** `npx vitest run collector/session.test.ts` → FAIL.

- [ ] **Step 3: Create `collector/session.ts`:**

```typescript
// OSE 日経先物の取引セッション判定 (JST=UTC+9, 日本はDSTなし)。
// 週: 月 8:45 → 土 6:00。Day=8:45:00–15:45:00、Night=17:00:00→翌6:00:00。
export interface SessionInfo { sessionDate: string; session: 'Day' | 'Night'; }

const JST_OFFSET = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** epoch ms を JST の {dow(0=日), minutesOfDay, dateStr 'YYYY-MM-DD'} に。 */
function jstParts(epochMs: number): { dow: number; mod: number; date: string } {
  const j = new Date(epochMs + JST_OFFSET);   // UTC ゲッタで JST 壁時計を読む
  return {
    dow: j.getUTCDay(),
    mod: j.getUTCHours() * 60 + j.getUTCMinutes(),
    date: j.toISOString().slice(0, 10),
  };
}
const isWeekday = (dow: number): boolean => dow >= 1 && dow <= 5;   // Mon–Fri

const DAY_OPEN = 8 * 60 + 45;     // 8:45
const DAY_CLOSE = 15 * 60 + 45;   // 15:45
const NIGHT_OPEN = 17 * 60;       // 17:00
const NIGHT_MORN_CLOSE = 6 * 60;  // 6:00

/** セッション判定。休場帯/週末は null。 */
export function classifySession(epochMs: number): SessionInfo | null {
  const { dow, mod, date } = jstParts(epochMs);
  // Day: Mon–Fri 8:45–15:45
  if (isWeekday(dow) && mod >= DAY_OPEN && mod < DAY_CLOSE) return { sessionDate: date, session: 'Day' };
  // Night evening: Mon–Fri 17:00–23:59
  if (isWeekday(dow) && mod >= NIGHT_OPEN) return { sessionDate: date, session: 'Night' };
  // Night morning: 00:00–06:00, 前日(JST)が Mon–Fri なら前日の夜セッション
  if (mod < NIGHT_MORN_CLOSE) {
    const prev = jstParts(epochMs - DAY_MS);
    if (isWeekday(prev.dow)) return { sessionDate: prev.date, session: 'Night' };
  }
  return null;
}

const LEAD_MS = 5 * 60_000;    // 開始5分前から
const TRAIL_MS = 10 * 60_000;  // 終了10分後まで

/** 収集プロセスがポーリングすべき時間帯か (セッション ± マージン)。 */
export function inPollWindow(epochMs: number): boolean {
  return classifySession(epochMs) !== null
    || classifySession(epochMs + LEAD_MS) !== null
    || classifySession(epochMs - TRAIL_MS) !== null;
}
```

- [ ] **Step 4: Run** `npx vitest run collector/session.test.ts` → PASS. `npm run typecheck` clean.

- [ ] **Step 5: Commit** `git add collector/session.ts collector/session.test.ts` → `git commit -m "feat(collector): JST session classification + poll window\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: bars_1m schema + recordTick session columns

**Files:** Modify `server/db/store.ts`; Test `server/db/store.test.ts`

Note: the live `%APPDATA%/jp225-monitor/jp225.db` from earlier collector runs has the OLD `bars_1m` schema (no session columns). This plan changes the schema. Strategy: keep `CREATE TABLE IF NOT EXISTS` with the new columns for fresh DBs, AND add a one-time migration in `initSchema` that `ALTER TABLE bars_1m ADD COLUMN` for `session_date`/`session` if they're missing (so existing local DBs upgrade without data loss; old rows get NULL session — acceptable).

- [ ] **Step 1: Update tests in `server/db/store.test.ts`.** The existing `recordTick(db, sym, t, price)` calls must become `recordTick(db, sym, t, price, sessionDate, session)`. Update every existing `recordTick(...)` call to pass `'2026-06-01', 'Day'` (the values don't matter for the existing bar-OHLC assertions). Then update the bar-shape assertions to include the new fields, and add a new test:

```typescript
// Update the existing memDb()-based tests: every recordTick(db,'NIY=F',T,P) → recordTick(db,'NIY=F',T,P,'2026-06-01','Day')
// And update the two getRecentBars equality assertions to include session_date/session, e.g.:
//   expect(getRecentBars(db,'NIY=F',0)).toEqual([{ symbol:'NIY=F', session_date:'2026-06-01', session:'Day', t:10*M, o:67000,h:67000,l:67000,c:67000 }]);

it('bar carries session_date + session from recordTick', () => {
  const db = memDb();
  recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Night');
  const b = getRecentBars(db, 'NIY=F', 0)[0]!;
  expect(b.session_date).toBe('2026-06-01');
  expect(b.session).toBe('Night');
  expect(b.t).toBe(10 * M);
});
```
(Keep the duplicate-tick, minute-rollover, sinceT, getLatestTick, openDb-roundtrip, pruneTicks tests — just thread the two new args through each `recordTick` call. The bar OHLC behavior is unchanged.)

- [ ] **Step 2: Run** `npx vitest run server/db/store.test.ts` → FAIL (signature/shape mismatch).

- [ ] **Step 3: Edit `server/db/store.ts`:**
  - Extend `Bar1m`: add `session_date: string | null; session: string | null;` (after `symbol`, before/around the OHLC fields — order only matters for the SELECT/return).
  - In `initSchema`, change the `bars_1m` CREATE to include the columns, and add the migration:

```typescript
export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS bars_1m (
      symbol TEXT NOT NULL,
      session_date TEXT, session TEXT,
      t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
  // 旧スキーマ(セッション列なし)からの移行: 無ければ追加。
  const cols = (db.prepare('PRAGMA table_info(bars_1m)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('session_date')) db.exec('ALTER TABLE bars_1m ADD COLUMN session_date TEXT');
  if (!cols.includes('session')) db.exec('ALTER TABLE bars_1m ADD COLUMN session TEXT');
}
```

  - Change `recordTick` signature + bar upsert to carry session:

```typescript
export function recordTick(db: DatabaseSync, symbol: string, t: number, price: number, sessionDate: string, session: string): void {
  if (!Number.isFinite(price) || price <= 0) return;
  db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)').run(symbol, t, price);
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      h = max(h, excluded.h), l = min(l, excluded.l), c = excluded.c
  `).run(symbol, sessionDate, session, minute, price, price, price, price);
}
```

  - Update `getRecentBars` SELECT to include the new columns:

```typescript
export function getRecentBars(db: DatabaseSync, symbol: string, sinceT: number): Bar1m[] {
  return db.prepare(
    'SELECT symbol, session_date, session, t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Bar1m[];
}
```

  - `backfillBars` (in `collector/record.ts`, Task 3) will also need session columns — handle there.

- [ ] **Step 4: Run** `npx vitest run server/db/store.test.ts` → PASS. Then `npm run typecheck`. NOTE: `server/warmup.ts`'s `selectWarmup` maps `getRecentBars(...).map(b => ({ t: b.t, close: b.c }))` — still valid (b.c exists). `collector/record.ts` `backfillBars` and `recordFeedPrices` will break (recordTick signature) — those are fixed in Task 3, so the FULL suite will be red until Task 3. Run `npx vitest run server/db/store.test.ts` (this file) to PASS here; full-suite green is restored in Task 3.

- [ ] **Step 5: Commit** `git add server/db/store.ts server/db/store.test.ts` → `git commit -m "feat(db): bars_1m session_date+session columns + recordTick session args (migration)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: collector record — classify + drop out-of-session; backfill session columns

**Files:** Modify `collector/record.ts`; Test `collector/record.test.ts`

- [ ] **Step 1: Update `collector/record.test.ts`:**

```typescript
import { classifySession } from './session.js';
// recordFeedPrices now drops out-of-session prices and tags in-session ones.

describe('recordFeedPrices (session-aware)', () => {
  it('writes in-session prices with session tag; drops out-of-session and stale', () => {
    const db = memDb();
    // 2026-06-01 Monday 12:00 JST is Day session; 16:00 JST is a break (out of session)
    const daySession = Date.UTC(2026, 5, 1, 12 - 9, 0, 0);    // Mon 12:00 JST
    const breakTime  = Date.UTC(2026, 5, 1, 16 - 9, 0, 0);    // Mon 16:00 JST (closed)
    recordFeedPrices(db, [px('NIY=F', 67000, daySession)]);
    recordFeedPrices(db, [px('NIY=F', 99999, breakTime)]);            // out of session → dropped
    recordFeedPrices(db, [{ ...px('NIY=F', 88888, daySession + 1000), stale: true }]); // stale → dropped
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.session).toBe('Day');
    expect(bars[0]!.session_date).toBe('2026-06-01');
  });
});

describe('backfillBars (session-tagged, idempotent)', () => {
  it('tags each backfilled bar by its open time and skips out-of-session bars', () => {
    const db = memDb();
    const t1 = Date.UTC(2026, 5, 1, 12 - 9, 0, 0);   // Mon 12:00 JST (Day)
    const t2 = Date.UTC(2026, 5, 1, 16 - 9, 0, 0);   // Mon 16:00 JST (closed → skipped)
    backfillBars(db, 'NIY=F', [{ t: t1, close: 67000 }, { t: t2, close: 67100 }]);
    backfillBars(db, 'NIY=F', [{ t: t1, close: 67000 }]);            // idempotent
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars).toHaveLength(1);
    expect(bars[0]!.t).toBe(Math.floor(t1 / 60_000) * 60_000);
    expect(bars[0]!.session).toBe('Day');
  });
});
```
(The `px` helper and `memDb`/`getRecentBars` imports already exist in this file; add the `classifySession` import if needed, and the existing simpler tests can be replaced by the two above.)

- [ ] **Step 2: Run** `npx vitest run collector/record.test.ts` → FAIL.

- [ ] **Step 3: Edit `collector/record.ts`:**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { recordTick } from '../server/db/store.js';
import type { Price } from '../server/types.js';
import type { Bar } from '../server/correlation.js';
import { classifySession } from './session.js';

/** feed のリアルタイム価格を tick/1分足として DB へ。stale・場外(セッション外)はスキップ。 */
export function recordFeedPrices(db: DatabaseSync, prices: Price[]): void {
  for (const p of prices) {
    if (p.stale) continue;
    const s = classifySession(p.timestamp);
    if (!s) continue;   // 場外tickは破棄
    recordTick(db, p.symbol, p.timestamp, p.price, s.sessionDate, s.session);
  }
}

/** Yahoo 分足履歴を欠損のみ埋める。各足を OPEN時刻でセッション分類し、場外足はスキップ。
 *  bars のみ書き込む(ticks は汚さない) — INSERT OR IGNORE で冪等。 */
export function backfillBars(db: DatabaseSync, symbol: string, bars: Bar[]): void {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const b of bars) {
    if (!(Number.isFinite(b.close) && b.close > 0)) continue;
    const s = classifySession(b.t);
    if (!s) continue;
    stmt.run(symbol, s.sessionDate, s.session, b.t, b.close, b.close, b.close, b.close);
  }
}
```
NOTE: `backfillBars` writes ONLY `bars_1m` (not ticks) so it doesn't pollute the tick buffer the monitor warms from. Keep the `recordTick` import — `recordFeedPrices` still uses it.

- [ ] **Step 4: Run** `npx vitest run collector/record.test.ts` → PASS. Then `npm run typecheck`; then full `npx vitest run` → all green again.

- [ ] **Step 5: Commit** `git add collector/record.ts collector/record.test.ts` → `git commit -m "feat(collector): session-tag bars, drop out-of-session ticks/backfill\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: session-bounded poll loop in the daemon

**Files:** Modify `collector/index.ts`

- [ ] **Step 1: Edit `collector/index.ts`** poll loop to idle outside the poll window. Add `import { inPollWindow } from './session.js';`. Replace the `while (running)` body so that:
  - if `inPollWindow(Date.now())`: fetch + `recordFeedPrices` (as today), wait `POLL_MS` (2 s).
  - else: skip fetching, wait a longer idle interval `IDLE_MS = 30_000`.
  - The 1-min prune call (Task 6 of Plan 1) stays, runs every iteration regardless.

```typescript
  let lastPrune = 0;
  while (running) {
    const start = Date.now();
    let wait = IDLE_MS;
    if (inPollWindow(start)) {
      try {
        const prices = await fetchFeedPrices();
        recordFeedPrices(db, prices);
      } catch (err) {
        console.error('[collector] poll error:', err instanceof Error ? err.message : err);
      }
      wait = POLL_MS;
    }
    if (Date.now() - lastPrune > 60_000) {
      pruneTicks(db, Date.now() - 3 * 24 * 60 * 60 * 1000);
      lastPrune = Date.now();
    }
    await new Promise(r => setTimeout(r, Math.max(0, wait - (Date.now() - start))));
  }
```
Add `const IDLE_MS = 30_000;` near `POLL_MS`. Keep the startup backfill as-is (it already only writes in-session bars via Task 3's `backfillBars`).

- [ ] **Step 2: Manual live run** (only meaningful during/near a session; if currently closed, just confirm it idles without error): `npx tsx collector/index.ts &` → wait 8s → `kill %1`. Confirm no crash and, if in-session, that the inspection shows fresh in-session ticks (reuse the inspection one-liner from Plan 1). If out-of-session, confirm logs show it idling (no writes) — that's correct behavior.

- [ ] **Step 3:** `npm run typecheck` clean; `npx vitest run` all pass (loop has no unit test; logic is `inPollWindow` which is tested).

- [ ] **Step 4: Commit** `git add collector/index.ts` → `git commit -m "feat(collector): poll only during session window (idle off-hours)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: Full gate + evaluator

- [ ] `npm run typecheck && npx vitest run` → clean + all green. Fix + commit if needed.
- [ ] (Controller dispatches an evaluator over `master..HEAD` for spec compliance + quality, focusing on the session-classification edge cases.)

## Out of scope (Plan 3b)
- Monitor launches the collector detached; settings "通常終了" (leave daemon) vs "完全終了" (kill daemon); Tauri-side process management + exit UI.
