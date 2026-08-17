# シグナル制約 層1（執行）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 執行の都合（発注ラグの緩衝・刻み）をコード側の強制に移し、プロンプトからは「存在しない機構の説明」と「死んだ条項」を取り除く。

**Architecture:** 制約を3層（執行／戦略／助言）に分け、層1（執行）はコードだけが持ちプロンプトには書かない。最低距離はレッグ単位で `checkStaleLegs`（live価格基準・既にレッグを落とす経路）に足す。tick 丸めは発注価格の生成点で行う。

**Tech Stack:** TypeScript / Node / vitest / better-sqlite3(node:sqlite)

**Spec:** `docs/superpowers/specs/2026-08-17-signal-constraints-design.md`（コミット `7d70244`）

## Global Constraints

- コミットは各タスク末尾で行う。**版ファイル（package.json / tauri.conf.json / tauri.lite.conf.json / Cargo.toml / Cargo.lock / package-lock.json）には触らない。** 版上げは本計画の範囲外。
- `git checkout` / `git stash` / `git reset` / `git restore` **禁止**（作業ツリーに未コミットの承認済み実装が乗っている）。
- **PowerShell でソースを書き換えない**（BOM で vitest が無音ハングする既知事故）。Write/Edit を使う。
- 実DB原本 `C:\Users\user\Documents\trade\` を開かない。複製が scratchpad にある。
- **`server/llm/scalpPlan.ts` の質問文（v1）の「最低距離」記述は本計画では触らない。** 候補腕 `prompt-v1d` の測定結果が出るまで凍結（理由は「開いている前提」参照）。
- 検知（アラート）ロジックは変更しないので `scripts/alert-audit.mts` は非対象。
- 基線: `npx tsc --noEmit` エラー0 / `npx vitest run` = **268ファイル・3,525 passed・1 skipped**。

---

## 開いている前提（着手前に読むこと）

**プロンプトから最低距離を削除するタスクは、本計画に意図的に含めていない。**

候補腕 `prompt-v1d`（= v1 マイナス最低距離）が生成器で走っており、「距離の記述を外したら AI が節目に寄るか」を測っている最中。ここで v1 側の記述を消すと v1d と v1 が同一になり、**実験が成立しなくなる**。

測定が出たら別計画で扱う。主指標は 現在値からの距離の分布 / LC幅の**相異なる値の種類数** / 両レッグ同幅率 / `none` 率。

**本計画で変えるのはコード側の強制と、距離とは無関係な「死んだ記述」だけ。** これにより、v1d の測定に干渉しない。

---

## File Structure

| ファイル | 責務 | 変更 |
|---|---|---|
| `server/signalTrade/decisions.ts` | ARM 判定・レッグ落としの純関数群 | `MIN_ENTRY_DISTANCE_YEN` 追加、`checkStaleLegs` に最低距離を統合 |
| `server/signalTrade/decisions.test.ts` | 同テスト | 新規テスト追加 |
| `server/signalTrade/entryTick.ts` | **新規**: エントリー価格の刻み丸め（純関数1つ） | 新規作成 |
| `server/signalTrade/entryTick.test.ts` | **新規**: 同テスト | 新規作成 |
| `server/llm/scalpPlan.ts` | プロンプト組み立て | 死んだ range 条項と「存在しない安全網」の削除のみ |
| `server/llm/scalpPlan.test.ts` | 同テスト | 削除を固定するテスト追加 |

---

### Task 1: 最低距離（ラグ緩衝）をレッグ単位で強制する

**なぜここか**: `checkStaleLegs` は **live 価格**を基準に**レッグ単位で**落とす唯一の既存経路（`decisions.ts:246`）。最低距離は「発注が届くまでに価格が越えてしまう近さ」を弾くものなので、plan 時点の `refPrice` ではなく **ARM 直前の live 価格**で測る必要がある。plan 全体を落とす `checkSanity` ではなく、ここに置くことで「片方が近すぎるだけなら、もう片方は生かす」が成立する（設計書 原則3）。

**Files:**
- Modify: `server/signalTrade/decisions.ts:152-160`（定数の近く）と `:246-300`（`checkStaleLegs`）
- Test: `server/signalTrade/decisions.test.ts`

**Interfaces:**
- Produces: `export const MIN_ENTRY_DISTANCE_YEN = 10`
- Produces: `StaleLegReport` に `reason?: 'filled' | 'tooClose'` を追加（既存の呼び出し側は `reason` を読まないので後方互換）

- [ ] **Step 1: 失敗するテストを書く**

`server/signalTrade/decisions.test.ts` に追記:

```ts
import { checkStaleLegs, MIN_ENTRY_DISTANCE_YEN } from './decisions.js';

