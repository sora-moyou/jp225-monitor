# 急変アラートパラメータの設定可能化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 急変(shock)検知のしきい値・寄り抑制本数・超短期フラッシュ値幅を `config.json`（+ 🎛️詳細パラメータUI）から変更できるようにし、**リビルド不要・モニター/デーモン両方に反映**する。

**Architecture:** 既存の `configStore`(resolver) + `/api/settings` + 詳細パラメータUI の仕組みに新パラメータを追加。検知側(`alertEngine`/`tickDetector`/開ガード)は固定定数の代わりに resolver を**評価のたびに**呼ぶ。`loadConfig` を **mtime ベースのキャッシュ無効化**にして、別プロセスのデーモンもファイル更新を1分以内に自動検知（再起動不要）。

**Tech Stack:** TypeScript ESM(`.js`)、Vitest、Express、Vanilla TS フロント。設定は `~/.jp225-monitor/config.json`。

---

## 設計判断(リーダー)

- **公開するノブ(10)**: `shockMove1Yen`(25)/`shockMove2Yen`(40)/`shock1Yen`(50)/`shock2Yen`(70)/`shockAccelYen`(10)/`shockAvgMult`(2.0)/`shockScoreNeed`(4)/`shockCooldownBars`(3)/`openGuardBars`(3)/`flashYen`(80)。既定値は現行のハードコード値と一致。
- **窓長は固定**: `avgLen`(30)/`breakLen`(10)/`sameDirLen`(3)/`sameDirNeed`(2) は構造的なので `DEFAULT_SHOCK_PARAMS` のまま（UI には出さない）。
- **反映方式**: 検知側は resolver を毎評価呼ぶ（≒1分に1回）。`loadConfig` の mtime キャッシュにより、モニター保存→ファイル更新→デーモンが次の評価で再読込。ループ再起動不要（ポーリング間隔/ポートのみ従来どおり再起動扱い）。
- **`scoreNeed`**: 6条件中いくつで「急変」とみなすか（現行ハードコード `>=4`）を可変化。

---

## File Structure

**変更**: `server/shockDetector.ts`(scoreNeed 追加)、`server/configStore.ts`(mtime/bounds/resolver)、`server/alertEngine.ts`(resolver 利用)、`server/alertHistory.ts`(emitAlert の開ガード nBars)、`collector/alertCollector.ts`(sink の開ガード nBars)、`server/tickDetector.ts`(flashYen)、`server/routes/settings.ts`(新パラメータ受理・DRY化)、`web/components/paramsModal.ts`(PARAMS 配列)、`web/index.html`(入力欄)。
**テスト**: 既存 `configStore.test.ts`/`shockDetector.test.ts` 拡張 + 新規 `server/configResolvers.test.ts`。

---

## Task 1: shockDetector に `scoreNeed` を追加(可変スコア閾値)

**Files:** Modify `server/shockDetector.ts`, `server/shockDetector.test.ts`

- [ ] **Step 1: テストを追加（失敗確認用）** — `shockDetector.test.ts` に、scoreNeed を下げると弱い動きでも発火することを確認するケースを足す:

```ts
  it('respects a custom scoreNeed (lower = fires more easily)', () => {
    // d1=30(>=move1 25, <shock1 50), 緩い上昇でスコアは出るが既定 scoreNeed=4 では未達のケースを作り、
    // scoreNeed=2 なら発火することを確認。
    const c: number[] = []; let p = 30000;
    for (let i = 0; i < 33; i++) { p += (i % 2 === 0 ? 1 : -1); c.push(p); }
    c.push(p + 30);   // d1=30: aUp,bUp,eUp,fUp は立つが d2 が 30 前後で cUp 怪しい → score 4 前後
    const strict = detectShock(c, { ...DEFAULT_SHOCK_PARAMS, scoreNeed: 6 });   // 厳しく → 出ない想定
    const loose  = detectShock(c, { ...DEFAULT_SHOCK_PARAMS, scoreNeed: 2 });   // 緩く → 出る想定
    expect(strict).toBeNull();
    expect(loose).not.toBeNull();
  });
```
  > 既存の「fires up/down」テストは `shock1` 経由(d1=55)で発火するので scoreNeed 追加後も通る。`DEFAULT_SHOCK_PARAMS.scoreNeed` 既定は 4 とする。

