# Collector Standalone Alert Recording — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 24/7 collector daemon detect and record alerts to the shared SQLite `alerts` table on its own, so alert history is captured even when the monitor (Tauri) app is closed.

**Architecture:** Single-writer arbitration. The collector becomes the authoritative alert *recorder*: it feeds its 2s price poll into the existing `feedBars` realtime builder, runs the **same** detection logic as the monitor via a new sink-based `alertEngine`, and writes to `alerts` (DB only, no SSE). The monitor keeps detecting for instant SSE/UI feedback but **defers DB writes while the collector is alive** (detected via a heartbeat in the `meta` table). When the collector is not running, the monitor falls back to writing itself. A near-duplicate guard on insert is the belt-and-suspenders second line of defense. Detection modules already exist and are pure/singleton (`alertDetector`, `feedBars`, `alertCooldown`, `granville`); the `alerts` table, `insertAlert`, follow-up (`ret5/15/30`), and `/api/alerts/history` already exist. This plan adds the missing piece: the collector driving detection.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:sqlite` (DatabaseSync, WAL), Vitest. Two processes share one DB file (`%APPDATA%/jp225-monitor/jp225.db`).

**Process model reminder:** monitor and collector are **separate OS processes**. Node module singletons (`feedBars`, `alertCooldown`) are **per-process** — the collector maintains its own in-memory bars/cooldown, fully independent of the monitor. The only shared state is the SQLite file.

---

## File Structure

**New files:**
- `server/alertEngine.ts` — sink-based, headless detection (extracted from `alertLoop.ts`). Pure of any I/O except reading the per-process `feedBars`/`alertCooldown` singletons. Both monitor and collector import this.
- `server/alertEngine.test.ts` — engine unit tests.
- `server/collectorHeartbeat.ts` — `writeHeartbeat(db)` / `isCollectorAlive(db, now)` over the `meta` table.
- `server/collectorHeartbeat.test.ts` — heartbeat tests.
- `collector/alertCollector.ts` — collector-side driver: seed from DB, feed ticks, run engine on each poll + each minute, DB-only sink, follow-up scheduling.
- `collector/alertCollector.test.ts` — collector driver integration test.

**Modified files:**
- `server/alertLoop.ts` — delegate `evaluateAndFire` (NIY branch) and `evaluateRealtime` to `alertEngine`, passing `emitAlert` as the sink. No behavior change.
- `server/alertHistory.ts` — `emitAlert` skips the DB insert when `isCollectorAlive` (still broadcasts). Export a DB-only `recordAlert` already exists; reuse it.
- `server/db/store.ts` — add `insertAlertIfNew(db, a, dedupWindowMs)` (near-duplicate guard) and `countRecentAlerts` helper used by it.
- `collector/index.ts` — wire `alertCollector`, write heartbeat each loop iteration, bump `COLLECTOR_VERSION`.

**Key existing functions to reuse (do NOT reimplement):**
- `server/alertHistory.ts` → `recordAlert(db, payload: AlertEventPayload, price)` (DB-only insert), `followupTick(db, now)` (DB-only ret fill).
- `server/db/store.ts` → `getLatestTick`, `getRecentBars`, `getMeta`, `setMeta`, `insertAlert`.
- `server/feedBars.ts` → `feedRealtimePrice`, `getRealtimeBars`, `isRealtimeBarsReady`, `seedBars`, `seedSamples`, `getRollingReturn`.
- `server/alertDetector.ts` → `detectBurst`, `detectTrend`, `computeContext`, `returns`, `returns5m`, `stdDev`, `DEFAULT_PARAMS`.
- `server/granville.ts` → `detectGranvilleReversal`, `detectGranvilleContinuation`.
- `server/alertCooldown.ts` → `canFire`, `markFired`, `setCooldownMs`.
- `server/config.ts` → `INSTRUMENTS` (`{ symbol, labelJa, ... }`).
- `server/configStore.ts` → `resolveCooldownMin()`.

**Type note:** `AlertEvent` (in `alertDetector.ts`) is structurally the SSE `AlertEventPayload` (in `types.ts:41`); the current `alertLoop` already passes `AlertEvent` objects to `emitAlert(p: AlertEventPayload)`. The engine sink type is `(e: AlertEventPayload) => void`.

---

## Task 1: Extract sink-based detection engine (`alertEngine.ts`)

Move the NIY-specific detection bodies out of `alertLoop.ts` into a reusable engine that takes a `sink` callback instead of calling `emitAlert` directly. The monitor wires `sink = emitAlert`; the collector will wire a DB-only sink in Task 4. **Behavior must be identical** — existing tests + the full suite must still pass.

**Files:**
- Create: `server/alertEngine.ts`
- Create: `server/alertEngine.test.ts`
- Modify: `server/loops/alertLoop.ts`

- [ ] **Step 1: Write the failing test** — `server/alertEngine.test.ts`

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { evaluateBarsNiy } from './alertEngine.js';
import { DEFAULT_PARAMS } from './alertDetector.js';
import { INSTRUMENTS } from './config.js';
import { _reset as resetCooldown } from './alertCooldown.js';
import type { Bar } from './correlation.js';
import type { AlertEventPayload } from './types.js';

const META = INSTRUMENTS.find(i => i.symbol === 'NIY=F')!;

// 60 quiet bars then a sharp jump → burst should fire via the sink exactly once.
function quietThenJump(): Bar[] {
  const bars: Bar[] = [];
  let price = 30000;
  for (let i = 0; i < 64; i++) { price += (i % 2 === 0 ? 1 : -1); bars.push({ t: i * 60_000, close: price }); }
  bars.push({ t: 64 * 60_000, close: price + 120 });   // ~0.4% jump
  return bars;
}

describe('evaluateBarsNiy', () => {
  beforeEach(() => resetCooldown());

  it('fires a burst alert through the sink on a quiet-then-jump series', () => {
    const fired: AlertEventPayload[] = [];
    const now = 65 * 60_000;
    evaluateBarsNiy(quietThenJump(), META, DEFAULT_PARAMS, now, (e) => fired.push(e));
    expect(fired.length).toBe(1);
    expect(fired[0]!.symbol).toBe('NIY=F');
    expect(fired[0]!.direction).toBe('up');
    expect(fired[0]!.detectionKind === 'slope' || fired[0]!.detectionKind === 'magnitude').toBe(true);
  });

  it('does not fire on a flat series', () => {
    const flat: Bar[] = Array.from({ length: 70 }, (_, i) => ({ t: i * 60_000, close: 30000 }));
    const fired: AlertEventPayload[] = [];
    evaluateBarsNiy(flat, META, DEFAULT_PARAMS, 70 * 60_000, (e) => fired.push(e));
    expect(fired.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/alertEngine.test.ts`
