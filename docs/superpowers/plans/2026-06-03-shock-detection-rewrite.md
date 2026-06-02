# 急変検知の方式変更（短期/長期 → 価格変化スコア方式）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 短期(1分 z-score burst)＋長期(5分 z-score trend)のアラート方式を撤廃し、**完成1分足の終値変化のみ**を使う「急変(shock)」スコア方式に置き換える。クールダウンはバー数方式(直近ラベルから N 本超)。グランビルと超短期フラッシュ(tickDetector)は不変。

**Architecture:** 新しい純粋関数 `detectShock(closes)` を追加し、`alertEngine.evaluateBarsNiy` の burst/trend ブロックをこれに差し替える。検知は**確定足のみ**(getRealtimeBars の末尾=進行中バーを除外)。realtime サブ分 z-score 経路(`evaluateRealtimeNiy` とその呼び出し)は撤去。新 `detectionKind='shock'` を型・表示・LLM・履歴分類に通す。発火は確定足ベース(≈1分粒度)で、モニター(60秒タイマ)と collector(onMinute) の両方で動き、collector が単独記録(既存の単一ライター調停はそのまま)。

**Tech Stack:** TypeScript ESM(`.js` 指定子)、Vitest、node:sqlite。検知は円(yen)単位。NIY=F のみ発火。

---

## 設計判断(リーダー)

1. **確定足ベース**: 提示ロジックは `close[1]`/`close[2]`/`bar_index` を使う確定足アルゴリズム。よって**完成した1分足**(getRealtimeBars の末尾=進行中バーを除外した系列)で評価し、最新の完成足で発火判定する。realtime サブ分 z-score(`evaluateRealtimeNiy`)は撤去。速い大口は超短期フラッシュ(tickDetector 5-10秒/80円)が引き続き担う。
2. **クールダウン=バー数方式**: 急変は独自の「直近ラベルから cooldownBars 本超」で間引く(既定3本=3分)。グランビル/超短期が使う共有時間クールダウン(`alertCooldown`)とは**別系統**。→ 強い動きでグランビルと急変が同時に出うる(指標仕様に忠実な既定)。
3. **温存**: グランビル(MA75)・超短期フラッシュ(tickDetector)は変更しない。
4. **種別**: 新 `detectionKind='shock'`。バナー/履歴/LLM では「急変」と表示。`windowSeconds=60`(情報用)。`changePercent = d1/close[1]*100`、`note` に円ベースの内訳。
5. **プロセス**: モニターは `alertLoop`(60秒タイマ)→`evaluateBarsNiy`、collector は `onMinute`→`evaluateBarsNiy`。どちらも確定足で同一結果。cross-process 重複は既存 `insertAlertIfNew`(symbol+dir+kind+window ±窓)で吸収。バー数クールダウンはプロセスごと独立(`feedBars`/`alertCooldown` と同じく per-process)。

---

## 移植するアルゴリズム(価格変化スコア方式)

完成1分足の終値列 `C[0..n-1]`(古い→新しい)を入力、最新完成足 `last=n-1` で評価。`C0=C[last]`(最新完成終値)、`C1=C[last-1]`、`C2=C[last-2]`。すべて**円**単位。

**パラメータ(既定)**: move1=25, move2=40, shock1=40, shock2=70, accelTh=15, avgLen=30, avgMult=2.0, breakLen=10, sameDirLen=3, sameDirNeed=2, cooldownBars=3。

**派生量**:
- `d1 = C0 - C1`(1分変化)、`d2 = C0 - C2`(2分変化)
- `d1prev = C1 - C2`、`accel = d1 - d1prev`(加速度)
- `avgAbsMove` = 現在足を**除く**直近 avgLen 本の1分変化幅の平均 = mean of `|C[last-i] - C[last-i-1]|` for i in 1..avgLen
- `prevRangeHigh` = max(C[last-1] .. C[last-breakLen])(現在足を除く直近 breakLen 本の最高終値)、`prevRangeLow` = その最小
- `upCount` = i in 0..sameDirLen-1 で `C[last-i] > C[last-i-1]` の本数、`dnCount` = `C[last-i] < C[last-i-1]` の本数