- [ ] **Step 2: 失敗確認** — Run: `cd C:/Users/user/Desktop/Finance_Monitor && npx vitest run server/shockDetector.test.ts` → 新テストが `scoreNeed` 未定義で型/挙動エラー。

- [ ] **Step 3: 実装** — `ShockParams` に `scoreNeed: number;` を追加、`DEFAULT_SHOCK_PARAMS` に `scoreNeed: 4` を追加、`detectShock` 内の `upScore >= 4` / `dnScore >= 4` を `>= p.scoreNeed` に置換。

```ts
export interface ShockParams {
  move1: number; move2: number; shock1: number; shock2: number; accelTh: number;
  avgLen: number; avgMult: number; breakLen: number; sameDirLen: number; sameDirNeed: number;
  scoreNeed: number;   // 急変とみなす最小スコア(6条件中)
}
export const DEFAULT_SHOCK_PARAMS: ShockParams = {
  move1: 25, move2: 40, shock1: 50, shock2: 70, accelTh: 10,
  avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2, scoreNeed: 4,
};
```
  detectShock 内:
```ts
  const upShockRaw = (d1 >= p.shock1 && (d2 >= p.shock2 || eUp)) || upScore >= p.scoreNeed;
  const dnShockRaw = (d1 <= -p.shock1 && (d2 <= -p.shock2 || eDn)) || dnScore >= p.scoreNeed;
```

- [ ] **Step 4: 通過確認** — Run: `npx vitest run server/shockDetector.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS, exit 0。新テストの合成系列がうまく境界に乗らない場合は **テスト系列の jump 値だけ**調整（scoreNeed の意味は変えない）。

- [ ] **Step 5: コミット** — `git add server/shockDetector.ts server/shockDetector.test.ts && git commit -m "feat(alerts): make shock score threshold (scoreNeed) a param"`

---

## Task 2: configStore に新パラメータ + mtime キャッシュ無効化 + resolver

**Files:** Modify `server/configStore.ts`, `server/configStore.test.ts`; Create `server/configResolvers.test.ts`

- [ ] **Step 1: mtime キャッシュのテストを追加** — `configStore.test.ts` に、保存→ファイル更新で `loadConfig` が再読込することを確認するケース（一時ディレクトリで HOME を差し替える既存パターンに倣う。既存テストの構造を READ して合わせること）。最低限、`resolveShockParams()` が config 値を反映し、未設定なら既定を返すことを `configResolvers.test.ts` で確認:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// configStore は homedir()/.jp225-monitor/config.json を読む。HOME を一時dirに差し替える。
// 既存 configStore.test.ts が HOME/USERPROFILE をどう差し替えているか READ して同じ方法を使うこと。

import { resolveShockParams, resolveOpenGuardBars, resolveFlashYen, resetConfigCache } from './configStore.js';
import { DEFAULT_SHOCK_PARAMS } from './shockDetector.js';

describe('shock param resolvers', () => {
  beforeEach(() => resetConfigCache());
  it('returns defaults when unset', () => {
    const p = resolveShockParams();
    expect(p.shock1).toBe(DEFAULT_SHOCK_PARAMS.shock1);   // 50
    expect(p.accelTh).toBe(DEFAULT_SHOCK_PARAMS.accelTh); // 10
    expect(resolveOpenGuardBars()).toBe(3);
    expect(resolveFlashYen()).toBe(80);
  });
});
```
  > 実 HOME を汚さないため、テストは既存 `configStore.test.ts` の隔離手法に合わせる（環境変数差し替え or 一時ファイル）。READ してから書くこと。

- [ ] **Step 2: 失敗確認** — Run: `npx vitest run server/configResolvers.test.ts` → resolver 未実装で FAIL。

