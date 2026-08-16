# BB スクイーズ/バルジ 第3弾（売買）実装計画

> **実装者へ:** タスクごとに `superpowers:subagent-driven-development` で進める。手順は `- [ ]` で追跡する。

**目的:** スクイーズで両側に逆指値を出し、バルジで利の乗った建玉を強制決済し、バルジをまたいだロスカットでドテンする。**AI を経由しない第2の入口**を作る。

**方針:** 既存の「AI → planToArmed → 武装」経路には触らない。並行して `ruleToArmed` / `ruleToClose` を足す。設定トグル `squeezeTradeEnabled`（**既定 false**）が OFF の間は、判定も記録も走るが**発注しない**。

**技術:** TypeScript / vitest / node:sqlite。既存の純関数＋薄いエンジン配線という構造に従う。

---

## Global Constraints（全タスク共通・逸脱不可）

```
git checkout / git stash / git reset は禁止（過去版は git show <rev>:<path> > 一時ファイル）
一時ファイルは C:\Users\user\AppData\Local\Temp\claude\C--Users-user-Desktop-Finance-Monitor\b2c8a2a2-41b1-40b6-8046-525a782d2349\scratchpad 配下のみ
ユーザーの実DBを書き換えない（コピーして {readOnly:true} で開く）
証券会社の認証情報ファイル(keys_kabu.json 等)は読まない
外部 LLM を呼ばない
private.ts の数値をコード・テスト・ログ・DB・報告に一切書かない
漏洩検査 server/signalTrade/exit/leak.test.ts が 10 passed / skip 0 であること
コミットしない。版ファイル（package.json / tauri.conf.json / tauri.lite.conf.json / Cargo.toml / Cargo.lock / package-lock.json）に触らない
★AI プロンプトの文言を1文字も変えない（実走中の質問文 A/B の標本が割れる）
★BB_SIGMA(0.7) を変えない
```

**既存の規律（そのまま使う。再実装しない）**

| もの | 場所 |
|---|---|
| 向きガード | `server/signalTrade/decisions.ts:145 stopOnCorrectSide` |
| 逆指値のスリップ | `decisions.ts:172 STOP_SLIPPAGE_YEN = 0` |
| 成行のスリップ | `decisions.ts:157 SLIPPAGE_YEN = 5` |
| LC 下限 | `server/config/scalpResolvers.ts:47 resolveScalpLcFloorYen`（既定 55） |
| LC 安全上限 | `scalpResolvers.ts:149` 付近の hardMax リゾルバ（既定 159・enabled 既定 true） |
| 決済逆指値の算出 | `decisions.ts:317 restingStopOf` → 非公開 `computeExitStop` |

---

## File Structure

| ファイル | 責務 | 新規/変更 |
|---|---|---|
| `core/exitReasons.ts` | 決済理由の表（SSOT・コンパイル強制） | 変更（`rule:bulge` 追加） |
| `server/signalTrade/ruleEntry.ts` | **新設**。`ruleToArmed` / バルジ強制決済の可否 / ドテン境界判定の**純関数だけ** | 新規 |
| `server/signalTrade/ruleEntry.test.ts` | 上の純関数の表テスト | 新規 |
| `server/signalTrade/decisions.ts` | `mode:'squeeze'` の型・約定・決済の分岐 | 変更 |
| `server/signalTrade/engine.ts` | 規則発の配線（武装・強制決済・ドテン・P の記録） | 変更 |
| `server/loops/levelsLoop.ts` | `getSqueezeSnapshot()` を公開（`getLevelsSnapshot` と同じ流儀） | 変更 |
| `server/configStore.ts` / `server/config/scalpResolvers.ts` / `server/routes/settings.ts` | トグル `squeezeTradeEnabled` | 変更 |
| `web/index.html` / `web/main.ts` / `web/components/settings/*` | トグルの UI | 変更 |
| `web/components/signalPanel.ts` | 規則発シグナルの表示 | 変更 |
| `server/db/store.ts` | `signal_trades.source` 列（ALTER 冪等） | 変更 |
| `scripts/squeeze-trade-audit.mts` | **新設**。実データで発火量を数える（出荷ゲート） | 新規 |

---

## Task 1: 決済理由 `rule:bulge` を足す

**Files:**
- Modify: `core/exitReasons.ts:39-50`
- Test: `core/exitReasons.test.ts`

