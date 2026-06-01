# Monitor DB Warmup — Implementation Plan (Plan 2 of SP1)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** On monitor startup, seed in-memory `feedBars` (1m bars + raw samples) and the `tickDetector` buffer from the local SQLite DB the collector maintains — so the monitor is instantly warm (no ~65-min wait, no restart data loss), **but only when the DB data is current** (collector actively running), to avoid stale-seed false alerts.

**Architecture:** A new `server/warmup.ts` opens the shared DB (read), checks freshness (latest NIY=F tick < 2 min old), and if fresh seeds: all tracked symbols' 1m bars into `feedBars`, plus NIY=F recent ticks into `feedBars` samples and the `tickDetector` buffer. Called once in `server/index.ts` before the loops start. If the DB is missing/empty/stale, it's a safe no-op (current Yahoo/feed warmup behavior is unchanged).

**Tech Stack:** TypeScript, `node:sqlite` (already used by `server/db/store.ts`), vitest.

**Why the freshness gate:** seeding stale bars/samples and then appending a live tick would create a huge spurious rolling-return / bar-seam jump → false alert. So we seed only when the collector's latest data is within 2 minutes of now (i.e. the collector is currently running and contiguous).

---

### Task 1: feedBars seed functions

**Files:** Modify `server/feedBars.ts`; Test `server/feedBars.test.ts`

- [ ] **Step 1: Append tests** to `server/feedBars.test.ts` (it already imports from `./feedBars.js`, has `beforeEach(_reset)` and `const M = 60_000`):

```typescript
import { seedBars, seedSamples } from './feedBars.js';

describe('seedBars / seedSamples (DB warmup)', () => {
  it('seedBars fills closed bars + an in-progress bar from the last, and reports ready', () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({ t: i * M, close: 67000 + i }));
    seedBars('NIY=F', bars);
    const out = getRealtimeBars('NIY=F');
    expect(out).toHaveLength(70);
    expect(out[0]).toEqual({ t: 0, close: 67000 });
    expect(out[69]).toEqual({ t: 69 * M, close: 67069 });
    expect(isRealtimeBarsReady('NIY=F')).toBe(true);
  });

  it('seedBars does nothing on empty input or if the series already has data', () => {
    seedBars('NIY=F', []);
    expect(getRealtimeBars('NIY=F')).toEqual([]);
    feedRealtimePrice('NIY=F', 67000, 10 * M);            // now has live data
    seedBars('NIY=F', [{ t: 0, close: 99999 }]);          // must NOT overwrite
    expect(getRealtimeBars('NIY=F').some(b => b.close === 99999)).toBe(false);
  });

  it('after seedBars, a live tick in a new minute appends (no duplicate of the last seeded minute)', () => {
    seedBars('NIY=F', [{ t: 10 * M, close: 67000 }, { t: 11 * M, close: 67010 }]);
    feedRealtimePrice('NIY=F', 67050, 12 * M);
    const out = getRealtimeBars('NIY=F');
    expect(out.map(b => b.t)).toEqual([10 * M, 11 * M, 12 * M]);
  });

  it('seedSamples enables getRollingReturn; does nothing if samples already exist', () => {
    seedSamples('NIY=F', [{ t: 0, price: 67000 }, { t: 61_000, price: 67067 }]);
    expect(getRollingReturn(60_000, 'NIY=F')).toBeCloseTo((67067 - 67000) / 67000, 6);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run server/feedBars.test.ts` → FAIL (`seedBars`/`seedSamples` not exported).

- [ ] **Step 3: Implement in `server/feedBars.ts`.** The module has `const series = new Map<string, Series>()` where `interface Series { closed: Bar[]; curMinute: number; curBar: Bar | null }`, `const samples = new Map<string, Sample[]>()` where `interface Sample { t: number; price: number }`, and `const MAX_BARS`. Add:

```typescript
/** DB ウォームアップ用。1分足を closed[] に、最後の足を進行中(curBar)として種付け。
 *  既にライブデータがある銘柄は上書きしない。 */
export function seedBars(symbol: string, bars: Bar[]): void {
  if (bars.length === 0) return;
  const existing = series.get(symbol);
  if (existing && (existing.closed.length > 0 || existing.curBar)) return;
  const trimmed = bars.slice(-MAX_BARS);
  const last = trimmed[trimmed.length - 1]!;
  series.set(symbol, {
    closed: trimmed.slice(0, -1).map(b => ({ t: b.t, close: b.close })),
    curMinute: Math.floor(last.t / 60_000),
    curBar: { t: last.t, close: last.close },
  });
}

/** DB ウォームアップ用。生サンプル(ローリング窓用)を種付け。既存があれば上書きしない。 */
export function seedSamples(symbol: string, seeded: Sample[]): void {
  if (seeded.length === 0) return;
  if ((samples.get(symbol)?.length ?? 0) > 0) return;
  samples.set(symbol, seeded.map(s => ({ t: s.t, price: s.price })).slice(-1000));
}
```

- [ ] **Step 4: Run** `npx vitest run server/feedBars.test.ts` → PASS. Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit** `git add server/feedBars.ts server/feedBars.test.ts` → `git commit -m "feat(feedBars): seedBars/seedSamples for DB warmup\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 2: tickDetector seedBuffer

**Files:** Modify `server/tickDetector.ts`; Test `server/tickDetector.test.ts`

- [ ] **Step 1: Append test** to `server/tickDetector.test.ts` (it has `_reset`, `getMomentum`, `px()` helper, `import ... from './tickDetector.js'`):

```typescript
import { seedBuffer } from './tickDetector.js';