**上方向6条件(各1点)**: aUp:`d1>=move1` / bUp:`avgAbsMove有効 && d1>=avgAbsMove*avgMult` / cUp:`d2>=move2` / dUp:`upCount>=sameDirNeed` / eUp:`C0>prevRangeHigh` / fUp:`accel>=accelTh`。`upScore`=真の数(0..6)。
**下方向6条件**: aDn:`d1<=-move1` / bDn:`avgAbsMove有効 && -d1>=avgAbsMove*avgMult` / cDn:`d2<=-move2` / dDn:`dnCount>=sameDirNeed` / eDn:`C0<prevRangeLow` / fDn:`accel<=-accelTh`。`dnScore`=真の数。

**方向**: `upScore>dnScore`→up、`dnScore>upScore`→down、同点→発火なし。
**急変条件**: `upShockRaw = (d1>=shock1 && (d2>=shock2 || eUp)) || upScore>=4`、`dnShockRaw = (d1<=-shock1 && (d2<=-shock2 || eDn)) || dnScore>=4`。
**発火**: up = 方向up && upShockRaw、down = 方向down && dnShockRaw(クールダウンは呼び出し側で適用)。

**必要本数**: `avgLen+2`(=32)以上の完成足。未満は null。

---

## File Structure

**新規**: `server/shockDetector.ts`(純粋関数+型+既定パラメータ)、`server/shockDetector.test.ts`。
**変更**: `server/alertDetector.ts`(DetectionKind に 'shock')、`server/types.ts`(AlertEventPayload.detectionKind に 'shock')、`server/alertEngine.ts`(burst/trend→shock 差し替え+バー数クールダウン、evaluateRealtimeNiy 撤去)、`server/alertEngine.test.ts`、`server/loops/alertLoop.ts`(evaluateRealtime 撤去)、`server/loops/priceLoop.ts`(evaluateRealtime 呼び出し撤去)、`collector/alertCollector.ts`(onPrice の realtime 呼び出し撤去)、`server/alertHistory.ts`(rowKind/kindLabel に 急変)、`web/components/alertBanner.ts`(shock→急変)、`server/llm/openai.ts`(detectionKind に shock、ラベル 急変)、`server/routes/explain.ts`(shock 受理)、`web/lib/api.ts`(型)。

---

## Task 1: 急変検知モジュール `shockDetector.ts`(純粋関数 + TDD)

**Files:** Create `server/shockDetector.ts`, `server/shockDetector.test.ts`

- [ ] **Step 1: 失敗するテストを書く** — `server/shockDetector.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { detectShock, DEFAULT_SHOCK_PARAMS } from './shockDetector.js';

// 30本の微小ジグザグ(±1円)で平均変化を小さくし、最後に+45円ジャンプ → 上急変。
function quietThenJump(jump: number): number[] {
  const c: number[] = []; let p = 30000;
  for (let i = 0; i < 33; i++) { p += (i % 2 === 0 ? 1 : -1); c.push(p); }
  c.push(p + jump);
  return c;
}

describe('detectShock', () => {
  it('fires up on a sharp jump after a quiet stretch', () => {
    const sig = detectShock(quietThenJump(45), DEFAULT_SHOCK_PARAMS);
    expect(sig).not.toBeNull();
    expect(sig!.dir).toBe('up');
    expect(sig!.d1).toBeGreaterThanOrEqual(DEFAULT_SHOCK_PARAMS.shock1);
  });

  it('fires down on a sharp drop', () => {
    const sig = detectShock(quietThenJump(-45), DEFAULT_SHOCK_PARAMS);
    expect(sig).not.toBeNull();
    expect(sig!.dir).toBe('down');
  });

  it('does not fire on a flat series', () => {
    const flat = Array.from({ length: 40 }, () => 30000);
    expect(detectShock(flat, DEFAULT_SHOCK_PARAMS)).toBeNull();
  });

  it('does not fire when there are too few bars', () => {
    expect(detectShock([30000, 30050], DEFAULT_SHOCK_PARAMS)).toBeNull();
  });

  it('does not fire on a tie (no dominant direction)', () => {
    // 緩やかな単調上昇: スコアは出るが急変条件未満になるよう小さめの傾き
    const c = Array.from({ length: 40 }, (_, i) => 30000 + i * 2);
    const sig = detectShock(c, DEFAULT_SHOCK_PARAMS);
    // 2円/分の単調上昇は move1=25 等に届かず急変にならない
    expect(sig).toBeNull();
  });
});
```

