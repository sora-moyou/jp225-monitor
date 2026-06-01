# SP2 多時間軸メド（セッションH/L＋フィボ戻し）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** SP1 で貯めた `bars_1m` をセッション単位で集計し、過去セッションの H/L を主軸にコンフルエンスとフィボナッチ戻しを加えた上値/下値メドを生成して AI チャットと UI に出す。

**Architecture:** DB クエリ（`store.ts` の `getSessionOHLC`）→ 純粋関数（`server/levels.ts` の `computeLevels`）→ 薄いループ（`levelsLoop.ts` が 60秒＋セッション境界で再計算・キャッシュ・SSE 配信）→ REST `/api/levels` ＋ SSE `levels` → UI パネル ＆ AI の technical ブロック。`computeLevels` は I/O を持たず（現在セッションを引数注入）テスト容易。

**Tech Stack:** Node + Express + `node:sqlite`（SP1基盤）、Vanilla TS フロント、vitest、SSE。依存追加なし。

**Spec:** `docs/superpowers/specs/2026-06-02-multi-timeframe-levels-design.md`

---

## File Structure

- Create `server/levels.ts` — 型定義 ＋ `computeLevels`（純粋）。レベル計算の本体。
- Create `server/levels.test.ts` — `computeLevels` 単体テスト。
- Modify `server/db/store.ts` — `getSessionOHLC` 追加。
- Modify `server/db/store.test.ts` — `getSessionOHLC` テスト追加。
- Create `server/loops/levelsLoop.ts` — 定期＋境界で再計算・キャッシュ・SSE。`getLevelsSnapshot` を export。
- Create `server/loops/levelsLoop.test.ts` — `sessionKey` 純粋ヘルパのテスト。
- Create `server/routes/levels.ts` — `GET /api/levels`。
- Modify `server/types.ts` — `SSEEvent` に `levels` を追加。
- Modify `server/index.ts` — route 登録 ＋ `startLevelsLoop()`。
- Modify `server/chatContext.ts` — `computeLevels` 結果を technical に反映。
- Modify `server/chatContext.test.ts` — レベル反映／フォールバックのテスト。
- Create `web/components/levelsPanel.ts` — パネル描画（レベル集合＋現値→距離リアルタイム）。
- Modify `web/lib/stream.ts` — `onLevels` ハンドラ追加。
- Modify `web/types.ts` — `LevelsResult` 型を再 export。
- Modify `web/main.ts` — パネル mount、onLevels／onPrices 配線。
- Modify `web/index.html` — パネルのコンテナ追加。
- Modify `web/styles.css` — パネルのスタイル。

各タスク末尾で `npm run typecheck` を通し commit する。

---

### Task 1: `getSessionOHLC`（セッション別 OHLC 集計）

**Files:**
- Modify: `server/db/store.ts`（末尾に追加）
- Test: `server/db/store.test.ts`

セッション（session_date+session）ごとに O/H/L/C と、H・L が出た bar の時刻（フィボ方向判定用）を返す。

- [ ] **Step 1: 失敗するテストを書く**

`server/db/store.test.ts` の既存 import 群に `getSessionOHLC` を加え、新しい describe を追加する。

```ts
import { openDb, initSchema, recordTick, getSessionOHLC } from './store.js';
// （既存 import に getSessionOHLC を追加。openDb は ':memory:' でも可）

describe('getSessionOHLC', () => {
  function seedBar(db: any, sd: string, ses: string, t: number, o: number, h: number, l: number, c: number) {
    db.prepare(
      'INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)'
    ).run('NIY=F', sd, ses, t, o, h, l, c);
  }

  it('セッションごとに O/H/L/C と high_t/low_t を集計し新しい順で返す', () => {
    const db = openDb(':memory:');
    // Day セッション: 3本。高値は2本目(t=200)、安値は3本目(t=300)
    seedBar(db, '2026-06-01', 'Day', 100, 67000, 67100, 66950, 67050);
    seedBar(db, '2026-06-01', 'Day', 200, 67050, 67300, 67000, 67200);
    seedBar(db, '2026-06-01', 'Day', 300, 67200, 67250, 66800, 66850);
    // Night セッション: 1本
    seedBar(db, '2026-06-01', 'Night', 400, 66850, 66900, 66700, 66750);

    const out = getSessionOHLC(db, 'NIY=F', 10);
    expect(out.length).toBe(2);
    // 新しい順: Night(min t=400) が先
    expect(out[0]).toEqual({
      sessionDate: '2026-06-01', session: 'Night',
      open: 66850, high: 66900, low: 66700, close: 66750, highT: 400, lowT: 400,
    });
    expect(out[1]).toEqual({
      sessionDate: '2026-06-01', session: 'Day',
      open: 67000, high: 67300, low: 66800, close: 66850, highT: 200, lowT: 300,
    });
    db.close();
  });

  it('limit を尊重する', () => {
    const db = openDb(':memory:');
    seedBar(db, '2026-05-30', 'Day', 100, 1, 2, 0.5, 1.5);
    seedBar(db, '2026-05-31', 'Day', 200, 1, 2, 0.5, 1.5);
    seedBar(db, '2026-06-01', 'Day', 300, 1, 2, 0.5, 1.5);
    expect(getSessionOHLC(db, 'NIY=F', 2).length).toBe(2);
    db.close();
  });
});
```

