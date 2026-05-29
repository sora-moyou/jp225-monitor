# 日経先物のみアラート + 大変動他銘柄を AI 元ネタに — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アラート表示を日経225先物(NIY=F)のみに絞り、他銘柄は |z| ≥ 4.0 の大変動があったものだけを NIY=F アラートの AI 説明の元ネタに使う。あわせて設定の「最新かチェック」ボタンをボタンと分かる見た目にする。

**Architecture:** 新規 `server/marketSnapshot.ts` が既存 `barsCache`(`getCachedBars`)と `alertDetector` の純粋関数を使い、`detectBurst`/`detectTrend` の z 計算をミラーして「大きく動いた他銘柄」`Mover[]` を返す。`alertLoop` は評価を NIY=F のみに制限。`explain` ルートが explain 時に movers を集めて LLM プロンプトに注入する。

**Tech Stack:** Node.js + TypeScript (ESM, `.js` 拡張子付き import), Express, vitest, Vanilla CSS。

---

## File Structure

- `server/marketSnapshot.ts` (Create): 「|z| ≥ 閾値で大きく動いた他銘柄」算出。`getCachedBars` と `alertDetector` 純粋関数に依存。`Mover` 型と `getSignificantMovers()` を export。
- `server/marketSnapshot.test.ts` (Create): z 判定・除外・並び順の検証(bars 取得を注入)。
- `server/loops/alertLoop.ts` (Modify): 評価ループを NIY=F のみに制限。
- `server/llm/openai.ts` (Modify): `ExplainInput.crossAsset` 追加 + `formatCrossAsset()` + プロンプト注入。
- `server/llm/openai.test.ts` (Create): `formatCrossAsset()` の整形を検証。
- `server/routes/explain.ts` (Modify): explain 時に `getSignificantMovers()` を呼び `crossAsset` を渡す。
- `web/styles.css` (Modify): `#settings-check-update` のボタン見た目。

依存方向: `explain.ts → marketSnapshot.ts → alertLoop.ts(getCachedBars)/alertDetector.ts`。`openai.ts` は `Mover` を **型のみ** import(循環なし)。

---

### Task 1: marketSnapshot.ts — 大変動他銘柄の算出

**Files:**
- Create: `server/marketSnapshot.ts`
- Test: `server/marketSnapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/marketSnapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getSignificantMovers } from './marketSnapshot.js';
import type { Bar } from './correlation.js';

// 60+ 本の極小ノイズ baseline の後に最終バーで spikePct の急変を1本足す。
// → 最終 1分リターン ≈ spikePct, baseline σ ≈ 0.00005 → |z| 巨大。
function quietThenSpike(spikePct: number, n = 70): Bar[] {
  const closes = [10000];
  for (let i = 1; i < n; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    closes.push(closes[i - 1]! * (1 + sign * 0.00005));
  }
  closes.push(closes[closes.length - 1]! * (1 + spikePct));
  return closes.map((c, i) => ({ t: i * 60000, close: c }));
}

// 終始極小ノイズのみ → |z| ≈ 1。
function quiet(n = 71): Bar[] {
  const closes = [10000];
  for (let i = 1; i < n; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    closes.push(closes[i - 1]! * (1 + sign * 0.00005));
  }
  return closes.map((c, i) => ({ t: i * 60000, close: c }));
}

describe('getSignificantMovers', () => {
  const bars: Record<string, Bar[]> = {
    'NIY=F': quietThenSpike(0.01),    // 巨大 z だが除外対象
    'NQ=F': quietThenSpike(-0.005),   // -0.5% 急変, 大 z, down
    'ES=F': quiet(),                  // 静か, 閾値未満
  };
  const getBars = (s: string) => bars[s] ?? [];

  it('excludes the alerting symbol itself', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    expect(movers.every(m => m.symbol !== 'NIY=F')).toBe(true);
  });

  it('includes a symbol with a large move (|z| >= threshold) and reports direction', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    const nq = movers.find(m => m.symbol === 'NQ=F');
    expect(nq).toBeDefined();
    expect(nq!.direction).toBe('down');
    expect(nq!.changePercent).toBeLessThan(0);
    expect(nq!.z).toBeGreaterThanOrEqual(4.0);
  });

  it('excludes quiet symbols below the threshold', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    expect(movers.every(m => m.symbol !== 'ES=F')).toBe(true);
  });

  it('sorts movers by |z| descending', () => {
    const movers = getSignificantMovers('NIY=F', 4.0, getBars);
    for (let i = 1; i < movers.length; i++) {
      expect(movers[i - 1]!.z).toBeGreaterThanOrEqual(movers[i]!.z);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/marketSnapshot.test.ts`