**Interfaces:**
- Produces: `ExitReason` に `'rule:bulge'` が加わる。`EXIT_REASON_SPEC['rule:bulge'] = { label: 'バルジ強制決済', ratchet: false }`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// core/exitReasons.test.ts に追記
it('バルジの強制決済が決済理由として登録されている', () => {
  expect(EXIT_REASON_SPEC['rule:bulge']).toEqual({ label: 'バルジ強制決済', ratchet: false });
});
it('ラチェット由来ではない（利確ではなく規則による打ち切り）', () => {
  expect(EXIT_REASON_SPEC['rule:bulge'].ratchet).toBe(false);
});
```

- [ ] **Step 2: 落ちることを確認** — `npx vitest run core/exitReasons.test.ts` → FAIL
- [ ] **Step 3: 表に1行足す**

```ts
  doten:         { label: 'ドテン',       ratchet: false },
  'rule:bulge':  { label: 'バルジ強制決済', ratchet: false },
```

- [ ] **Step 4: 緑を確認 + `npx tsc --noEmit`**
- [ ] **Step 5: ★波及の確認** — `core/exitReasons.ts:18-22` に挙がっている `decisions.ts` / `persist.ts` / `db/store.ts` を開き、**新しい値を網羅していない switch / Record が無いか**を目で確認する。`tsc` が通っても、`default:` で握り潰している箇所は落ちない。見つけたら報告に書く（この時点では直さない）。

### ★Task 1 実施後に判明した事実（2026-08-16・実測）

**この節を Task 6 の担当は必ず読むこと。**

1. **`server/signalTrade/exitRecord.test.ts:146-152` が赤くなる。** 「表の全理由が実際の決済経路から1つずつ出る」という
   死んだ選択肢の禁止ガード（`core/exitReasons.ts:36-38`）が作動する。**これは設計どおりの正しい赤**であり、
   `rule:bulge` を実際に produce する経路（Task 6）が入るまで解消しない。
   → **Task 6 の担当が `exitRecord.test.ts` に `exitBulge()` 相当のケースを足すこと。**
   → それまで木は1本赤のまま。**この赤を消すために表から `rule:bulge` を消してはいけない。**

2. **`decisions.ts:542` は実質 `default:` の握り潰し。**
   ```ts
   exitReason: stop === pos.initialStop ? 'initial_stop' : 'ratchet_floor',
   ```
   phase-exit 経路の理由はこの二択に固定されている。**バルジ強制決済をこの分岐に通すと、理由が黙って
   `ratchet_floor` に化ける**（`tsc` は通る・既存テストも通る）。Task 6 は**専用経路**で `'rule:bulge'` を渡すこと。

3. **`exitReasonLabel()` には本番の消費者がまだ1つも無い**（`web/` `collector/` `scripts/` 全走査で0件）。
   Task 9 が繋ぐまでラベルはどこにも出ない。Task 9 は必ず `exitReasonLabel()` 経由にすること。

4. **`core/exitReasons.ts:18-22` の「消費側」注記が古い**（3ファイルしか挙げていないが実際は5つ。
   `server/signalTrade/shadow/sim.ts` と `server/db/shadowStore.ts` が抜けている）。Task 8 の担当が直すこと。

---

## Task 2: スクイーズ/バルジをエンジンから読めるようにする

**Files:**
- Modify: `server/loops/levelsLoop.ts`
- Test: `server/loops/levelsLoopSqueezeSnapshot.test.ts`（新規）

**Interfaces:**
- Produces: `export function getSqueezeSnapshot(): { state: SqueezeState; t: number | null; barHigh: number | null; barLow: number | null; price: number | null } | null`

`getLevelsSnapshot` と同じ流儀（engine は既に `engine.ts:23` でそれを import している）。

**★なぜ `squeezeFire` の戻り値ではないか:** `squeezeFire` は**エッジ1回＋30分クールダウン**しか返さない（`registry.ts:394-409`）。売買側は「今どちらの状態か」と「その足の高安」が要る。エッジだけだと、クールダウン中に建玉が発生した場合に状態が読めない。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('スクイーズ判定に使った確定足の高安と時刻を返す', () => {
  // levelsLoop に既知の足を流し込み、確定足の h/l がそのまま返ることを確認
  const snap = getSqueezeSnapshot();
  expect(snap!.state).toBe('squeeze');
  expect(snap!.barHigh).toBe(/* 流し込んだ確定足の高値 */);
  expect(snap!.barLow).toBe(/* 同 安値 */);
  expect(snap!.t).toBe(/* 確定足の時刻 */);
});
it('形成中の足は使わない（判定に使った足は必ず確定足）', () => {
  // 形成中足の高安を返していないこと（= 5分ごとにしか t が動かない）
});
it('判定材料が無いときは null（古い値を現在の状態として出さない）', () => {
  expect(getSqueezeSnapshot()).toBeNull();
});
```

