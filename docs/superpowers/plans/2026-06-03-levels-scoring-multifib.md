# 意識される水準パネルの精度向上（多スイングFib + 多時間スケール + 点数化）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「主要レベル(意識される水準)」パネルの精度を上げる。(1) フィボナッチの基準スイングを**複数の時間スケール**で取り、**比率も拡張**(23.6/78.6/127.2/161.8 を追加)。(2) 前日終値・長期高安・多スケール節目など**他の時間スケールの水準**を追加。(3) 二値★をやめ**意識度スコア(点数化)**で評価し、**複数スイングのフィボや異種水準が重なる「合流帯」を最優先**で浮かせる。日経225で実効性の高い重なり価格帯を強調する。

**Architecture:** 新しい純粋モジュール `server/fibLevels.ts`(多スイング抽出 + 比率展開)を追加。`server/levels.ts` の候補生成を拡張(前日終値/長期高安/多スケール節目/多スイングFib)し、クラスタに**重み合計ベースのスコア + 合流/被テスト/リーセンシー・ボーナス**を付与。選抜を「近接窓内スコア降順」に変更。`Level` 型にスコア/ティアを追加し `levelsPanel` で ★/★★＋数値表示。主要ノブは config 化(🎛️)。

**Tech Stack:** TypeScript ESM(`.js`)、Vitest。データ源は `getSessionOHLC`(セッション別OHLC、取得本数を増やす)。NIY=F のみ。

---

## 設計判断(リーダー)

- **多スイング(基準を複数)**: 完了セッションの窓 {5,10,20} の極大→極小スイング + 当日スイング = 最大4基準。各々フィボ群を生成。脚の向き= newer 極値で決定(既存ロジック踏襲)。
- **比率**: 戻し `[0.236,0.382,0.5,0.618,0.786]`、拡張 `[1.272,1.618]`。50% は reversalLine(維持)。
  - 戻し: up脚 `high - r*range` / down脚 `low + r*range`。
  - 拡張: up脚 `high + (e-1)*range` / down脚 `low - (e-1)*range`。
- **合算幅 = 約25円**(ユーザー指定)。`levelTol` 既定 **25**。この幅で候補を束ねてスコアを合算する。
- **代表価格 = 意味のある実価格**(ユーザー指定)。クラスタ代表は中央値ではなく **最高重みメンバーの実価格**(節目/セッション高安/前日終値など実際に意識される価格)。同点は (1) 節目(100/500/1000の倍数)優先 → (2) 中央値に最も近いメンバー。最後に5円丸め。
- **タイプ別重み(評価指摘で再調整)**: longHL 1.6 / prevClose 1.3 / round1000 1.2 / sessHL・todayHL 1.0 / **fib戻し 0.9** / round500 0.7 / **fib拡張 0.5** / **当日スイングfib 0.5** / open 0.8 / round250 0.4 / adr 0.7。(フィボ戻しを 0.6→**0.9** に上げ、2本フィボ合流が偶然の構造クラスタに負けないように。拡張・当日は established 不足のため低め。)
- **スコア = Σ(member.weight) × (1 + testBonus) × 合流倍率**。二値 `strong` は後方互換で残しつつ `score:number` と `tier:0|1|2` を追加。
- **被テスト(自己カウント除外・評価指摘)**: 代表価格 P に対し、**そのクラスタのメンバーでないセッション**の high/low/close が P±tol に入った回数 count を数え `× (1 + LEVEL_TEST_BONUS × min(count,5))`(既定0.15)。自分のメンバー(=既に Σweight 済み)は数えない＝独立した再テストのみ加点。
- **合流倍率(段階化・評価指摘)**: クラスタ内の**異なるスイングスケール由来 fib の種類数** s(5S/10S/20S/当日、当日は0.5扱い)と非fib構造水準の有無 b。`mult=1`; (s≥2) または (fib有 かつ b) → `mult=fibConfluenceBonus`(既定1.5); さらに s≥3 で `×1.25`。これが日経で効く重なり帯。
- **ティア = 相対ランク(評価指摘・絶対閾値廃止)**: 表示集合内で score を最大値で正規化。`norm≥0.66 かつ mult>1` → **tier2(合流帯)**; `norm≥0.40` → tier1; else 0。絶対定数は使わない(ボラ局面で破綻しないため)。
- **選抜**: 近接窓(現値 ±`levelSelectWindowYen`、既定 **1500円**)内の clustered をスコア降順で上下各 `levelShowN` 本。さらに **(a) 現値直近の上下各1本** と **(b) スコア最上位の上下各1本(窓外でも)** は必ず含める(強い遠方水準を埋もれさせない)。fib50(reversalLine)強制追加は維持。
- **可変ノブ(🎛️)**: `levelTol`(束ね許容, 既定 **25**) / `levelShowN`(既定5) / `levelSelectWindowYen`(既定 **1500**) / `fibConfluenceBonus`(既定 **1.5**) / `levelTestBonus`(既定0.15)。タイプ別重み・比率セットは定数(誤設定リスク回避、要望あれば後日)。