- [ ] **Step 2: 失敗を確認**

Run: `cd C:/Users/user/Desktop/Finance_Monitor && npx vitest run server/shockDetector.test.ts`
Expected: FAIL(モジュール無し)。

- [ ] **Step 3: `server/shockDetector.ts` を実装**(アルゴリズムは上記「移植するアルゴリズム」節に従う。Pine コードの逐語移植ではなく TS で表現)

```ts
// 価格変化(円)のみで急変を検知。出来高/高安は使わず、完成1分足の終値列だけを使う。
// d1=1分変化, d2=2分変化, 加速度, 平均変化倍率, ブレイク, 同方向本数 の6条件スコア + 急変条件。

export interface ShockParams {
  move1: number; move2: number; shock1: number; shock2: number; accelTh: number;
  avgLen: number; avgMult: number; breakLen: number; sameDirLen: number; sameDirNeed: number;
}
export const DEFAULT_SHOCK_PARAMS: ShockParams = {
  move1: 25, move2: 40, shock1: 40, shock2: 70, accelTh: 15,
  avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2,
};

export interface ShockSignal {
  dir: 'up' | 'down';
  d1: number;        // 1分変化(円)
  d2: number;        // 2分変化(円)
  score: number;     // 採用方向のスコア(0..6)
}

/** 完成1分足の終値列(古い→新しい)から、最新完成足で急変を判定。該当なし/データ不足は null。
 *  クールダウンは含まない(呼び出し側でバー数方式を適用)。 */
export function detectShock(closes: number[], p: ShockParams = DEFAULT_SHOCK_PARAMS): ShockSignal | null {
  const n = closes.length;
  const need = p.avgLen + 2;               // avgAbsMove(現在足を除く avgLen 本) + 現在足
  if (n < need) return null;
  const last = n - 1;
  const C0 = closes[last]!, C1 = closes[last - 1]!, C2 = closes[last - 2]!;
  const d1 = C0 - C1;
  const d2 = C0 - C2;
  const accel = d1 - (C1 - C2);

  // 現在足を除く直近 avgLen 本の1分変化幅の平均
  let sumAbs = 0;
  for (let i = 1; i <= p.avgLen; i++) sumAbs += Math.abs(closes[last - i]! - closes[last - i - 1]!);
  const avgAbsMove = sumAbs / p.avgLen;

  // 現在足を除く直近 breakLen 本の最高/最安終値
  let hi = -Infinity, lo = Infinity;
  for (let i = 1; i <= p.breakLen; i++) { const v = closes[last - i]!; if (v > hi) hi = v; if (v < lo) lo = v; }

  // 直近 sameDirLen 本の1分変化の符号本数
  let upCount = 0, dnCount = 0;
  for (let i = 0; i < p.sameDirLen; i++) {
    const diff = closes[last - i]! - closes[last - i - 1]!;
    if (diff > 0) upCount++; else if (diff < 0) dnCount++;
  }

  const aUp = d1 >= p.move1, bUp = avgAbsMove > 0 && d1 >= avgAbsMove * p.avgMult,
        cUp = d2 >= p.move2, dUp = upCount >= p.sameDirNeed, eUp = C0 > hi, fUp = accel >= p.accelTh;
  const aDn = d1 <= -p.move1, bDn = avgAbsMove > 0 && -d1 >= avgAbsMove * p.avgMult,
        cDn = d2 <= -p.move2, dDn = dnCount >= p.sameDirNeed, eDn = C0 < lo, fDn = accel <= -p.accelTh;
  const b = (x: boolean): number => x ? 1 : 0;
  const upScore = b(aUp) + b(bUp) + b(cUp) + b(dUp) + b(eUp) + b(fUp);
  const dnScore = b(aDn) + b(bDn) + b(cDn) + b(dDn) + b(eDn) + b(fDn);

  const upShockRaw = (d1 >= p.shock1 && (d2 >= p.shock2 || eUp)) || upScore >= 4;
  const dnShockRaw = (d1 <= -p.shock1 && (d2 <= -p.shock2 || eDn)) || dnScore >= 4;

  if (upScore > dnScore && upShockRaw) return { dir: 'up', d1, d2, score: upScore };
  if (dnScore > upScore && dnShockRaw) return { dir: 'down', d1, d2, score: dnScore };
  return null;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npx vitest run server/shockDetector.test.ts`