- [ ] **Step 2: 落ちることを確認**
- [ ] **Step 3: 実装** — `runLevelDetectors` が既に作っている `closed` 配列と `snap` を、モジュール変数に保持して返すだけ。**7日窓の読み直しを増やさない**（既存の `slot` キャッシュに相乗りする）。
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: ★否定対照** — 保持を「形成中足込み」に変えるとテストが赤くなることを実際に確認し、報告に落ちたテスト名を書く。
- [ ] **Step 6: 既存不変の実証** — `npx vitest run server/detect/ server/loops/` が全緑。アラートの発火が変わっていないこと。

---

## Task 3: 設定トグル `squeezeTradeEnabled`（既定 false）

**Files:** `server/configStore.ts` / `server/config/scalpResolvers.ts` / `server/routes/settings.ts` / `web/components/settings/types.ts` / `web/components/settings/form.ts` / `web/index.html` / `web/main.ts`

**Interfaces:**
- Produces: `resolveSqueezeTradeEnabled(profile?: SignalProfile): boolean`（**未設定は false**）

**手本にする既存トグル:** `dotenEnabled`（profile 対応・既定 OFF・`readKnobRaw` 経由）。`indicatorsEnabled` は既定 ON なので**手本にしない**。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('未設定は false（既定で発注しない）', () => {
  expect(resolveSqueezeTradeEnabled()).toBe(false);
});
it('B は A へフォールバックする（dotenEnabled と同じ流儀）', () => { /* ... */ });
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**（`scalpResolvers.ts` に追加し `configStore.ts` から再エクスポート）
- [ ] **Step 5: 17箇所を通す** — 構造マップの D 節の表（1〜17）を順に埋める。
- [ ] **Step 6: ★実 HTTP で往復を実証** — サーバを起動し、`POST /api/settings/keys` で true を書き、`GET /api/settings` で true が返り、false に戻せることを **curl で**確認。テスト緑では完了としない。

### ★Task 3 実施後の訂正（2026-08-16・実測）

**この節は以降のタスクも読むこと。計画の記述が2つ間違っていた。**

1. **`PATCH /api/settings` は存在しない。** ルートは `GET /api/settings`（`server/index.ts:121`）と
   `POST /api/settings/keys`（`:122`）の2本だけ。上の Step 6 は訂正済み。