- [ ] **Step 3: 実装** — `server/configStore.ts`:
  - import に `statSync` 追加、`DEFAULT_SHOCK_PARAMS`, `type ShockParams` を `./shockDetector.js` から import。
  - `UserConfig` に 10 個の optional number フィールドを追加: `shockMove1Yen, shockMove2Yen, shock1Yen, shock2Yen, shockAccelYen, shockAvgMult, shockScoreNeed, shockCooldownBars, openGuardBars, flashYen`。
  - `PARAM_BOUNDS` に追加:
```ts
  shockMove1Yen:    { min: 1, max: 500,  default: 25 },
  shockMove2Yen:    { min: 1, max: 1000, default: 40 },
  shock1Yen:        { min: 1, max: 1000, default: 50 },
  shock2Yen:        { min: 1, max: 2000, default: 70 },
  shockAccelYen:    { min: 0, max: 1000, default: 10 },
  shockAvgMult:     { min: 0.1, max: 20, default: 2.0 },
  shockScoreNeed:   { min: 2, max: 6,    default: 4 },
  shockCooldownBars:{ min: 0, max: 120,  default: 3 },
  openGuardBars:    { min: 0, max: 60,   default: 3 },
  flashYen:         { min: 1, max: 1000, default: 80 },
```
  - `loadConfig` を mtime キャッシュに変更（既存の戻り値挙動は維持）:
```ts
let cached: UserConfig | null = null;
let cachedMtime = -1;
export function loadConfig(): UserConfig {
  const file = CONFIG_FILE();
  if (!existsSync(file)) { if (!cached) cached = {}; return cached; }
  let mtime = -1;
  try { mtime = statSync(file).mtimeMs; } catch { /* ignore */ }
  if (cached && mtime === cachedMtime) return cached;
  try {
    cached = JSON.parse(readFileSync(file, 'utf-8')) as UserConfig;
    cachedMtime = mtime;
    return cached;
  } catch (err) {
    console.error('[configStore] load failed:', err);
    if (!cached) cached = {};
    return cached;
  }
}
```
  - `saveConfig` 末尾で `try { cachedMtime = statSync(file).mtimeMs; } catch { cachedMtime = -1; }` を追加（自分の書込みで余計な再読込をしないため）。
  - `resetConfigCache` を `cached = null; cachedMtime = -1;` に。
  - 汎用 resolver と shock resolver を追加:
```ts
function resolveNumeric(key: keyof typeof PARAM_BOUNDS): number {
  const v = (loadConfig() as Record<string, unknown>)[key];
  return typeof v === 'number' ? v : PARAM_BOUNDS[key].default;
}
export function resolveShockParams(): ShockParams {
  return {
    ...DEFAULT_SHOCK_PARAMS,   // 固定: avgLen/breakLen/sameDirLen/sameDirNeed
    move1: resolveNumeric('shockMove1Yen'),
    move2: resolveNumeric('shockMove2Yen'),
    shock1: resolveNumeric('shock1Yen'),
    shock2: resolveNumeric('shock2Yen'),
    accelTh: resolveNumeric('shockAccelYen'),
    avgMult: resolveNumeric('shockAvgMult'),
    scoreNeed: resolveNumeric('shockScoreNeed'),
  };
}
export function resolveShockCooldownBars(): number { return resolveNumeric('shockCooldownBars'); }
export function resolveOpenGuardBars(): number { return resolveNumeric('openGuardBars'); }
export function resolveFlashYen(): number { return resolveNumeric('flashYen'); }
```