Expected: PASS(5 tests)。落ちる場合はテストの合成系列を調整(検知パラメータは変えない)。

- [ ] **Step 5: コミット**

```bash
git add server/shockDetector.ts server/shockDetector.test.ts
git commit -m "feat(alerts): price-change shock detector (yen-based score)"
```

---

## Task 2: DetectionKind に 'shock' を追加(型のみ)

**Files:** Modify `server/alertDetector.ts`, `server/types.ts`

- [ ] **Step 1: `server/alertDetector.ts`** の `DetectionKind` を拡張

```ts
export type DetectionKind = 'slope' | 'magnitude' | 'granville' | 'shock';  // shock = 価格変化スコア急変(短期/長期の後継)
```

- [ ] **Step 2: `server/types.ts`** の `AlertEventPayload.detectionKind` を拡張

```ts
  detectionKind: 'slope' | 'magnitude' | 'granville' | 'shock';
```

- [ ] **Step 3: typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0(まだ 'shock' を生成する箇所は無いので型エラーは出ない)。

- [ ] **Step 4: コミット**

```bash
git add server/alertDetector.ts server/types.ts
git commit -m "feat(alerts): add 'shock' detection kind"
```

---

## Task 3: alertEngine に shock を統合し、realtime z-score 経路を撤去

**Files:** Modify `server/alertEngine.ts`, `server/alertEngine.test.ts`

READ `server/alertEngine.ts` 全体を先に読むこと。現状: `evaluateBarsNiy`(granville + detectBurst/detectTrend)と `evaluateRealtimeNiy`(60s/300s rolling z-score)。

- [ ] **Step 1: `evaluateBarsNiy` の burst/trend ブロックを shock に差し替え。** granville ブロックは**そのまま残す**(先に評価)。burst/trend(detectBurst/detectTrend を使う部分)を削除し、以下に置換:

```ts
  // 急変(価格変化スコア方式)。完成足のみ(末尾=進行中バーを除外)。バー数クールダウンで間引く。
  const completed = bars.slice(0, -1).map(b => b.close);
  const shock = detectShock(completed, DEFAULT_SHOCK_PARAMS);
  if (shock) {
    const lastCompleted = bars[bars.length - 2]!;        // 評価対象の完成足
    const bar = Math.floor(lastCompleted.t / 60_000);    // 「バーインデックス」=分インデックス
    if (shockCanFire(sym, bar)) {
      shockMarkFired(sym, bar);
      const ctx = computeContext(bars);
      const prevClose = completed[completed.length - 2] ?? lastCompleted.close;
      console.log(`[alertEngine] ${sym} shock ${shock.dir} d1=${Math.round(shock.d1)}円 score=${shock.score}/6`);
      sink({
        symbol: sym, symbolLabel: meta.labelJa + ' (急変)',
        changePercent: prevClose > 0 ? (shock.d1 / prevClose) * 100 : 0,
        windowSeconds: 60, detectionKind: 'shock', direction: shock.dir,
        triggeredAt: lastCompleted.t,
        change15min: ctx.change15min, pa15min: ctx.pa15min, range1h: ctx.range1h,
        zscore: 0,
        note: `急変 ${shock.dir === 'up' ? '↑' : '↓'}${Math.round(shock.d1)}円 (1分) / 2分 ${Math.round(shock.d2)}円 / score ${shock.score}/6`,
      });
    }
  }
```

  併せて、`evaluateBarsNiy` 冒頭の `if (!bars || bars.length < 65) return;` は維持(granville は 106 本必要・内部ガード、shock は completed≥32 を内部ガード)。`completed` が 2 本未満になる極小ケースでも `detectShock` の `n < need` ガードで null になるので安全。