---

## File Structure

**新規**: `server/fibLevels.ts`(+ `server/fibLevels.test.ts`)。
**変更**: `server/levels.ts`(候補拡張 + スコア + 選抜)、`server/levels.test.ts`(あれば拡張、無ければ新規 `server/levelsScoring.test.ts`)、`server/loops/levelsLoop.ts`(取得セッション数増, config 反映)、`web/components/levelsPanel.ts`(スコア表示)、`web/types.ts`/`server/types.ts`(Level 型: score/tier 追加)、`server/configStore.ts`(新ノブ)、`server/routes/settings.ts`(新ノブ)、`web/components/paramsModal.ts` + `web/index.html`(UI)。

---

## Task 1: 多スイング・多比率フィボ生成 `fibLevels.ts`(純粋 + TDD)

**Files:** Create `server/sessionOHLC.ts`, `server/fibLevels.ts`, `server/fibLevels.test.ts`; Modify `server/levels.ts`(型/関数の再export)

> **循環import回避(必須・最初に実施)**: fibLevels は `SessionOHLC` 型と `isSessionComplete` を使い、levels は fibLevels を使う → 相互参照=循環。これを断つため、まず `SessionOHLC` interface と `isSessionComplete`/`sessionOpenEpoch`/`DAY_OPEN_MIN`/`NIGHT_OPEN_MIN`/`COMPLETE_TOL_MS` を **新ファイル `server/sessionOHLC.ts`** へ移動する。`server/levels.ts` はそれらを `./sessionOHLC.js` から import し、**後方互換のため `export type { SessionOHLC } from './sessionOHLC.js';` と `export { isSessionComplete } from './sessionOHLC.js';` を再export**(既存の `levels.ts` 経由 import を壊さない。`forecast.ts` は `./levels.js` から両方を import しているので、この再exportで無改修のまま動く)。fibLevels.ts は `./sessionOHLC.js` から import する。

- [ ] **Step 0: `server/sessionOHLC.ts` を新設**し、上記の型/関数/定数を levels.ts から移設 + levels.ts で再export。`npx tsc --noEmit -p tsconfig.json && npx vitest run` が緑のままを確認(純粋な移設なので挙動不変)。コミット: `git add server/sessionOHLC.ts server/levels.ts && git commit -m "refactor(levels): extract SessionOHLC + isSessionComplete to break import cycle"`