注: `openDb(':memory:')` は WAL を張るが `:memory:` でも動作する。既存テストの DB 生成パターンに合わせること（既存が `new DatabaseSync(':memory:')+initSchema` ならそれに合わせる）。

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run server/db/store.test.ts -t getSessionOHLC`
Expected: FAIL（`getSessionOHLC is not a function`）

- [ ] **Step 3: `getSessionOHLC` を実装**

`server/db/store.ts` の末尾に追加。

```ts
export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number;
}

/** セッション(session_date+session)別の OHLC と H/L 発生時刻。新しい順(直近が先)、最大 limit 件。 */
export function getSessionOHLC(db: DatabaseSync, symbol: string, limit: number): SessionOHLC[] {
  const rows = db.prepare(`
    SELECT session_date AS sessionDate, session,
           MAX(h) AS high, MIN(l) AS low,
           (SELECT o FROM bars_1m b2 WHERE b2.symbol=b.symbol AND b2.session_date=b.session_date
              AND b2.session=b.session ORDER BY t ASC  LIMIT 1) AS open,
           (SELECT c FROM bars_1m b3 WHERE b3.symbol=b.symbol AND b3.session_date=b.session_date
              AND b3.session=b.session ORDER BY t DESC LIMIT 1) AS close,
           (SELECT t FROM bars_1m b4 WHERE b4.symbol=b.symbol AND b4.session_date=b.session_date
              AND b4.session=b.session ORDER BY h DESC, t ASC LIMIT 1) AS highT,
           (SELECT t FROM bars_1m b5 WHERE b5.symbol=b.symbol AND b5.session_date=b.session_date
              AND b5.session=b.session ORDER BY l ASC,  t ASC LIMIT 1) AS lowT
    FROM bars_1m b
    WHERE symbol = ? AND session_date IS NOT NULL AND session IS NOT NULL
    GROUP BY session_date, session
    ORDER BY MIN(t) DESC
    LIMIT ?
  `).all(symbol, limit) as Array<Record<string, unknown>>;
  return rows.map(r => ({
    sessionDate: r.sessionDate as string,
    session: r.session as 'Day' | 'Night',
    open: r.open as number, high: r.high as number, low: r.low as number, close: r.close as number,
    highT: r.highT as number, lowT: r.lowT as number,
  }));
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/db/store.test.ts -t getSessionOHLC`
Expected: PASS（2 tests）

- [ ] **Step 5: typecheck ＆ commit**

```bash
npm run typecheck
git add server/db/store.ts server/db/store.test.ts
git commit -m "feat(levels): getSessionOHLC — per-session OHLC + H/L timestamps from bars_1m"
```

---

### Task 2: `levels.ts` コア（型・セッションH/L候補・コンフルエンス・近傍選抜）

**Files:**
- Create: `server/levels.ts`
- Test: `server/levels.test.ts`

フィボはまだ入れない（Task 3）。現在セッションは引数で注入し純粋に保つ。

- [ ] **Step 1: 失敗するテストを書く**

`server/levels.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeLevels, type SessionOHLC } from './levels.js';

// ヘルパ: H/L だけ効かせたいときは o/c を適当に
function s(sessionDate: string, session: 'Day' | 'Night', high: number, low: number,
           extra: Partial<SessionOHLC> = {}): SessionOHLC {
  return {
    sessionDate, session, high, low,
    open: extra.open ?? low, close: extra.close ?? high,
    highT: extra.highT ?? 0, lowT: extra.lowT ?? 0,
  };
}