- [ ] **Step 2: バー数クールダウンを `alertEngine.ts` に追加**(per-process、テスト用 reset 付き)

```ts
// 急変専用のバー数クールダウン(直近ラベルの分インデックスから cooldownBars 本超で再発火可)。
// alertCooldown(共有・時間ベース)とは別系統。プロセスごとに独立。
const SHOCK_COOLDOWN_BARS = 3;
const lastShockBar = new Map<string, number>();
function shockCanFire(symbol: string, bar: number): boolean {
  const prev = lastShockBar.get(symbol);
  return prev === undefined || bar - prev > SHOCK_COOLDOWN_BARS;
}
function shockMarkFired(symbol: string, bar: number): void { lastShockBar.set(symbol, bar); }
export function _resetShockCooldown(): void { lastShockBar.clear(); }
```

  `import { detectShock, DEFAULT_SHOCK_PARAMS } from './shockDetector.js';` を追加。不要になった import(`detectBurst`,`detectTrend`,`returns`,`returns5m`,`stdDev`,`getRollingReturn`)を整理。`computeContext`,`detectGranville*`,`canFire`,`markFired`(granville 用)は残す。

- [ ] **Step 3: `evaluateRealtimeNiy` を削除**(関数本体とエクスポートごと撤去)。これは短期/長期の realtime z-score 専用だったため、shock 方式では不要。

- [ ] **Step 4: `server/alertEngine.test.ts` を更新。** 既存の `evaluateBarsNiy` burst テストは shock 方式に合わせて書き換える(quiet-then-jump で `detectionKind==='shock'`、`direction` 確認、`note` に「急変」)。`evaluateRealtimeNiy` を参照するテストがあれば削除。`beforeEach` で `_resetShockCooldown()` も呼ぶ。

```ts
// 置換後の中心ケース例
it('fires a shock alert through the sink on a quiet-then-jump series', () => {
  const fired: AlertEventPayload[] = [];
  // 完成足を ≥34 本与える(末尾は進行中として1本余分に積む)
  const bars = [];
  let p = 30000;
  for (let i = 0; i < 34; i++) { p += (i % 2 === 0 ? 1 : -1); bars.push({ t: i * 60_000, close: p }); }
  bars.push({ t: 34 * 60_000, close: p + 50 });   // 完成: index33 まで, 末尾(34)=進行中として除外される
  bars.push({ t: 35 * 60_000, close: p + 50 });   // 進行中バー
  evaluateBarsNiy(bars, META, DEFAULT_PARAMS, 35 * 60_000, (e) => fired.push(e));
  expect(fired.some(e => e.detectionKind === 'shock')).toBe(true);
});
```
  > 注意: `evaluateBarsNiy(bars, meta, params, now, sink)` の `params`(DetectorParams)は granville/旧検知用。shock は `DEFAULT_SHOCK_PARAMS` を内部で使う(engine 内固定)。テストの bars 本数は granville(106本)に満たないので granville は発火せず shock のみを検証できる。

- [ ] **Step 5: 全スイート + typecheck**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 失敗するのは「evaluateRealtimeNiy を import している箇所」(priceLoop/collector/alertLoop)。これらは Task 4 で直す。**この時点では alertEngine 単体テストと型(engine)を green に**し、呼び出し側の型エラーが残るのは想定内(次タスクで解消)。もし全体を緑にしたい場合は Task 4 と続けて実施し、まとめてコミットしてよい。

- [ ] **Step 6: コミット**(Task 4 と続けて実施する場合は Step 6 を Task 4 末尾に統合可)