- [ ] **Step 1: 失敗テスト** — `server/fibLevels.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { deriveSwing, fibLevelsForSwing, DEFAULT_RETR, DEFAULT_EXT, type Swing } from './fibLevels.js';
import type { SessionOHLC } from './levels.js';

function ses(date: string, session: 'Day'|'Night', o: number, h: number, l: number, c: number, highT: number, lowT: number): SessionOHLC {
  return { sessionDate: date, session, open: o, high: h, low: l, close: c, highT, lowT, openT: 0 };
}

describe('deriveSwing', () => {
  it('picks extreme high/low over the window and leg by newer extreme', () => {
    // 高値が新しい → up脚
    const s = [
      ses('2026-06-01','Day', 100, 120, 90, 110, 5000, 1000),   // high@5000
      ses('2026-06-01','Night',110, 115, 95, 100, 2000, 6000),  // low@6000 (newer)
    ];
    const sw = deriveSwing(s, 2);
    expect(sw).not.toBeNull();
    expect(sw!.high).toBe(120); expect(sw!.low).toBe(90);
    // 低値の時刻(6000) > 高値の時刻(5000) → down脚
    expect(sw!.leg).toBe('down');
  });
  it('returns null when fewer sessions than window', () => {
    expect(deriveSwing([], 5)).toBeNull();
  });
});

describe('fibLevelsForSwing', () => {
  it('produces retracement + extension levels with correct prices (up-leg)', () => {
    const sw: Swing = { high: 200, low: 100, leg: 'up', scaleLabel: '5S' };  // range=100
    const lv = fibLevelsForSwing(sw, [0.382, 0.5], [1.618]);
    const byRatio = new Map(lv.map(x => [x.ratio, x.price]));
    expect(byRatio.get(0.382)).toBeCloseTo(200 - 0.382 * 100);  // 161.8 戻し
    expect(byRatio.get(0.5)).toBeCloseTo(150);
    expect(byRatio.get(1.618)).toBeCloseTo(200 + 0.618 * 100);  // 261.8 拡張(上)
    // 50% は reversalLine
    expect(lv.find(x => x.ratio === 0.5)!.reversalLine).toBe(true);
  });
  it('down-leg retracement goes up from low, extension goes below low', () => {
    const sw: Swing = { high: 200, low: 100, leg: 'down', scaleLabel: '10S' };
    const lv = fibLevelsForSwing(sw, [0.382], [1.618]);
    const m = new Map(lv.map(x => [x.ratio, x.price]));
    expect(m.get(0.382)).toBeCloseTo(100 + 0.382 * 100);
    expect(m.get(1.618)).toBeCloseTo(100 - 0.618 * 100);
  });
});
```

- [ ] **Step 2: 失敗確認** — `cd C:/Users/user/Desktop/Finance_Monitor && npx vitest run server/fibLevels.test.ts` → FAIL(モジュール無し)。

- [ ] **Step 3: 実装** — `server/fibLevels.ts`