Expected: FAIL — cannot find module `./marketSnapshot.js` / `getSignificantMovers` not exported.

- [ ] **Step 3: Implement `server/marketSnapshot.ts`**

```ts
import { INSTRUMENTS } from './config.js';
import { getCachedBars } from './loops/alertLoop.js';
import { returns, stdDev, returns5m, DEFAULT_PARAMS } from './alertDetector.js';
import type { Bar } from './correlation.js';

export const CROSS_ASSET_Z_THRESHOLD = 4.0;

export interface Mover {
  symbol: string;
  label: string;
  changePercent: number;   // 採用された窓のリターン (%)
  windowSeconds: number;   // 60 (1分burst) または 300 (5分trend)
  z: number;               // 採用された |z|
  direction: 'up' | 'down';
}

interface WindowZ { z: number; ret: number; windowSeconds: number; }

// 1分 burst z (detectBurst の z 部分をミラー。静寂前提・横断確認は無し)
function burstZ(bars: Bar[]): WindowZ | null {
  const L = DEFAULT_PARAMS.baselineLookback;
  if (bars.length < L + 1) return null;
  const baseline = bars.slice(-(L + 1), -1);
  const br = returns(baseline);
  if (br.length < 10) return null;
  const sigma = stdDev(br);
  const prev = bars[bars.length - 2]!.close;
  const cur = bars[bars.length - 1]!.close;
  if (prev <= 0) return null;
  const ret = (cur - prev) / prev;
  const z = sigma > 0 ? Math.abs(ret) / sigma : 0;
  return { z, ret, windowSeconds: 60 };
}

// 5分 trend z (detectTrend の z 部分をミラー)
function trendZ(bars: Bar[]): WindowZ | null {
  const L = DEFAULT_PARAMS.baselineLookback;
  if (bars.length < L + 5) return null;
  const r5 = returns5m(bars);
  if (r5.length < 10) return null;
  const sigma = stdDev(r5.slice(0, -1));
  const ret = r5[r5.length - 1]!;
  const z = sigma > 0 ? Math.abs(ret) / sigma : 0;
  return { z, ret, windowSeconds: 300 };
}

/**
 * excludeSymbol を除く全 INSTRUMENTS を評価し、|z| >= threshold で
 * 大きく動いた銘柄を |z| 降順で返す。getBars はテスト用に注入可。
 */
export function getSignificantMovers(
  excludeSymbol: string,
  threshold: number = CROSS_ASSET_Z_THRESHOLD,
  getBars: (symbol: string) => Bar[] = getCachedBars,
): Mover[] {
  const movers: Mover[] = [];
  for (const inst of INSTRUMENTS) {
    const sym = inst.symbol;
    if (sym === excludeSymbol) continue;
    const bars = getBars(sym);
    const b = burstZ(bars);
    const t = trendZ(bars);
    // 2窓のうち |z| が大きい方を採用 (両方 null ならスキップ)
    let chosen: WindowZ | null = null;
    if (b && t) chosen = b.z >= t.z ? b : t;
    else chosen = b ?? t;
    if (!chosen) continue;
    if (chosen.z < threshold) continue;
    movers.push({
      symbol: sym,
      label: inst.labelJa,
      changePercent: chosen.ret * 100,
      windowSeconds: chosen.windowSeconds,
      z: chosen.z,
      direction: chosen.ret >= 0 ? 'up' : 'down',
    });
  }
  movers.sort((a, b) => b.z - a.z);
  return movers;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/marketSnapshot.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/marketSnapshot.ts server/marketSnapshot.test.ts
git commit -m "feat(alerts): cross-asset significant-mover snapshot (|z|>=4.0)"
```

---

### Task 2: alertLoop — アラートを NIY=F のみに制限

**Files:**
- Modify: `server/loops/alertLoop.ts:60` (evaluateAndFire のループ先頭)

- [ ] **Step 1: Add the NIY=F-only guard**

In `server/loops/alertLoop.ts`, inside `evaluateAndFire()`, the loop currently starts:

```ts
  for (const sym of SYMBOLS) {
    const bars = barsCache.get(sym);
    if (!bars || bars.length < 65) continue;
```

Insert a guard as the FIRST line inside the loop, so it becomes:

```ts
  for (const sym of SYMBOLS) {
    // v0.3.19: アラートは日経225先物のみ。他銘柄は分足取得のみ続け、AI 説明の元ネタ専用。
    if (sym !== 'NIY=F') continue;
    const bars = barsCache.get(sym);
    if (!bars || bars.length < 65) continue;
```

Do NOT change `refreshAllBars()` (全銘柄の分足取得は維持) or `buildCrossSnapshot()`
(NIY=F の横断確認に他銘柄スナップショットが必要)。

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run full test suite (no regressions)**

Run: `npm run test`
Expected: all pass (alertDetector tests unaffected; the loop change has no unit test — verified by typecheck + manual).

- [ ] **Step 4: Commit**

```bash
git add server/loops/alertLoop.ts
git commit -m "feat(alerts): restrict alert firing to NIY=F only"
```

---

### Task 3: openai.ts — crossAsset 注入 + formatCrossAsset

**Files:**
- Modify: `server/llm/openai.ts` (ExplainInput, prompt, new helper)
- Test: `server/llm/openai.test.ts` (Create)

- [ ] **Step 1: Write the failing test**

Create `server/llm/openai.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatCrossAsset } from './openai.js';
import type { Mover } from '../marketSnapshot.js';

describe('formatCrossAsset', () => {
  it('returns a "no linkage" line when there are no movers', () => {
    expect(formatCrossAsset([])).toBe('【他資産】同時刻に目立った連動なし。');
  });

  it('formats movers with arrow, signed percent, window and z', () => {
    const movers: Mover[] = [
      { symbol: 'NQ=F', label: 'ナスダック100先物', changePercent: -1.85, windowSeconds: 300, z: 4.3, direction: 'down' },
      { symbol: 'JPY=X', label: 'ドル円', changePercent: 0.42, windowSeconds: 60, z: 4.1, direction: 'up' },
    ];
    const out = formatCrossAsset(movers);
    expect(out).toContain('【同時刻に大きく動いた他資産(z>=4.0)】');
    expect(out).toContain('- ナスダック100先物 ▼ -1.85% (5分, z=4.3)');
    expect(out).toContain('- ドル円 ▲ +0.42% (1分, z=4.1)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/llm/openai.test.ts`
Expected: FAIL — `formatCrossAsset` not exported.

- [ ] **Step 3: Add the type-only import and `crossAsset` field**

In `server/llm/openai.ts`, add near the other imports at the top of the file:

```ts
import type { Mover } from '../marketSnapshot.js';
```

In the `ExplainInput` interface (currently ends with `news: NewsItem[];`), add a field:

```ts
export interface ExplainInput {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope';
  change15min: number | null;
  pa15min: { open: number; high: number; low: number; current: number } | null;
  range1h: { high: number; low: number } | null;
  news: NewsItem[];
  crossAsset?: Mover[];
}
```

- [ ] **Step 4: Add the `formatCrossAsset` helper**

In `server/llm/openai.ts`, add this exported function just above `function rankAndFormatNews(` :

```ts
export function formatCrossAsset(movers: Mover[]): string {
  if (movers.length === 0) return '【他資産】同時刻に目立った連動なし。';
  const lines = movers.map(m => {
    const arrow = m.direction === 'up' ? '▲' : '▼';
    const win = m.windowSeconds >= 300 ? '5分' : '1分';
    const sign = m.changePercent >= 0 ? '+' : '';
    return `- ${m.label} ${arrow} ${sign}${m.changePercent.toFixed(2)}% (${win}, z=${m.z.toFixed(1)})`;
  });
  return `【同時刻に大きく動いた他資産(z>=4.0)】\n${lines.join('\n')}`;
}
```

- [ ] **Step 5: Inject the cross-asset section into the prompt and revise the steps**

In `server/llm/openai.ts`, inside `explain()`, replace the existing `userPrompt` assignment
(the block from `const userPrompt =` through the `出力は必ず200文字以内、1〜2文で.\`;` line) with:

```ts
  const userPrompt =
    `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% ${dirJa} (${dirEmphasis}) しました。\n` +
    (magnitudeNote ? magnitudeNote + '\n' : '') +
    ctx15Line + pa15Line + range1hLine +
    `\n${formatCrossAsset(input.crossAsset ?? [])}\n` +
    `\n【直近${windowHours}時間のニュース（関連性順、重大マクロは古くても上位）】\n${rankAndFormatNews(input, now)}\n\n` +
    `[手順]\n` +
    `1) まず「他資産」を見る。${dirEmphasis} と同方向に大きく動いた資産があれば、連動(リスクオン/オフ・金利・為替)として最優先で説明に使う。\n` +
    `2) 次に候補ニュースを上から見て、その材料なら相場が ${dirEmphasis} へ動くはずか判定。\n` +
    `3) 方向が一致する材料(他資産 or ニュース)を選んで「○○分前のXX、(方向の根拠)」形式で説明。\n` +
    `4) 方向が一致するものが無ければ「整合する明確な材料なし、テクニカル/ノイズ可能性」と書く。地政学リスクなのに株が上がっている等の矛盾を引用しない。\n` +
    `5) OHLCで下髭/上髭/サポート反転等が読めれば併記してよい。\n\n` +
    `出力は必ず200文字以内、1〜2文で。`;
```

- [ ] **Step 6: Run the new test + typecheck**

Run: `npm run test -- server/llm/openai.test.ts`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/llm/openai.ts server/llm/openai.test.ts
git commit -m "feat(explain): inject cross-asset movers into the LLM prompt"
```

---

### Task 4: explain ルート — movers を集めて渡す

**Files:**
- Modify: `server/routes/explain.ts:2-3` (import), `:31-41` (explain 呼び出し)

- [ ] **Step 1: Add the import**

In `server/routes/explain.ts`, add below the existing `import { getNews } from '../cache.js';` line:

```ts
import { getSignificantMovers } from '../marketSnapshot.js';
```

- [ ] **Step 2: Pass `crossAsset` into the `explain()` call**

In `explainHandler`, the `explain({...})` call currently ends with `news: getNews(),`.
Add a `crossAsset` line right after it:

```ts
    const text = await explain({
      symbol: body.symbol,
      symbolLabel: body.symbolLabel,
      changePercent: body.changePercent,
      windowSeconds: body.windowSeconds,
      detectionKind: body.detectionKind,
      change15min: typeof body.change15min === 'number' ? body.change15min : null,
      pa15min: body.pa15min ?? null,
      range1h: body.range1h ?? null,
      news: getNews(),
      crossAsset: getSignificantMovers(body.symbol),
    });
```

(`getSignificantMovers` は live な `barsCache` を読む。実行時は alertLoop が
全銘柄の分足を更新済み。`body.symbol` は NIY=F なので自身は自動除外される。)

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck`
Expected: no errors.
Run: `npm run test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add server/routes/explain.ts
git commit -m "feat(explain): collect cross-asset movers at explain time"
```

---

### Task 5: ① 「最新かチェック」ボタンの視認性 (CSS)

**Files:**
- Modify: `web/styles.css` (末尾に追記)

- [ ] **Step 1: Append the button styles**

Append to the END of `web/styles.css`:

```css
#settings-check-update { color: #58a6ff; border-color: #58a6ff; }
#settings-check-update:hover { background: rgba(88, 166, 255, 0.12); }
```

(`.btn-secondary` は他所でも使うため変更せず、id セレクタで上書きする。)

- [ ] **Step 2: Build sanity check**

Run: `npm run build:web`
Expected: built successfully (26 modules transformed).

- [ ] **Step 3: Commit**

```bash
git add web/styles.css
git commit -m "style(settings): make the check-update button clearly a button"
```

---

## Self-Review

- **Spec coverage:**
  - ① ボタン視認性 → Task 5 ✓
  - ②-(a) NIY=F のみ発火 → Task 2 ✓
  - ②-(b) getCachedBars(既存) → Task 1 が利用 ✓(変更不要)
  - ②-(c) marketSnapshot |z|≥4.0 → Task 1 ✓
  - ②-(d) explain 注入(ExplainInput.crossAsset + formatCrossAsset + プロンプト + ルート配線)→ Task 3, Task 4 ✓
  - テスト方針(marketSnapshot 注入テスト + formatCrossAsset テスト + typecheck/全テスト)→ Task 1 Step1, Task 3 Step1, 各 typecheck ✓
- **Placeholder scan:** なし(全ステップに実コード/実コマンド)。
- **Type consistency:** `Mover`(symbol/label/changePercent/windowSeconds/z/direction)は Task 1 定義、Task 3 のテスト・`formatCrossAsset`・`ExplainInput.crossAsset`、Task 4 の `getSignificantMovers(body.symbol): Mover[]` で一致。`getSignificantMovers(excludeSymbol, threshold?, getBars?)` のシグネチャは Task 1 定義と Task 4 呼び出し(第1引数のみ)で整合。`Bar` は `correlation.ts` 由来で全 import 一致。`CROSS_ASSET_Z_THRESHOLD = 4.0`。
