# monitor トレードシグナル（表示専用・紙トラッキング） (design)

日付: 2026-07-16 / 対象: monitor (Finance_Monitor・公開リポ)

## 目的
monitor 自身に「トレードシグナル」を追加する。エントリーは AI（`/api/scalp-plan`＝案A）、
決済は**非公開の phase-exit**。**売買命令は送らず表示のみ**。左上（節目の上）に目立つパネルで
現在シグナルを表示、発生時にアラート音。アラート履歴と同様に**売買履歴＋収益曲線**を持ち、
**再起動で消えず・設定から消去可能**。trade2 とは完全独立。

## 用語の衝突回避
既存 `server/signals/`（アラート合流）と区別するため、本機能は名前空間 **`signalTrade`** を使う
（UI 表示名は「トレードシグナル」）。

## 全体アーキテクチャ
表示専用の**紙トレードエンジン**を monitor 内に置く。price/SSE の現在値 tick で駆動：
1. **FLAT** → 一定間隔で `buildScalpPlan()`（openai.ts・案A）を呼び AiPlan 取得。
   `direction!=='none'` なら**ブラケット**（`limitEntry` 指値＋`stopEntry` 逆指値、各 SL＝初期LC）を armed 表示。
2. **ARMED** → 現在値が entry を跨いだら**擬似約定**（fill）→ FILLED。両entry armed で片方 fill したら他方キャンセル。
3. **FILLED** → 初期LC を起点に**非公開 phase-exit** がラチェット決済（内部で逆指値を動かす）。
   現在値が決済逆指値/利確に達したら**擬似決済** → 実現損益を確定 → `signal_trades` に記録 → FLAT。
- **実発注は一切しない**（③）。SSE現在値だけで擬似約定する。売買命令送信コード・endpoint は持たない。
- trade2 の `forward.db`・engine・APIには一切触れない（⑤）。専用テーブル・専用状態・専用ループ。

## ① 決済ロジックは非公開
- ディレクトリ `server/signalTrade/exit/`。
  - **committed 公開** `index.ts`：エクスポート IF `computeExitStop(state): number|null`（+ 型）と、
    **簡易フォールバック実装**（初期LC固定＝ラチェットなし）。公開リポ単体でビルド・動作する（劣化）。
  - **gitignored 非公開** `private.ts`：trade2 由来の実 phase-exit（3段ラチェット床＝peak閾値→床）。
  - `index.ts` は起動時に `./private.js` を **optional dynamic import（try/catch）** し、在れば差し替え、無ければ簡易版。
- `.gitignore` に `server/signalTrade/exit/private.ts` を追加。**数値・ルールは公開ファイルに書かない**。
- テスト：`index.ts` は簡易版で決定論的にテスト。private はローカルのみ（公開テストは簡易版のみ検証）。

## SSE state 契約（backend→frontend の唯一のIF）
price ループの state broadcast に **`signalTrade`** を1フィールド追加（`server/sse/broker` の既存 broadcast を利用）。
接続直後にも1回送る（stream.ts の初回送出に追加）。形（値が無いフィールドは省略可）:
```ts
interface SignalTradeState {
  phase: 'flat' | 'armed' | 'filled';
  // armed（エントリー注文中）。表示は「買い78050指値 / 売り78500逆指値 / 決済逆指値78000（初期LCのみ）」
  entry?: {
    direction: 'buy' | 'sell';
    limitEntry?: number; stopEntry?: number;   // 指値 / 逆指値の新規
    initialStop?: number;                       // 初期LC（1つに正規化・途中のLC移動は出さない）
    rationale?: string; at: number;
  };
  // filled（保有中）。決済価格は出さない（途中の決済逆指値は非表示＝②の要件）。建値と含みのみ。
  position?: { direction: 'buy'|'sell'; entryPrice: number; qty: number; unrealized: number; at: number };
  // 直近決済（決済時に「決済79000」を一時表示するため）
  lastExit?: { exitPrice: number; pnl: number; at: number };
  updatedAt: number;
}
```
既存 SSE state 型（frontend 側）にも `signalTrade?: SignalTradeState` を追加。**既存フィールドは不変**（trade2/他UI非影響）。