describe('computeLevels コア（H/L・コンフルエンス・選抜）', () => {
  it('完了セッションの H/L を現値近傍に上下分割して返す', () => {
    // current=67000。新しい順。currentSession=null(場外=全完了扱い)。
    const sessions = [
      s('2026-06-01', 'Night', 67300, 66800),
      s('2026-06-01', 'Day',   67500, 66600),
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const upPrices = r.up.map(l => l.price);
    const downPrices = r.down.map(l => l.price);
    expect(upPrices).toContain(67300);   // 6/1夜高
    expect(upPrices).toContain(67500);   // 6/1昼高
    expect(downPrices).toContain(66800); // 6/1夜安
    expect(downPrices).toContain(66600); // 6/1昼安
    // up は現値より上のみ・近い順
    expect(r.up.every(l => l.price > 67000)).toBe(true);
    expect(r.up.map(l => l.price)).toEqual([...r.up.map(l => l.price)].sort((a, b) => a - b));
  });

  it('±30円以内で重なる H/L を強レベル(★)に束ね、ラベルを連結する', () => {
    const sessions = [
      s('2026-06-01', 'Night', 67410, 66000),  // 高値 67410
      s('2026-05-31', 'Day',   67400, 66010),  // 高値 67400 (20円差→束ねる)
    ];
    const r = computeLevels(sessions, 67000, 0, null);
    const strong = r.up.find(l => l.strong);
    expect(strong).toBeDefined();
    expect(strong!.labels.length).toBe(2);          // 2本の高値ラベル
    expect(strong!.price).toBeGreaterThanOrEqual(67400);
    expect(strong!.price).toBeLessThanOrEqual(67410);
  });

  it('進行中(当日)セッションは current で識別し、当日H/L/始値を出す', () => {
    const sessions = [
      s('2026-06-02', 'Day', 67200, 66900, { open: 67050 }),  // 進行中
      s('2026-06-01', 'Night', 67400, 66700),                  // 完了
    ];
    const cur = { sessionDate: '2026-06-02', session: 'Day' as const };
    const r = computeLevels(sessions, 67000, 0, cur);
    const labels = [...r.up, ...r.down].flatMap(l => l.labels);
    expect(labels.some(x => x.includes('当日高'))).toBe(true);
    expect(labels.some(x => x.includes('当日安'))).toBe(true);
    expect(labels.some(x => x.includes('当日始'))).toBe(true);
  });

  it('up/down は各最大4本', () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      s(`2026-05-${10 + i}`, 'Day', 67000 + (i + 1) * 100, 67000 - (i + 1) * 100));
    const r = computeLevels(sessions, 67000, 0, null);
    expect(r.up.length).toBeLessThanOrEqual(4);
    expect(r.down.length).toBeLessThanOrEqual(4);
  });

  it('履歴ゼロなら空を返す（クラッシュしない）', () => {
    const r = computeLevels([], 67000, 0, null);
    expect(r.up).toEqual([]);
    expect(r.down).toEqual([]);
    expect(r.swing).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run server/levels.test.ts`
Expected: FAIL（`Cannot find module './levels.js'`）

- [ ] **Step 3: `levels.ts` を実装（フィボ抜き）**

`server/levels.ts`:

```ts
export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number;
}
export interface Level {
  price: number;
  dist: number;             // price - current (5円丸め)
  labels: string[];
  strong: boolean;          // コンフルエンス(>=2本)
  fib?: number;             // 0.382 | 0.5 | 0.618
  reversalLine?: boolean;   // fib 50% の方向転換ライン
}
export interface LevelsResult {
  current: number;
  up: Level[];
  down: Level[];
  swing: { high: number; low: number; leg: 'up' | 'down' } | null;
  reversalSatisfied: boolean;
  asOf: number;
}

// ── 調整ノブ ──
export const LOOKBACK_SESSIONS = 10;
export const CONFLUENCE_TOL = 30;   // 円
export const GRID = 250;            // 節目グリッド
export const NEAR_N = 4;            // up/down 各表示本数

interface Cand { price: number; label: string; fib?: number; reversalLine?: boolean; }

function fmtSession(sd: string, ses: 'Day' | 'Night'): string {
  const [, m, d] = sd.split('-');   // YYYY-MM-DD
  return `${Number(m)}/${Number(d)}${ses === 'Day' ? '昼' : '夜'}`;
}
const round5 = (v: number): number => Math.round(v / 5) * 5;
function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** 価格昇順の候補を ±CONFLUENCE_TOL で束ねる。代表=中央値、strong=2本以上、fib/reversal は保持。 */
function cluster(cands: Cand[], current: number): Level[] {
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  let group: Cand[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const price = round5(median(group.map(g => g.price)));
    const labels: string[] = [];
    for (const g of group) if (!labels.includes(g.label)) labels.push(g.label);
    const fibMember = group.find(g => g.fib !== undefined);
    out.push({
      price,
      dist: round5(price - current),
      labels,
      strong: group.length >= 2,
      fib: fibMember?.fib,
      reversalLine: group.some(g => g.reversalLine) || undefined,
    });
    group = [];
  };
  for (const c of sorted) {
    if (group.length && c.price - group[group.length - 1]!.price > CONFLUENCE_TOL) flush();
    group.push(c);
  }
  flush();
  return out;
}

export function computeLevels(
  sessions: SessionOHLC[],
  current: number,
  asOf: number,
  currentSession: { sessionDate: string; session: 'Day' | 'Night' } | null,
): LevelsResult {
  const isCurrent = (s: SessionOHLC): boolean =>
    !!currentSession && s.sessionDate === currentSession.sessionDate && s.session === currentSession.session;
  const inProgress = sessions.find(isCurrent) ?? null;
  const completed = sessions.filter(s => !isCurrent(s));

  const cands: Cand[] = [];
  // 完了セッション H/L（直近 LOOKBACK_SESSIONS）
  const recent = completed.slice(0, LOOKBACK_SESSIONS);
  for (const s of recent) {
    const tag = fmtSession(s.sessionDate, s.session);
    cands.push({ price: s.high, label: `${tag}高` });
    cands.push({ price: s.low, label: `${tag}安` });
  }
  // 進行中(当日)
  if (inProgress) {
    cands.push({ price: inProgress.high, label: '当日高' });
    cands.push({ price: inProgress.low, label: '当日安' });
    cands.push({ price: inProgress.open, label: '当日始' });
  }
  // 直近 LOOKBACK の最高/最安（大きな天底）
  if (recent.length) {
    cands.push({ price: Math.max(...recent.map(s => s.high)), label: '直近高' });
    cands.push({ price: Math.min(...recent.map(s => s.low)), label: '直近安' });
  }
  // 節目グリッド（現値直近の上下1本）
  cands.push({ price: Math.ceil((current + 5) / GRID) * GRID, label: '節目' });
  cands.push({ price: Math.floor((current - 5) / GRID) * GRID, label: '節目' });

  // フィボは Task 3 で追加（ここでは swing=null）。
  const swing: LevelsResult['swing'] = null;
  const reversalSatisfied = false;

  const clustered = cluster(cands, current);
  const up = clustered.filter(l => l.dist > 0).sort((a, b) => a.dist - b.dist).slice(0, NEAR_N);
  const down = clustered.filter(l => l.dist < 0).sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist)).slice(0, NEAR_N);

  return { current, up, down, swing, reversalSatisfied, asOf };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/levels.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: typecheck ＆ commit**

```bash
npm run typecheck
git add server/levels.ts server/levels.test.ts
git commit -m "feat(levels): computeLevels core — session H/L candidates, confluence, near selection"
```

---

### Task 3: `levels.ts` フィボナッチ戻し（直近5Sスイング・38.2/50/61.8・50%転換）

**Files:**
- Modify: `server/levels.ts`
- Test: `server/levels.test.ts`（describe 追加）

- [ ] **Step 1: 失敗するテストを書く**

`server/levels.test.ts` に追加：

```ts
import { computeLevels, FIB_SWING_SESSIONS } from './levels.js';
// （既存 import 行に FIB_SWING_SESSIONS を追記）

describe('computeLevels フィボナッチ', () => {
  // 5セッションぶん。窓内 swingHigh/Low と極値の新しさで leg を決める。
  function swingSessions(opts: { highT: number; lowT: number }): SessionOHLC[] {
    // swingHigh=68000(highT), swingLow=66000(lowT)。他3本は内側。
    return [
      s('2026-06-01', 'Night', 67200, 66500, { highT: 10, lowT: 11 }),
      s('2026-05-31', 'Day',   67100, 66400, { highT: 8, lowT: 9 }),
      s('2026-05-30', 'Night', 67000, 66300, { highT: 6, lowT: 7 }),
      s('2026-05-30', 'Day',   68000, 66800, { highT: opts.highT, lowT: 5 }), // swingHigh here
      s('2026-05-29', 'Day',   67300, 66000, { highT: 3, lowT: opts.lowT }),  // swingLow here
    ];
  }

  it('下げ脚(安値が新しい): 50%戻し=swingLow+0.5*range、現値が上なら転換成立', () => {
    // lowT(20) > highT(4) → 安値が新しい → 下げ脚。range=68000-66000=2000。
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    const r = computeLevels(sessions, 67100, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'down' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);               // 66000 + 0.5*2000
    expect(r.reversalSatisfied).toBe(true);         // 67100 > 67000
  });

  it('上げ脚(高値が新しい): 50%戻し=swingHigh-0.5*range、現値が下なら転換成立', () => {
    // highT(20) > lowT(4) → 高値が新しい → 上げ脚。
    const sessions = swingSessions({ highT: 20, lowT: 4 });
    const r = computeLevels(sessions, 66800, 0, null);
    expect(r.swing).toEqual({ high: 68000, low: 66000, leg: 'up' });
    const fib50 = [...r.up, ...r.down].find(l => l.reversalLine);
    expect(fib50!.price).toBe(67000);               // 68000 - 0.5*2000
    expect(r.reversalSatisfied).toBe(true);         // 66800 < 67000
  });

  it('fib50(転換ライン)は近傍4に入らなくても必ず含める', () => {
    const sessions = swingSessions({ highT: 4, lowT: 20 });
    // current を fib50(67000) から遠ざけ、間に節目/H・L を多数置いても 50% が残るか
    const r = computeLevels(sessions, 67100, 0, null);
    expect([...r.up, ...r.down].some(l => l.reversalLine)).toBe(true);
  });

  it('セッションが5本未満ならフィボ省略（swing=null）', () => {
    const sessions = [s('2026-06-01', 'Day', 67500, 66500)];
    const r = computeLevels(sessions, 67000, 0, null);
    expect(r.swing).toBeNull();
    expect([...r.up, ...r.down].some(l => l.fib !== undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run server/levels.test.ts -t フィボナッチ`
Expected: FAIL（`r.swing` が null のまま等）

- [ ] **Step 3: フィボを実装**

`server/levels.ts` に定数を追加し、`computeLevels` 内の swing 計算を差し替える。

定数追加（ノブ群の近くに）：

```ts
export const FIB_SWING_SESSIONS = 5;
export const FIB_RATIOS = [0.382, 0.5, 0.618];
```

`computeLevels` 内の
```ts
  // フィボは Task 3 で追加（ここでは swing=null）。
  const swing: LevelsResult['swing'] = null;
  const reversalSatisfied = false;
```
を、以下に置き換える：

```ts
  // ── フィボナッチ戻し（完了セッション直近 FIB_SWING_SESSIONS のスイング）──
  let swing: LevelsResult['swing'] = null;
  let reversalSatisfied = false;
  const fibWin = completed.slice(0, FIB_SWING_SESSIONS);
  if (fibWin.length >= FIB_SWING_SESSIONS) {
    const hi = fibWin.reduce((a, b) => (b.high > a.high ? b : a));
    const lo = fibWin.reduce((a, b) => (b.low < a.low ? b : a));
    const swingHigh = hi.high, swingLow = lo.low;
    if (swingHigh > swingLow) {
      const range = swingHigh - swingLow;
      // 極値が新しい方が脚の終点。安値が新しい→下げ脚、高値が新しい→上げ脚。
      const leg: 'up' | 'down' = lo.lowT > hi.highT ? 'down' : 'up';
      swing = { high: swingHigh, low: swingLow, leg };
      for (const r of FIB_RATIOS) {
        const price = leg === 'down' ? swingLow + r * range : swingHigh - r * range;
        cands.push({
          price, label: `Fib${(r * 100).toFixed(1).replace(/\.0$/, '')}%`,
          fib: r, reversalLine: r === 0.5 || undefined,
        });
      }
      const fib50 = leg === 'down' ? swingLow + 0.5 * range : swingHigh - 0.5 * range;
      reversalSatisfied = leg === 'down' ? current > fib50 : current < fib50;
    }
  }
```

さらに、`fib50` を必ず含めるため、`up`/`down` 確定の直後に強制包含を追加する。
```ts
  const up = clustered.filter(l => l.dist > 0).sort((a, b) => a.dist - b.dist).slice(0, NEAR_N);
  const down = clustered.filter(l => l.dist < 0).sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist)).slice(0, NEAR_N);
```
の直後に：
```ts
  // fib50(方向転換ライン)が選抜から漏れたら、現値の上下どちらかへ強制追加。
  const fib50Level = clustered.find(l => l.reversalLine);
  if (fib50Level && ![...up, ...down].includes(fib50Level)) {
    if (fib50Level.dist > 0 && !up.includes(fib50Level)) up.push(fib50Level);
    else if (fib50Level.dist < 0 && !down.includes(fib50Level)) down.push(fib50Level);
  }
```

注: クラスタリングは候補配列 `cands` を読むので、フィボ候補の push は `cluster(cands, current)` 呼び出しより**前**で行うこと（上記スイング計算ブロックは `const clustered = cluster(...)` の前に置く）。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/levels.test.ts`
Expected: PASS（コア5 + フィボ4 = 9 tests）

- [ ] **Step 5: typecheck ＆ commit**

```bash
npm run typecheck
git add server/levels.ts server/levels.test.ts
git commit -m "feat(levels): Fibonacci retracement (5S swing, 38.2/50/61.8, 50% reversal line)"
```

---

### Task 4: levelsLoop ＋ `/api/levels` ＋ SSE `levels` ＋ index 配線

**Files:**
- Modify: `server/types.ts`（`SSEEvent` に levels 追加）
- Create: `server/loops/levelsLoop.ts`
- Create: `server/loops/levelsLoop.test.ts`
- Create: `server/routes/levels.ts`
- Modify: `server/index.ts`

`computeLevels` の入力（現値・現在セッション）は既存部品から得る：現値は `getRollingReturn` ではなく
`feedBars` の最新足 or `getLatestTick`、現在セッションは collector の `classifySession`。ループは DB ハンドルを
1つ開いて保持する。

- [ ] **Step 1: `SSEEvent` に levels を追加**

`server/types.ts` の `SSEEvent` を拡張（`LevelsResult` を import）：

```ts
import type { LevelsResult } from './levels.js';
// …既存…
export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] }
  | { type: 'alert'; payload: AlertEventPayload }
  | { type: 'levels'; payload: LevelsResult };
