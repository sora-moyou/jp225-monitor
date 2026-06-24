# AIチャットに monitor 自身のデータを参照させる 設計

作成: 2026-06-25 / 対象: JP225 Monitor の AI チャット（`server/llm/openai.ts` `chat()` / `runChatWithTools`）

## 目的

チャットが monitor の保有データ（価格履歴・セッションOHLC・アラート履歴・原因分析）を参照して回答できるようにする。
フラッグシップは「**なぜ急落した?**」への回答。現状は現在価格/テクニカル/相関/ニュースしか見ておらず、
下落の起点(本日高値)・検知済みアラート・原因分析を持たないため答えられない。

## 方針: ハイブリッド（常時注入 + オンデマンド道具）

### A. 常時注入（軽量・確実、tool 非依存）
`chat()` の system prompt 組立（`openai.ts:425` 付近）に追記する:
- **直近アラート要約**: `getRecentAlerts(db, limit)` + `rowKind()`（`alertHistory.ts`）で直近60分の crash/shock/節目抜け等を
  「時刻・種別・方向・価格」で最大数件。`getRecentL2Summary` も流用可。
- **セッションOHLC（日経=NIY中心）**: `getSessionOHLC(db, symbol, 1)`（`store.ts:234`）で本日の高値/安値とその時刻。
→ 「いつ・どの水準から・何%下げたか」に tool 無しで即答可能になる。トークン増は数行に抑える。

### B. オンデマンド道具（function-calling・深掘り）
`runChatWithTools`（`openai.ts:396`）を **ツール名→ハンドラのディスパッチ**へ改修（現状は全 tool_call を `search()` に流す前提）。
`web_search` は従来どおり Tavily（`isWebSearchEnabled()` ゲート）。以下のデータ道具は外部キー不要ゆえ**常時有効**。

1. **`explain_move`（本命）**: 引数 `{ symbol?, sinceMinutes? }`。直近の急変（`getRecentAlerts` の crash/shock 行、
   無ければ `getSessionOHLC` の高値 vs 現在値を `crashDrawdown` で算出）を特定し、`explain()`（`openai.ts:200`）を再利用して
   **原因文**（ニュース近接+他資産+極性）を返す。`explainHandler`（`routes/explain.ts:25`）の入力組立を
   共有ヘルパ `buildExplainInput(symbol, ...)` に切り出し、route と tool で再利用する。
   - 注意: `explain()` は `callWithFallback` 経由＝tool ループ内で LLM 二段呼び出しになる（許容）。
2. **`query_alerts`**: 引数 `{ withinMinutes?, limit? }`。`getRecentAlerts` + `summarize()`（種別別 hit/revert/平均リターン）+ `rowKind`。
3. **`price_history`**: 引数 `{ symbol, window: 'today'|'recentMinutes', minutes? }`。`getSessionOHLC` / `getRecentBars`（`store.ts:88`）。

### ツール配線
- `chat()`（`openai.ts:451`）で tools 配列をデータ道具は無条件、`web_search` は `isWebSearchEnabled()` の時のみ追加。
- ハンドラは短い文字列（データ要約 or 「該当なし」）を返す。**例外を tool ループへ投げない**（try/catch で握り、説明文字列を返す）。
- DB は `openDb(resolveDbPath())`（`store.ts:7,14`）。キャッシュは `getPrices()/getNews()`（`cache.ts`）、
  スナップは `getLevelsSnapshot/getForecastSnapshot/getCorrelationSnapshot`。新規SQLは書かず既存ヘルパを使う。

## データフロー（急落の例）
ユーザー「なぜ急落?」→ モデルが `explain_move` を呼ぶ → ハンドラが直近 crash/shock を特定 →
`buildExplainInput` で news/crossAsset/l2Recent/newsWindow を組み → `explain()` が原因文を生成 → tool 結果として返す →
モデルが最終回答。常時注入(A)により tool を呼ばずとも基本(いつ・どの水準)は回答可能。

## エラー処理
- 各ツールハンドラは try/catch。DB 不在/データ無しは「データがありません」を返す（ループ継続）。
- `explain_move` は LLM 無効時（`isLLMEnabled()` false）は呼ばれない（チャット自体が LLM 前提）。

## テスト
- `server/llm/chatTools.test.ts` を拡張: 名前ディスパッチ（web_search と新道具の振り分け）、tool_calls→結果→最終回答の形。
- 各ハンドラ単体: 一時DB（`openDb(':memory:')` 等）にダミー alerts/bars を入れ、要約文字列を検証。長/短・データ無しの分岐。
- `explain_move`: `explain()` をモックし、入力組立(`buildExplainInput`)が crash 時に newsWindow=24h・newsSince=0 になることを検証。
- 常時注入: prompt にアラート要約/セッションOHLC 行が含まれること（`chat()` の system 文字列）。

## 非対象 / YAGNI
- ベクトル検索/RAG は導入しない（道具で十分）。
- 過去の AI 説明文は永続化していない＝読み戻さず `explain()` で都度再生成（既存仕様）。
- 検知ロジックは変更しない（チャット参照の追加のみ）→ `alert-audit` 非対象。

## バージョン
monitor current=v0.7.6 → 本機能で **v0.7.7**（package.json/tauri.conf/Cargo.toml の3点）。署名鍵=無パスフレーズ。
リリースノートは通常どおり機能説明可（monitor のルールは非公開対象ではない）。
