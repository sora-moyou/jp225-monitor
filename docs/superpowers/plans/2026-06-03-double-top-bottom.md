# ダブルトップ/ボトム検知アラート Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主要レベル(computeLevels の全レベル)に対し、ダブルトップ/ダブルボトムを検知してアラートを出す。発火位置=レベルの手前10円ゾーン。ネック割れ不要。

**Architecture:** 純粋関数 `detectDoubleTopBottom(levels, bars, current, params)` を新設。`levelsLoop`(主要レベル＋最新tick＋recent 1分足を持つ)に組み込み、各tickで検知→per-levelクールダウンで間引いて `emitAlert`。新 `detectionKind='dtb'` を型・表示・LLM に通す。

**Tech Stack:** TypeScript ESM(`.js`)、Vitest。NIY=F のみ。levelsLoop(8秒)。

---

## 仕様(ユーザー確定)

- **対象レベル**: すべての主要レベル(高安/節目/fib/前日終値/長期高安/ADR…種別問わず)。
- **ダブルトップ**(レジスタンス L、L ≥ 現値、下から接近):
  - **左(1つ目の山)= 髭タッチ**: 直近窓に、`high` が L に到達した足がある(`high >= L − touchTol`)。
  - **髭で超えたら不成立**: 窓内で `high > L + touchTol` の足が1本でもあれば INVALID(レベルがブレイクされた)。
  - **押し戻し(谷)**: 1つ目の山の後、価格が `L − pullbackYen` を下回った(ゾーンを下抜けた=2つの山の分離)。
  - **右(2つ目の山)= 手前10円**: 現値が `L − zoneYen ≤ 現値 ≤ L` かつ `現値 ≤ L`(まだ超えていない)。
  - → **ダブルトップ成立 → direction=down(反転売り)**。
- **ダブルボトム**(サポート L、L ≤ 現値、上から接近)は上記の上下対称:
  - 左=`low` が L に到達(`low <= L + touchTol`)、`low < L − touchTol` の足があれば INVALID(下抜け)、戻り(山)で `L + pullbackYen` を上回り、現値が `L ≤ 現値 ≤ L + zoneYen`。→ direction=up(反転買い)。

**既定パラメータ**: `zoneYen=10`(手前10円ゾーン), `touchTol=5`(髭タッチ許容/超過判定), `pullbackYen=10`(山谷の分離=ゾーン下抜け幅), `lookbackBars=240`(直近4時間で1つ目の山を探す), `cooldownMin=15`(同一レベルの再発火抑制)。

---

## File Structure

**新規**: `server/doublePattern.ts`(+ `server/doublePattern.test.ts`)。
**変更**: `server/alertDetector.ts`(DetectionKind に 'dtb')、`server/types.ts`(AlertEventPayload.detectionKind)、`web/types.ts`(DetectionKind エイリアス)、`server/loops/levelsLoop.ts`(検知組込+emitAlert)、`server/alertHistory.ts`(rowKind)、`web/components/alertBanner.ts`(kindLabel)、`server/llm/openai.ts`(ExplainInput/kindLabel)、`server/routes/explain.ts`(受理)。

---

## Task 1: 検知モジュール `doublePattern.ts`(純粋 + TDD)

**Files:** Create `server/doublePattern.ts`, `server/doublePattern.test.ts`

