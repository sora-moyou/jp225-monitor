# trade2 を monitor シグナルの追従者にする(同一提案を共有) (design)

日付: 2026-07-16 / 対象: monitor(Finance_Monitor) + trade2(jp225-trade2) / ★実弾・大改修

## 目的
AIのエントリー提案を **monitor の単一シグナル** に集約し、trade2 はそれを **完全追従** する。
trade2 は自分でAIを呼ばない。**違いは実際の約定値のみ**(trade2=実/紙の建値、monitorシグナル=擬似約定)。
- 保有中は新シグナルを見送り、FLAT に戻って次シグナルを待つ。
- バイアス・最大初期LC・節目トリガーは monitor 設定(既実装 v0.7.44)。
- 決済は従来 phase-exit を各建玉に対して継続(ロジック同一・約定値のみ実物)。

## monitor 変更(現在シグナルを公開)
### 現在シグナル(currentSignal)の保持と公開
- signalエンジンが **ARM するたびに単調増加 `signalId`(整数)を採番**し、**最新の armed プラン**を
  `currentSignal = { signalId, at, direction, limitEntry?, stopEntry?, stopLossForLimit?, stopLossForStop?, rationale }`
  として保持(engine.ts)。エンジンが擬似約定(filled)に進んでも currentSignal は **保持し続ける**
  (次に ARM した時のみ signalId 更新)。見送り(none)では ARM しない=更新なし。
- **SSE `signalTrade` 拡張**: payload に `signalId?: number` と full plan の両レッグ+SL を追加
  (`SignalTradeState` に `signal?: { signalId, direction, limitEntry?, stopEntry?, stopLossForLimit?, stopLossForStop?, at }`)。
  **既存の表示用フィールド(phase/entry/position/lastExit)は不変**(パネル互換)。ARM 時に即 broadcast。
- **`GET /api/current-signal`**: `{ signalId, at, direction, plan:{limitEntry,stopEntry,stopLossForLimit,stopLossForStop}, rationale } | { signalId:null }`
  を返す(late-join の trade2 が初期同期に使う)。表示専用で発注はしない。
- エンジンの擬似約定/決済/DB/節目リアーム/qty=1/enforcePlanConstraints は不変。

## trade2 変更(自前AIを撤去し追従へ)
### 撤去
- **自前AI要求経路**: `planner.ts`(requestPlan/POST `/api/scalp-plan`)、`entryLoop` の `maybeRequestPlan`/
  broker-clear→AI要求、**trade2側の節目リアーム(ai-wait suppress)**、`monitorBaseUrl` への scalp-plan POST。
- **価格微調整**: `adjustEntryDistance`(現値から50円離す)と `enforceFiveYen`(±5円) を**撤去**
  = monitor の提案価格を**そのまま**使う(=約定値以外は完全一致)。
### 追加(シグナル追従)
- monitor の **SSE `signalTrade` を購読**(既存 sseFeed に配線・levels 購読と同方式)し、
  `currentSignal(signalId+full plan)` を保持。接続直後は `GET /api/current-signal` で初期同期。
- entryLoop の FLAT 分岐を置換: **FLAT かつ 建玉照会クリア かつ `currentSignal.signalId != lastActedSignalId` かつ
  direction!=none** のとき、その提案でエントリー(**checkSanity 通過時のみ**・従来の逐次OCO実行)。
  発注したら `lastActedSignalId = currentSignal.signalId`(同一シグナルで二重発注しない)。
- **保有中(ARMED/FILLED)は新シグナルを取らない**。FLAT 復帰後に「その時点の currentSignal」を上記条件で取る
  (保有中に過ぎたシグナルは追わない=ご指定)。
### 温存(不変=実弾の安全弁)
- 逐次OCO(cancel-the-loser)・**checkSanity(現値が両建ての間でなければ見送り)**・建玉照会クリアゲート・
  **phase-exit(決済)**・doten・リコンサイル・注文ハイジーン。発注/約定/送信の実装は不変。

## テスト / 受入(★実弾・厳格)
- monitor: currentSignal 採番(ARM毎に+1・filled でも保持・none で不変)・SSE payload に signal(full plan+id)が入る・
  `/api/current-signal` シェイプ。純関数/ルートをテスト。既存 signalTrade 表示・パネル不変。
- trade2: 純関数「次シグナル採用判定」(flat&clear&new id&!none→採用 / holding→skip / same id→skip)をテスト。
  価格微調整撤去で **提案価格がそのまま発注価格**になること。planner 撤去の参照切れ無し。
  **売買パス(逐次OCO/サニティ/建玉ゲート/phase-exit/doten/リコンサイル)は不変**。
- **エバリュ重点**: (a)trade2 が自前AIを一切呼ばない、(b)同一 signalId で二重発注しない、
  (c)保有中は新シグナルを取らない、(d)提案価格=発注価格(±5/50円が消えた)、(e)サニティ/建玉ゲート温存で
  実弾安全、(f)monitor currentSignal の採番/公開が正しい。両リポ tsc0/vitest緑/build緑。

## リリース
- monitor v0.7.45 / trade2 v0.1.26。署名ビルド→両公開→マニュアル/メモリ更新。

## 非対象
- 過剰エントリー原因③(損切り直後の即再突入)は本設計で自然に緩和(trade2は monitorの1シグナルに同期)。
  monitorエンジン自身の再突入抑制(クールダウン)は別途必要なら後続。