```

- [ ] **Step 2: `sessionKey` ヘルパの失敗するテストを書く**

セッション境界検知を純粋ヘルパに切り出してテストする。`server/loops/levelsLoop.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sessionKey } from './levelsLoop.js';

describe('sessionKey', () => {
  it('classifySession の結果を安定キー文字列にする', () => {
    expect(sessionKey({ sessionDate: '2026-06-01', session: 'Night' })).toBe('2026-06-01/Night');
    expect(sessionKey(null)).toBe('none');
  });
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `npx vitest run server/loops/levelsLoop.test.ts`
Expected: FAIL（モジュール無し）

- [ ] **Step 4: `levelsLoop.ts` を実装**

`server/loops/levelsLoop.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getSessionOHLC, getLatestTick } from '../db/store.js';
import { computeLevels, LOOKBACK_SESSIONS, type LevelsResult } from '../levels.js';
import { broadcast } from '../sse/broker.js';
import { classifySession } from '../../collector/session.js';

const SYMBOL = 'NIY=F';
const POLL_MS = 60_000;
const FETCH_SESSIONS = LOOKBACK_SESSIONS + 2;   // フィボ窓 + 余裕

let db: DatabaseSync | null = null;
let timer: NodeJS.Timeout | null = null;
let running = false;
let last: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
let lastSessionKey = '';

export function sessionKey(cs: { sessionDate: string; session: string } | null): string {
  return cs ? `${cs.sessionDate}/${cs.session}` : 'none';
}

function tick(): void {
  if (!db) return;
  try {
    const now = Date.now();
    const latest = getLatestTick(db, SYMBOL);
    if (!latest) { return; }                       // データ皆無: 前回(空)を保持
    const sessions = getSessionOHLC(db, SYMBOL, FETCH_SESSIONS);
    const cs = classifySession(now);               // {sessionDate,session}|null
    const result = computeLevels(sessions, latest.price, now, cs);
    last = result;
    lastSessionKey = sessionKey(cs);
    broadcast({ type: 'levels', payload: result });
  } catch (err) {
    console.warn('[levelsLoop] tick failed:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  timer = setTimeout(() => {
    // セッション境界をまたいだら即時再計算済みなので、通常間隔で回す
    tick();
    schedule();
  }, POLL_MS);
}

export function startLevelsLoop(): void {
  if (running) return;
  try { db = openDb(resolveDbPath()); }
  catch (err) { console.warn('[levelsLoop] open db failed:', err instanceof Error ? err.message : err); return; }
  running = true;
  tick();          // 起動直後に1回
  schedule();
}

export function stopLevelsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (db) { db.close(); db = null; }
}

export function getLevelsSnapshot(): LevelsResult { return last; }
```

注: `lastSessionKey` は将来のセッション境界即時再計算用に保持（POLL_MS=60s でも十分追従するため現状は記録のみ。YAGNI で即時トリガは入れない）。`classifySession` は `collector/session.ts` の純粋関数（JST 計算のみ、I/O なし）。

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run server/loops/levelsLoop.test.ts`
Expected: PASS（1 test）

- [ ] **Step 6: route を作成し index に配線**

`server/routes/levels.ts`:

```ts
import type { Request, Response } from 'express';
import { getLevelsSnapshot } from '../loops/levelsLoop.js';

export function levelsHandler(_req: Request, res: Response): void {
  res.json(getLevelsSnapshot());
}
```

`server/index.ts` に追記：
- import 群に `import { levelsHandler } from './routes/levels.js';` と
  `import { startLevelsLoop } from './loops/levelsLoop.js';`
- ルート登録（既存 `app.get('/api/correlation', correlationHandler);` の近く）に
  `app.get('/api/levels', levelsHandler);`
- ループ起動（既存 `startAlertLoop();` の近く）に `startLevelsLoop();`

- [ ] **Step 7: typecheck ＆ 全テスト ＆ commit**

```bash
npm run typecheck
npx vitest run server/
git add server/types.ts server/loops/levelsLoop.ts server/loops/levelsLoop.test.ts server/routes/levels.ts server/index.ts
git commit -m "feat(levels): levelsLoop + /api/levels + SSE levels event, wired into server"
```

---

### Task 5: UI レベルパネル（SSE 受信＋現値で距離リアルタイム）

**Files:**
- Modify: `web/types.ts`（`LevelsResult` 再 export）
- Modify: `web/lib/stream.ts`（`onLevels`）
- Create: `web/components/levelsPanel.ts`
- Modify: `web/index.html`（コンテナ）
- Modify: `web/main.ts`（mount・配線）
- Modify: `web/styles.css`

- [ ] **Step 1: 型を再 export**

`web/types.ts` 1行目の再 export に `LevelsResult` を追加し、型エイリアスを足す：

```ts
export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent, AlertEventPayload } from '../server/types.js';
export type { LevelsResult, Level } from '../server/levels.js';
```

- [ ] **Step 2: stream に onLevels を追加**

`web/lib/stream.ts`:
- import に `LevelsResult` を追加: `import type { Price, NewsItem, AlertEvent, LevelsResult } from '../types.js';`
- `StreamHandlers` に `onLevels: (levels: LevelsResult) => void;` を追加
- `es.addEventListener('alert', …)` の直後に：

```ts
    es.addEventListener('levels', (e) => {
      try { handlers.onLevels(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse levels', err); }
    });
```

- [ ] **Step 3: コンテナを HTML に追加**

`web/index.html` の左カラム、`<section id="price-grid" …></section>` の**直後**に：

```html
      <section id="levels-panel" class="levels-panel">
        <h2>主要レベル <span id="levels-meta" class="levels-meta"></span></h2>
        <div id="levels-body" class="levels-body"><div class="levels-empty">蓄積中…</div></div>
      </section>
```

- [ ] **Step 4: パネルコンポーネントを作成**

`web/components/levelsPanel.ts`:

```ts
import type { LevelsResult, Level } from '../types.js';

let bodyEl: HTMLElement | null = null;
let metaEl: HTMLElement | null = null;
let latest: LevelsResult | null = null;
let currentPrice: number | null = null;

export function initLevelsPanel(body: HTMLElement, meta: HTMLElement): void {
  bodyEl = body; metaEl = meta;
}
export function setLevels(r: LevelsResult): void { latest = r; render(); }
export function setLevelsPrice(p: number): void { currentPrice = p; render(); }

function round5(v: number): number { return Math.round(v / 5) * 5; }
function fmtPrice(v: number): string { return Math.round(v).toLocaleString('en-US'); }
function fmtDist(d: number): string { return `${d >= 0 ? '+' : ''}${d}`; }

function rowHtml(l: Level, cur: number): string {
  const dist = round5(l.price - cur);
  const cls = ['levels-row'];
  if (l.strong) cls.push('strong');
  if (l.reversalLine) cls.push('reversal');
  const star = l.strong ? '★ ' : '';
  const flag = l.reversalLine ? ' ⚑転換' : '';
  const labels = l.labels.join('・');
  return `<div class="${cls.join(' ')}">` +
    `<span class="lv-price">${star}${fmtPrice(l.price)}</span>` +
    `<span class="lv-dist">${fmtDist(dist)}</span>` +
    `<span class="lv-label">${labels}${flag}</span></div>`;
}

function render(): void {
  if (!bodyEl) return;
  const cur = currentPrice ?? latest?.current ?? null;
  if (!latest || cur === null || (latest.up.length === 0 && latest.down.length === 0)) {
    bodyEl.innerHTML = '<div class="levels-empty">蓄積中…</div>';
    if (metaEl) metaEl.textContent = '';
    return;
  }
  // up は遠い順に上から並べ、現値、down と続ける（価格降順の自然な並び）
  const up = [...latest.up].sort((a, b) => b.price - a.price);
  const down = [...latest.down].sort((a, b) => b.price - a.price);
  const curLine = `<div class="levels-cur">― 現値 ${fmtPrice(cur)} ―</div>`;
  bodyEl.innerHTML =
    up.map(l => rowHtml(l, cur)).join('') + curLine + down.map(l => rowHtml(l, cur)).join('');
  if (metaEl) {
    metaEl.textContent = latest.swing
      ? `${latest.swing.leg === 'down' ? '下げ脚' : '上げ脚'} ${latest.reversalSatisfied ? '転換目安○' : '転換目安—'}`
      : '';
  }
}
```

- [ ] **Step 5: main.ts に配線**

`web/main.ts`:
- import 追加: `import { initLevelsPanel, setLevels, setLevelsPrice } from './components/levelsPanel.js';`
- 既存の `const bannerEl = document.getElementById('alert-banner')!;` 付近で初期化：

```ts
const levelsBodyEl = document.getElementById('levels-body');
const levelsMetaEl = document.getElementById('levels-meta');
if (levelsBodyEl && levelsMetaEl) initLevelsPanel(levelsBodyEl, levelsMetaEl);
```

- `connectStream({...})` のハンドラに `onLevels` を追加し、`onPrices` 内で NIY 現値をパネルへ渡す：

```ts
  onPrices: (prices) => {
    const displayed = new Set([getAnchorSymbol(), getCurrentLeader()]);
    renderPriceGrid(priceGridEl, prices, displayed);
    const niy = prices.find(p => p.symbol === 'NIY=F');
    if (niy) setLevelsPrice(niy.price);
  },
  onLevels: (levels) => setLevels(levels),
```

（`onNews` 等、既存ハンドラはそのまま。`onLevels` を StreamHandlers の必須プロパティとして追加済みなので、ここで渡さないと型エラーになる＝付け忘れ防止。）

- [ ] **Step 6: スタイルを追加**

`web/styles.css` の `.alert .close:hover { … }` の後あたりに追記：

```css
.levels-panel { margin: 8px 0; }
.levels-panel h2 { font-size: 13px; margin: 0 0 4px; color: var(--muted); }
.levels-meta { font-size: 11px; color: var(--muted); font-weight: normal; }
.levels-body { font-variant-numeric: tabular-nums; font-size: 13px; }
.levels-row { display: flex; gap: 8px; padding: 1px 4px; }
.levels-row .lv-price { width: 72px; text-align: right; }
.levels-row .lv-dist { width: 48px; text-align: right; color: var(--muted); }
.levels-row .lv-label { color: var(--muted); font-size: 12px; }
.levels-row.strong .lv-price { font-weight: bold; color: var(--text); }
.levels-row.reversal { color: #d29922; }
.levels-row.reversal .lv-label { color: #d29922; }
.levels-cur { padding: 2px 4px; color: #58a6ff; font-size: 12px; }
.levels-empty { color: var(--muted); font-size: 12px; padding: 2px 4px; }
```

- [ ] **Step 7: ビルド確認 ＆ commit**

```bash
npm run typecheck
npm run build:web
git add web/types.ts web/lib/stream.ts web/components/levelsPanel.ts web/index.html web/main.ts web/styles.css
git commit -m "feat(levels): UI levels panel — SSE levels + live distance from price stream"
```

注: `npm run build:web` が型エラー無く通れば UI 配線は健全。実画面確認はユーザ環境で（Tauri 起動時）。

---

### Task 6: AI 統合（chatContext に上値/下値メド＋フィボ50%転換を反映）

**Files:**
- Modify: `server/chatContext.ts`
- Test: `server/chatContext.test.ts`

DB に十分なセッションがあるとき `computeLevels` の結果を technical ブロックに使う。不足時は既存ロジック維持。

- [ ] **Step 1: 失敗するテストを書く**

`server/chatContext.test.ts` に追加：

```ts
import { formatLevelsBlock } from './chatContext.js';
import type { LevelsResult } from './levels.js';

describe('formatLevelsBlock', () => {
  const base: LevelsResult = {
    current: 67100,
    up: [{ price: 67300, dist: 200, labels: ['6/1夜高'], strong: false }],
    down: [{ price: 67000, dist: -100, labels: ['Fib50%'], strong: false, fib: 0.5, reversalLine: true }],
    swing: { high: 68000, low: 66000, leg: 'down' },
    reversalSatisfied: true,
    asOf: 0,
  };

  it('上値/下値メドを価格＋ラベルで、フィボ50%の転換判定を文章で出す', () => {
    const out = formatLevelsBlock(base)!;
    expect(out).toContain('67,300');
    expect(out).toContain('6/1夜高');
    expect(out).toContain('上値メド');
    expect(out).toContain('下値メド');
    expect(out).toContain('方向転換');
    expect(out).toContain('満たす');     // reversalSatisfied=true
  });

  it('レベルが空なら null', () => {
    const empty: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
    expect(formatLevelsBlock(empty)).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `npx vitest run server/chatContext.test.ts -t formatLevelsBlock`
Expected: FAIL（`formatLevelsBlock` 未定義）

- [ ] **Step 3: `formatLevelsBlock` を実装し `buildNikkeiTechnical` から使う**

`server/chatContext.ts` の先頭 import に追加：
```ts
import { getLevelsSnapshot } from './loops/levelsLoop.js';
import type { LevelsResult, Level } from './levels.js';
```

ファイル末尾に純粋フォーマッタを追加：
```ts
/** computeLevels の結果を AI 向けテキストに。空なら null。 */
export function formatLevelsBlock(r: LevelsResult): string | null {
  if (r.up.length === 0 && r.down.length === 0) return null;
  const fp = (v: number): string => Math.round(v).toLocaleString('en-US');
  const one = (l: Level): string => {
    const star = l.strong ? '(強)' : '';
    const flag = l.reversalLine ? '【方向転換ライン】' : '';
    return `${fp(l.price)}円${star}(${l.labels.join('・')}${flag})`;
  };
  const lines: string[] = [];
  if (r.up.length) lines.push(`上値メド: ${r.up.map(one).join(' / ')}`);
  if (r.down.length) lines.push(`下値メド: ${r.down.map(one).join(' / ')}`);
  if (r.swing) {
    const leg = r.swing.leg === 'down' ? '下げ脚' : '上げ脚';
    const fib50 = r.swing.leg === 'down'
      ? r.swing.low + 0.5 * (r.swing.high - r.swing.low)
      : r.swing.high - 0.5 * (r.swing.high - r.swing.low);
    const side = r.swing.leg === 'down'
      ? (r.reversalSatisfied ? '上回り、上方向への転換目安を満たす' : '下回り、転換目安は未達')
      : (r.reversalSatisfied ? '下回り、下方向への転換目安を満たす' : '上回り、転換目安は未達');
    lines.push(`フィボ戻し(${leg}, スイング ${fp(r.swing.high)}→${fp(r.swing.low)}): 50%=${fp(fib50)}円。現値はこれを${side}`);
  }
  return lines.join('\n');
}
```

`buildNikkeiTechnical` の冒頭（`const bars = getBars(NIKKEI);` の直前）に、DB レベルがあれば優先採用するブロックを追加：
```ts
  // SP2: levelsLoop が算出した多時間軸レベルがあれば、それを上値/下値メドとして使う。
  const lv = formatLevelsBlock(getLevelsSnapshot());
  if (lv) {
    const headBars = getBars(NIKKEI);
    const cur = headBars.length ? headBars[headBars.length - 1]!.close : fallbackPrice;
    const head = cur ? `現値 ${Math.round(cur).toLocaleString('en-US')}円\n` : '';
    return `■ 日経225先物 (NIY=F) テクニカル(セッションH/L・フィボ):\n${head}${lv}`;
  }
```

注: これにより十分なレベルがある時はセッションH/L＋フィボ版を返し、無い時（新規PC/場外でレベル空）は既存の `bars.length < 62` フォールバックや 15〜60分版に自然に落ちる。既存テストは `getLevelsSnapshot` が空（up/down 空）を返す限り通る（ループ未起動のテスト環境では `last` 初期値が空）。

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run server/chatContext.test.ts`
Expected: PASS（既存 + formatLevelsBlock 2 tests）

- [ ] **Step 5: 全テスト ＆ typecheck ＆ commit**

```bash
npm run typecheck
npx vitest run
git add server/chatContext.ts server/chatContext.test.ts
git commit -m "feat(levels): AI technical uses session H/L + Fibonacci levels (fallback when empty)"
```

---

## Final Verification（全タスク後）

```bash
npm run typecheck
npx vitest run            # 全テスト緑
npm run build:web         # フロントのビルド緑
```

実画面・実データ確認はユーザ環境（`npm run release:build` 後）で：
- 左カラムに「主要レベル」パネルが出て、★強レベル・⚑フィボ50%が区別表示され、距離が価格に追従する
- AI チャット①で上値/下値メドがセッションH/L＋フィボ50%転換判定付きで返る
- 新規/場外（レベル空）でもクラッシュせず「蓄積中…」表示＋AIは従来フォールバック

リリースは SP2 完了後に別途バージョン bump（v0.4.1 想定）＋署名ビルド＋GitHub リリース。

---

## Self-Review メモ（作成者チェック済み）

- **Spec coverage**: §2.1 H/L→Task2、§2.2 コンフルエンス→Task2、§2.3 フィボ→Task3、§2.4 節目→Task2、
  §2.5 近傍選抜→Task2/3、§4 クエリ→Task1、§5 levels.ts→Task2/3、§6 AI→Task6、§7 UI→Task5、
  §8 ループ→Task4、§9 フォールバック→Task2(空)/Task4(latest無)/Task6(空でフォールバック)、§10 テスト→各Task。
- **型整合**: `SessionOHLC`/`Level`/`LevelsResult` は Task2 で定義し以降参照。`computeLevels` 第4引数=現在セッション
  注入で統一。`getLevelsSnapshot`/`getSessionOHLC`/`startLevelsLoop`/`formatLevelsBlock` の名前は全 Task で一致。
- **spec からの軽微な精緻化**: (a) `computeLevels` は `classifySession` を内部 import せず現在セッションを引数注入
  （純粋性・テスト容易性向上）。(b) セッションラベルは相対「N日前」でなく絶対「M/D昼夜」（曖昧さ排除）。
  どちらも spec の意図（純粋関数・セッションH/L表示）を保ちつつ実装を堅くする変更。