describe('★最低距離(ラグ緩衝): live 価格に近すぎるレッグを落とす', () => {
  // 実測: monitor ARM → trade2 発注決定 の中央値 6.7秒。その間に価格が越えると
  // 指値/逆指値として成立しない。10円は「発注拒否の処理があるなら十分」というユーザー判断による。
  const base = {
    direction: 'buy' as const, at: 1, signalId: 1,
    limitEntry: 68990, stopLossForLimit: 68930,
    stopEntry: 69100, stopLossForStop: 69040,
  };

  it('現在値から10円未満の指値レッグは落ちる(逆指値は残る)', () => {
    // live=69000 → 指値 68990 は 10円ちょうど…ではなく 10円。境界は「未満だけ落とす」
    const r = checkStaleLegs({ ...base, limitEntry: 68995 }, 69000);   // 5円 = 近すぎ
    expect(r.armed?.limitEntry).toBeUndefined();
    expect(r.armed?.stopEntry).toBe(69100);
    expect(r.legs.find(l => l.name === 'limit')?.reason).toBe('tooClose');
  });

  it('ちょうど10円は落とさない(境界は含む)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68990 }, 69000);   // 10円ちょうど
    expect(r.armed?.limitEntry).toBe(68990);
  });

  it('両レッグとも近すぎれば armed は null(=見送り)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68998, stopEntry: 69002 }, 69000);
    expect(r.armed).toBeNull();
  });

  it('live 価格が取れないときは何も落とさない(fail-safe・既存の契約を壊さない)', () => {
    const r = checkStaleLegs({ ...base, limitEntry: 68998 }, null);
    expect(r.armed).toBe(base as unknown);   // 同一参照で返る既存契約
  });

  it('定数は 10 円', () => {
    expect(MIN_ENTRY_DISTANCE_YEN).toBe(10);
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run server/signalTrade/decisions.test.ts -t 最低距離`
Expected: FAIL（`MIN_ENTRY_DISTANCE_YEN` が export されていない）

- [ ] **Step 3: 最小の実装**

`server/signalTrade/decisions.ts` の `SLIPPAGE_YEN`（157行付近）の直後に追加:

```ts
/** ★層1(執行): エントリーが live 価格に近すぎて、発注が届くまでに越えてしまう距離[円]。
 *  これ **未満** のレッグは落とす(ちょうどは通す)。
 *
 *  ■ 実測(2026-08-17)
 *   monitor ARM → trade2 発注決定 のラグは 中央値 6.7秒 / p90 9.2秒 / p99 19.8秒。
 *   そのうち 82% は trade2 の内部処理(受信そのものは中央値 22ms)。
 *   旧「50円」はプロンプトに3箇所書かれていたがコードの強制はゼロで、実測 72% のレッグが違反していた。
 *   50円は「節目の5〜10円内側」と 89.8% の断面で両立せず、AI は例外なく距離のほうを捨てていた。
 *  ■ なぜ 10 か
 *   trade2 に発注拒否の処理があり(第2レッグ拒否→第1レッグ取消→FLAT)、失敗は機会損失の方向に倒れる。
 *   現在の配置の 94.8% が 10円以上なので、正常な計画はほぼ落ちない。
 *  ★この値はラグに比例する。trade2 の内部処理 5.5秒が縮めば、この値も下げられる。 */
export const MIN_ENTRY_DISTANCE_YEN = 10;
```

`StaleLegReport` の型に `reason` を足す（既存定義の隣）:

```ts
  /** なぜ落ちたか。filled=live が既に通過 / tooClose=最低距離未満。落ちていないレッグには付かない。 */
  reason?: 'filled' | 'tooClose';
```

`checkStaleLegs` の directional 分岐（`:275` 以降）で、各レッグの `stale` 判定に最低距離を **OR** で足す。**range 分岐には足さない**（設計書 §5: 最低距離は buy/sell のみ。range は上下の反応帯の位置で決まる）。

```ts
  // ★最低距離(層1): live に近すぎるレッグは、発注が届くまでに越える=成立しないので落とす。
  const tooClose = (entry: number): boolean => Math.abs(entry - price) < MIN_ENTRY_DISTANCE_YEN;
```

各レッグで `const stale = detectFill(...) != null;` を
`const filled = detectFill(...) != null; const close = tooClose(entry); const stale = filled || close;`
に変え、`legs.push({ name, entry, stale, ...(stale ? { reason: filled ? 'filled' as const : 'tooClose' as const } : {}) })` とする。

- [ ] **Step 4: 通ることを確認**

Run: `npx vitest run server/signalTrade/decisions.test.ts`
Expected: PASS（既存テストも全て緑のまま）

- [ ] **Step 5: 全体テスト**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 268ファイル・3,530 passed 前後（追加5件）・1 skipped

- [ ] **Step 6: コミット**

```bash
git add server/signalTrade/decisions.ts server/signalTrade/decisions.test.ts
git commit -m "feat(signal): 最低距離(ラグ緩衝10円)をレッグ単位でコード強制する"
```

---

### Task 2: エントリー価格を刻み(5円)に丸める

**なぜ**: 実測で、monitor も trade2 も `roundToTick` 相当を**決済・保護ストップにしか掛けていない**。エントリー価格は生値のまま送られ、刻み外の価格は業者拒否まで検出されない（設計書 §5「tick 丸め（5円）… どこにも無い → 新設」）。

**Files:**
- Create: `server/signalTrade/entryTick.ts`
- Create: `server/signalTrade/entryTick.test.ts`

**Interfaces:**
- Produces: `export const ENTRY_TICK_YEN = 5`
- Produces: `export function roundEntryToTick(price: number, side: 'buy' | 'sell', kind: 'limit' | 'stop'): number`

- [ ] **Step 1: 失敗するテストを書く**

`server/signalTrade/entryTick.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { roundEntryToTick, ENTRY_TICK_YEN } from './entryTick.js';

describe('roundEntryToTick', () => {
  it('刻みは5円', () => expect(ENTRY_TICK_YEN).toBe(5));

  it('既に刻み上なら値を変えない', () => {
    expect(roundEntryToTick(68990, 'buy', 'limit')).toBe(68990);
    expect(roundEntryToTick(68995, 'sell', 'stop')).toBe(68995);
  });

  // ★丸めは必ず「不利でない側」へ寄せる=約定しにくくなる向き。
  //   有利側へ寄せると、AI が意図していない価格で約定しうる。
  it('買いの指値は切り下げる(より安く買う=約定しにくい側)', () => {
    expect(roundEntryToTick(68993, 'buy', 'limit')).toBe(68990);
  });
  it('売りの指値は切り上げる(より高く売る=約定しにくい側)', () => {
    expect(roundEntryToTick(68992, 'sell', 'limit')).toBe(68995);
  });
  it('買いの逆指値は切り上げる(より高く入る=約定しにくい側)', () => {
    expect(roundEntryToTick(69101, 'buy', 'stop')).toBe(69105);
  });
  it('売りの逆指値は切り下げる(より安く入る=約定しにくい側)', () => {
    expect(roundEntryToTick(69104, 'sell', 'stop')).toBe(69100);
  });

  it('非有限はそのまま返す(呼び出し側の既存の欠損処理を壊さない)', () => {
    expect(Number.isNaN(roundEntryToTick(NaN, 'buy', 'limit'))).toBe(true);
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run server/signalTrade/entryTick.test.ts`
Expected: FAIL（モジュールが存在しない）

- [ ] **Step 3: 実装**

`server/signalTrade/entryTick.ts`:

```ts
// ★層1(執行): エントリー価格を N225 の刻みに丸める純関数。
//
// ■ なぜ要るか(実測 2026-08-17)
//   monitor も trade2 も、刻み丸めを **決済・保護ストップにしか** 掛けていなかった。
//   エントリー価格は AI が出した生値のまま送られ、刻み外の価格は **業者に拒否されるまで検出されない**。
// ■ 丸める向き
//   必ず「約定しにくい側」へ寄せる。有利側へ寄せると AI が意図していない価格で約定しうる。
//     買い指値 → 切り下げ / 売り指値 → 切り上げ / 買い逆指値 → 切り上げ / 売り逆指値 → 切り下げ

/** N225(ミニ/マイクロ)の呼値。 */
export const ENTRY_TICK_YEN = 5;

/** エントリー価格を刻みに丸める。非有限はそのまま返す(欠損処理は呼び出し側の既存契約に任せる)。 */
export function roundEntryToTick(price: number, side: 'buy' | 'sell', kind: 'limit' | 'stop'): number {
  if (!Number.isFinite(price)) return price;
  // 買い指値・売り逆指値は下へ / 売り指値・買い逆指値は上へ。
  const down = (side === 'buy') === (kind === 'limit');
  const t = ENTRY_TICK_YEN;
  return down ? Math.floor(price / t) * t : Math.ceil(price / t) * t;
}
```

- [ ] **Step 4: 通ることを確認**

Run: `npx vitest run server/signalTrade/entryTick.test.ts`
Expected: PASS（7件）

- [ ] **Step 5: コミット**

```bash
git add server/signalTrade/entryTick.ts server/signalTrade/entryTick.test.ts
git commit -m "feat(signal): エントリー価格の刻み丸め(5円・約定しにくい側へ)を純関数として新設"
```

★**この時点では誰も呼んでいない。** 配線は Task 3。純関数を先に固めるのは、丸めの向きを取り違えると実弾で不利約定になるため（実測: 過去に「外側」の語の衝突で損切りが逆位置になった事故がある）。

---

### Task 3: 刻み丸めを ARM 経路に配線する

**Files:**
- Modify: `server/signalTrade/decisions.ts`（`planToArmed` 内・`:723-767` 付近）
- Test: `server/signalTrade/decisions.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('★刻み丸め: ARM するエントリー価格は必ず5円刻み', () => {
  it('刻み外の価格は丸めて武装する', () => {
    const plan = {
      direction: 'buy' as const, rationale: 'x', refPrice: 69000,
      limitEntry: 68993, lcWidthForLimit: 60, stopLossForLimit: 68933,
      stopEntry: 69101, lcWidthForStop: 60, stopLossForStop: 69041,
    };
    const armed = planToArmed(plan as never, 1, 1);
    expect(armed!.limitEntry! % 5).toBe(0);
    expect(armed!.stopEntry! % 5).toBe(0);
    expect(armed!.limitEntry).toBe(68990);   // 買い指値は切り下げ
    expect(armed!.stopEntry).toBe(69105);    // 買い逆指値は切り上げ
  });
});
```

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run server/signalTrade/decisions.test.ts -t 刻み丸め`
Expected: FAIL（68993 が返る）

- [ ] **Step 3: 実装**

`decisions.ts` の先頭に `import { roundEntryToTick } from './entryTick.js';` を足し、`planToArmed` が `limitEntry` / `stopEntry` を `ArmedBracket` に詰める箇所で `roundEntryToTick(v, plan.direction, 'limit'|'stop')` を通す。

★**損切り価格は丸めない。** 損切りは `stopLossFromWidth` がエントリーから導くので、エントリーを丸めた後の値から再計算されるべき。**この順序を守ること**（丸め → 損切り再計算）。順序を逆にすると幅が刻み分ずれる。

- [ ] **Step 4: 通ることを確認**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全緑。★既存テストで刻み外の価格を使っているものがあれば、**期待値を丸め後に更新**し、更新した理由をテストのコメントに残すこと。

- [ ] **Step 5: コミット**

```bash
git add server/signalTrade/decisions.ts server/signalTrade/decisions.test.ts
git commit -m "feat(signal): ARM するエントリー価格を刻みに丸める(損切りは丸め後の建値から再計算)"
```

---

### Task 4: 「存在しない安全網」の一文を削除する

**なぜ**: トレンドveto を AI委任にすると、実装は【レジーム/勢い】ブロックを**プロンプトから丸ごと落とし**、コード側の veto も無効になる（閾値0）。にもかかわらず、`strategySpec` の1行だけが「※自動見送り(veto)は直近10分の±N円だけで判定する」と**存在しない安全網の存在を AI に告げている**（設計書 §5「削除するもの」）。実測: `veto_fired` は 12,043 プラン全てで 0、`leg_drops` の `trend` も 0件。

**Files:**
- Modify: `server/llm/scalpPlan.ts:892` と `:1823`
- Test: `server/llm/scalpPlan.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('★存在しない安全網を告げない(委任時)', () => {
  it('トレンドveto が AI委任(閾値0)のとき、質問文にも spec にも「自動見送り」の語が出ない', () => {
    const spec = buildStrategySpec({ /* 実効設定: trendVeto を委任(mode:'ai', value:0) にする */ } as never);
    expect(spec).not.toContain('自動見送り');
    const q = buildScalpQuestion(55, 159, false, 0, undefined);   // trendVetoYen=0 = 委任
    expect(q).not.toContain('自動見送り');
  });

  it('手動(閾値>0)のときは従来どおり出る(否定対照)', () => {
    const q = buildScalpQuestion(55, 159, false, 100, undefined);
    expect(q).toContain('自動見送り');
  });
});
```

★引数の実シグネチャは `scalpPlan.ts` の定義を読んで合わせること。上は形の例。

- [ ] **Step 2: 落ちることを確認**

Run: `npx vitest run server/llm/scalpPlan.test.ts -t 存在しない安全網`
Expected: FAIL（委任時も語が出る）

- [ ] **Step 3: 実装**

`:892` と `:1823` の該当文を、**`trendVetoYen > 0` のときだけ出す**条件付きにする。削除ではなく条件化とする理由: 手動設定に戻したときは正しい説明になるため。

- [ ] **Step 4: 通ることを確認**

Run: `npx tsc --noEmit && npx vitest run`

- [ ] **Step 5: コミット**

```bash
git add server/llm/scalpPlan.ts server/llm/scalpPlan.test.ts
git commit -m "fix(prompt): トレンドveto が委任のとき「自動見送り」の説明を出さない(存在しない安全網を告げていた)"
```

---

### Task 5: レンジ無効時に死んでいる条項を削除する

**なぜ**: `rangeEnabled=false` のとき「range は出さないこと」だけが載るべきだが、実測で次が残っている（設計書 §5）。
- `:764` / `:945` / `:1827`「★レンジの距離: 上下2本… 400円以内 / 片方だけ… 200円以内」— **禁止した機能の距離規則**
- `:1114` / `:1127`「レンジと判断したときの取り方は**上の2択**に従うこと」— **参照先の「上の2択」が range 無効時には存在しない**（`rangeNote` が注入されないため）

**Files:**
- Modify: `server/llm/scalpPlan.ts:764, 945, 1114, 1127, 1827`
- Test: `server/llm/scalpPlan.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

```ts
describe('★レンジ無効時に死んだ条項を出さない', () => {
  it('rangeEnabled=false なら「レンジの距離」も「上の2択」も出ない', () => {
    const q = buildScalpQuestion(55, 159, /* rangeEnabled */ false, 0, undefined);
    expect(q).not.toContain('レンジの距離');
    expect(q).not.toContain('上の2択');
  });
  it('rangeEnabled=true なら従来どおり出る(否定対照)', () => {
    const q = buildScalpQuestion(55, 159, true, 0, undefined);
    expect(q).toContain('レンジの距離');
  });
});
```

同じ対で `buildStrategySpec` / `buildDelegationNote` 側も固定すること（`:1827` / `:1114`）。

- [ ] **Step 2: 落ちることを確認 → Step 3: 該当箇所を `rangeEnabled` 条件下に移す → Step 4: 全体テスト**

- [ ] **Step 5: コミット**

```bash
git add server/llm/scalpPlan.ts server/llm/scalpPlan.test.ts
git commit -m "fix(prompt): レンジ無効時に死んでいた距離規則と「上の2択」参照を出さない"
```

---

## 本計画に含めないもの（理由つき）

| | 理由 |
|---|---|
| **プロンプトからの最低距離削除** | 候補腕 `prompt-v1d` が測定中。消すと実験が成立しない |
| **プロンプトからの距離上限200/400の削除** | 上と同じ経路の文言。v1d の測定に干渉させない |
| **trade2 側の最低距離** | 別リポジトリ・別リリース。monitor 単独で ARM を止められるので、これだけで動く増分になる。次の計画で扱う |
| **層2（節目からの導出のコード検証）** | 設計書 §7.1 の開いている論点。層1の後の実データで可否を判断する |
| **trade2 の `tradingEnabled` 死配線 / LC幅の再検査なし / range type 無検査** | 設計書 §6「別枠」。実弾に関わるので独立した計画で扱う |

---

## Self-Review

**1. Spec coverage（層1のみ）**
- 最低距離 → Task 1 ✓（コード強制。プロンプト削除は意図的に除外・理由を明記）
- 距離上限 プロンプト削除 → **除外**（理由を明記）
- tick 丸め → Task 2, 3 ✓
- 存在しない機構の説明 → Task 4 ✓
- 死んだ range 条項 → Task 5 ✓
- 数量・銘柄／時間帯・鮮度など「現状維持」の項目 → 変更不要 ✓

**2. Placeholder scan** — 「適切に」「TBD」「必要なら」の類は無し。Task 4/5 のテスト引数だけ「実シグネチャを読んで合わせる」と書いたが、これは既存関数の形が版で変わりうるためで、埋めるべき内容自体は明示してある。

**3. Type consistency** — `MIN_ENTRY_DISTANCE_YEN`(Task 1) / `ENTRY_TICK_YEN`・`roundEntryToTick`(Task 2) / `StaleLegReport.reason`(Task 1) は Task 3 以降で同名で参照している。齟齬なし。