2. **「保存許可一覧(#6)を忘れるとボディが黙って捨てられる」は不正確だった。**
   `server/routes/settings.ts:84` の `_AllConfigKeysClassified` という型アサーションにより、
   `keyof UserConfig` は EXPLICIT / PRESERVED / NUMERIC のいずれかに分類されないとコンパイルが落ちる。
   実測: #6 だけ外すと `TS2344: Type '"squeezeTradeEnabled"' does not satisfy the constraint 'true'`。
   **真に無言で捨てられるのは #6 と #8（保存）を両方落としたときだけ。**
   → #6 の価値は「ボディが捨てられるのを防ぐ」ではなく「**#8 の書き忘れをコンパイル時に落とす**」こと。

3. **★命名で epoch が無言で割れる地雷がある（新発見）。**
   `EXPERIMENT_SETTINGS_PREFIXES` は **`'scalp'` 接頭辞の前方一致**で実験設定を判定する。
   実測: `isExperimentSettingsKey('scalpSqueezeTradeEnabled') = true` / `('squeezeTradeEnabled') = false`。
   もし `scalpSqueezeTradeEnabled` と命名していたら、**実走中の質問文 A/B の期が無言で割れていた**。
   → 今後 AIエントリー系の設定を足すときは、**名前だけで期が割れる**ことを意識すること。
- [ ] **Step 7: ★プロンプト版に含めない** — `server/generator/epoch.ts:66,75` の knob 列挙に**足さない**。このトグルはプロンプトを変えないので、足すと epoch が無駄に割れて A/B の標本が壊れる。この判断を報告に書く。

---

## Task 4: `ruleToArmed`（純関数・両レッグ生成と規律）

**Files:**
- Create: `server/signalTrade/ruleEntry.ts` / `server/signalTrade/ruleEntry.test.ts`

**Interfaces:**
- Consumes: `resolveScalpLcFloorYen` / LC 安全上限リゾルバ / `stopOnCorrectSide`
- Produces:

```ts
export const SQUEEZE_ENTRY_BUFFER_YEN = 5;   // 節目ちょうどには置かない（既存の流儀）

export interface SqueezeBar { high: number; low: number; }
export interface RuleArmInput {
  bar: SqueezeBar;
  now: number;
  lcFloorYen: number;
  lcHardMaxYen: number | null;   // null = 安全上限が無効
}
/** スクイーズ足から両側の逆指値ブラケットを作る。両レッグとも落ちたら null。 */
export function ruleToArmed(input: RuleArmInput): ArmedBracket | null;
```

**規律（仕様 5.2）**

- 買い: `bar.high + 5` に逆指値 / 売り: `bar.low - 5` に逆指値
- 損切りは**反対側の足の価格**: 買いの損切り = `bar.low - 5` / 売りの損切り = `bar.high + 5`
- 幅 = `(bar.high + 5) - (bar.low - 5)` = レンジ + 10（両レッグ同じ幅になる）
- 幅 < 下限 → **下限まで広げる**（損切り価格を動かす。建値は動かさない）
- 幅 > 安全上限 → **そのレッグを出さない**
- 両方落ちたら `null`

- [ ] **Step 1: 表テストを書く（固定の数値で）**

```ts
// 高値 100 / 安値 40 → 建値 105 と 35、素の幅 70
describe('ruleToArmed', () => {
  const base = { bar: { high: 100, low: 40 }, now: 0, lcFloorYen: 55, lcHardMaxYen: 159 };

  it('両側に逆指値を作る（建値は高値+5 / 安値-5）', () => {
    const a = ruleToArmed(base)!;
    expect(a.mode).toBe('squeeze');
    expect(a.range!.upper).toEqual({ side: 'buy',  type: 'stop', entry: 105, stopLoss: 35 });
    expect(a.range!.lower).toEqual({ side: 'sell', type: 'stop', entry: 35,  stopLoss: 105 });
  });

  it('★幅が下限未満なら、下限まで広げる（建値は動かさない）', () => {
    // 高値 100 / 安値 90 → 建値 105 と 85、素の幅 20 < 55 → 損切りだけを動かす
    const a = ruleToArmed({ ...base, bar: { high: 100, low: 90 } })!;
    expect(a.range!.upper).toEqual({ side: 'buy',  type: 'stop', entry: 105, stopLoss: 50 });   // 105-55
    expect(a.range!.lower).toEqual({ side: 'sell', type: 'stop', entry: 85,  stopLoss: 140 });  // 85+55
  });

  it('★幅が安全上限を超えるレッグは出さない', () => {
    // 高値 200 / 安値 40 → 幅 170 > 159 → 両レッグとも落ちる
    expect(ruleToArmed({ ...base, bar: { high: 200, low: 40 } })).toBeNull();
  });

  it('安全上限が無効(null)なら幅で落とさない', () => {
    const a = ruleToArmed({ ...base, bar: { high: 200, low: 40 }, lcHardMaxYen: null })!;
    expect(a.range!.upper!.entry).toBe(205);
  });

  // ★この形は一度「空振り合格」した(2026-08-16 に実測して修正済み)。
  //   `if (!a) continue` と `if (u)` / `if (l)` は **3重の逃げ道**になる。符号を反転すると
  //   最終検算が両レッグを落として null になり、1つも検査せずに緑で終わる。
  //   **検査した回数を数えて固定すること。** 以降のタスクで似た形を書くときも同じ。
  it('★向きは必ず正しい（買いの損切りは建値より下・売りは上）', () => {
    let checked = 0;
    for (const bar of [{ high: 100, low: 40 }, { high: 100, low: 90 }, { high: 61000, low: 60940 }]) {
      const a = ruleToArmed({ ...base, bar });
      expect(a, `足 ${bar.high}/${bar.low} は規律の内側なので武装できるはず`).not.toBeNull();
      const u = a!.range!.upper!, l = a!.range!.lower!;
      expect(u.stopLoss).toBeLessThan(u.entry);
      expect(l.stopLoss).toBeGreaterThan(l.entry);
      checked += 2;
    }
    expect(checked, '検査が空振りしている').toBe(6);
  });

  it('高安が同値/逆転している足は null（凍結フィード対策）', () => {
    expect(ruleToArmed({ ...base, bar: { high: 100, low: 100 } })).toBeNull();
    expect(ruleToArmed({ ...base, bar: { high: 40,  low: 100 } })).toBeNull();
  });

  it('非有限は null', () => {
    expect(ruleToArmed({ ...base, bar: { high: NaN, low: 40 } })).toBeNull();
  });

  it('★利確(rangeTp)を作らない = 決済は phase-exit に任せる', () => {
    expect(ruleToArmed(base)! as Record<string, unknown>).not.toHaveProperty('rangeTp');
  });
});
```

- [ ] **Step 2: 落ちることを確認**
- [ ] **Step 3: 実装**（`ruleEntry.ts`。**エンジンや DB を import しない純関数だけ**）
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: ★否定対照** — 損切りの符号を反転させると「向きは必ず正しい」が赤くなることを実際に確認し、落ちたテスト名を報告に書く。

---

## Task 5: `mode:'squeeze'` の約定と、エンジンへの配線

**Files:** `server/signalTrade/decisions.ts` / `server/signalTrade/engine.ts` / それぞれのテスト

**Interfaces:**
- `ArmedBracket.mode` / `OpenPosition.mode` に `'squeeze'` を追加（既存 `'range'` は不変）
- `detectRangeFill` を **`'range'` と `'squeeze'` の両方**で使う（OCO＝片方約定で反対を捨てる挙動は既存のまま）

**★なぜ `mode:'range'` に相乗りしないか**
- `computeHold` のレンジ分岐は `mode==='range' && rangeTp != null`。squeeze は `rangeTp` を作らないので**どちらでも phase-exit になる**が、`mode` を分けないと**記録で区別できない**。
- trade2 の `followRange`（実験終了・既定OFF）のゲートに巻き込まれる。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('★squeeze 建玉の決済逆指値は phase-exit（レンジの固定ストップではない）', () => {
  // rangeTp を持たない squeeze 建玉で computeHold を呼び、
  // hold.exitStop が restingStopOf の値と一致し、hold.rangeTp が undefined であること
});
it('片方が約定したら反対レッグは消える（OCO）', () => { /* detectRangeFill 経由 */ });
it('逆指値の約定は逆指値価格ちょうど（STOP_SLIPPAGE_YEN=0）', () => { /* ... */ });
it('★同じ足で両側に触れたら、買い側を優先せず「先に触れた方」だけが約定する', () => {
  // ここは実装の判断が要る。1分足の高安からは順序が決まらないので、
  // **悲観側（=損になる方）を採る**か「その足では約定させない」かを決め、テストで固定する。
  // ★実装者へ: どちらを採ったかと理由を報告に書くこと。
});
it('★squeezeTradeEnabled=false のときは武装しない（判定と記録は走る）', () => { /* ... */ });

// ★★鮮度の検査（Task 2 の実装から判明した必須要件・2026-08-16）
//
// `getSqueezeSnapshot()` は **最後の観測を保持し続ける**。クリアされるのは start/stop だけで、
// 取引時間外（inPollWindow=false でループが止まる）や tick 欠測の間も古い値が返り続ける。
// これを見ずに武装すると、**週明けに金曜のスクイーズ足で両側逆指値を出す**。
// 建値は金曜の高安なので、月曜の価格では即約定するか永久に届かないかのどちらかになる。
const FRESH_MS = 15 * 60_000;   // 足5分 + settle 20秒 + 1枠取りこぼし + 余裕

it('★古い観測では武装しない（保持された値をそのまま使わない）', () => {
  const obs = { state: 'squeeze', t: now - FRESH_MS - 1, barHigh: 61000, barLow: 60940, price: 60980 };
  expect(armFromSqueeze(obs, now, /* enabled */ true)).toBeNull();
});
it('鮮度の内側なら武装する（境界: ちょうど FRESH_MS は可）', () => {
  const obs = { state: 'squeeze', t: now - FRESH_MS, barHigh: 61000, barLow: 60940, price: 60980 };
  expect(armFromSqueeze(obs, now, true)).not.toBeNull();
});
it('★週明けの再開で、前営業日の足では武装しない', () => {
  // 金曜の確定足 → 月曜の now。実時間で2日以上空く形を明示的に固定する。
  const obs = { state: 'squeeze', t: now - 3 * 24 * 3600_000, barHigh: 61000, barLow: 60940, price: 60980 };
  expect(armFromSqueeze(obs, now, true)).toBeNull();
});
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**
- [ ] **Step 5: ★既存不変の実証** — `mode:'range'` の既存テストが**1本も書き換わっていない**こと。`git diff` で range 関連テストの差分が 0 行であることを示す。
- [ ] **Step 6: ★再起動で消えることを記録に残す** — `engine.ts:309-322` は state を復元しない。規則発の武装/建玉も**再起動で失われる**。この性質をコード注記に書く（実装は変えない。仕様の想定内）。

---

### ★Task 5 の積み残し（Task 6 の担当が最初に直すこと・2026-08-16 実測）

**`decisions.ts` の `armedToCurrentSignal` が、スクイーズの武装を `'range'` と名乗らせて外に出している。**

```ts
if (a.mode === 'range' || a.range != null) {
  s.mode = 'range';      // ← ★ハードコード。a.mode をコピーしていない
  s.range = a.range;
}
```

スクイーズの武装は2脚を持つので `a.range != null` が真になり、**`mode:'range'` として SSE と
`/api/current-signal` に出る**。trade2 の `followRange`（実験終了・既定OFF）を誰かが ON にすると、
スクイーズの武装が**レンジのストラドルとして実取引に流れる**。既定OFFなので今は無害だが、
「記録が嘘をつく」形であり、このリポジトリが繰り返し事故を起こした形。

**直し方（この順で）**

1. `CurrentSignal.mode` の型を `'range' | 'squeeze'` に広げる（`decisions.ts:59` 付近）
2. `armedToCurrentSignal` を `s.mode = a.mode ?? 'range'` に変える（**ハードコードをやめる**）
3. `server/types.ts` の `SignalTradeState` の `mode` も同様に広げる
4. **テストで固定**: スクイーズの武装から作った `CurrentSignal.mode` が `'squeeze'` であること。
   ★否定対照として、`'range'` にハードコードし直すと赤くなることを実際に確認する
5. `web/components/signalPanel.ts` の**独自 DTO** は Task 9 の担当（server の型を import していないので別途必要）

★これを直すと trade2 の `followRange` は `mode === 'range'` に一致しなくなり、
**スクイーズは追従されない**（第3弾では trade2 側の追従は実装しない方針なので、これが正しい状態）。

---

## Task 6: バルジ強制決済（④・利が乗っているときだけ）

**Files:** `server/signalTrade/ruleEntry.ts`（判定の純関数）/ `server/signalTrade/engine.ts`（配線）

**Interfaces:**

```ts
/** バルジで強制決済すべきか。含み損（0 を含む）は false = ロスカットに任せる。 */
export function shouldForceCloseOnBulge(
  pos: { direction: 'buy' | 'sell'; entryPrice: number }, price: number,
): boolean;
```

- [ ] **Step 1: 表テストを書く**

```ts
// ★値は日経スケール(61,000 前後)にしてある。小さい整数(100/101 など)を使うと
//   漏洩検査(server/signalTrade/exit/leak.test.ts ⑦弱い文脈)に引っかかる。実際に一度引っかけた。
it.each([
  ['buy',  61000, 61010, true ],   // 含み益
  ['buy',  61000, 61000, false],   // ★同値は決済しない（0 は「利が乗っている」ではない）
  ['buy',  61000, 60990, false],   // 含み損
  ['sell', 61000, 60990, true ],
  ['sell', 61000, 61000, false],
  ['sell', 61000, 61010, false],
] as const)('%s 建値%d 現値%d → %s', (dir, entry, price, want) => {
  expect(shouldForceCloseOnBulge({ direction: dir, entryPrice: entry }, price)).toBe(want);
});
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**
- [ ] **Step 5: エンジン配線のテスト**

```ts
it('★強制決済は既存の記録経路を通る（lastExitedSignalId が立つ）', () => {
  // これが立たないと trade2 の再同期が働かず、実取引だけ建玉が残る。
  // 仕様 5.0.1 の再訂正で確認した、この機能の生命線。
  expect(state.lastExitedSignalId).toBe(/* 決済したシグナルの signalId */);
});
it('決済理由は rule:bulge', () => { expect(recorded.exitReason).toBe('rule:bulge'); });
it('スリップは成行のもの（SLIPPAGE_YEN=5・逆指値の 0 ではない）', () => { /* ... */ });
it('含み損の建玉には何もしない（建玉が残る）', () => { /* ... */ });
it('squeezeTradeEnabled=false なら決済しない', () => { /* ... */ });
```

- [ ] **Step 6: 緑を確認**
- [ ] **Step 7: ★否定対照** — `lastExitedSignalId` を立てない実装に変えると、上のテストが赤くなることを確認して報告する。

---

### ★Task 6 の積み残し（Task 7 の担当が最初に直すこと・2026-08-16 実測）

**`server/routes/currentSignal.ts:23-24` に、まだ同じ嘘が残っている。**

```ts
if (sig.mode === 'range' || sig.range != null) {
  out.mode = 'range';      // ← ★ハードコード
  out.range = sig.range;
}
```

Task 6 が SSE 側（`armedToCurrentSignal` と `toSignalTradeState` の `entry.mode` / `signal.mode`）を直したが、
**`GET /api/current-signal` は今もスクイーズを `mode:'range'` と返す**。これは trade2 の
late-join 経路（`sseFeed.ts:314 fetchCurrentSignal` ほか4本）が読む口なので、**穴は塞がっていない**。

★この非対称（SSE には出るが GET には出ない／逆に GET だけ嘘をつく）は、このリポジトリが
**実害バグを出した既知の形**（`sseFeed.ts:172-186` に事故の記録がある）。

**直し方**: `out.mode = sig.mode ?? 'range'` にする。テストで「スクイーズの武装は GET でも squeeze と名乗る」
を固定し、**否定対照（`'range'` に戻すと赤くなる）まで実行する**。

---

## Task 7: バルジ価格 P とドテンの境界判定（⑤後半）

**Files:** `server/signalTrade/ruleEntry.ts` / `server/signalTrade/engine.ts`

**Interfaces:**

```ts
/** ロスカット決済がバルジ価格 P をまたいだか。またいだときだけドテンする。
 *  ちょうど P はまたいでいない（仕様の表どおり）。 */
export function crossesBulge(entryPrice: number, exitPrice: number, bulgePrice: number): boolean;
```

`OpenPosition` に `bulgePrice?: number` を追加（バルジが複数回出たら**直近で上書き**）。

- [ ] **Step 1: 仕様の表をそのままテストにする**

```ts
it.each([
  ['買い', 110, 100, 105, true ],   // 仕様の表 1行目
  ['買い', 110, 106, 105, false],   // 2行目
  ['売り', 100, 108, 105, false],   // 3行目
  ['売り', 100, 110, 105, true ],   // 4行目
  ['ちょうど P（建値側）', 105, 100, 105, false],
  ['ちょうど P（決済側）', 110, 105, 105, false],
] as const)('%s: 建値%d 決済%d P=%d → %s', (_l, e, x, p, want) => {
  expect(crossesBulge(e, x, p)).toBe(want);
});
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**
- [ ] **Step 5: エンジン配線のテスト**

```ts
it('バルジが複数回出たら直近の P で上書きされる', () => { /* ... */ });
it('★ドテンするのはロスカット決済のときだけ（バルジ強制決済の後にドテンしない）', () => {
  // 強制決済は「利が乗っている」ので、そこからドテンすると仕様の意図と逆になる。
});
it('P が無い建玉（バルジを経験していない）はドテンしない', () => { /* ... */ });
it('ドテンの記録は exitReason=doten（既存）で、発生源が rule:doten', () => { /* ... */ });
it('squeezeTradeEnabled=false ならドテンしない', () => { /* ... */ });
```

- [ ] **Step 6: 緑を確認 + `npx tsc --noEmit`**

---

## Task 8: 発生源 `source` の記録

**Files:** `server/signalTrade/decisions.ts` / `persist.ts` / `server/db/store.ts` / `core/`（型）

**Interfaces:**
- `type SignalSource = 'ai' | 'rule:squeeze' | 'rule:doten'`（**`'rule:double'` は作らない**）
- `ArmedBracket.source?` / `OpenPosition.source?` / `RecordedTrade.source?`
- `signal_trades.source` 列（**ALTER 冪等**。既存行は NULL = AI 発）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('AI 発の建玉は source=ai として記録される', () => { /* ... */ });
it('スクイーズ発は rule:squeeze', () => { /* ... */ });
it('規則発のドテンは rule:doten（AI 発のドテンとは区別できる）', () => { /* ... */ });
it('既存行（source 列が無かった時代）は NULL のまま読める', () => { /* 実ファイル SQLite で */ });
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**
- [ ] **Step 5: ★実ファイル SQLite で実証** — メモリDBではなく一時ファイルに旧スキーマの DB を作り、ALTER が冪等に通り、既存行が壊れないことを確認する。

---

## Task 9: 規則発シグナルの画面表示（仕様 5.0.2）

**Files:** `web/components/signalPanel.ts` / `web/components/signalPanel.test.ts`

**★注意:** `signalPanel.ts:31-64` は server の `SignalTradeState` を import せず**独自に再定義**している。フィールドを足すときは**両方**触る。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('スクイーズの両側待ちは両レッグを出す', () => {
  expect(buildSignalView(st).main).toContain('スクイーズ 両側待ち');
  expect(buildSignalView(st).main).toContain('69,240');
  expect(buildSignalView(st).main).toContain('69,120');
});
it('★バルジの強制決済は「理由」が画面に出る', () => {
  // ★文字列を再ハードコードしない。表(core/exitReasons.ts)が唯一の出所。
  //   画面側で書き直すと、表を直したときに画面だけ古い語が残る(このリポジトリが繰り返した事故)。
  expect(buildPositionView(st, now).main).toContain(exitReasonLabel('rule:bulge'));
});
it('規則発のドテンは、発生源が規則であることが分かる', () => { /* ... */ });
it('AI 発の表示は1文字も変わらない', () => {
  // 既存のフィクスチャを通して、旧実装と同じ文字列になること
});
```

- [ ] **Step 2〜4: 落ちる → 実装 → 緑**
- [ ] **Step 5: ★実描画で実証** — アプリを起動し、規則発の状態を流し込んで**実際に画面に出ること**をスクリーンショットか DOM ダンプで示す。テスト緑では完了としない。
- [ ] **Step 6: 遷移音が鳴ることの確認** — `signalPanel.ts:230-235` の既存ロジックは `phase` の変化で鳴る。規則発でも `phase` が動くので鳴るはずだが、**実際に鳴ることを確認**して報告する。

---

## Task 10: ★実データでの発火量監査（出荷ゲート）

**Files:**
- Create: `scripts/squeeze-trade-audit.mts`

**これが無いと出さない。** 「テストが緑」は完了ではない。ユーザーの要求は「シグナルの発生は十分検証して」である。

- [ ] **Step 1: スクリプトを書く** — `%APPDATA%\jp225-monitor\jp225.db`（213日ぶんの1分足がある）を **readOnly コピー**して再生し、次を数える:

| 出す数字 | なぜ |
|---|---|
| スクイーズ武装の回数 / 日 | 乱発していないか |
| そのうち **約定した**回数（買い側 / 売り側） | 両側の偏り＝ベータの有無 |
| **両レッグとも落ちた**回数と理由（下限で広げた / 安全上限で落とした） | 規律が効きすぎて無発火になっていないか |
| バルジ強制決済の回数 / 全決済に占める割合 | ④が実際に効くか |
| ドテンの回数 / P をまたがず見送った回数 | 境界規則が「常に真」や「常に偽」になっていないか |
| 武装から約定までの中央値[分] | 逆指値が現実的な位置か |

- [ ] **Step 2: 実行して結果を報告に貼る**
- [ ] **Step 3: ★異常の判定基準を先に決める** — 実行**前**に「これを超えたら乱発とみなす」線を書いてから実行する（後から基準を作らない）。目安: 武装が **5回/日**を超える、または **0.05回/日**を下回る（＝実質無発火）なら較正し直す。
- [ ] **Step 4: ★片側だけに偏っていないか** — 買い側だけが約定している場合、それは日経のロングバイアス（ベータ）である可能性が高い。第2弾までの検証で**繰り返し出た形**なので、必ず両側を分けて報告する。
- [ ] **Step 5: `npx tsx scripts/alert-audit.mts` も実行** — 検知そのものを変えていなくても、`levelsLoop` に手を入れるので**既存アラートの発火が変わっていない**ことを確認する。

---

## 出荷ゲート（全タスク完了後・リーダーが確認する）

- [ ] `npx tsc --noEmit` クリーン
- [ ] `npx vitest run` 全緑（**既存テストを書き換えていない**こと。変えたなら理由）
- [ ] 漏洩検査 10 passed / skip 0
- [ ] Task 10 の監査結果が判定基準の内側
- [ ] `alert-audit` で既存アラートが不変
- [ ] 実 HTTP（Task 3）と実描画（Task 9）の実証がある
- [ ] エバリュエーターの判定が「出してよい」
- [ ] **`squeezeTradeEnabled` の既定が false であること**（実取引が黙って動き出さない）
- [ ] リリースノートに **「実取引での実証はまだ無い」** と明記する

---

## この計画で**やらないこと**

- **ダブル（⑥）の売買** — 撤回済み（仕様 第6章の追記）。`source` に `'rule:double'` も作らない。
- **trade2 の変更** — バルジ強制決済は既存の再同期経路（`lastExitedSignalId` → `flatten`）で自動的に効く。
  ただし **`mode:'squeeze'` の武装を trade2 が追従する実装は別途必要**。第3弾は monitor の仮想取引で
  挙動を確認するところまでとし、trade2 側は次版に回す（既定 OFF なので実害なし）。この分割を
  リリースノートに明記する。
- **AI プロンプトへの追記** — 実走中の質問文 A/B を割らない。
