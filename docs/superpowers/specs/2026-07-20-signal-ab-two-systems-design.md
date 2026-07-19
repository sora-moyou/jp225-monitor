# トレードシグナル A/B 2系統(A=実売買/B=紙のみ・独立設定・書き出し比較) (design)

日付: 2026-07-20 / 対象: monitor2 のみ(trade2 無改修) / 版=monitor v0.8.2

## 目的(ユーザー確定)
monitor2 内でトレードシグナルを **A/B 2系統**、独立設定で**紙並走**。**A だけを trade2 に渡す**(実売買はA・口座1つ)。
**書き出しは A+B**(比較)。**B は紙のみ**(実売買に一切渡さない)=口座干渉ゼロ。**lite(表示縮小版monitor)は B 関連を全非表示**。

## 系統の役割
- **System A** = 現行エンジン・現行(グローバル)設定を踏襲=**挙動バイト単位で不変**。currentSignal/SSE `signalTrade` を出し **trade2 が従来どおり追従(=実売買A)**。
- **System B** = 新規の**紙専用**エンジン。独立設定。同じ価格tickで独立に AI提案→armed→擬似約定→記録。
  **currentSignal は出さない**(trade2 は A のみ追従)。パネル/履歴表示と signal_trades 記録のみ。

## 設定(B は独立・未設定は A にフォールバック)
- config に **`signalB`** ブロック: A と同じ knob 一式(`scalpLcFloorYen/scalpLcCeilingYen/scalpTrendVetoYen/scalpCooldownSec/scalpBias/scalpRangeEnabled/scalpLcHardMaxYen/scalpLcHardMaxEnabled` と各 `*Source`)。
- **B リゾルバ**: `signalB.<knob>` 優先→未設定は **A(グローバル)の値/directive にフォールバック**(箱出しは B も A と同じ挙動→そこから B だけ差分)。
- scalp-plan を **設定プロファイル(A|B)でパラメータ化**: `buildScalpPlan(input, {profile})` で directive/hardMax/LC/bias/trend/cooldown/range を A か B のリゾルバから解決。B の提案は B の設定・委任(手動/AI)・ロジック転写(v0.7.58)で生成。**A のパスは既定(profile 省略=A)で完全不変**。

## エンジン(マルチインスタンス化・A不変)
- 現 singleton の orchestration を **system キーのインスタンス**に一般化(純関数 advance/detectFill/planToArmed/computeExitStop/restingStopOf は共有・不変)。
- A インスタンス: currentSignal/SSE/getSignalPhase/hold を**現行の公開関数からそのまま**露出(外部契約不変=trade2 不変)。
- B インスタンス: 独立の state/plan interval/擬似約定/クールダウン。**currentSignal を持たない**。B の SSE 露出は別フィールド(下記)。
- ★A の getSignalTradeState/getCurrentSignal/getSignalHold/getSignalPhase は**戻り値バイト不変**(回帰テストで証明)。

## 記録(signal_trades に system タグ)
- `signal_trades` に **`system TEXT`** 列(idempotent ALTER・**既定/NULL='A'** 後方互換)。insert は system を受ける。
- `getSignalTrades(db, {system})`・`clearSignalTrades(db, {system})` を system で絞る(未指定=全件/既定A)。
- ★trade2 `signalsExport`(schema-freshコピー)は **system 列を自動で運ぶ**=trade2 無改修で書き出しに A+B が入る。

## API/SSE
- `GET /api/signal-trades?system=A|B`(既定 A) → その系統の trades+equity。`POST /api/signal-trades/clear?system=A|B`。
- SSE `signalTrade` は **A(現行payload・不変)**。**B は別露出**: payload に `systemB`(B の SignalTradeState 相当・軽量)を追加 or 別イベント `signalTradeB`。currentSignal(/api/current-signal)は **A のみ**(trade2 が誤って B を追わない)。

## UI(monitor2=full)
- **パネル(左上)**: A シグナル(現行)＋ **B シグナルを併記**(B は「📝紙のみ」バッジで区別・レッグ別LC表示は流用)。
- **履歴**: 「トレードシグナルB履歴」を作成。既存 📈 履歴モーダルに **系統セレクタ(A/B)** を追加し、選択系統の trades+収益曲線を表示(`?system=`)。消去も系統別。
- **設定(AIエントリー fieldset)**: ★**行を増やさず**、各設定行の入力を **A・B の順に横並び**(例 `初期LC下限: [A手動/AI][A値] [B手動/AI][B値]`)。B 列は `signalB` に保存。ラベルに A/B の小見出し。

## lite(表示縮小版 monitor)= B を全非表示
- variant='lite' で **B 関連をすべて hidden**: パネルの B 併記・履歴の B(系統セレクタ)・設定の B 列。
  (AIエントリー fieldset 自体は lite で既に非表示なので A/B 設定とも隠れる。パネル/履歴の B だけ追加で hidden。)
- lite の履歴は **A 固定**(系統セレクタ非表示・`?system=A`)。A の表示・trade2連携は不変。

## trade2(無改修)
- currentSignal=A を従来どおり追従(実売買A)。signalsExport が signal_trades を schema-freshコピー=**system 列込みで A+B が forward 隣の signals_<host>.db に入り比較可能**。

## テスト/受入
- B リゾルバ(signalB 優先・未設定は A フォールバック)、buildScalpPlan profile=B が B 設定で解決、engine B インスタンス(独立state/擬似約定/記録 system='B')、signal_trades system 列(ALTER/insert/get/clear by system・NULL→A)、API ?system、SSE に B 露出・currentSignal は A のみ。
- ★**A 完全不変(回帰)**: getSignalTradeState/getCurrentSignal/getSignalHold/getSignalPhase・SSE payload・/api/current-signal・trade2 追従契約がバイト不変。既定(profile 省略)で現行テスト緑。
- UI: full で A/B 併記・B履歴・設定A,B横並び(行数不変)/ lite で B 全非表示・A のみ。
- tsc0/vitest緑/build緑。受入の肝: (a)A は実売買含め完全不変、(b)B は紙のみで currentSignal に出ずtrade2に渡らない、(c)書き出しに system タグでA+B、(d)lite は B を一切表示しない、(e)設定行は増えない。

## リリース
- monitor2 のみ版上げ(v0.8.2)。⑥2製品(monitor2/monitor)同時公開。trade2 無改修。
