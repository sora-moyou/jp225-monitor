# 追従の詰まり修正(armedの間だけ追従)＋保護ストップ自己修復 (design)

日付: 2026-07-17 / 対象: monitor + trade2 / ★実弾

## 背景(実データで判明)
kabu(追従版稼働)で **trade2 が古いシグナルを毎tick再試行して詰まる**(90分で sanity fail 830件)。
原因: monitor が ARM したシグナルを**自身の sim が約定(phase=filled)して保有中**でも、trade2 は
`shouldFollowSignal`(FLAT かつ 新signalId)だけで判定し、**monitor が既に取ったか(phase)を見ない**ため、
価格が両建ての外に出た約定済みシグナルを追い続け、サニティ却下では lastActedSignalId が更新されず無限再試行。
→ trade2 が入れず monitor と乖離(本日 monitor 5件 / trade2 1件)。安全影響なし(FLAT・無防備なし)。
併せて既知の堅牢化(前回エバリュ指摘): 保護close拒否時の理論的沈黙naked を自己修復で閉じる。

## Fix A: monitor が `armed` の間だけ追従(詰まり解消)
### monitor(小)
- `GET /api/current-signal` に **`phase: 'flat'|'armed'|'filled'`** を追加(SSE `signalTrade` は既に top-level phase を持つ)。late-join でも trade2 が phase を取れるように。挙動変更なし・表示不変。
### trade2
- `sseFeed` が signalTrade の **top-level `phase`** を保持(`monitorPhase` getter・未受信/GET初期同期含む)。entryLoop に `monitorPhase: () => 'flat'|'armed'|'filled'|null` を配線。
- `shouldFollowSignal` に **`phase === 'armed'` を AND** 条件で追加(filled/flat/null では追従しない=monitor が取った/未ARMのシグナルを追わない)。これで「monitar が armed の一瞬だけ・新signalId・FLAT・direction!=none・sanity通過」で1回だけ入り、乗り遅れたら次 ARM を待つ。
- ※lastActedSignalId は従来どおり sanity 通過時のみ更新(armed 中は価格が両建ての間に戻れば入れる=機会を残す)。armed が終われば phase ゲートで止まる=無限再試行が構造的に不能。
- 純関数として `shouldFollowSignal(state, signal, lastActed, monitorPhase)` をテスト(armed のみ true / filled・flat・null は false)。

## Fix B: 保護ストップ自己修復(無防備ゼロ化)
### trade2
- 既存 `queryBrokerState()`(建玉照会+新規/返済注文状況)を保有中も定期に回す前提で、**保有建玉があるのに
  ブローカー側に保護close(返済逆指値)が実在しない**ことを検知したら、**直近の保護ストップ(lastPlacedStop or
  現在の hold.exitStop)を強制 re-assert**(再発注)する。
- 検知: reconcile スナップショット(実建玉あり)＋ 返済注文状況に当該サイドの close 逆指値が**無い**。
  一過性の照会失敗/不確実は re-assert しない(fail-safe: 確実に「無い」時だけ)。ハイジーン(送信2秒/dedup/ブレーカー)で過剰発注防止。
- 純関数 `needsStopReassert(held, hasProtectiveClose, lastStop)` を切り出しテスト(建玉あり&close無し&lastStop有 → true / それ以外 → false)。
- **★安全**: これは「ストップを足す」方向のみ。ストップを消す/緩めることはしない。lastStop 不明なら発注しない(既存の初期LC/exitStop が権威)。

## 温存(不変)
発注/約定/OCO/±なし(価格そのまま)/checkSanity/建玉照会クリアゲート/exitStop 同期(v0.1.27)/doten/
src/live・src/core は無改変。Fix A は追従判定に AND 追加、Fix B は reconcile 監視に「足すだけ」を追加。

## テスト/受入(★実弾)
- monitor: GET に phase・SSE 不変・既存緑。
- trade2: `shouldFollowSignal` の phase ゲート(armed のみ)、`needsStopReassert` 純関数、保有中に close 欠落→再assert・
  照会失敗時は再assertしない、ストップを消さない。既存の追従/exitStop同期/売買パス不変。
- **エバリュ重点**: (a)filled/flat の signalId を追従しない=詰まり解消、(b)自己修復が「足すだけ」で無防備化を作らない・
  照会失敗で誤発注しない、(c)実行部/doten/exitStop同期 温存、(d)過剰発注しない。両リポ tsc0/vitest緑/build緑。

## リリース
- monitor v0.7.47 / trade2 v0.1.28。署名ビルド→両公開→メモリ更新。