```ts
import type { SessionOHLC } from './sessionOHLC.js';
import { isSessionComplete } from './sessionOHLC.js';

export const DEFAULT_RETR = [0.236, 0.382, 0.5, 0.618, 0.786];
export const DEFAULT_EXT = [1.272, 1.618];
export const DEFAULT_SWING_WINDOWS = [5, 10, 20];   // 完了セッション窓(=基準スケール)

export interface Swing { high: number; low: number; leg: 'up' | 'down'; scaleLabel: string; }
export interface FibLevel { price: number; ratio: number; reversalLine: boolean; scaleLabel: string; kind: 'retr' | 'ext'; }

/** 完了(寄り揃い)セッション先頭 n 本の極大→極小スイング。脚= newer 極値の向き。n 本未満は null。 */
export function deriveSwing(completed: SessionOHLC[], n: number): Swing | null {
  const use = completed.filter(isSessionComplete).slice(0, n);
  if (use.length < n) return null;                          // 窓を満たすスケールのみ出す(20S は20本揃ってから)
  const hi = use.reduce((a, b) => (b.high > a.high ? b : a));
  const lo = use.reduce((a, b) => (b.low < a.low ? b : a));
  if (!(hi.high > lo.low)) return null;
  const leg: 'up' | 'down' = lo.lowT > hi.highT ? 'down' : 'up';   // 安値が新しい→down脚
  return { high: hi.high, low: lo.low, leg, scaleLabel: `${n}S` };
}

/** スイングから戻し+拡張のフィボ価格群。up脚=戻しは高値から下、拡張は高値より上。down脚は反転。 */
export function fibLevelsForSwing(sw: Swing, retr: number[] = DEFAULT_RETR, ext: number[] = DEFAULT_EXT): FibLevel[] {
  const range = sw.high - sw.low;
  if (!(range > 0)) return [];
  const out: FibLevel[] = [];
  for (const r of retr) {
    const price = sw.leg === 'up' ? sw.high - r * range : sw.low + r * range;
    out.push({ price, ratio: r, reversalLine: r === 0.5, scaleLabel: sw.scaleLabel, kind: 'retr' });
  }
  for (const e of ext) {
    const price = sw.leg === 'up' ? sw.high + (e - 1) * range : sw.low - (e - 1) * range;
    out.push({ price, ratio: e, reversalLine: false, scaleLabel: sw.scaleLabel, kind: 'ext' });
  }
  return out;
}

/** 当日(進行中)セッションのスイング(today H/L)。今日が寄り揃いの時のみ。 */
export function currentSessionSwing(inProgress: SessionOHLC | null, current: number): Swing | null {
  if (!inProgress || !isSessionComplete(inProgress)) return null;
  const high = Math.max(inProgress.high, current);
  const low = Math.min(inProgress.low, current);
  if (!(high > low)) return null;
  // ライブ現値が新高値/新安値を作った場合、その時刻が最新 → 脚向きを現値で決める。
  // どちらも更新していなければ保存済みの highT/lowT(新しい極値)で決定。
  let leg: 'up' | 'down';
  if (current >= inProgress.high) leg = 'up';
  else if (current <= inProgress.low) leg = 'down';
  else leg = inProgress.lowT > inProgress.highT ? 'down' : 'up';
  return { high, low, leg, scaleLabel: '当日' };
}
```

- [ ] **Step 4: 通過確認** — `npx vitest run server/fibLevels.test.ts && npx tsc --noEmit -p tsconfig.json` → PASS, exit 0。

- [ ] **Step 5: コミット** — `git add server/fibLevels.ts server/fibLevels.test.ts && git commit -m "feat(levels): multi-swing multi-ratio fibonacci generator"`

---

## Task 2: スコアリング基盤 + 拡張候補を levels.ts に統合

**Files:** Modify `server/levels.ts`; Create `server/levelsScoring.test.ts`

READ `server/levels.ts` 全体を先に読むこと。`Cand` に `weight` と `kind` を、`Level` に `score` と `tier` を追加し、`cluster` をスコア集計に拡張、選抜をスコア降順に変更。フィボは Task 1 のジェネレータを使う。

- [ ] **Step 1: 失敗テスト** — `server/levelsScoring.test.ts`(合流帯が高スコア・上位選抜されることを確認)

