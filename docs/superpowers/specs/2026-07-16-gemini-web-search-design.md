# チャットWeb検索を Tavily → Gemini グラウンディングへ (design)

日付: 2026-07-16 / 対象: monitor (Finance_Monitor) `server/llm`

## 目的
チャットの `web_search` ツールの実体を Tavily REST から **Gemini の Google Search グラウンディング**へ置き換える。
専用の(課金)Gemini キーを設定でき、未設定なら共通 `geminiKey` にフォールバック。Web検索用モデルは
通常の chatModel と分離して指定できる。

## 決定事項(ユーザー承認済み・全推奨)
1. 実装経路 = **ネイティブ Gemini `:generateContent` + `tools:[{google_search:{}}]`**
   (OpenAI互換エンドポイントの標準 tools では `google_search` が通らないため。plain fetch・OpenAI SDK非経由)
2. **Tavily は撤去**(案A・Gemini一本化)。`tavilySearch`/`looksLikeTavilyKey` と Tavily 経路を削除。
3. `webSearchModel` 既定 = **`gemini-flash-latest`**(ListModels で存在・generateContent対応を確認済。Gemini 3.x=grounding対応)

## キー/モデル解決 (`configStore.ts`)
- 新フィールド `webSearchKey?`(Web検索専用の課金Geminiキー)/ `webSearchModel?`
- `resolveWebSearchKey()` = `config.webSearchKey` → `config.geminiKey` → `env GEMINI_API_KEY`(専用が無ければ共通に落ちる)
- `resolveWebSearchModel()` = `config.webSearchModel` → 既定 `gemini-flash-latest`
- `tavilyKey`/`resolveTavilyKey` は撤去(既存 config.json に残っていても無視=JSON余剰キーは無害)

## 実装 (`server/llm/webSearch.ts`) — Tavily を全面置換
- `isWebSearchEnabled(): boolean` = `!!resolveWebSearchKey()`
- `webSearch(query: string): Promise<string>` — all-in-one。キー/モデル解決 → grounding呼び出し → 整形文字列。
  失敗/キー無し/空は `(検索できませんでした)` / `(検索結果なし)`(チャットは検索なしで継続=現状の耐障害性維持)
- 内部の純関数(テスト対象):
  - `geminiGroundedSearch(query, key, model, fetchImpl?)`: POST `…/v1beta/models/{model}:generateContent?key=…`
    body `{ contents:[{parts:[{text: query}]}], tools:[{ google_search:{} }] }`。非200/例外は空結果。
  - `parseGrounding(json)`: `candidates[0].content.parts[].text` を answer に、
    `candidates[0].groundingMetadata.groundingChunks[].web{uri,title}` を sources(SearchHit[]) に。
  - `formatGrounded({answer, sources})`: `answer` + `\n\n出典:\n1. title (url)…`。sources 空でも answer は返す。
- `SearchHit{title,url,content}` 型は流用(content は grounding では基本空=uri/titleのみ)。

## 呼び出し側 (`server/llm/openai.ts`)
- import を `isWebSearchEnabled, webSearch` に変更(`tavilySearch`/`formatHits` 依存を除去)
- 2箇所の web_search ハンドラ(chat / もう一方)を `q ? await webSearch(q) : '(クエリ空)'` に。
- ツール定義(name=web_search・description)は不変。`isWebSearchEnabled()` ゲートも不変。

## 設定UI (`web` の ⚙️設定モーダル)
- `webSearchKey`(Web検索用Geminiキー・空欄は共通geminiに従う旨のヒント)と `webSearchModel`(既定 gemini-flash-latest)の入力を追加。
- Tavily キー入力欄は撤去。

## テスト
- `webSearch.test.ts` を全面改訂: `parseGrounding`(answer+sources 抽出/欠損時)/`formatGrounded`/
  `geminiGroundedSearch`(fetch モックで正常・非200・例外)/キー無しは fetch しない。
- `chatTools.test.ts` 等が Tavily を参照していれば追従。
- tsc + `server/llm` 全緑。

## 非対象/留意
- grounding の live 実動作はキーが 429(quota)で未検証。課金枠回復時に実確認。既定モデルは存在確認済。
- 検知/SSE/アラート不変。alert-audit 非対象(LLM経路のみ)。
- リリースは in-flight の v0.7.42 に本変更を織り込む(Tavily形式ガードは撤去に置換)。