Expected: FAIL — `evaluateBarsNiy` is not exported / module missing.

- [ ] **Step 3: Create `server/alertEngine.ts`** — move the logic verbatim from `alertLoop.ts`, swapping `emitAlert(...)` → `sink(...)`. Read `server/loops/alertLoop.ts` lines 49–201 first and preserve the exact detection conditions, labels, and cooldown calls.

```ts
import type { Bar } from './correlation.js';
import {
  detectBurst, detectTrend, computeContext, returns, returns5m, stdDev,
  type DetectorParams, type AlertEvent,
} from './alertDetector.js';
import { detectGranvilleReversal, detectGranvilleContinuation } from './granville.js';
import { canFire, markFired } from './alertCooldown.js';
import { getRollingReturn } from './feedBars.js';
import type { InstrumentMeta } from './config.js';
import type { AlertEventPayload } from './types.js';

export type AlertSink = (e: AlertEventPayload) => void;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

/** Bar-confirmed detection for NIY=F: Granville (reversal/continuation) first, then burst(1m)/trend(5m).
 *  Mirrors alertLoop.evaluateAndFire's NIY branch exactly, but routes events to `sink`. */
export function evaluateBarsNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  if (!bars || bars.length < 65) return;
  const sym = 'NIY=F';

  // Granville (MA(75)) — evaluated first; if it fires, the shared cooldown suppresses same-dir burst/trend.
  const closes = bars.map(b => b.close);
  const rev = detectGranvilleReversal(closes);
  const cont = detectGranvilleContinuation(closes);
  const g = rev
    ? { sig: rev, note: `グランビル${rev.dir === 'up' ? '買い' : '売り'}転換` }
    : cont
      ? { sig: cont, note: cont.dir === 'up' ? 'グランビル押し目買い' : 'グランビル戻り売り' }
      : null;
  const gPrice = bars[bars.length - 1]!.close;
  if (g && canFire(sym, g.sig.dir, gPrice, now)) {
    const ctx = computeContext(bars);
    markFired(sym, g.sig.dir, gPrice, now);
    sink({
      symbol: sym, symbolLabel: meta.labelJa, changePercent: g.sig.deviation,
      windowSeconds: 75 * 60, detectionKind: 'granville', direction: g.sig.dir,
      triggeredAt: bars[bars.length - 1]!.t, change15min: ctx.change15min,
      pa15min: ctx.pa15min, range1h: ctx.range1h, zscore: 0, note: g.note,
    });
  }

  const burst = detectBurst(bars, params);
  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;
  if (burst) result = { ...burst, kind: 'slope', windowSec: 60 };
  else {
    const trend = detectTrend(bars, params);
    if (trend) result = { ...trend, kind: 'magnitude', windowSec: 300 };
  }
  if (!result) return;

  const dir = result.latestRet >= 0 ? 'up' : 'down';
  const curPrice = bars[bars.length - 1]!.close;
  if (!canFire(sym, dir, curPrice, now)) return;

  const { pa15min, change15min, range1h } = computeContext(bars);
  const alert: AlertEvent = {
    symbol: sym, symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
    changePercent: result.latestRet * 100, windowSeconds: result.windowSec,
    detectionKind: result.kind, direction: dir, triggeredAt: bars[bars.length - 1]!.t,
    change15min, pa15min, range1h, zscore: result.z,
  };
  markFired(sym, dir, curPrice, now);
  sink(alert);
}

/** Realtime (sub-minute) detection for NIY=F. Uses the per-process feedBars rolling buffers.
 *  Mirrors alertLoop.evaluateRealtime exactly, but routes events to `sink`. */
export function evaluateRealtimeNiy(
  bars: Bar[], meta: InstrumentMeta, params: DetectorParams, now: number, sink: AlertSink,
): void {
  const sym = 'NIY=F';
  if (bars.length < params.baselineLookback + 1) return;
  const baselineReturns = returns(bars.slice(-(params.baselineLookback + 1), -1));
  if (baselineReturns.length < 10) return;
  const sigma1 = stdDev(baselineReturns);
  if (sigma1 <= 0) return;

  let result: { z: number; latestRet: number; kind: 'slope' | 'magnitude'; windowSec: number } | null = null;

  const ret60 = getRollingReturn(60_000, sym);
  if (ret60 !== null) {
    const z = Math.abs(ret60) / sigma1;
    const recent = baselineReturns.slice(-params.quietLookback);
    const quietOk = recent.length >= params.quietLookback
      && median(recent.map(Math.abs)) < sigma1 * params.quietMedianRatio;
    if (z >= params.zThreshold && quietOk) result = { z, latestRet: ret60, kind: 'slope', windowSec: 60 };
  }
  if (!result) {
    const r5 = returns5m(bars);
    const ret300 = getRollingReturn(300_000, sym);
    if (r5.length >= 11 && ret300 !== null) {
      const sigma5 = stdDev(r5.slice(0, -1));
      const z = sigma5 > 0 ? Math.abs(ret300) / sigma5 : 0;
      if (sigma5 > 0 && z >= params.zThreshold) result = { z, latestRet: ret300, kind: 'magnitude', windowSec: 300 };
    }
  }
  if (!result) return;

  const dir = result.latestRet >= 0 ? 'up' : 'down';
  const curPrice = bars[bars.length - 1]!.close;
  if (!canFire(sym, dir, curPrice, now)) return;

  const { pa15min, change15min, range1h } = computeContext(bars);
  markFired(sym, dir, curPrice, now);
  sink({
    symbol: sym, symbolLabel: meta.labelJa + (result.windowSec === 60 ? ' (短期1分)' : ' (長期5分)'),
    changePercent: result.latestRet * 100, windowSeconds: result.windowSec,
    detectionKind: result.kind, direction: dir, triggeredAt: now,
    change15min, pa15min, range1h, zscore: result.z,
  });
}
```