describe('seedBuffer (DB warmup)', () => {
  it('seeds the tick buffer so getMomentum has history immediately; no overwrite if data exists', () => {
    seedBuffer('NIY=F', [{ t: 0, price: 67000 }, { t: 10_000, price: 67040 }]);
    const m = getMomentum('NIY=F')!;
    expect(m.ultraShortYen).toBe(40);   // 10秒窓: 67040-67000
    // 既存があれば上書きしない
    seedBuffer('NIY=F', [{ t: 0, price: 1 }]);
    expect(getMomentum('NIY=F')!.ultraShortYen).toBe(40);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run server/tickDetector.test.ts` → FAIL.

- [ ] **Step 3: Implement in `server/tickDetector.ts`.** The module has `const buffers = new Map<string, Tick[]>()` where `interface Tick { t: number; price: number }`. Add:

```typescript
/** DB ウォームアップ用。NIY=F の tick バッファを種付け。既存があれば上書きしない。 */
export function seedBuffer(symbol: string, ticks: Tick[]): void {
  if (ticks.length === 0) return;
  if ((buffers.get(symbol)?.length ?? 0) > 0) return;
  buffers.set(symbol, ticks.map(t => ({ t: t.t, price: t.price })));
}
```

- [ ] **Step 4: Run** `npx vitest run server/tickDetector.test.ts` → PASS. Typecheck clean.

- [ ] **Step 5: Commit** `git add server/tickDetector.ts server/tickDetector.test.ts` → `git commit -m "feat(tickDetector): seedBuffer for DB warmup\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 3: warmFromDb (freshness gate + seeding)

**Files:** Create `server/warmup.ts`; Test `server/warmup.test.ts`

- [ ] **Step 1: Create `server/warmup.test.ts`** (TDD the freshness gate via a pure helper, using a `:memory:` DB):

```typescript
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, recordTick } from './db/store.js';
import { selectWarmup } from './warmup.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
const M = 60_000;

describe('selectWarmup', () => {
  it('returns null when DB has no NIY=F ticks', () => {
    expect(selectWarmup(memDb(), 100 * M)).toBeNull();
  });

  it('returns null when latest NIY=F tick is older than 2 minutes (stale collector)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 100 * M, 67000);
    expect(selectWarmup(db, 100 * M + 3 * M)).toBeNull();   // 3 min later → stale
  });

  it('returns bars(by symbol) + NIY=F ticks when latest tick is fresh (<2 min)', () => {
    const db = memDb();
    for (let i = 0; i < 65; i++) recordTick(db, 'NIY=F', (100 + i) * M, 67000 + i);
    recordTick(db, 'NQ=F', 164 * M, 30000);
    const now = 165 * M;   // latest NIY=F tick at 164*M → 1 min old → fresh
    const w = selectWarmup(db, now)!;
    expect(w).not.toBeNull();
    expect(w.barsBySymbol.get('NIY=F')!.length).toBeGreaterThanOrEqual(60);
    expect(w.niyTicks.length).toBeGreaterThan(0);
    expect(w.barsBySymbol.get('NQ=F')!.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run server/warmup.test.ts` → FAIL.

- [ ] **Step 3: Create `server/warmup.ts`:**

```typescript
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getRecentBars, getRecentTicks, getLatestTick } from './db/store.js';
import type { Bar } from './correlation.js';
import { INSTRUMENTS } from './config.js';
import { seedBars, seedSamples } from './feedBars.js';
import { seedBuffer } from './tickDetector.js';

const FRESH_MS = 2 * 60_000;       // 収集が現在進行中とみなす許容遅れ
const BARS_LOOKBACK_MS = 8 * 60 * 60_000;   // 8時間ぶんの1分足を種付け
const TICKS_LOOKBACK_MS = 6 * 60_000;       // 6分ぶんの生tick

export interface WarmupData {
  barsBySymbol: Map<string, Bar[]>;   // close 化済み
  niyTicks: { t: number; price: number }[];
}

/** DB から種付けデータを選ぶ純粋関数。収集が stale(最新NIY tickが2分超古い)なら null。 */
export function selectWarmup(db: DatabaseSync, now: number): WarmupData | null {
  const latest = getLatestTick(db, 'NIY=F');
  if (!latest || now - latest.t > FRESH_MS) return null;
  const barsBySymbol = new Map<string, Bar[]>();
  for (const inst of INSTRUMENTS) {
    const sym = inst.symbol as string;
    const bars = getRecentBars(db, sym, now - BARS_LOOKBACK_MS).map(b => ({ t: b.t, close: b.c }));
    if (bars.length > 0) barsBySymbol.set(sym, bars);
  }
  const niyTicks = getRecentTicks(db, 'NIY=F', now - TICKS_LOOKBACK_MS).map(t => ({ t: t.t, price: t.price }));
  return { barsBySymbol, niyTicks };
}

/** 起動時に呼ぶ。DB が現在進行中なら feedBars / tickDetector を種付け。stale/不在なら no-op。 */
export function warmFromDb(): void {
  let db: DatabaseSync;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[warmup] open db failed:', err instanceof Error ? err.message : err); return; }
  try {
    const w = selectWarmup(db, Date.now());
    if (!w) { console.log('[warmup] collector data not current — skipping (fresh warmup)'); return; }
    for (const [sym, bars] of w.barsBySymbol) seedBars(sym, bars);
    if (w.niyTicks.length > 0) { seedSamples('NIY=F', w.niyTicks); seedBuffer('NIY=F', w.niyTicks); }
    console.log(`[warmup] seeded from DB: ${w.barsBySymbol.size} symbols, ${w.niyTicks.length} NIY ticks`);
  } catch (err) {
    console.warn('[warmup] failed:', err instanceof Error ? err.message : err);
  } finally {
    db.close();
  }
}
```

- [ ] **Step 4: Run** `npx vitest run server/warmup.test.ts` → PASS (3). Typecheck clean. Full suite `npx vitest run` → all pass.

- [ ] **Step 5: Commit** `git add server/warmup.ts server/warmup.test.ts` → `git commit -m "feat(warmup): warmFromDb — seed feedBars/tickDetector from collector DB (fresh-only)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 4: Wire warmFromDb into server startup

**Files:** Modify `server/index.ts`

- [ ] **Step 1: Add import** near the other loop imports: `import { warmFromDb } from './warmup.js';`

- [ ] **Step 2: Call it first** inside the `app.listen` callback, before `startPriceLoop()`:

```typescript
const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  warmFromDb();          // v0.3.37: 収集デーモンの DB から即ウォームアップ (現在進行中なら)
  startPriceLoop();
  startNewsLoop();
  startCorrelationLoop();
  startAlertLoop();
});
```

- [ ] **Step 3: Verify** `npm run typecheck` clean; `npx vitest run` all pass. (No new test — startup wiring; warmFromDb is unit-tested via selectWarmup.)

- [ ] **Step 4: Commit** `git add server/index.ts` → `git commit -m "feat(server): warm up feedBars/tickDetector from collector DB on startup\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

---

### Task 5: Full gate

- [ ] `npm run typecheck && npx vitest run` → typecheck clean, all green. Commit any fixes.

## Out of scope (Plan 3)
- Monitor reading LIVE prices from the DB (single-poller); collector-offline status dot; ON/OFF toggle pausing heavy processing. (This plan keeps the monitor self-feeding live; DB is used only for startup warmup.)
- Version bump + signed monitor release happens after Plan 3 (or as a small "warmup" release if desired).