## 永続化（④・⑤独立）
- monitor DB（`server/db/store.ts`）に**新テーブル** `signal_trades(id, entry_t, entry_price, dir, exit_t, exit_price, pnl, qty, rationale, meta)`。
  既存テーブル（alerts等）不変。`CREATE TABLE IF NOT EXISTS`。
- 決済確定ごとに1行 INSERT。再起動しても残る。
- 起動時に履歴を読み state/UI に反映（収益曲線は実現損益の累積）。

## API
- `GET /api/signal-trades` → `{ trades: [...], equity: [...] }`（履歴＋累積損益点列）。
- `POST /api/signal-trades/clear` → 全削除（設定から呼ぶ）。返り `{ok:true, cleared:n}`。
- どちらも**表示/管理専用**。発注系エンドポイントは追加しない。

## ② パネル表示 + 音（frontend）
- 位置：左1/3カラムの `#levels-panel`（index.html 279行）の**直上**に新パネル `#signal-panel`。**目立つ**枠・色。
- 表示：
  - armed：`🎯 シグナル：買い 78050 指値 / 売り 78500 逆指値 ・ 初期LC 78000`（初期LCのみ）
  - filled：`● 保有：買い @78050（含み +xx）`（決済逆指値は出さない）
  - flat（直近決済あり）：`✔ 決済 79000（+xx）` を数十秒表示 → 以降「シグナル待機」
- **音**：`phase` が新規 armed/filled/決済へ遷移した時に**アラート音**（Web Audio の短いビープ or data URI 音源・外部ファイル無し）。ON/OFF は設定に小さなトグル（既定ON）。
- state は SSE の `signalTrade` を購読。既存描画パイプ라인に `renderSignalPanel(s)` を1つ足す。

## ④ 履歴 + 収益曲線 UI（frontend）
- 「トレードシグナル履歴」パネル（アラート履歴と同じ体裁）＋**収益曲線**（既存の equity canvas 描画を流用/踏襲）。
- 設定モーダルに **「トレードシグナル履歴を消去」** ボタン → `POST /api/signal-trades/clear` → 確認ダイアログ。

## ⑤ trade2 非干渉（不変条件＝評価の合否基準）
- trade2 の `forward.db`・`/api/scalp-plan` の**レスポンス契約**・SSE の既存イベント/フィールドは**バイト等価で不変**。
- 追加は「新テーブル」「新 state フィールド」「新パネル」「新 API」のみ。既存の検知/SSE/アラートロジックは変更しない
  （＝alert-audit 非対象）。`buildScalpPlan` は**呼ぶだけ**（改変しない）。

## 作業分割（並行・ファイル排他）
- **Coder-Backend**：`server/**`＋`.gitignore` のみ。engine/紙約定/非公開exit(index+stub)/DB/API/SSE state 追加。
  scalp-plan 呼び出し間隔・約定判定は純関数化してユニットテスト。全 tsc/vitest 緑。
- **Coder-Frontend**：`web/**` のみ。パネル(#signal-panel)/音/履歴/収益曲線/設定消去ボタン。上記 state 契約に対して実装。
  型は frontend 側 state 型に `signalTrade?` を足す（backend 実装完了前でも契約で進められる）。
- 両者ファイル排他（backend は web/ を触らない／frontend は server/ を触らない）。統合はリーダー。

## テスト / 受入
- 純関数（約定判定・phase 遷移・equity 集計・簡易exit）を vitest で網羅。tsc 0・vite build 緑。
- 受入：紙エンジンが SSE 現在値だけで entry→fill→exit を1サイクル回し `signal_trades` に記録・再起動で残存・clear で消える・
  パネルが armed/filled/決済を表示・音が鳴る・**発注コードが存在しない**・trade2 契約不変。
- 非公開 private.ts が `.gitignore` 済みで、無い状態（公開相当）でもビルド・起動・簡易exitで動く。

## リリース
- 版 v0.7.43（package.json/tauri.conf.json/Cargo.toml）→ 署名ビルド → `sora-moyou/jp225-monitor` リリース。
- マニュアル（USER_GUIDE）にトレードシグナルの節を追記。
