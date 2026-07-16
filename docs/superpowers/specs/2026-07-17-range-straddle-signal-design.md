# レンジ判断時の両面ストラドル(AI選択・別枠計測) (design)

日付: 2026-07-17 / 対象: monitor + trade2 / ★★実弾・戦略追加・全経路

## 目的
AIが**レンジと判断**したとき、現在価格の**上と下に1つずつ**エントリーを置く(両面ストラドル)。
各レッグは **side(buy/sell) × type(指値/逆指値)** を **AIが選ぶ(C)**: レンジ内逆張り=指値 / 抜け追随=逆指値。
どちらか約定 → **もう片方をキャンセル(OCO)** → 以降は通常の exitStop 追従で決済(v0.7.46/v0.1.27)。
★正直な前提: フェード(指値両面)はユーザーの9年検証で全否定。よって **別枠で成績をタグ計測**し、
設定で ON/OFF できる実験的モードとして入れる。バイアス競合レッグは落とす。

## スキーマ(monitor `openai.ts` AiPlan・engine・currentSignal 共通)
- `direction: 'buy'|'sell'|'none'|'range'` に **'range'** を追加。
- `RangeLeg = { side:'buy'|'sell'; type:'limit'|'stop'; entry:number; stopLoss:number }`。
- `range?: { upper: RangeLeg; lower: RangeLeg }`(direction==='range' の時のみ)。**upper.entry>現値・lower.entry<現値**。
  各レッグに初期LC(stopLoss)。既存の limit/stop 単方向フィールドは range では使わない。

## ★2段ゲート(推奨=測ってから実弾)
- **monitor `scalpRangeEnabled`(既定 ON・紙)**: AI が range を出し、monitor が**紙で別枠タグ計測**(signal_trades mode='range')。左上パネルに両面表示。低リスク=即計測開始。
- **trade2 `followRange`(既定 OFF・実弾)**: 実弾の range 発注はこの opt-in がある時だけ。**OFF 中は range シグナルを発注せずスキップ(ログのみ)**=フェード(9年検証で不利)にいきなり実弾を賭けない。monitor 紙計測で期待値を確認してからユーザーが ON にする。directional シグナルは従来どおり follow(このゲートは range のみ)。

## monitor: scalp-plan(prompt/parse/enforce/config/UI)
### 設定
- `scalpRangeEnabled?: boolean`(config+⚙️UI トグル・**既定 true**・実験/紙計測扱いの hint 必須)。false のとき AI に「range を出すな」と指示し、万一 range が返っても none 扱い。
### プロンプト(`buildScalpQuestion`/`scalpJsonInstruction`)
- 「**レンジ**(明確な方向性なし・上下に反応帯)と判断したら `direction:"range"` で、現在値の**上と下に1レッグずつ**置く。各レッグは side/type/entry/stopLoss。**レンジ内で逆張りするなら指値(上=売り指値/下=買い指値)、抜けに追随するなら逆指値(上=買い逆指値/下=売り逆指値)**。上は現値超、下は現値未満。各レッグの初期LCは上限内。方向性が明確なら従来どおり buy/sell。」を追記。JSON 例に range 形。scalpRangeEnabled=false なら range 禁止文。
### parse(`parseScalpPlan`)
- direction==='range' 時に `range{upper,lower}` を検証(side/type enum・entry/stopLoss 有限・upper.entry>refPrice>lower.entry を推奨、外れは当該レッグ落とし)。壊れていれば none。
### enforce(`enforcePlanConstraints`)
- range 各レッグ: **初期LC幅 |entry−stopLoss| が ceiling 超 → そのレッグを落とす**。**バイアス veto**: bias='long'→side='sell' レッグ落とし / bias='short'→side='buy' レッグ落とし。**両レッグ落ち→none**。片レッグのみ残ったら **その単レッグの range**(=実質片面)として通す。
- 純関数テスト網羅(上限/バイアス/片落ち/両落ち→none)。

