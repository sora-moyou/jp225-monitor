# AIエントリー制御(最大初期LC・バイアス)を monitor に一元化 (design)

日付: 2026-07-16 / 対象: monitor(Finance_Monitor) + trade2(jp225-trade2) / ★実弾挙動が変わる

## 目的
AIエントリーの制御を **monitor(scalp-plan)に一元化**する。
- **最大初期LC(円)** と **バイアス(買い中心/売り中心/両方向)** を monitor の設定にし、`buildScalpPlan` が
  **コードでハード適用**して「LC上限・バイアス準拠のプラン」だけを返す。
- monitor シグナルエンジンと trade2 の両方が、この monitor 設定に従う(単一の真実)。
- trade2 側の重複ガード(LCガード・バイアスveto)は撤去して monitor に委ねる。
- monitor シグナルエンジンの **枚数=1固定**。

背景: 同期データ実測で、monitorエンジン(buildScalpPlan直呼び・バイアスveto無し)が全売り40件・78%がLC損切り
＝過剰エントリー。バイアス移設で「veto無し」を解消する(他要因①③は別課題)。

## monitor 変更
### 設定(configStore.ts + ⚙️UI + routes/settings.ts)
- `UserConfig` に **`scalpLcCeilingYen?`**(最大初期LC・円)と **`scalpBias?`('long'|'short'|'none')** を追加。
- resolver: `resolveScalpLcCeiling()`(未設定は現行既定65)/`resolveScalpBias()`(未設定は 'none')。
- settings GET に現値、POST で保存(applyVisibleField 系・数値は範囲検証)。⚙️UIに「最大初期LC(円)」入力と
  「バイアス」選択(買い中心/売り中心/両方向)を追加。保存で即時反映(reload不要 or 次計画で反映)。

### buildScalpPlan のハード適用(openai.ts)
- `ScalpPlanInput` に `bias?: 'long'|'short'|'none'` を追加。`buildScalpPlan` は
  **lcCeilingYen 未指定なら `resolveScalpLcCeiling()`、bias 未指定なら `resolveScalpBias()`** を既定に使う
  (＝直呼びのシグナルエンジンも monitor 設定に従う)。
- 純関数 **`enforcePlanConstraints(plan, {ceilingYen, bias})`** を新設しテスト:
  1. **LC上限**: 各レッグ(指値/逆指値)の初期LC幅 = |entry − stopLoss| が ceilingYen 超なら**そのレッグを落とす**
     (limitEntry/stopLossForLimit or stopEntry/stopLossForStop を除去)。両レッグ落ちたら `direction:'none'`。
  2. **バイアス**: bias='long' かつ direction='sell' → 'none' / bias='short' かつ 'buy' → 'none' / 'none'は素通し。
  - `buildScalpPlan` が parse 後にこれを適用してから返す。プロンプトのLC/バイアス文言は補助(最終保証はコード)。
- プロンプトにバイアス指示を追記(buildScalpUserContent/system: 'long'=買い中心/売り新規veto 等)。**保証はコード**。

### signal engine(engine.ts)
- **QTY=1 固定**(既存 QTY 定数を 1 に固定・可変にしない)。
- buildScalpPlan 呼び出しは lc/bias を明示指定しない(＝ monitor 設定の既定が適用される)。

## trade2 変更(撤去してmonitorに委ねる)
- `entryLoop.ts`: **`evaluateLcGuard` / `lc-skip` / `LC_SKIP_REARM` / lcFloor()/lcCeiling() 参照 / dep lcFloorYen・lcCeilingYen** を撤去。
- **tradeBias のクライアント側veto** を撤去(bias veto 判定箇所・`/api/bias`・UIボタン・doten と別)。★doten は残す。
- `liveOrderStore.ts`: `lcFloorYen`/`lcCeilingYen`/`tradeBias` を config から撤去(既存 live.json に残っても無視=無害)。
- `/api/scalp-plan` 要求に **lcFloorYen/lcCeilingYen を渡すのをやめる**(monitor 設定が既定適用)。
- UI(web/): 初期LC下限/上限入力・バイアスボタン を撤去。
- **★安全**: 撤去は monitor の `enforcePlanConstraints`(ハード保証)が入った上で行う。trade2 は「monitorが
  LC上限・バイアス準拠を保証したプラン」を受けるだけ。**発注/約定/OCO/±5円/50円距離/phase-exit/節目リアーム
  /サニティは不変**(撤去するのは LCガードとバイアスvetoのみ)。

## テスト / 受入(★実弾のため厳格)
- monitor: `enforcePlanConstraints` を網羅(上限超レッグ落とし/両超→none/bias違反→none/none素通し/境界=ちょうどは許可)。
  resolver・settings 保存・buildScalpPlan が既定に config を使うことを確認。tsc0/vitest全緑/build:web緑。
- trade2: 撤去後も **売買パスが不変**(発注/約定/OCO/±5円/50円距離/phase-exit/節目リアーム/サニティ)。
  tradeBias/LCガード関連テストは削除/置換。tsc0/vitest全緑。
- **エバリュエーター重点**: (a)監視エンジン/ trade2 の双方に monitor の LC上限・バイアスがハードで効く、
  (b)trade2 から上限超/バイアス違反プランがエントリーに到達しない(=撤去が安全)、(c)qty=1固定、(d)doten等他機能不変。

## リリース
- monitor v0.7.44 / trade2 v0.1.25(版3点)→ 署名ビルド → 両リポ公開 → マニュアル/メモリ更新。

## 非対象(次課題)
過剰エントリー原因①(エンジンが chart/ガードレール無しの直呼び)③(損切り直後の即再突入)は本スコープ外。