```ts
import { describe, it, expect } from 'vitest';
import { computeLevels, type SessionOHLC } from './levels.js';

function mk(date: string, ses: 'Day'|'Night', o: number, h: number, l: number, c: number): SessionOHLC {
  // openT を寄りに合わせて isSessionComplete=true にする(寄り時刻=その日の8:45/17:00 UTC換算)
  const [y,m,d] = date.split('-').map(Number);
  const min = ses === 'Day' ? 8*60+45 : 17*60;
  const openT = Date.UTC(y!, m!-1, d!, Math.floor(min/60), min%60) - 9*3600_000;
  return { sessionDate: date, session: ses, open: o, high: h, low: l, close: c, highT: openT+3600_000, lowT: openT+1800_000, openT };
}

describe('computeLevels scoring', () => {
  it('numeric score+tier; heavy cluster at a meaningful round price outranks an isolated level; representative = real member price', () => {
    // 散らばった20セッション。高値の多くを 67500(=最大高=round500=longHL)に寄せ、
    // 安値・始値は散らす(病的な全同一系列にしない)。現値は 67000。
    const sessions: SessionOHLC[] = [];
    const highs = [67500, 67500, 67500, 67480, 67320, 67500, 67210, 67500, 67390, 67500,
                   67260, 67500, 67180, 67450, 67500, 67340, 67500, 67220, 67410, 67500];
    const lows  = [66480, 66510, 66200, 66620, 66380, 66540, 66700, 66260, 66590, 66440,
                   66660, 66300, 66720, 66520, 66360, 66600, 66280, 66640, 66460, 66340];
    for (let i = 0; i < 20; i++) {
      const dd = String(2 + i).padStart(2, '0');
      sessions.push(mk(`2026-05-${dd}`, i % 2 ? 'Day' : 'Night', 67000, highs[i]!, lows[i]!, 67000 + (i % 5) * 20));
    }
    const r = computeLevels(sessions, 67000, Date.now(), null, []);
    const all = [...r.up, ...r.down];
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(l => typeof l.score === 'number' && (l.tier === 0 || l.tier === 1 || l.tier === 2))).toBe(true);
    // 67500: 最大高(longHL)+多数のsessHL+round500 が集中 → 高スコア・tier>=1
    const conf = all.find(l => Math.abs(l.price - 67500) <= 12);
    expect(conf).toBeDefined();
    expect(conf!.tier).toBeGreaterThanOrEqual(1);
    // 代表価格は中央値の平均値ではなく、意味のある実価格(67500=最大高/round500)であること
    expect(conf!.price).toBe(67500);
    // 67500 のスコアは、孤立した節目(例 67000近傍の grid)より高い
    const isolated = all.filter(l => l !== conf).map(l => l.score);
    expect(Math.max(...isolated)).toBeLessThan(conf!.score);
  });
});
```

- [ ] **Step 2: 失敗確認** — `npx vitest run server/levelsScoring.test.ts` → FAIL(score/tier 未実装)。

- [ ] **Step 3: 実装** — `server/levels.ts` を以下方針で拡張(既存構造を保ちつつ):
  - `Cand` に `weight: number; kind: string; fibScale?: string;` を追加。各 push 箇所で kind/weight を付与(重みは設計判断の表どおり):
    - セッション高安 `kind:'sessHL' weight:1.0`、当日高安 `kind:'todayHL' weight:1.0`、当日始 `kind:'open' weight:0.8`
    - 直近高安マーク: 既存候補に併記(weight は触らない)
    - 節目: 250 `kind:'grid250' weight:0.4` に加え **500 `weight:0.7` / 1000 `weight:1.2`** を現値の上下最近1本ずつ追加
    - **前日終値**: 直近の完了 Day と Night の `close` を `kind:'prevClose' weight:1.3`(ラベル「前日Day終値」等)
    - **長期高安**: 取得セッション全体(寄り揃い)の最大高・最小安を `kind:'longHL' weight:1.6`(ラベル「長期高/安」)
    - ADR予測(extraLevels): `kind:'adr' weight:0.7`
    - **多スイングFib**: `import { deriveSwing, fibLevelsForSwing, currentSessionSwing, DEFAULT_SWING_WINDOWS } from './fibLevels.js';`。`completed` から各窓スイング + 当日スイングを集め、各 FibLevel を push。**戻し weight:0.9 / 拡張 weight:0.5 / 当日由来は 0.5**(reversalLine 保持、ラベル「Fib{ratio}%({scale})」)。`fibScale = sw.scaleLabel` を Cand に保持(合流判定用)。
  - `cluster` を**スコア集計+代表価格**に拡張。`tol` は引数(`resolveLevelsConfig().levelTol`、既定25)で渡す:
    - **代表価格(ユーザー指定)** = クラスタ内**最高 weight メンバーの実価格**。同 weight 複数なら (1)節目(100/500/1000の倍数)優先 → (2)中央値に最も近いメンバー、を選ぶ。最後に `round5`。中央値は使わない。
    - **score = Σ(member.weight)**。
    - **被テスト(自己除外)**: 代表価格 P に対し、**そのクラスタのメンバーになっていない**セッションの high/low/close が P±tol に入った回数 count → `score *= (1 + LEVEL_TEST_BONUS * min(count,5))`。メンバー判定は「その session 由来の sessHL/longHL/prevClose/todayHL が当クラスタに含まれるか」で行う(素の session 配列とクラスタ member の由来を突き合わせ。実装簡易化のため、cluster に `sessions` 配列と「クラスタが含む sessionDate+session の集合」を渡し、集合外のセッションのみ count)。
    - **合流倍率**: クラスタ内の異なる `fibScale` 種類数 s(当日は0.5換算)、非fib構造水準の有無 b。`mult=1`; (s>=2 || (fib有 && b)) → `mult=fibConfluenceBonus`(既定1.5); s>=3 でさらに `*=1.25`。`score *= mult`。`mult>1` を Level に `confluence:boolean` で持つ(tier 判定に使う)。
  - `Level` に `score:number; tier:0|1|2; confluence:boolean;` を追加。`strong` は後方互換で `tier>=1` を流用。
  - **ティア=相対ランク**: 選抜後の表示集合(up+down)で `maxScore` を取り、各 level の `norm=score/maxScore`。`norm>=0.66 && confluence` → tier2、`norm>=0.40` → tier1、else 0。絶対閾値定数は作らない。
  - **選抜変更**: clustered を「現値 ±`levelSelectWindowYen`(既定1500)内」に絞り、up(dist>0)/down(dist<0) をスコア降順で各 `levelShowN` 本。**さらに (a) 現値直近の上下各1本(窓内最近接)** と **(b) スコア最上位の上下各1本(窓外でも)** を必ず含める。fib50(reversalLine)強制追加は維持。重複は price で排除。
  - 調整ノブ定数(既定値): `LEVEL_TOL=25`, `LEVEL_SHOW_N=5`, `SELECT_WINDOW_YEN=1500`, `FIB_CONFLUENCE_BONUS=1.5`, `LEVEL_TEST_BONUS=0.15`(Task5 で config から上書き、ここでは定数を既定にして computeLevels 内で参照)。