- [ ] **Step 1: 失敗テスト** — `server/doublePattern.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { detectDoubleTopBottom, DEFAULT_DOUBLE_PARAMS, type DBar } from './doublePattern.js';

// 直近足を簡単に作る(t は分インデックス, h/l のみ重要)
function bars(seq: Array<[number, number]>): DBar[] {   // [high, low]
  return seq.map(([h, l], i) => ({ t: i * 60_000, h, l }));
}

describe('detectDoubleTopBottom', () => {
  const L = 67500;
  const levels = [{ price: L, label: '長期高' }];

  it('ダブルトップ: 髭タッチ→押し戻し→手前10円で2つ目の山 → top(down)', () => {
    // 1つ目: high=67500(タッチ) → 押し戻し(67400台へ) → 現値67495(手前5円)
    const b = bars([
      [67500, 67450],   // 1つ目の山(髭タッチ L)
      [67460, 67390],   // 押し戻し(L-10=67490 を下抜け)
      [67430, 67380],
      [67470, 67440],   // 2つ目の山形成中
    ]);
    const sigs = detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS);
    expect(sigs.length).toBe(1);
    expect(sigs[0]!.kind).toBe('top');
    expect(sigs[0]!.level).toBe(L);
  });

  it('髭がレベルを超えたら不成立(ブレイク)', () => {
    const b = bars([
      [67520, 67450],   // 髭が L+20 を超えた → INVALID
      [67460, 67390],
      [67470, 67440],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67495, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('押し戻しが無い(ゾーンに留まる)なら不成立', () => {
    const b = bars([
      [67500, 67492],   // タッチ
      [67498, 67491],   // 押し戻し無し(L-10 を割らない)
      [67497, 67493],
    ]);
    expect(detectDoubleTopBottom(levels, b, 67496, DEFAULT_DOUBLE_PARAMS).length).toBe(0);
  });

  it('現値が手前10円ゾーン外なら出さない', () => {
    const b = bars([[67500, 67450], [67450, 67380], [67440, 67430]]);
    expect(detectDoubleTopBottom(levels, b, 67470, DEFAULT_DOUBLE_PARAMS).length).toBe(0);   // L-30
  });

  it('ダブルボトム: 上下対称 → bottom(up)', () => {
    const Llow = 66200;
    const lv = [{ price: Llow, label: '長期安' }];
    const b = bars([
      [66260, 66200],   // 1つ目の谷(髭タッチ L)
      [66330, 66250],   // 戻り(L+10=66210 を上抜け)
      [66340, 66270],
      [66280, 66230],   // 2つ目の谷形成中
    ]);
    const sigs = detectDoubleTopBottom(lv, b, 66205, DEFAULT_DOUBLE_PARAMS);
    expect(sigs[0]?.kind).toBe('bottom');
  });
});
```

- [ ] **Step 2: 失敗確認** — `cd C:/Users/user/Desktop/Finance_Monitor && npx vitest run server/doublePattern.test.ts` → FAIL(モジュール無し)。

- [ ] **Step 3: 実装** — `server/doublePattern.ts`

```ts
export interface DBar { t: number; h: number; l: number; }
export interface DoubleParams {
  zoneYen: number;      // 2つ目の山の接近ゾーン(手前10円)
  touchTol: number;     // 髭タッチ許容 / 超過判定
  pullbackYen: number;  // 山谷の分離(ゾーン下/上抜け幅)
  lookbackBars: number; // 1つ目の山を探す直近本数
}
export const DEFAULT_DOUBLE_PARAMS: DoubleParams = { zoneYen: 10, touchTol: 5, pullbackYen: 10, lookbackBars: 240 };

export interface DoubleSignal { kind: 'top' | 'bottom'; level: number; label: string; }

/** 主要レベル群に対しダブルトップ/ボトムを検知。bars は古い→新しい順の直近1分足(h/l)。 */
export function detectDoubleTopBottom(
  levels: { price: number; label: string }[],
  bars: DBar[],
  current: number,
  p: DoubleParams = DEFAULT_DOUBLE_PARAMS,
): DoubleSignal[] {
  if (!(current > 0) || bars.length < 3) return [];
  const win = bars.slice(-p.lookbackBars);
  const out: DoubleSignal[] = [];

  for (const lv of levels) {
    const L = lv.price;
    if (!(L > 0)) continue;

    // ── ダブルトップ(レジスタンス): L >= 現値, 下から手前10円ゾーン ──
    if (L >= current && current >= L - p.zoneYen && current <= L) {
      // 髭で超えたら不成立(窓内のどれかの high が L+touchTol を超えた=ブレイク)
      const exceeded = win.some(b => b.h > L + p.touchTol);
      // 1つ目の山=髭タッチ(high が L に到達)。タッチ足のインデックス(最も古いタッチ)
      const touchIdx = win.findIndex(b => b.h >= L - p.touchTol);
      if (!exceeded && touchIdx >= 0) {
        // 押し戻し: タッチ後に価格が L-pullbackYen を下回った(ゾーン下抜け=2つの山の分離)
        const pulled = win.slice(touchIdx + 1).some(b => b.l < L - p.pullbackYen);
        if (pulled) out.push({ kind: 'top', level: L, label: lv.label });
      }
    }

    // ── ダブルボトム(サポート): L <= 現値, 上から手前10円ゾーン ──
    if (L <= current && current <= L + p.zoneYen && current >= L) {
      const exceeded = win.some(b => b.l < L - p.touchTol);
      const touchIdx = win.findIndex(b => b.l <= L + p.touchTol);
      if (!exceeded && touchIdx >= 0) {
        const pushed = win.slice(touchIdx + 1).some(b => b.h > L + p.pullbackYen);
        if (pushed) out.push({ kind: 'bottom', level: L, label: lv.label });
      }
    }
  }
  return out;
}
```
  > 注: `L >= current && current >= L - zoneYen && current <= L` は「現値が L の手前10円以内(下)」。`L <= current` 側はボトム。同一 L が両方に入ることはない(等号の重なりは現値==L のときだけで、その場合 top/bottom どちらも touchTol 内なら出るが、cooldown と実運用上問題なし。気になればコメント)。

