# monitor=ブレイン / trade2=実行のみ(決済逆指値も追従・クールダウンもmonitor) (design)

日付: 2026-07-16 / 対象: monitor + trade2 / ★★実弾・決済ロジック直結・最重要

## 目的
monitor を**完全な意思決定者**にし、trade2 は **monitor の指示どおり実発注するだけ**。
違いは **実約定価格のみ**。エントリー(指値/逆指値)・初期LC は既に monitor値(v0.1.26)。本設計で
**保有中の動く決済逆指値(exitStop)も monitor に追従**し、**クールダウンも monitor 側**に置く。

## 重要な前提(確認済み)
monitor シグナルエンジンの決済は **`computeExitStop`(動く resting stop・ラチェット床)による stop-only**。
TP指値・成行決済(揉み合い見切り等)は**持たない**。→ trade2 は **exitStop に実ストップを同期するだけ**で
決済まで monitor と一致する(提案の takeProfit/flatten は monitor が使わないため今回は実装しない=moot)。

## monitor 変更
### クールダウン(過剰エントリー原因③)
- 設定 `scalpCooldownSec`(config.json+⚙️UI+resolver・既定 **90**・0で無効)。
- signalエンジン: **決済(filled→flat)後 `scalpCooldownSec` 秒は再ARMしない**(全決済後に適用)。
  再計画ゲート(節目リアーム)に AND。cooldown 中は plan 要求もしない(ログ `cooldown` 出す)。
### exitStop の公開
- filled 中、engine が毎tick算出する `computeExitStop` の絶対価格を **`exitStop`** として公開。
- `SignalTradeState`(SSE `signalTrade`)と `GET /api/current-signal` に、**保有中の意図**を追加:
  `hold?: { signalId:number; direction:'buy'|'sell'; entryPrice:number; exitStop:number|null; at:number }`
  (signalId=そのエントリーの ARM 采番と同一=trade2 が「どの建玉のストップか」を対応づけられる)。
  flat/armed 時は hold なし。**既存 phase/entry/position/lastExit フィールドは不変**(表示互換)。
- engine が position 保持中に signalId を持ち続ける(ARMの采番を filled にも引き継ぐ)。

## trade2 変更(自前決済を撤去し追従)
### 撤去
- **自前 phase-exit**: AIエントリー建玉に対する `LevelBracketStrategy`(`this.exit`)のラチェット決済委譲
  (`exit.onMarket`/`resetPositionState`/節目利確 limit/揉み合い見切り)。=trade2 は決済を**計算しない**。
### 追加(決済ストップの追従)
- 保有中(建玉あり)、monitor の `hold.exitStop`(自分が入った signalId のもの)に **実の決済逆指値を常時同期**:
  値が変わったら bracket を置き直す(既存の bracket/lastStop 置換機構を流用)。
- **★安全(実弾必須)**: `exitStop` が **null / フィード途切れ / signalId 不一致** のときは、**直近に置いた
  ストップを維持**(絶対に外さない=無防備を作らない)。初回は monitor の初期LC(v0.1.26 の adoptedStopLoss)を置く。
### 温存(不変=手足)
- 建玉照会リコンサイル(実建玉の真実)、逐次OCO(cancel-the-loser)、注文ハイジーン、注文ID追跡、
  発注/約定/送信、entry時の checkSanity・建玉照会クリアゲート、doten(別系統・据え置き)。

## エッジ/整合(実弾)
- **monitor filled だが trade2 実建玉なし**(エントリー未約定): trade2 は reconcile が実建玉0を示すので
  決済ストップを置かない(建玉が無い side に発注しない=既存ハイジーン)。
- **trade2 保有中に monitor が再ARM**(cooldown 明け・新signalId): trade2 は保有中=新シグナル取らず(既存)。
  自分の signalId の hold が来なくなっても**ストップは維持**(安全)。
- **monitor 未起動/フィード切れ**: 直近ストップ維持で建玉を保護。復帰で同期再開。

## テスト/受入(★実弾・最厳格)
- monitor: cooldown(決済後N秒は再ARMなし・0で無効)・`hold.exitStop` 公開(filled で毎tick更新・signalId対応)・
  resolver/設定保存。純関数/ルート/エンジンをテスト。既存 signalTrade 表示不変。
- trade2: 「exitStop 同期」純関数(値変化で置換要否・null/不一致/フィード切れは維持)・自前 phase-exit 撤去の参照切れ無し・
  **建玉が無い時に決済発注しない**・初期LCは従来どおり monitor 値。**発注/約定/OCO/リコンサイル/ハイジーン/doten は不変**。
- **エバリュ最重点(実弾)**: (a)trade2 が決済を自前計算しない=monitorのexitStopに追従、(b)**いかなる時も保有建玉が
  無防備(ストップ無し)にならない**=フィード切れ/null/signalId不一致で直近ストップ維持、(c)建玉が無い側に決済発注しない、
  (d)cooldown が決済後に効き過剰エントリーが減る、(e)実約定価格以外は monitor と一致、(f)doten/リコンサイル温存。
  両リポ tsc0/vitest緑/build緑。

## リリース
- monitor v0.7.46 / trade2 v0.1.27。署名ビルド→両公開→マニュアル/メモリ更新。

## 非対象
- takeProfit/flatten(monitor が stop-only のため moot)。将来 monitor 決済モデルを拡張する時に追加。