- [ ] **Step 4: 通過確認** — Run: `npx vitest run server/configResolvers.test.ts server/configStore.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS, exit 0。

- [ ] **Step 5: コミット** — `git add server/configStore.ts server/configStore.test.ts server/configResolvers.test.ts && git commit -m "feat(config): shock param bounds/resolvers + mtime cache invalidation"`

---

## Task 3: 検知側を resolver 駆動にする（モニター/デーモン両対応）

**Files:** Modify `server/alertEngine.ts`, `server/alertHistory.ts`, `collector/alertCollector.ts`, `server/tickDetector.ts`

- [ ] **Step 1: `server/alertEngine.ts`** — shock 評価を resolver 駆動に:
  - `import { resolveShockParams, resolveShockCooldownBars } from './configStore.js';` を追加。
  - `detectShock(completed, DEFAULT_SHOCK_PARAMS)` → `detectShock(completed, resolveShockParams())`。
  - バー数クールダウン: 固定 `SHOCK_COOLDOWN_BARS` の代わりに `shockCanFire` で `resolveShockCooldownBars()` を使う:
```ts
function shockCanFire(symbol: string, bar: number): boolean {
  const prev = lastShockBar.get(symbol);
  return prev === undefined || bar - prev > resolveShockCooldownBars();
}
```
  （`SHOCK_COOLDOWN_BARS` 定数は削除。`lastShockBar`/`shockMarkFired`/`_resetShockCooldown` は維持。）`DEFAULT_SHOCK_PARAMS` の import が他で使われていなければ整理。

- [ ] **Step 2: 開ガードを config 本数に** — `isWithinOpenGuard(epochMs, nBars?)` は既に nBars 引数を持つ。呼び出し側で resolver を渡す:
  - `server/alertHistory.ts` の emitAlert: `import { resolveOpenGuardBars } from './configStore.js';` を追加し、`if (isWithinOpenGuard(p.triggeredAt, resolveOpenGuardBars())) return;`。
  - `collector/alertCollector.ts` の sink: `import { resolveOpenGuardBars } from '../server/configStore.js';` を追加し、`if (isWithinOpenGuard(e.triggeredAt, resolveOpenGuardBars())) return;`。

- [ ] **Step 3: 超短期フラッシュ値幅を config に** — `server/tickDetector.ts`:
  - `import { resolveFlashYen } from './configStore.js';` を追加。
  - `handleOne` 内で固定 `ABSOLUTE_THRESHOLD_YEN` の代わりに `const threshold = resolveFlashYen();` を評価ごとに読み、`if (Math.abs(yen) >= threshold)` と `console.log` の閾値表示をそれに置換。（定数 `ABSOLUTE_THRESHOLD_YEN` は削除 or 既定参照用に残すが未使用警告は問題なし＝noUnusedLocals 無効。）

- [ ] **Step 4: テスト更新。** 既存 `alertEngine.test.ts`/`alertCollector.test.ts`/`tickDetector` 系テストは、resolver が config 未設定時に既定(=現行値)を返すので**挙動不変**のはず。`resetConfigCache()` を呼ぶ必要があるテストがあれば追加（config 未設定＝既定なので通常は不要）。`server/alertHistory.test.ts` 等が開ガードに掛からないことを確認。

- [ ] **Step 5: 全スイート + typecheck + collector バンドル** — Run: `npx vitest run && npx tsc --noEmit -p tsconfig.json && npm run build:collector` → 全 PASS、exit 0、build 0。

- [ ] **Step 6: コミット** — `git add server/alertEngine.ts server/alertHistory.ts collector/alertCollector.ts server/tickDetector.ts && git commit -m "feat(alerts): drive shock/open-guard/flash thresholds from config (runtime-tunable)"`

---

## Task 4: /api/settings に新パラメータを通す（受理・検証・返却、DRY 化）

**Files:** Modify `server/routes/settings.ts`

READ `server/routes/settings.ts` 全体を先に読むこと。現状は 4 パラメータをハードコードで `applyNumberField`。新規 10 を足すと冗長なので、**数値パラメータを配列で回す**形に DRY 化する。

- [ ] **Step 1: 数値パラメータのキー一覧を定義**（restart 要否のメタ付き）。`PARAM_BOUNDS` のキー集合を使う。`getSettingsHandler` は全 resolver 値を返すよう拡張:

```ts
// restart が要るのは pricePollMs/newsPollMs/port/cooldownMin のみ。その他(shock系)は resolver 即時反映。
const NUMERIC_PARAM_KEYS = [
  'pricePollMs','newsPollMs','port','cooldownMin',
  'shockMove1Yen','shockMove2Yen','shock1Yen','shock2Yen','shockAccelYen',
  'shockAvgMult','shockScoreNeed','shockCooldownBars','openGuardBars','flashYen',
] as const;
```
  `getSettingsHandler` の res.json に、`resolveNumeric` 相当で各キーを追加（既存4つに加えて新10）。実装簡略化のため `configStore` に「全数値パラメータを解決して返す」ヘルパ `resolveAllNumericParams(): Record<string, number>` を追加してもよい（任意・DRY 向上）。

- [ ] **Step 2: POST ハンドラを配列ループに。** 各キーについて `applyNumberField(key, existing[key], body[key])` を回し、エラー集約。`next: UserConfig` は既存文字列フィールド + 全数値フィールドをループで埋める。保存後、restart 要否を判定:
  - `pricePollMs` 変化 → `restartPriceLoop()`
  - `newsPollMs` 変化 → `restartNewsLoop()`
  - `cooldownMin` 変化 → `setCooldownMs(resolveCooldownMin()*60_000)`
  - `port` 変化 → `portRequiresRestart`
  - **shock 系は何もしない**（resolver が次評価で拾う）。
  `applyNumberField` の `name` 引数型は `keyof typeof PARAM_BOUNDS` に広げる（4ユニオンのハードコードをやめる）。`validateParam` はそのまま使える。

- [ ] **Step 3: 型整合 + 全スイート** — Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run` → exit 0、全 PASS。`settings` 系テストがあれば新パラメータの受理/範囲外400 を1ケース追加。

