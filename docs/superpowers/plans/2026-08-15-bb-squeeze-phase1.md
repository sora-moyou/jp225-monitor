# BB スクイーズ/バルジ 第1弾（指標・パネル・アラート）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（このセッションでは
> リーダーがインラインで実行する）。手順はチェックボックスで追う。

**Goal:** 5分足20本±2σの新しいボリンジャーバンドから %B / Bandwidth / BWhigh・BWlow を出し、
パネルに表示し、スクイーズ/バルジをアラートとして発火させる（売買には一切触らない）。

**Architecture:** 既存の 14本/0.7σ 系列は**一切変更しない**（バンドウォーク判定と AI プロンプトが
共有しており、実走中の質問文 A/B が割れるため）。新バンドは純関数として `server/indicators.ts` に足し、
`indicatorsLoop` がスナップショットへ載せ、パネルと検知が読む。

**Tech Stack:** TypeScript / vitest / 素の DOM（web は素のブラウザスクリプト）

## Global Constraints

- 既存 `BB_SIGMA`（=0.7）と AI プロンプト文言は **1文字も変更しない**。
- 計算は**確定した5分足**のみ（形成中の足は使わない）。
- BWhigh/low は**現在足を含む** 125 本の最大/最小。本数不足の間は「その時点までの最大/最小」を返し、
  未成熟の印（`ready:false`）を添える。
- アラートは**状態に入った足で1回だけ**（同じ状態が続く間は再発火しない）。
- 出荷前に `npx tsx scripts/alert-audit.mts` で発火頻度を実データで確認する。
- 仕様書: `docs/superpowers/specs/2026-08-15-bb-squeeze-bulge-design.md`

---

### Task 1: 定数（スクイーズ用バンドの SSOT）

**Files:**
- Modify: `core/indicatorSpec.ts`
- Test: `core/indicatorSpec.test.ts`（無ければ作る）

**Interfaces:**
- Produces: `SQUEEZE_BB_PERIOD=20` / `SQUEEZE_BB_SIGMA=2` / `SQUEEZE_BW_LOOKBACK=125`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from 'vitest';
import { BB_SIGMA, SQUEEZE_BB_PERIOD, SQUEEZE_BB_SIGMA, SQUEEZE_BW_LOOKBACK } from './indicatorSpec.js';

describe('バンドの定数', () => {
  it('スクイーズ用は 20本/2σ/125本', () => {
    expect(SQUEEZE_BB_PERIOD).toBe(20);
    expect(SQUEEZE_BB_SIGMA).toBe(2);
    expect(SQUEEZE_BW_LOOKBACK).toBe(125);
  });
  it('★既存のバンドウォーク用σは変えない(AI プロンプトが共有している)', () => {
    expect(BB_SIGMA).toBe(0.7);
  });
});
```

- [ ] **Step 2: 落ちることを確認** — `npx vitest run core/indicatorSpec.test.ts` → `SQUEEZE_BB_PERIOD` が無い旨で FAIL
- [ ] **Step 3: 実装** — `core/indicatorSpec.ts` の末尾に3定数を追加し、「既存σと別系列である理由」をコメントに書く
- [ ] **Step 4: 通ることを確認** — 同コマンドで PASS
- [ ] **Step 5: コミット** — `git add core/indicatorSpec.ts core/indicatorSpec.test.ts && git commit -m "feat(indicators): スクイーズ用バンドの定数(20本/2σ/125本)"`

---

### Task 2: 純関数（bandwidth / 極値 / 状態判定）

**Files:**
- Modify: `server/indicators.ts`
- Test: `server/indicatorsSqueeze.test.ts`（新規）

**Interfaces:**
- Consumes: Task 1 の3定数、既存 `bollinger(closes, period, mult)` / `pctBOf(price, upper, lower)`
- Produces:
  - `bandwidthOf(upper: number|null, mid: number|null, lower: number|null): number|null`
  - `bandwidthExtremes(bw: (number|null)[], lookback: number): { high: number|null; low: number|null; ready: boolean }`
  - `squeezeStateOf(bw: number|null, high: number|null, low: number|null): 'squeeze'|'bulge'|null`
  - `computeSqueezeSeries(closes: number[]): { bw: (number|null)[]; pctB: (number|null)[] }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from 'vitest';
import { bandwidthOf, bandwidthExtremes, squeezeStateOf, computeSqueezeSeries } from './indicators.js';