```bash
git add server/alertEngine.ts server/alertEngine.test.ts
git commit -m "feat(alerts): replace short/long z-score with shock detector in engine"
```

---

## Task 4: realtime 経路の呼び出し撤去(alertLoop / priceLoop / collector)

**Files:** Modify `server/loops/alertLoop.ts`, `server/loops/priceLoop.ts`, `collector/alertCollector.ts`(+ それぞれのテスト)

READ 各ファイルを先に読むこと。

- [ ] **Step 1: `server/loops/alertLoop.ts`** から `evaluateRealtime`(エクスポート関数)を削除。`evaluateAndFire`(60秒タイマで `evaluateBarsNiy` を呼ぶ部分)は残す。`evaluateRealtimeNiy` の import を削除。`barsFor` 等は維持。

- [ ] **Step 2: `server/loops/priceLoop.ts`** から `import { evaluateRealtime } ...` と tick 内の `evaluateRealtime();` 呼び出しを削除。`feedRealtimePrice` は維持(バー構築に必要)。

- [ ] **Step 3: `collector/alertCollector.ts`** の `onPrice` から `evaluateRealtimeNiy(...)` 呼び出しを削除し、`feedRealtimePrice` のみ残す。`evaluateRealtimeNiy` の import を削除。`onMinute`→`evaluateBarsNiy` 経路はそのまま(これが急変を発火)。

```ts
  onPrice(symbol: string, price: number, t: number): void {
    feedRealtimePrice(symbol, price, t);
    // 急変は確定足ベース(onMinute → evaluateBarsNiy)。realtime z-score は廃止。
  }
```

- [ ] **Step 4: テスト更新。** `collector/alertCollector.test.ts` の burst テストは「onPrice を分ごとに与え、onMinute で shock 発火」を確認する形に調整(detectionKind==='shock')。`evaluateRealtime`/`evaluateRealtimeNiy` を参照する既存テスト(alertLoop 系)があれば削除/更新。