- [ ] **Step 4: 通過確認 + 全スイート** — `npx vitest run && npx tsc --noEmit -p tsconfig.json` → PASS。テストの合成系列(Step1 の散らばり系列)で「合流帯 tier=2、孤立節目 tier=0」になることを確認。閾値は相対(0.66/0.40)なので絶対調整は不要だが、合成データで合流が最上位になるよう重みバランスのみ確認(検知の意味は変えない)。

- [ ] **Step 5: コミット** — `git add server/levels.ts server/levelsScoring.test.ts && git commit -m "feat(levels): consciousness scoring + multi-timescale candidates + score-ranked selection"`

---

## Task 3: 表示(スコア/ティア)を UI に出す

**Files:** Modify `web/components/levelsPanel.ts`, `web/styles.css`(型は Task 2 で `server/levels.ts` の Level に追加済み)

> **重要(評価指摘)**: `Level` 型は **`server/levels.ts` のみで定義**。`server/types.ts` は `LevelsResult` を、`web/types.ts` は `Level`/`LevelsResult` を **`../server/levels.js` から再export しているだけ**(再宣言ではない)。よって Task 2 で `server/levels.ts` の `Level` に `score/tier/confluence` を足せば、再export 経由で `web/components/levelsPanel.ts`(`import { Level } from '../types.js'`)まで自動で届く。**`server/types.ts` と `web/types.ts` は編集しないこと**(編集すると no-op か、最悪 web 側に drift する重複宣言を生む)。`chatContext.ts` は `l.strong` 等を使うので `strong` は Task 2 で残す(編集不要)。

- [ ] **Step 1: `web/components/levelsPanel.ts` の `rowHtml` を更新:**
  - `tier===2` → `★★`(合流帯, 行に class `confluence`)、`tier===1` → `★`、`tier===0` → 無印(既存 strong★ の置換)。
  - 数値スコアを淡色で併記(例 `<span class="lv-score">${l.score.toFixed(1)}</span>`)。
  - reversalLine の ⚑転換 は維持。ラベルは `labels.join('・')` のまま(Fibスケール/要因が入る)。