- [ ] **Step 4: 通過確認** — `npx vitest run server/doublePattern.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS。合成系列が境界に合わなければ**テストの h/l 値だけ**調整(ロジックは変えない)。

- [ ] **Step 5: コミット** — `git add server/doublePattern.ts server/doublePattern.test.ts && git commit -m "feat(alerts): double top/bottom detector (wick touch + 10y approach, no neckline)"`

---

## Task 2: detectionKind 'dtb' を型・表示・LLM に通す

**Files:** Modify `server/alertDetector.ts`, `server/types.ts`, `web/types.ts`, `server/alertHistory.ts`, `web/components/alertBanner.ts`, `server/llm/openai.ts`, `server/routes/explain.ts`

- [ ] **Step 1: 型 union に 'dtb' 追加**:
  - `server/alertDetector.ts`: `DetectionKind` に `| 'dtb'`。
  - `server/types.ts`: `AlertEventPayload.detectionKind` に `| 'dtb'`。
  - `web/types.ts`: `DetectionKind` エイリアスに `| 'dtb'`。
- [ ] **Step 2: 表示/分類**:
  - `server/alertHistory.ts` `rowKind`: `if (detectionKind === 'dtb') return 'Wトップ/ボトム';`(granville と同様に特別扱い。granville/shock の分岐の近くに追加)。
  - `web/components/alertBanner.ts` kindLabel: `: alert.detectionKind === 'dtb' ? 'Wパターン'`(granville の次あたり)。バナーは note 優先表示なので、note に「Wトップ」/「Wボトム」が入る。
- [ ] **Step 3: LLM/explain**:
  - `server/llm/openai.ts`: `ExplainInput.detectionKind` に `| 'dtb'`、kindLabel 三項に `: input.detectionKind === 'dtb' ? 'ダブル天井/大底'` 等(slope/shock/granville の分岐に合流)。
  - `server/routes/explain.ts`: 型に `'dtb'` 追加、バリデーションで `'dtb'` を受理。
- [ ] **Step 4: typecheck + 全スイート + web build** — `npx tsc --noEmit -p tsconfig.json && npx vitest run && npx vite build` → exit 0 / PASS。
- [ ] **Step 5: コミット** — `git add -A && git commit -m "feat(alerts): surface 'dtb' (double top/bottom) kind in types/banner/history/LLM"`

---

## Task 3: levelsLoop に検知を組込み、emitAlert で発火

**Files:** Modify `server/loops/levelsLoop.ts`

READ `server/loops/levelsLoop.ts` を先に読むこと(tick で getSessionOHLC/getLatestTick/computeLevels 済み。emitAlert は未 import)。

- [ ] **Step 1:** import 追加: `getRecentBars`(`../db/store.js`)、`emitAlert`(`../alertHistory.js`)、`detectDoubleTopBottom, DEFAULT_DOUBLE_PARAMS`(`../doublePattern.js`)、`classifySession` は既存。
- [ ] **Step 2:** per-level クールダウン state を module に追加:
```ts
const dtbCooldownMs = 15 * 60_000;
const lastDtbFire = new Map<string, number>();   // key = `${kind}@${round5(level)}` → fired epoch
```
- [ ] **Step 3:** `tick()` の `computeLevels` 後・`broadcast` の近くに検知を追加(現値=latest.price を使用):
```ts
    // ── ダブルトップ/ボトム検知(全レベル対象、手前10円、ネック不要)──
    try {
      const sinceT = now - DEFAULT_DOUBLE_PARAMS.lookbackBars * 60_000;
      const recent = getRecentBars(db, SYMBOL, sinceT)
        .map(b => ({ t: b.t, h: b.h, l: b.l }));
      const allLevels = [...result.up, ...result.down].map(l => ({ price: l.price, label: l.labels.join('・') }));
      for (const sig of detectDoubleTopBottom(allLevels, recent, latest.price)) {
        const key = `${sig.kind}@${Math.round(sig.level / 5) * 5}`;
        if (now - (lastDtbFire.get(key) ?? -Infinity) <= dtbCooldownMs) continue;
        lastDtbFire.set(key, now);
        const s = classifySession(now);
        const dir: 'up' | 'down' = sig.kind === 'top' ? 'down' : 'up';
        const name = sig.kind === 'top' ? 'Wトップ' : 'Wボトム';
        console.log(`[levelsLoop] ${name} @${sig.level} (${sig.label})`);
        emitAlert({
          symbol: SYMBOL, symbolLabel: `日経225先物 (${name})`,
          changePercent: 0, windowSeconds: 60, detectionKind: 'dtb', direction: dir,
          triggeredAt: now, change15min: null, pa15min: null, range1h: null, zscore: 0,
          note: `${name} ${Math.round(sig.level)}円(${sig.label})に接近`,
        });
      }
    } catch (err) {
      console.warn('[levelsLoop] dtb detect failed:', err instanceof Error ? err.message : err);
    }