describe('bandwidthOf', () => {
  it('(上-下)/中央 ×100', () => {
    expect(bandwidthOf(102, 100, 98)).toBeCloseTo(4, 10);
  });
  it('未算出/中央0以下は null', () => {
    expect(bandwidthOf(null, 100, 98)).toBeNull();
    expect(bandwidthOf(102, 0, 98)).toBeNull();
  });
});

describe('bandwidthExtremes', () => {
  it('★現在足を含む直近 lookback 本の最大・最小', () => {
    const r = bandwidthExtremes([5, 1, 3, 9, 2], 3);   // 直近3本 = [3,9,2]
    expect(r.high).toBe(9);
    expect(r.low).toBe(2);
    expect(r.ready).toBe(true);
  });
  it('本数が足りない間は「その時点まで」の最大最小 + ready:false', () => {
    const r = bandwidthExtremes([4, 6], 125);
    expect(r.high).toBe(6);
    expect(r.low).toBe(4);
    expect(r.ready).toBe(false);
  });
  it('null は無視する(算出できない足で極値が壊れない)', () => {
    const r = bandwidthExtremes([null, 7, null, 3], 4);
    expect(r.high).toBe(7);
    expect(r.low).toBe(3);
  });
  it('全部 null なら null(0 にしない)', () => {
    expect(bandwidthExtremes([null, null], 2)).toEqual({ high: null, low: null, ready: false });
  });
});

describe('squeezeStateOf', () => {
  it('BW <= low はスクイーズ / BW >= high はバルジ', () => {
    expect(squeezeStateOf(1.0, 3.0, 1.0)).toBe('squeeze');
    expect(squeezeStateOf(3.0, 3.0, 1.0)).toBe('bulge');
    expect(squeezeStateOf(2.0, 3.0, 1.0)).toBeNull();
  });
  it('未算出は null', () => {
    expect(squeezeStateOf(null, 3, 1)).toBeNull();
    expect(squeezeStateOf(2, null, null)).toBeNull();
  });
});