## monitor: signal engine + currentSignal + タグ
- `ArmedBracket`/`CurrentSignal` に `range?:{upper,lower}` 追加。armed が range のとき両レッグを保持。
- **detectFill(range)**: 現在値が upper.entry / lower.entry のどちらを先に跨いだかで**片側約定**を決定(type=limit は価格が entry に到達で約定・stop は entry 到達で約定=向きに注意)。**約定した side の position** を建て、**もう片方はキャンセル(sim)**。以降 exitStop は約定レッグの stopLoss を初期に computeExitStop。
- 決済記録(`signal_trades`)に **`tag`/`meta` で `mode:'range'`** を付け、別枠集計可能に。
- currentSignal(SSE `signalTrade.signal` と `GET /api/current-signal`)に **`range` レッグ**を露出(trade2 追従用)。既存 phase/hold は不変。

## trade2: 追従で両面発注 + OCO + タグ
- `SignalProposal`/`planFromSignal` に range 対応。`shouldFollowSignal` は range(upper/lower present)でも(armed/新signalId/FLAT/建玉クリア)で追従。**ただし followRange=OFF なら range は不採用**(directional は不変)。
- ★**逐次機の一般化(最小リスク)**: 逐次エントリー(placing_limit→confirm→placing_stop→confirm→ARMED)を内部で **2つのレッグ記述子 `{type,side,entry,stopLoss}`** で駆動するよう一般化する。**directional は特殊ケース**として leg1={type:'limit',side:direction,entry:limitEntry,sl:stopLossForLimit}・leg2={type:'stop',side:direction,entry:stopEntry,sl:stopLossForStop} を投入=**挙動不変(同順序・同type・同side・同価格)を回帰テストで証明**。range は leg1=upper・leg2=lower(逆方向・type は各自)。**採用レッグの side がポジション方向**・SL は採用レッグの stopLoss(既存 adoptedStopLoss を汎化)。
- **両面発注**: 既存の**逐次OCO(cancel-the-loser)**をそのまま流用: どちらか約定 → 本ループが相方を id 取消。**checkSanity は range のとき「upper は現値超・lower は現値未満」を満たすときのみ発注**(外れは見送り=詰まらない・phase ゲート併用)。noCancelSameSide 等の既存フラグは温存。
- 約定後: **exitStop 追従(v0.1.27)・保護ストップ自己修復(v0.1.28)** をそのまま適用。
- **タグ**: 採用が range 由来なら entry_meta に `mode:'range'`(+ どちらのレッグか)を記録し、forward.db で別枠計測。
- ★温存: 発注/約定/建玉照会リコンサイル/ハイジーン/ID追跡/exitStop同期/自己修復/doten・src/live・src/core は無改変。

## エッジ/安全(実弾)
- 両レッグ発注中に片約定 → 相方を確実に取消(既存 cancel-the-loser)。二重建玉防止(held>qtyでflatten・MAX_QTY)は不変。
- range が enforce/parse で片レッグに落ちたら片面のみ発注(単方向と同じ扱い)。
- scalpRangeEnabled=false で range を一切出さない/追従しない(従来の単方向のみ)。
- 無防備禁止(exitStop null/切れ→直近ストップ維持)は約定後も不変。

## テスト/受入(★実弾・厳格)
- monitor: parse/enforce の range(上限/バイアス/片落ち/両落ち)、engine detectFill(range・先跨ぎ判定・相方キャンセル・exitStop)、currentSignal に range 露出、`signal_trades` の mode:'range' タグ、scalpRangeEnabled ゲート。
- trade2: 両面発注→片約定でOCO→exitStop追従、sanity(上超/下未満)、range タグ(entry_meta)、片レッグ range、scalpRangeEnabled/none で range を追従しない。売買パス不変。
- **エバリュ最重点**: (a)片約定で相方を確実に取消し二重建玉にならない、(b)約定後 無防備にならない(exitStop/自己修復温存)、(c)バイアス競合レッグが落ちる、(d)scalpRange OFF で従来動作、(e)range トレードがタグで別集計できる、(f)実行部/doten/リコンサイル温存。両リポ tsc0/vitest緑/build緑。

## リリース
- monitor v0.7.51 / trade2 v0.1.29。署名ビルド→両公開→マニュアル/メモリ更新。
## 非対象/留意
- フェード(指値)はユーザー検証で不利。**別枠タグ計測**で実データ検証してから常用可否を判断(比較インフラ既存)。