```
  > `result` は computeLevels の戻り。`latest`/`now`/`db` は tick 内で既に定義済み。`getRecentBars` の戻り型は `Bar1m`(h/l あり)。クールダウンは per-level(価格丸め)＋種別で15分。共有クールダウン(alertCooldown)とは独立(ダブルは別系統・ブロックされない)。
- [ ] **Step 4:** 全スイート + typecheck + collector bundle — `npx vitest run && npx tsc --noEmit -p tsconfig.json && npm run build:collector` → 全 PASS、exit 0。
- [ ] **Step 5: コミット** — `git add server/loops/levelsLoop.ts && git commit -m "feat(alerts): fire double top/bottom alerts from levelsLoop (per-level cooldown)"`

---

## Task 4: ドキュメント + バージョン + リリース(LEADER 主導、評価通過後)

- [ ] **Step 1:** `USER_GUIDE.md`/`docs/USER_GUIDE.html` のアラート説明に「ダブルトップ/ボトム(主要レベルに手前10円で接近・髭タッチ後の2山目・ネック不要)」を追記(発火条件の4種→Wパターン追加)。
- [ ] **Step 2:** バージョン bump(0.4.35 → 0.4.36)。
- [ ] **Step 3:** `feat`/`docs` + `chore(release): bump version to 0.4.36`。push。
- [ ] **Step 4:** 署名ビルド → `release:latest-json`(Bash UTF-8) → `gh release create v0.4.36 --target master`。公開 latest.json 検証。

---

## Risks & Decisions(リーダー注記)
1. **対象=全レベル**(ユーザー指定)。高安/節目/fib/前日終値/長期高安/ADR すべて。node 上は labels で文脈表示。
2. **発火位置=手前10円ゾーン**(現値が L の ±10円以内、top は下から/bottom は上から)。`zoneYen` 既定10。
3. **髭タッチ(左)** は窓内に `high>=L-touchTol`(top)。**髭超過(`high>L+touchTol`)は不成立**。押し戻し(`L-pullbackYen` 下抜け)で2山の分離を担保し、ネック割れは不要。
4. **クールダウン**: per-level(価格丸め+種別)で15分。8秒ループでの連発を防止。共有クールダウンとは独立(ダブルは抑制されない/しない)。希望あれば共有結合に変更可。
5. **windowSeconds=60 / changePercent=0**: 円ベースのパターンなので note(「Wトップ 67500円(長期高)に接近」)を表示。banner は note 優先。
6. **パラメータ可変化(将来)**: zoneYen/touchTol/pullbackYen/cooldown を 🎛️ に出すのは次段で可能(今回は定数)。

## Self-Review
- 仕様網羅: 全レベル(T1/T3)・手前10円(T1)・髭タッチ左(T1)・髭超過で不成立(T1)・2山目で発火(T1/T3)。
- 型整合: 'dtb' を alertDetector/types/web/types + 表示/LLM(T2)で一致。`detectDoubleTopBottom` 戻り `DoubleSignal[]` を levelsLoop が消費(T3)。
- プレースホルダ無し: 各ステップに具体コード/コマンド。