- [ ] **Step 2: `web/styles.css`** に `.levels-row.confluence`(強調色/太字)と `.lv-score`(淡色・小)を追加(既存 `.levels-row.strong` のスタイルに倣う)。

- [ ] **Step 3: ビルド + 型 + テスト** — `npx vite build && npx tsc --noEmit -p tsconfig.json && npx vitest run` → exit 0 / PASS。

- [ ] **Step 4: コミット** — `git add web/components/levelsPanel.ts web/styles.css && git commit -m "feat(levels): show consciousness score/tier (★/★★ 合流帯) in panel"`

---

## Task 4: 取得セッション数を増やし、levelsLoop を新ロジックに合わせる

**Files:** Modify `server/loops/levelsLoop.ts`, `server/levels.ts`(export 定数)

- [ ] **Step 1:** `levelsLoop.ts` の `FETCH_SESSIONS` を長期高安/20Sスイングを賄えるよう拡大(例 `Math.max(LOOKBACK_SESSIONS, 20) + 4`)。`computeLevels` 呼び出しは不変(同シグネチャ)。`levelSignature` は up/down 価格 + swing で署名しているが、tier/score が変わっても価格が同じなら再配信されない問題に注意 → **署名に各 level の `tier` と丸めた `score`(0.5刻み)も含める**(`price:tier:scoreRounded` 形)。価格が同じでも強さ/スコアが変わったら UI 更新されるようにする。
- [ ] **Step 2: 全スイート + 型** — `npx vitest run && npx tsc --noEmit -p tsconfig.json` → PASS。
- [ ] **Step 3: コミット** — `git add server/loops/levelsLoop.ts server/levels.ts && git commit -m "feat(levels): deepen session fetch + include tier in SSE signature"`

---

## Task 5: 主要ノブを config(🎛️)で可変化

**Files:** Modify `server/configStore.ts`, `server/routes/settings.ts`, `web/components/paramsModal.ts`, `web/index.html`, `server/levels.ts`

公開ノブ: `levelTol`(束ね許容円, 既定 **25**, 5-200) / `levelShowN`(上下表示数, 既定5, 1-12) / `levelSelectWindowYen`(既定 **1500**, 100-10000) / `fibConfluenceBonus`(既定 **1.5**, 1.0-5.0, step0.1) / `levelTestBonus`(既定0.15, 0-1, step0.05)。

- [ ] **Step 1: `configStore.ts`** に5ノブの `UserConfig` フィールド + `PARAM_BOUNDS` + `resolveLevelsConfig()`(これらをまとめて返す)を追加(既存 resolver パターン踏襲、mtimeキャッシュは既存)。
- [ ] **Step 2: `server/levels.ts`** の該当定数(`LEVEL_TOL`(既存 CONFLUENCE_TOL),`LEVEL_SHOW_N`(既存 NEAR_N),`SELECT_WINDOW_YEN`,`FIB_CONFLUENCE_BONUS`,`LEVEL_TEST_BONUS`)を、`computeLevels` 内で `resolveLevelsConfig()` から読む形に(定数は既定値として残す)。**注意**: levels.ts が configStore を import すると循環の有無を確認(configStore→shockDetector のみ。levels.ts→configStore→shockDetector で levels は configStore に依存、configStore は levels に依存しない=非循環。ただし fibLevels/forecast は levels を import するので、configStore が levels を import しないこと)。**configStore は levels を import しない**設計を厳守(resolveLevelsConfig は数値を返すだけ、Level 型に依存しない)。
- [ ] **Step 3: `settings.ts`** の `NUMERIC_PARAM_KEYS` に5キー追加(Task4方式の DRY ループにそのまま乗る)。restart 不要(levels は毎tick resolver 読み)。
- [ ] **Step 4: `paramsModal.ts` PARAMS + `index.html`** に「主要レベル」セクションの入力5つを追加(Task5方式: PARAMS 1行 + input 1個 ずつ)。
- [ ] **Step 5: 全スイート + 型 + ビルド** — `npx vitest run && npx tsc --noEmit -p tsconfig.json && npx vite build && npm run build:collector` → PASS/exit0。
- [ ] **Step 6: コミット** — `git add -A && git commit -m "feat(levels): configurable level knobs (tol/showN/window/confluence/test bonus) via 🎛️"`