- [ ] **Step 5: 全スイート + typecheck**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json`
Expected: 全 PASS、tsc exit 0。

- [ ] **Step 6: collector バンドル smoke**

Run: `npm run build:collector`
Expected: exit 0。

- [ ] **Step 7: コミット**

```bash
git add server/loops/alertLoop.ts server/loops/priceLoop.ts collector/alertCollector.ts server/loops/*.test.ts collector/*.test.ts
git commit -m "refactor(alerts): remove realtime z-score path (shock is bar-confirmed)"
```

---

## Task 5: 表示・LLM・履歴分類に 'shock'='急変' を通す

**Files:** Modify `server/alertHistory.ts`, `web/components/alertBanner.ts`, `server/llm/openai.ts`, `server/routes/explain.ts`, `web/lib/api.ts`

- [ ] **Step 1: `server/alertHistory.ts`** の `rowKind` を更新: `detection_kind === 'shock'` → `'急変'`(granville と同様の特別扱い)。

```ts
export function rowKind(detectionKind: string | null, windowSeconds: number | null): string {
  if (detectionKind === 'granville') return 'グランビル';
  if (detectionKind === 'shock') return '急変';
  return kindLabel(windowSeconds);
}
```

- [ ] **Step 2: `web/components/alertBanner.ts`** の kindLabel 分岐に shock を追加:

```ts
  const kindLabel = alert.detectionKind === 'granville' ? 'グランビル'
    : alert.detectionKind === 'shock' ? '急変'
    : alert.detectionKind === 'slope' ? UI.ja.flash : UI.ja.trend;
```

- [ ] **Step 3: `server/llm/openai.ts`** — `ExplainInput.detectionKind`(:132)に 'shock' を追加し、kindLabel(:194)を更新:

```ts
  detectionKind: 'magnitude' | 'slope' | 'shock';
```
```ts
  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ'
    : input.detectionKind === 'shock' ? '急変' : 'トレンド';
```

- [ ] **Step 4: `server/routes/explain.ts`** — バリデーション(:27)で 'shock' を受理し、型(:15)を拡張:

```ts
  detectionKind?: 'magnitude' | 'slope' | 'shock';
```
```ts
      || (body.detectionKind !== 'magnitude' && body.detectionKind !== 'slope' && body.detectionKind !== 'shock')) {
```

- [ ] **Step 5: `web/lib/api.ts`** — explain リクエストの detectionKind 型に 'shock' を追加(READ して該当 union を更新)。

- [ ] **Step 6: 全スイート + typecheck + web ビルド**

Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npx vite build`
Expected: 全 PASS、tsc exit 0、vite build exit 0。

- [ ] **Step 7: コミット**

```bash
git add server/alertHistory.ts web/components/alertBanner.ts server/llm/openai.ts server/routes/explain.ts web/lib/api.ts
git commit -m "feat(alerts): surface 'shock' kind in banner/history/LLM/explain"
```

---

## Task 6: ドキュメント + バージョン + リリース(LEADER 主導、評価通過後)

- [ ] **Step 1:** `USER_GUIDE.md` / `docs/USER_GUIDE.html` のアラート説明を更新: 短期/長期 z-score → 「急変(価格変化スコア方式、確定1分足、バー数クールダウン)」。超短期フラッシュ/グランビルは不変。
- [ ] **Step 2:** バージョン bump `package.json` + `src-tauri/tauri.conf.json`(0.4.23 → 0.4.24)。
- [ ] **Step 3:** `feat`/`docs` コミット + `chore(release): bump version to 0.4.24`。push。
- [ ] **Step 4:** 署名ビルド + リリース: `npm run release:build` → `release:latest-json`(Bash で RELEASE_NOTES=... を UTF-8 保持) → `gh release create v0.4.24 --target master` で .exe+.sig+latest.json。公開 latest.json を再DL検証。

---

## Risks & Decisions(リーダー注記)

1. **確定足ベース(realtime 撤去)** = 提示ロジックに忠実。ラベルは最大~60秒遅延。超短期フラッシュが速い動きを補完。**もし realtime 即時発火も残したい場合**は別途「ライブ進行中バー版」を追加可能(リペイント注意)。
2. **shock 専用バー数クールダウン**(3本)はグランビル/超短期の共有時間クールダウンと独立。→ 同一の強い動きで複数種別が同時に出うる。指標仕様に忠実な既定。煩ければ shock 発火時に共有クールダウンも markFired する一方向結合に変更可。
   - **バー数の数え方**: `bar = floor(完成足.t / 60000)`(分インデックス)で数える。同一立会内では連続1分足=連続分インデックスなのでチャートの連続バー数と一致。ただし**夜間など立会ギャップを跨ぐと分インデックスが大きく飛ぶため、ギャップ直後の最初の急変は必ずクールダウンを通過する**(チャートの gapless bar_index とは異なる)。実害は小さく、場替わり後の再アームとして自然なので**この挙動を既定として許容**する(ユーザー確認済み)。厳密な gapless 連番が必要なら完成足ごとに +1 する連番カウンタに差し替え可。
3. **cross-process 重複**: collector と monitor が両方確定足で評価しても、`insertAlertIfNew`(symbol+dir+kind='shock'+window=60、±窓)が近接重複を吸収。バー数クールダウンは per-process。
4. **granville 温存**: granville は先に評価、共有クールダウンで自種の連発を抑制(従来どおり)。shock とは別クールダウンなので相互抑制はしない(注記2)。
5. **detectionKind='shock' の DB 値**: TEXT カラムなので移行不要。履歴の `summarize` は rowKind でグループ化(急変が独立カテゴリになる)。

## Self-Review
- スペック網羅: 6条件スコア/急変条件/方向優勢/バー数クールダウン/円ベース/確定足/NIY限定 — Task 1+3 で実装。表示系 — Task 5。
- 型整合: `detectionKind` union を alertDetector.ts と types.ts と openai/explain/api で一致させる(Task 2+5)。`ShockSignal`/`ShockParams` は Task 1 定義を Task 3 が利用。
- プレースホルダ無し: 各ステップに具体コード/コマンドあり。
