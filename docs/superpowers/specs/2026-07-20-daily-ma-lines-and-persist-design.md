# 日足MA5/20/50/75 の追加＋MA25バンド維持＋取引日15:45終値の永続化 (design)

日付: 2026-07-20 / 対象: monitor2 のみ / 版=v0.8.6(継続)

## 目的(ユーザー・訂正込み)
- 先行修正: 日足バンド(MA25 ±1σ/±2σ)を**取引日足=15:45終値**基準に修正済(v0.8.6)。**MA25バンドは維持**。
- 追加: **日足MA5 / MA20 / MA50 / MA75 を"線"としてアラートに追加**(これらは±σバンドは付けない=線のみ)。
- **15:45終値が無い日時は保存**(基礎データに15:45が無い取引日でも、取引日終値を durable に保存し欠損を埋める)。
  ※MA75には75本の取引日終値が必要なため、履歴の完全性が重要。

## A. 日足MA線の追加(MA5/20/50/75・バンドなし)
- `dailyBand.ts`: 既存 `computeDailyBands`(MA25±σ)は**そのまま維持**。追加で純関数
  `computeDailyMAs(dailyCloses: number[]): { price: number; label: string; period: number }[]` を新設。
  各期間(5/20/50/75)につき、**その期間以上の終値がある時だけ** 直近period本の単純平均を1水準として返す(不足期間はスキップ)。label 例 `MA5`。丸めは整数。
- `levelsLoop`: 既存 `confirmedDailyCloses`(取引日15:45終値・v0.8.6で Day セッション化済)を使い、
  `dailyMaLevels = computeDailyMAs(dailyCloseSeries(confirmedDailyCloses, latest.price))` を毎tick算出
  (バンド同様、進行中取引日の終値=現在値を append してリアルタイム)。
  ★**MA75用に取引日終値を≥75本確保**: `getSessionOHLC` の取得深さを増やし(Dayセッション≥75=取引日75)、`confirmedDailyCloses` の保持を `slice(-80)` 程度に拡張。
- 発火: 既存のバンドと同じ機構(`detectLevelBreak`/`detectLevelHold` + ゾーン/方向クールダウン)で、`dailyMaLevels` を水準として直接 emit。ラベルは `日足MA5` `日足MA20` `日足MA50` `日足MA75`。detectionKind は既存の `dailyband`(または新種別 `dailyma`。履歴の種別表示 `alertHistory.ts:42` に「日足MA」を追加)。バンド(MA25±σ)の emit は不変。

## B. 取引日15:45終値の永続化(欠損日を保存)
- 新テーブル **`daily_closes(symbol TEXT, session_date TEXT, close REAL, t INTEGER, PRIMARY KEY(symbol, session_date))`**(store.ts・idempotent CREATE)。
- **確定した取引日の終値を upsert**: 取引日=Dayセッション。各 Day セッションの終値(=15:45 の bar・**無ければ当該 Day セッションの最後に存在する bar** を代替終値)を `upsertDailyClose` で保存。
  - **基礎データ import 時**(`importBars` 後): 取り込んだ範囲の各 Day セッション終値を daily_closes に upsert(歴史分を埋める)。
  - **ライブ**(levelsLoop or collector): Day セッション確定後(15:45経過)に当日の取引日終値を upsert(以後は毎日保存され蓄積)。
  - ★これで「15:45 の bar が無い取引日」も、その日の Day セッションの最終 bar を終値として**保存**する(欠損を残さない)。
- 日足MA/バンドの終値系列は **daily_closes 優先**(完全・durable)で取得し、無ければ従来の getSessionOHLC Day クローズにフォールバック。confirmed 系列=daily_closes の close(古い→新しい)。進行中取引日は現在値で代表(不変)。

## 不変/非対象
- MA25±σバンド(v0.8.6・15:45基準)の算出・emit は不変。σ(母N=25)不変。
- トレードシグナルA/B・trade2・私的exit は無関係。UI(主要レベルパネル)は既存の levels 表示に日足MA線が水準として乗る(表示機構不変)。

## テスト/受入
- computeDailyMAs(5/20/50/75・不足期間スキップ・丸め)、confirmedDailyCloses が≥75確保できる取得深さ、
  daily_closes upsert(基礎データ import で歴史埋め・ライブで日次追加・15:45欠損時は Day 最終bar代替)、
  MA線が detectLevelBreak/Hold で emit(日足MA5..75 ラベル)、MA25バンドは不変。
- ★検知変更: 実データで日足MA線と MA25バンドの水準が妥当(現値近傍)・発火頻度が過剰でない(クールダウン維持)。tsc0/vitest緑/build緑。
- 受入の肝: (a)MA25±σバンドは維持(15:45基準・不変)、(b)日足MA5/20/50/75 が線として追加され抜け/反発で発火、(c)取引日15:45終値が daily_closes に永続化され欠損日も保存、(d)MA75に必要な≥75本を確保、(e)trade2/A-B 無関係。