---

## Task 6: ドキュメント + バージョン + リリース(LEADER 主導、評価通過後)

- [ ] **Step 1:** `USER_GUIDE.md`/`docs/USER_GUIDE.html` の主要レベル説明を更新: 多スイング・多比率フィボ(23.6-161.8%)、前日終値/長期高安/多スケール節目、**合流帯を点数化(★/★★)して最優先表示**、🎛️で可変。
- [ ] **Step 2:** バージョン bump(0.4.26 → 0.4.27)。
- [ ] **Step 3:** `feat`/`docs` + `chore(release): bump version to 0.4.27`。push。
- [ ] **Step 4:** 署名ビルド → `release:latest-json`(Bash UTF-8) → `gh release create v0.4.27 --target master`。公開 latest.json 検証。

---

## Risks & Decisions(リーダー注記)
1. **ティアは相対ランク**(maxScore で正規化、norm≥0.66&合流→2 / ≥0.40→1)。絶対閾値(TIER*_MIN)は廃止 — 実データのボラ局面でスコア絶対値が変動しても破綻しないため。体感とズレたら 🎛️ の tol/重み/合流ボーナスで追従。
2. **多スイング×多比率で候補が増える** → cluster がO(n log n)、n は数十〜百程度で軽い(levelsLoop 8秒間隔・NIY=Fのみ)。負荷問題なし。
6. **`SessionOHLC` は store.ts にも別定義あり(store.ts:113)** — これは**意図的に分離**(構造的型互換で levelsLoop が store→levels に渡せている)。`server/sessionOHLC.ts` 切り出し時に **store.ts の定義を統合しない**こと(`store → sessionOHLC` の依存辺を作らない)。新 `sessionOHLC.ts` の interface は store.ts の8フィールドと同一構造を保つ。
7. **代表価格=実価格**(最高重みメンバー)なので、被テスト count はその実価格 P 基準。自己メンバー除外で独立再テストのみ加点(自己二重計上を回避)。
3. **拡張Fib(127.2/161.8%)は上値/下値メドの“先”** を出す。現値から遠いものは SELECT_WINDOW で間引かれるが、合流すれば残る(意図的)。
4. **循環import回避**: configStore は levels/fibLevels を import しない(数値ノブのみ返す)。fibLevels は levels の型のみ import(値依存は isSessionComplete のみ=非循環: levels→fibLevels ではなく fibLevels→levels だが levels も fibLevels を import するため**相互参照**になる。回避策: `isSessionComplete` と `SessionOHLC` 型を fibLevels が使うが、levels も fibLevels を使う → 循環。**対策**: `SessionOHLC` 型と `isSessionComplete` を新ファイル `server/sessionOHLC.ts` に切り出し、levels.ts と fibLevels.ts の両方がそこから import する(循環解消)。Task 1 でこの切り出しを先に行う。)
5. **署名(SSE再配信)**: tier/score を署名に含め、価格同じでも強さが変わったら UI 更新。

## Self-Review
- フィボ: 多スイング(5/10/20/当日) × 比率(戻し5 + 拡張2) — Task1。合流帯ボーナス — Task2。
- 時間スケール: 前日終値/長期高安/多スケール節目 — Task2。
- 点数化: score/tier + 被テスト + 合流 — Task2、表示 — Task3。
- 循環回避: SessionOHLC/isSessionComplete を sessionOHLC.ts に分離(Task1 Step0 として明記)。
- config: 5ノブ — Task5。