> If `InstrumentMeta` is not exported from `config.ts`, add `export` to its declaration in that file (verify by reading `server/config.ts`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/alertEngine.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `server/loops/alertLoop.ts` to delegate to the engine.** In `evaluateAndFire`, replace the NIY-specific body (the Granville block + burst/trend block) with a single call `evaluateBarsNiy(bars, meta, DEFAULT_PARAMS, now, emitAlert)`. Keep the loop over `SYMBOLS`, the `if (sym !== 'NIY=F') continue;`, and the `bars.length < 65` guard. Replace the entire body of `evaluateRealtime` with: build the same `bars`/`meta` it already computes, then `evaluateRealtimeNiy(bars, meta, DEFAULT_PARAMS, Date.now(), emitAlert)`. Remove now-unused imports (`detectBurst`, `detectTrend`, `granville`, `returns*`, `stdDev`, `getRollingReturn`, `canFire`, `markFired`) from `alertLoop.ts` if no longer referenced; keep `barsFor`, `refreshAllBars`, the timer/scheduler, `getCachedBars`, and the `console.log` lines (move the logs into the engine OR keep a thin log in the loop — preserve at least one informative log per fire path; simplest: keep the engine silent and add `console.log` in `alertLoop` is not possible post-delegation, so move the two `console.log` fire lines into the engine right before each `sink(...)`).

  Concretely add to `alertEngine.ts` before the burst/trend `sink(alert)`:
  `console.log(\`[alertEngine] \${sym} \${alert.detectionKind} \${dir} \${alert.changePercent.toFixed(3)}% (|z|=\${result.z.toFixed(2)})\`);`
  and before the Granville `sink(...)`:
  `console.log(\`[alertEngine] \${sym} \${g.note} dev=\${g.sig.deviation.toFixed(2)}%\`);`

- [ ] **Step 6: Run the full suite to verify no regression**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all tests PASS (≥163), tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add server/alertEngine.ts server/alertEngine.test.ts server/loops/alertLoop.ts server/config.ts
git commit -m "refactor(alerts): extract sink-based detection engine (alertEngine)"
```

---

## Task 2: Collector heartbeat + monitor write-deferral

The collector stamps a heartbeat; the monitor reads it and skips DB persistence while the collector is alive (still broadcasts to the UI).

**Files:**
- Create: `server/collectorHeartbeat.ts`
- Create: `server/collectorHeartbeat.test.ts`
- Modify: `server/alertHistory.ts`

- [ ] **Step 1: Write the failing test** — `server/collectorHeartbeat.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db/store.js';
import { writeHeartbeat, isCollectorAlive, HEARTBEAT_FRESH_MS } from './collectorHeartbeat.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('collectorHeartbeat', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('reports dead when no heartbeat written', () => {
    expect(isCollectorAlive(db, 1_000_000)).toBe(false);
  });

  it('reports alive within the freshness window', () => {
    writeHeartbeat(db, 1_000_000);
    expect(isCollectorAlive(db, 1_000_000 + HEARTBEAT_FRESH_MS - 1)).toBe(true);
  });

  it('reports dead once the heartbeat is stale', () => {
    writeHeartbeat(db, 1_000_000);
    expect(isCollectorAlive(db, 1_000_000 + HEARTBEAT_FRESH_MS + 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/collectorHeartbeat.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `server/collectorHeartbeat.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './db/store.js';

const HEARTBEAT_KEY = 'collector_heartbeat';
// Collector polls every 2s (and stamps every loop incl. idle 30s). Allow >1 idle cycle of slack.
export const HEARTBEAT_FRESH_MS = 45_000;

export function writeHeartbeat(db: DatabaseSync, now: number = Date.now()): void {
  setMeta(db, HEARTBEAT_KEY, String(now));
}

export function isCollectorAlive(db: DatabaseSync, now: number = Date.now()): boolean {
  const raw = getMeta(db, HEARTBEAT_KEY);
  if (!raw) return false;
  const ts = Number(raw);
  return Number.isFinite(ts) && now - ts < HEARTBEAT_FRESH_MS && now - ts >= -HEARTBEAT_FRESH_MS;
}
```

> Note: the collector idles at 30s outside market hours, so `HEARTBEAT_FRESH_MS` must exceed 30s. 45s gives one idle cycle of slack. The `>= -HEARTBEAT_FRESH_MS` guard tolerates small clock skew where the heartbeat appears slightly in the future.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/collectorHeartbeat.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Modify `server/alertHistory.ts` `emitAlert` to defer when collector alive.** Replace the body of `emitAlert` so it always broadcasts, then only persists when the collector is NOT alive:

```ts
export function emitAlert(p: AlertEventPayload): void {
  broadcast({ type: 'alert', payload: p });
  try {
    if (!db) db = openDb(resolveDbPath());
    if (isCollectorAlive(db, Date.now())) return;   // collector is the authoritative writer
    const latest = getLatestTick(db, p.symbol);
    const price = latest ? latest.price : (p.pa15min ? p.pa15min.current : 0);
    if (price > 0) recordAlert(db, p, price);
  } catch (err) {
    console.warn('[alertHistory] record failed:', err instanceof Error ? err.message : err);
  }
}
```

Add the import at the top of `alertHistory.ts`: `import { isCollectorAlive } from './collectorHeartbeat.js';`

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS, tsc exit 0. (No heartbeat is ever written in monitor tests, so `isCollectorAlive` is always false there → existing emitAlert behavior unchanged.)

- [ ] **Step 7: Commit**

```bash
git add server/collectorHeartbeat.ts server/collectorHeartbeat.test.ts server/alertHistory.ts
git commit -m "feat(alerts): collector heartbeat + monitor write-deferral"
```

---

## Task 3: Near-duplicate insert guard (`insertAlertIfNew`)

Second line of defense so a brief overlap (both processes alive, or monitor running just as the collector starts) cannot create twin rows.

**Files:**
- Modify: `server/db/store.ts`
- Create test: `server/db/insertAlertIfNew.test.ts`

- [ ] **Step 1: Write the failing test** — `server/db/insertAlertIfNew.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertAlertIfNew, getRecentAlerts, type AlertInsert } from './store.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }
const base: AlertInsert = {
  symbol: 'NIY=F', triggeredAt: 1_000_000, direction: 'up', detectionKind: 'slope',
  windowSeconds: 60, changePercent: 0.4, price: 30000, sessionDate: '2026-06-02', session: 'Day',
};

describe('insertAlertIfNew', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('inserts when no recent duplicate', () => {
    expect(insertAlertIfNew(db, base, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('suppresses a duplicate within the window (same symbol/dir/kind/window)', () => {
    insertAlertIfNew(db, base, 120_000);
    const dup = { ...base, triggeredAt: base.triggeredAt + 90_000 };
    expect(insertAlertIfNew(db, dup, 120_000)).toBe(false);
    expect(getRecentAlerts(db, 10).length).toBe(1);
  });

  it('allows a distinct direction within the window', () => {
    insertAlertIfNew(db, base, 120_000);
    const opp = { ...base, direction: 'down', triggeredAt: base.triggeredAt + 30_000 };
    expect(insertAlertIfNew(db, opp, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });

  it('allows the same alert again after the window elapses', () => {
    insertAlertIfNew(db, base, 120_000);
    const later = { ...base, triggeredAt: base.triggeredAt + 200_000 };
    expect(insertAlertIfNew(db, later, 120_000)).toBe(true);
    expect(getRecentAlerts(db, 10).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/db/insertAlertIfNew.test.ts`
Expected: FAIL — `insertAlertIfNew` not exported.

- [ ] **Step 3: Add `insertAlertIfNew` to `server/db/store.ts`** (place directly after `insertAlert`)

```ts
/** Insert an alert only if no row with the same symbol+direction+detection_kind+window_seconds
 *  exists within [triggeredAt - dedupWindowMs, triggeredAt + dedupWindowMs]. Cross-process
 *  near-duplicate guard (monitor + collector overlap). Returns true if inserted. */
export function insertAlertIfNew(db: DatabaseSync, a: AlertInsert, dedupWindowMs: number): boolean {
  const dup = db.prepare(`
    SELECT 1 FROM alerts
    WHERE symbol = ? AND direction = ? AND detection_kind = ?
      AND (window_seconds IS ? OR window_seconds = ?)
      AND triggered_at >= ? AND triggered_at <= ?
    LIMIT 1
  `).get(
    a.symbol, a.direction, a.detectionKind,
    a.windowSeconds, a.windowSeconds,
    a.triggeredAt - dedupWindowMs, a.triggeredAt + dedupWindowMs,
  );
  if (dup) return false;
  insertAlert(db, a);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/db/insertAlertIfNew.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/db/store.ts server/db/insertAlertIfNew.test.ts
git commit -m "feat(db): insertAlertIfNew near-duplicate guard"
```

---

## Task 4: Collector-side alert driver (`collector/alertCollector.ts`)

Drive the engine from the collector: seed bars from DB, feed each poll price into `feedBars`, run realtime detection per poll and bar detection per minute, persist via a DB-only sink using `insertAlertIfNew`, and run follow-up on a timer.

**Files:**
- Create: `collector/alertCollector.ts`
- Create: `collector/alertCollector.test.ts`

- [ ] **Step 1: Write the failing test** — `collector/alertCollector.test.ts`

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getRecentAlerts } from '../server/db/store.js';
import { _reset as resetCooldown } from '../server/alertCooldown.js';
import { _reset as resetFeed } from '../server/feedBars.js';
import { AlertCollector } from './alertCollector.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('AlertCollector', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); resetCooldown(); resetFeed(); });

  it('records a burst alert to the DB when a quiet feed jumps', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    // 64 quiet minutes (one sample per minute) then a sharp jump on the 65th.
    let price = 30000;
    for (let i = 0; i < 64; i++) {
      price += (i % 2 === 0 ? 1 : -1);
      ac.onPrice('NIY=F', price, t0 + i * 60_000);
      ac.onMinute(t0 + i * 60_000);
    }
    const jumpT = t0 + 64 * 60_000;
    ac.onPrice('NIY=F', price + 120, jumpT);   // ~0.4% jump
    ac.onMinute(jumpT);
    const rows = getRecentAlerts(db, 10);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.symbol).toBe('NIY=F');
  });

  it('ignores non-NIY symbols for firing', () => {
    const ac = new AlertCollector(db);
    const t0 = 1_700_000_000_000;
    let price = 20000;
    for (let i = 0; i < 70; i++) { price += i === 65 ? 200 : (i % 2 ? -1 : 1); ac.onPrice('NQ=F', price, t0 + i * 60_000); ac.onMinute(t0 + i * 60_000); }
    expect(getRecentAlerts(db, 10).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run collector/alertCollector.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `collector/alertCollector.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { feedRealtimePrice, getRealtimeBars, isRealtimeBarsReady, seedBars } from '../server/feedBars.js';
import { evaluateBarsNiy, evaluateRealtimeNiy, type AlertSink } from '../server/alertEngine.js';
import { DEFAULT_PARAMS } from '../server/alertDetector.js';
import { INSTRUMENTS } from '../server/config.js';
import { getRecentBars, getLatestTick, insertAlertIfNew, type AlertInsert } from '../server/db/store.js';
import { followupTick } from '../server/alertHistory.js';
import { classifySession } from './session.js';
import type { Bar } from '../server/correlation.js';
import type { AlertEventPayload } from '../server/types.js';

const NIY = 'NIY=F';
const META = INSTRUMENTS.find(i => i.symbol === NIY)!;
const BARS_SEED_LOOKBACK_MS = 8 * 60 * 60_000;
const DEDUP_WINDOW_MS = 120_000;

/** Collector-side alert driver. One per process; holds the DB handle and a DB-only sink. */
export class AlertCollector {
  private lastMinute = -1;
  constructor(private readonly db: DatabaseSync) {}

  /** DB-only sink: persist the alert with a near-duplicate guard. No SSE (collector has no UI). */
  private sink: AlertSink = (e: AlertEventPayload) => {
    const latest = getLatestTick(this.db, e.symbol);
    const price = latest ? latest.price : (e.pa15min ? e.pa15min.current : 0);
    if (!(price > 0)) return;
    const s = classifySession(e.triggeredAt);
    const row: AlertInsert = {
      symbol: e.symbol, triggeredAt: e.triggeredAt, direction: e.direction,
      detectionKind: e.detectionKind, windowSeconds: e.windowSeconds,
      changePercent: e.changePercent, price,
      sessionDate: s?.sessionDate ?? null, session: s?.session ?? null,
    };
    insertAlertIfNew(this.db, row, DEDUP_WINDOW_MS);
  };

  /** Seed realtime bars from DB so bar detection is ready immediately (not gated on tick freshness —
   *  the collector IS the source). Call once at startup after backfill. */
  seedFromDb(now: number = Date.now()): void {
    for (const inst of INSTRUMENTS) {
      const sym = inst.symbol as string;
      const bars: Bar[] = getRecentBars(this.db, sym, now - BARS_SEED_LOOKBACK_MS).map(b => ({ t: b.t, close: b.c }));
      if (bars.length > 0) seedBars(sym, bars);
    }
  }

  /** Feed one live price; build realtime bars and run sub-minute detection for NIY. */
  onPrice(symbol: string, price: number, t: number): void {
    feedRealtimePrice(symbol, price, t);
    if (symbol !== NIY) return;
    const bars = this.barsForNiy();
    evaluateRealtimeNiy(bars, META, DEFAULT_PARAMS, t, this.sink);
  }

  /** Run bar-confirmed detection at most once per minute boundary. */
  onMinute(now: number): void {
    const minute = Math.floor(now / 60_000);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    const bars = this.barsForNiy();
    evaluateBarsNiy(bars, META, DEFAULT_PARAMS, now, this.sink);
  }

  /** Fill ret5/15/30 for matured alerts (DB-only, idempotent). */
  followup(now: number = Date.now()): void {
    followupTick(this.db, now);
  }

  private barsForNiy(): Bar[] {
    return isRealtimeBarsReady(NIY)
      ? getRealtimeBars(NIY)
      : getRecentBars(this.db, NIY, Date.now() - BARS_SEED_LOOKBACK_MS).map(b => ({ t: b.t, close: b.c }));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run collector/alertCollector.test.ts`
Expected: PASS (2 tests). If the burst test does not fire, widen the jump or confirm `evaluateBarsNiy` sees ≥65 bars from `getRealtimeBars` (seeded by `onPrice` minute folding). Do NOT loosen detection thresholds — adjust the synthetic series instead.

- [ ] **Step 5: Commit**

```bash
git add collector/alertCollector.ts collector/alertCollector.test.ts
git commit -m "feat(collector): AlertCollector driver (DB-only alert recording)"
```

---

## Task 5: Wire AlertCollector into the daemon (`collector/index.ts`)

**Files:**
- Modify: `collector/index.ts`

- [ ] **Step 1: Read `collector/index.ts`** (already small). Add imports:

```ts
import { AlertCollector } from './alertCollector.js';
import { writeHeartbeat } from '../server/collectorHeartbeat.js';
import { setCooldownMs } from '../server/alertCooldown.js';
import { resolveCooldownMin } from '../server/configStore.js';
```

- [ ] **Step 2: Bump version** — change `export const COLLECTOR_VERSION = '0.4.00';` to `'0.5.00'`.

- [ ] **Step 3: After the backfill block (after `console.log('[collector] backfill done')`), set up the alert driver:**

```ts
  setCooldownMs(resolveCooldownMin() * 60_000);   // match the monitor's configured cooldown
  const alerts = new AlertCollector(db);
  alerts.seedFromDb();
  console.log('[collector] alert detection armed');
  let lastFollowup = 0;
```

- [ ] **Step 4: Inside the `while (running)` loop, drive alerts + heartbeat.** Replace the poll-window block and prune block so that, each iteration:
  - `writeHeartbeat(db, start)` is called **every** iteration (even idle), so the monitor sees the collector as alive whenever the daemon runs.
  - When in poll window and `recordFeedPrices` ran, also feed each fresh, non-stale, in-session price to `alerts.onPrice(p.symbol, p.price, p.timestamp)`, then call `alerts.onMinute(Date.now())`.
  - Every 30s call `alerts.followup(Date.now())` (gate with `lastFollowup`).

  Concretely the loop body becomes:

```ts
  while (running) {
    const start = Date.now();
    let wait = IDLE_MS;
    writeHeartbeat(db, start);
    if (inPollWindow(start)) {
      try {
        const prices = await fetchFeedPrices();
        recordFeedPrices(db, prices);
        for (const p of prices) {
          if (p.stale) continue;
          if (!classifySession(p.timestamp)) continue;
          alerts.onPrice(p.symbol, p.price, p.timestamp);
        }
        alerts.onMinute(Date.now());
      } catch (err) {
        console.error('[collector] poll error:', err instanceof Error ? err.message : err);
      }
      wait = POLL_MS;
    }
    if (start - lastFollowup > 30_000) { try { alerts.followup(start); } catch { /* ignore */ } lastFollowup = start; }
    if (Date.now() - lastPrune > 60_000) {
      pruneTicks(db, Date.now() - 3 * 24 * 60 * 60 * 1000);
      lastPrune = Date.now();
    }
    await new Promise(r => setTimeout(r, Math.max(0, wait - (Date.now() - start))));
  }
```

  Add `import { classifySession } from './session.js';` at the top of `collector/index.ts` (it is not currently imported there).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: tsc exit 0, all tests PASS.

- [ ] **Step 6: Smoke-run the collector build path** (it must compile under the collector bundler)

Run: `npm run build:collector`
Expected: exit 0, no TypeScript/bundler errors.

- [ ] **Step 7: Commit**

```bash
git add collector/index.ts
git commit -m "feat(collector): drive standalone alert recording + heartbeat (v0.5.00)"
```

---

## Task 6: End-to-end arbitration test

Prove the single-writer contract: with a fresh heartbeat present, `emitAlert` (monitor path) does NOT write; with a stale/absent heartbeat it does.

**Files:**
- Create: `server/alertArbitration.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

// broker.broadcast is a no-op sink in tests; ensure import side-effects are safe.
vi.mock('./sse/broker.js', () => ({ broadcast: () => {} }));

import { initSchema, getRecentAlerts, recordTick } from './db/store.js';
import { writeHeartbeat } from './collectorHeartbeat.js';

// NOTE: emitAlert opens its own DB via resolveDbPath(); for this test we exercise the
// arbitration helper directly to avoid coupling to the global DB path.
import { isCollectorAlive } from './collectorHeartbeat.js';

function memDb(): DatabaseSync { const db = new DatabaseSync(':memory:'); initSchema(db); return db; }

describe('single-writer arbitration', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = memDb(); });

  it('isCollectorAlive gates persistence: true when heartbeat fresh', () => {
    writeHeartbeat(db, 5_000_000);
    expect(isCollectorAlive(db, 5_000_000 + 1_000)).toBe(true);
  });

  it('isCollectorAlive false when no heartbeat → monitor would persist', () => {
    expect(isCollectorAlive(db, 5_000_000)).toBe(false);
  });
});
```

> Rationale: `emitAlert` resolves the real DB path internally, which is unsafe to exercise in unit tests. The arbitration contract is fully covered by `isCollectorAlive` (here) + the deferral branch added in Task 2 + the collector recording path in Task 4. This test documents the contract at the integration boundary.

- [ ] **Step 2: Run it**

Run: `npx vitest run server/alertArbitration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Commit**

```bash
git add server/alertArbitration.test.ts
git commit -m "test(alerts): document single-writer arbitration contract"
```

---

## Task 7: Docs + version bump + release (LEADER-DRIVEN, after evaluator sign-off)

- [ ] **Step 1:** Update `USER_GUIDE.md` / `docs/USER_GUIDE.html`: note that the collector daemon now records alert history 24/7 even when the app is closed (under the alert-history / data-collector section). Keep wording consistent with existing style.
- [ ] **Step 2:** Bump app version in `package.json` + `src-tauri/tauri.conf.json` (0.4.22 → 0.4.23). `COLLECTOR_VERSION` already bumped in Task 5.
- [ ] **Step 3:** Commit `feat`/`docs` + `chore(release): bump version to 0.4.23`. Push master.
- [ ] **Step 4:** Signed build + release per `DEVELOPMENT.md`: `npm run release:build` → `release:latest-json` → `gh release create v0.4.23 ...` with the 3 assets. Verify published `latest.json`.

---

## Risks & Decisions (Leader notes)

1. **Single-writer via heartbeat (chosen)** over DB-dedup-only or lock-file IPC. Rationale: gives one authoritative recorder (the daemon — matches user intent), keeps the live UI responsive, no fragile cross-process cooldown sharing. `insertAlertIfNew` is the safety net for the brief overlap window.
2. **Collector records both realtime + bar-confirmed alerts** (same as monitor) so recorded history is identical regardless of which process is the writer. Detection thresholds are NOT changed — this is purely about *where* detection runs.
3. **Per-process singletons are fine**: each process has its own `feedBars`/`alertCooldown`. No shared-memory coordination needed; SQLite is the only shared surface.
4. **Heartbeat freshness 45s** > collector idle 30s, so the monitor never wrongly considers a healthy idle collector dead.
5. **No new DB migration**: the `alerts` table and `meta` table already exist; heartbeat is just a `meta` row.
6. **Follow-up runs in both processes** (idempotent — only fills `ret*` where NULL, computed from the same `bars_1m`). Left in both for resilience; duplicate UPDATEs are harmless.

## Self-Review notes
- Spec coverage: collector detects (T4/T5) + records (T3/T4) + 24/7 (daemon loop T5) + no duplicates (T2 heartbeat + T3 guard) + follow-up (T4/T5). ✓
- Type consistency: `AlertSink = (e: AlertEventPayload) => void` used identically in T1/T4; `AlertInsert` fields match `store.ts`; `evaluateBarsNiy`/`evaluateRealtimeNiy` signatures identical across T1/T4. ✓
- No placeholders: all steps contain concrete code/commands. ✓