- [ ] **Step 4: コミット** — `git add server/routes/settings.ts server/configStore.ts && git commit -m "feat(settings): accept/return shock params via /api/settings (DRY numeric loop)"`

---

## Task 5: 詳細パラメータUIに「急変アラート」セクションを追加

**Files:** Modify `web/components/paramsModal.ts`, `web/index.html`

- [ ] **Step 1: `web/index.html`** の 詳細パラメータ モーダル（`settings-section` の「定期 API ポーリング / アラート」付近、READ して位置特定）に、新セクションを追加。各行は既存 cooldown 入力欄に倣う（`<label>` + `<input type="number">`）:

```html
      <fieldset class="settings-section">
        <legend>急変アラート (リビルド不要・即反映)</legend>
        <label>1分急変値幅 (円) <input type="number" id="params-shock1" min="1" max="1000" step="5"></label>
        <label>2分急変合計 (円) <input type="number" id="params-shock2" min="1" max="2000" step="5"></label>
        <label>加速度しきい値 (円) <input type="number" id="params-shock-accel" min="0" max="1000" step="5"></label>
        <label>1分スコア値幅 (円) <input type="number" id="params-shock-move1" min="1" max="500" step="5"></label>
        <label>2分スコア合計 (円) <input type="number" id="params-shock-move2" min="1" max="1000" step="5"></label>
        <label>平均変化倍率 <input type="number" id="params-shock-avgmult" min="0.1" max="20" step="0.1"></label>
        <label>急変スコア閾値 (2〜6) <input type="number" id="params-shock-score" min="2" max="6" step="1"></label>
        <label>急変クールダウン (本) <input type="number" id="params-shock-cooldown-bars" min="0" max="120" step="1"></label>
        <label>寄り抑制本数 <input type="number" id="params-open-guard-bars" min="0" max="60" step="1"></label>
        <label>超短期フラッシュ値幅 (円) <input type="number" id="params-flash-yen" min="1" max="1000" step="5"></label>
      </fieldset>
```
  > 既存モーダルのマークアップ（`<label>` の構造/クラス）に合わせること。READ してスタイルを踏襲。

- [ ] **Step 2: `web/components/paramsModal.ts`** の `PARAMS` 配列に 10 行追加（key は config キー、inputId は上記 id）:

```ts
  { key: 'shock1Yen',        inputId: 'params-shock1' },
  { key: 'shock2Yen',        inputId: 'params-shock2' },
  { key: 'shockAccelYen',    inputId: 'params-shock-accel' },
  { key: 'shockMove1Yen',    inputId: 'params-shock-move1' },
  { key: 'shockMove2Yen',    inputId: 'params-shock-move2' },
  { key: 'shockAvgMult',     inputId: 'params-shock-avgmult' },
  { key: 'shockScoreNeed',   inputId: 'params-shock-score' },
  { key: 'shockCooldownBars',inputId: 'params-shock-cooldown-bars' },
  { key: 'openGuardBars',    inputId: 'params-open-guard-bars' },
  { key: 'flashYen',         inputId: 'params-flash-yen' },
```
  > `paramsModal.ts` は PARAMS を回して取得/保存する汎用実装なので**配列追加だけで動く**（refresh/save 双方）。小数 `shockAvgMult` も `Number(input.value)` で扱える。

- [ ] **Step 3: web ビルド + 型 + 全スイート** — Run: `npx vite build && npx tsc --noEmit -p tsconfig.json && npx vitest run` → exit 0、全 PASS。

- [ ] **Step 4: 手動確認の指示（任意）** — 開発起動で 🎛️ を開き、急変セクションに既定値（shock1=50 等）が表示され、保存→`config.json` に反映されることを目視（リリース前に leader が確認可）。

- [ ] **Step 5: コミット** — `git add web/components/paramsModal.ts web/index.html && git commit -m "feat(ui): 急変アラートパラメータを詳細パラメータモーダルに追加"`

---

## Task 6: ドキュメント + バージョン + リリース(LEADER 主導、評価通過後)

- [ ] **Step 1:** `USER_GUIDE.md`/`docs/USER_GUIDE.html` の詳細パラメータ説明に「急変アラート」ノブ群（リビルド不要で即反映、デーモンにも反映）を追記。
- [ ] **Step 2:** バージョン bump `package.json` + `src-tauri/tauri.conf.json`（0.4.25 → 0.4.26）。
- [ ] **Step 3:** `feat`/`docs` コミット + `chore(release): bump version to 0.4.26`。push。
- [ ] **Step 4:** 署名ビルド + リリース: `npm run release:build` → `release:latest-json`(Bash, UTF-8 notes) → `gh release create v0.4.26 --target master` で .exe+.sig+latest.json。公開 latest.json 検証。

---

## Risks & Decisions(リーダー注記)

1. **mtime キャッシュ無効化**: `loadConfig` が毎回 `statSync`（極小）。デーモンは別プロセスだが、モニターが保存→ファイル mtime 更新→デーモンの次評価(≤1分)で再読込。再起動不要。`saveConfig` は自分の書込み mtime を `cachedMtime` に入れ、無駄な再読込を防ぐ。
2. **resolver を毎評価呼ぶコスト**: `evaluateBarsNiy`(1分に1回)・`tickDetector`(発火判定時)で `loadConfig()`（mtime 一致なら即キャッシュ返し）。負荷は無視可。
3. **既定値＝現行ハードコード値**: 未設定ユーザーは挙動不変。`ensureDefaults` で新キーも書き込むかは任意（resolver が既定フォールバックするので必須ではない）。UI は resolver 値（既定込み）を表示するので未書込みでも値は見える。
4. **窓長(avgLen 等)は非公開**: 構造的で誤設定リスクが高いため固定。要望が出たら追加可。
5. **DRY 化**: settings ルートを数値パラメータ配列ループに。今後ノブ追加は PARAM_BOUNDS + NUMERIC_PARAM_KEYS + paramsModal.PARAMS + index.html の4箇所に1行ずつ。

## Self-Review
- スペック網羅: shock 7 + クールダウン本数 + 寄り抑制本数 + フラッシュ値幅 を config 化、両プロセス反映(mtime)、UI 追加、検証。
- 型整合: `ShockParams.scoreNeed`(T1)→`resolveShockParams`(T2)→engine(T3)。`PARAM_BOUNDS` キー(T2)↔settings ループ(T4)↔paramsModal キー(T5)↔index.html id(T5) を一致。
- プレースホルダ無し: 各ステップに具体コード/コマンド。