describe('computeSqueezeSeries', () => {
  it('本数不足の先頭は null、20本目から値が出る', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + (i % 3));
    const r = computeSqueezeSeries(closes);
    expect(r.bw).toHaveLength(25);
    expect(r.bw[18]).toBeNull();
    expect(r.bw[19]).not.toBeNull();
    expect(r.pctB[19]).not.toBeNull();
  });
  it('全同値なら幅0 → bw=0 / pctB=null', () => {
    const r = computeSqueezeSeries(Array.from({ length: 21 }, () => 100));
    expect(r.bw[20]).toBe(0);
    expect(r.pctB[20]).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — `npx vitest run server/indicatorsSqueeze.test.ts` → 関数が無い旨で FAIL
- [ ] **Step 3: 実装**

```ts
/** Bandwidth = (上−下)/中央 ×100。未算出/中央<=0 は null。 */
export function bandwidthOf(upper: number | null, mid: number | null, lower: number | null): number | null {
  if (upper == null || mid == null || lower == null || !(mid > 0)) return null;
  return ((upper - lower) / mid) * 100;
}

export interface BandwidthExtremes { high: number | null; low: number | null; ready: boolean }

/** ★現在足を含む直近 lookback 本の最大/最小(null は無視)。本数が足りなければ ready:false。 */
export function bandwidthExtremes(bw: readonly (number | null)[], lookback: number): BandwidthExtremes {
  const win = bw.slice(Math.max(0, bw.length - lookback));
  const vals = win.filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length === 0) return { high: null, low: null, ready: false };
  return { high: Math.max(...vals), low: Math.min(...vals), ready: win.length >= lookback };
}

export type SqueezeState = 'squeeze' | 'bulge' | null;

/** BW <= low = スクイーズ / BW >= high = バルジ(=125本の新記録に達した足)。 */
export function squeezeStateOf(bw: number | null, high: number | null, low: number | null): SqueezeState {
  if (bw == null || high == null || low == null) return null;
  if (bw <= low) return 'squeeze';
  if (bw >= high) return 'bulge';
  return null;
}

/** close 列から BW と %B の系列を作る(各点はその点までの prefix で再計算)。 */
export function computeSqueezeSeries(closes: number[]): { bw: (number | null)[]; pctB: (number | null)[] } {
  const bw: (number | null)[] = [];
  const pctB: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const prefix = closes.slice(0, i + 1);
    const b = bollinger(prefix, SQUEEZE_BB_PERIOD, SQUEEZE_BB_SIGMA);
    bw.push(bandwidthOf(b.upper, b.mid, b.lower));
    pctB.push(pctBOf(closes[i]!, b.upper, b.lower));
  }
  return { bw, pctB };
}
```

★`bollinger` の戻り値のプロパティ名は実装を読んで合わせること（`{ upper, mid, lower }` でなければ実物に合わせる）。

- [ ] **Step 4: 通ることを確認** — 同コマンドで PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(indicators): Bandwidth/%B/極値/スクイーズ判定の純関数"`

---

### Task 3: スナップショットへ載せる（loop）

**Files:**
- Modify: `server/indicators.ts`（`IndicatorSnapshot` に `squeeze?` を足す）
- Modify: `server/loops/indicatorsLoop.ts`
- Test: `server/loops/indicatorsLoopSqueeze.test.ts`（新規）

**Interfaces:**
- Produces: `IndicatorSnapshot.squeeze?: { pctB: number|null; prevPctB: number|null; bw: number|null; prevBw: number|null; bwHigh: number|null; bwLow: number|null; ready: boolean; state: SqueezeState; t?: number }`

- [ ] **Step 1: 失敗するテストを書く**（loop の純関数部分を切り出して検査する）

```ts
import { describe, it, expect } from 'vitest';
import { buildSqueezeSnapshot } from '../indicators.js';

describe('buildSqueezeSnapshot', () => {
  it('★確定足だけで作る(最後の形成中足を渡さない前提)', () => {
    const closes = Array.from({ length: 130 }, (_, i) => 100 + Math.sin(i / 3) * (i < 60 ? 1 : 5));
    const s = buildSqueezeSnapshot(closes);
    expect(s.bw).not.toBeNull();
    expect(s.prevBw).not.toBeNull();
    expect(s.bwHigh! >= s.bw!).toBe(true);
    expect(s.bwLow! <= s.bw!).toBe(true);
    expect(s.ready).toBe(true);
  });
  it('本数不足では ready:false・state は null', () => {
    const s = buildSqueezeSnapshot([100, 101, 102]);
    expect(s.ready).toBe(false);
    expect(s.state).toBeNull();
  });
});
```

- [ ] **Step 2: 落ちることを確認** — FAIL
- [ ] **Step 3: 実装** — `buildSqueezeSnapshot(closes, times?)` を `server/indicators.ts` に足し、
  `indicatorsLoop` の `snap` に `snap.squeeze = buildSqueezeSnapshot(usedCloses, usedTimes)` を足す。
  ★`state` は `ready` が false の間は必ず `null`（本数不足で誤発火させない）。
- [ ] **Step 4: 通ることを確認** — PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(indicators): スクイーズ用スナップショットを配信に載せる"`

---

### Task 4: パネル表示（%B / BW / BWhigh・low ＋ 色）

**Files:**
- Modify: `web/components/indicatorPanel.ts`
- Modify: `web/styles.css`（色クラス2つ）
- Test: `web/components/indicatorPanel.test.ts`（既存に追記）

**Interfaces:**
- Consumes: Task 3 の `snap.squeeze`

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('★列は RSI / %B / BW / BWhigh/low', () => {
  const html = buildIndicatorHtml({
    rsi: 52, sma: 100, bbUpper: 101, bbMid: 100, bbLower: 99, price: 100, pctB: 0.5, series: [],
    squeeze: { pctB: 0.83, prevPctB: 0.70, bw: 1.42, prevBw: 1.80, bwHigh: 2.10, bwLow: 0.61, ready: true, state: null },
  } as never);
  expect(html).toContain('%B');
  expect(html).toContain('BW');
  expect(html).toContain('0.83');
  expect(html).toContain('1.42');
  expect(html).toContain('2.10/0.61');
  expect(html).not.toContain('0.7σ');     // 旧列は消えている
});

it('★増加は緑・減少は橙・同値は灰', () => {
  const mk = (pctB: number, prevPctB: number, bw: number, prevBw: number) => buildIndicatorHtml({
    rsi: 50, sma: 100, bbUpper: 101, bbMid: 100, bbLower: 99, price: 100, pctB: 0.5, series: [],
    squeeze: { pctB, prevPctB, bw, prevBw, bwHigh: 3, bwLow: 0.1, ready: true, state: null },
  } as never);
  expect(mk(0.8, 0.7, 1.0, 2.0)).toContain('ind-up');     // %B 増加
  expect(mk(0.8, 0.7, 1.0, 2.0)).toContain('ind-down');   // BW 減少
  expect(mk(0.7, 0.7, 1.0, 1.0)).not.toContain('ind-up');
});
```

- [ ] **Step 2: 落ちることを確認** — FAIL
- [ ] **Step 3: 実装** — `COLS` を `['RSI', '%B', 'BW', 'BWhigh/low']` に差し替え、データセルを
  `%B`（小数2桁）/ `BW`（小数2桁）/ `bwHigh/bwLow`（小数2桁・`/` 区切り）にする。
  色クラスは `ind-up`（緑 `#3fb950`）/ `ind-down`（橙 `#d29922`）/ 無印（灰）。
  `squeeze` が無い旧スナップショットでは**従来どおり**の空表示にフォールバックする。
- [ ] **Step 4: 通ることを確認** — PASS
- [ ] **Step 5: コミット** — `git commit -m "feat(ui): 指標パネルを %B/BW/BWhigh・low に差し替え"`

---

### Task 5: 検知種別とアラート（1回だけ発火）

**Files:**
- Modify: `core/detectionKinds.ts`（`squeeze` / `bulge` を追加）
- Modify: `server/detect/registry.ts`（判定と emit）
- Test: `server/detect/squeezeAlert.test.ts`（新規）

**Interfaces:**
- Consumes: Task 2 の `squeezeStateOf`、Task 3 のスナップショット
- Produces: 検知種別 `'squeeze' | 'bulge'`、`squeezeEdge(prev, next)`（**状態に入った瞬間だけ true**）

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, it, expect } from 'vitest';
import { squeezeEdge } from './registry.js';

describe('squeezeEdge — 入った足だけ発火', () => {
  it('null → squeeze で発火', () => expect(squeezeEdge(null, 'squeeze')).toBe('squeeze'));
  it('squeeze → squeeze は発火しない(連続で板を埋めない)', () => expect(squeezeEdge('squeeze', 'squeeze')).toBeNull());
  it('squeeze → bulge は発火する', () => expect(squeezeEdge('squeeze', 'bulge')).toBe('bulge'));
  it('squeeze → null は発火しない(抜けたことは通知しない)', () => expect(squeezeEdge('squeeze', null)).toBeNull());
});
```

- [ ] **Step 2: 落ちることを確認** — FAIL
- [ ] **Step 3: 実装**
  - `core/detectionKinds.ts` に
    `squeeze: { layer: 'L2', label: 'スクイーズ', promptLabel: 'BBスクイーズ(バンド収縮)' }`、
    `bulge: { layer: 'L2', label: 'バルジ', promptLabel: 'BBバルジ(バンド拡大)' }` を追加。
  - `server/detect/registry.ts` に `export function squeezeEdge(prev: SqueezeState, next: SqueezeState): SqueezeState`
    （`next` が非 null かつ `prev !== next` のときだけ `next`、それ以外 null）。
  - detector 本体: 5分足のスナップショットから `state` を求め、`squeezeEdge` が返したときだけ
    `signals.push({ type: state, direction: 'up'（bulge は 'up'/スクイーズは 'up' 固定＝方向を持たない）, ... })`
    ではなく、**方向を持たない検知**として `sink` に直接流す（`double` と同じく `reference` に価格を入れる）。
    文言: `スクイーズ — BB幅が125本の最小(BW 0.61 / 高安 2.10/0.61) 価格69,120円`。
- [ ] **Step 4: 通ることを確認** — PASS
- [ ] **Step 5: 実データで発火頻度を確認** — `npx tsx scripts/alert-audit.mts`。1日あたりの発火数を計画に記録する。
- [ ] **Step 6: コミット** — `git commit -m "feat(detect): スクイーズ/バルジのアラート"`

---

### Task 6: 出荷

- [ ] **Step 1:** `npx tsc --noEmit` / `npx vitest run` が全緑
- [ ] **Step 2:** `npx tsx scripts/alert-audit.mts` の結果をリリースノートに書く
- [ ] **Step 3:** 版を6点上げる（package.json / tauri.conf / tauri.lite.conf / Cargo.toml / Cargo.lock / package-lock）
- [ ] **Step 4:** `npm run release:build` → `PRODUCT=lite npm run release:build`
- [ ] **Step 5:** コミット → push（origin と monitorlite）→ `gh release create`（latest.json のアセット名を実物と照合）
