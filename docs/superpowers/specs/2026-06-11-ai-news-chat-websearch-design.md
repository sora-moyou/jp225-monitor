# monitor AI ニュース扱いの改善（実参照アンカー + チャットWeb検索 + 文脈ニュース）設計

- 日付: 2026-06-11
- 対象: Finance_Monitor（monitor・AI説明/チャット）
- 関連: alert-redesign（v0.6.0）, settings-db-merge

## 1. 背景・目的

monitor の AI は (a) アラート説明、(b) AIチャット でニュースを扱う。現状の課題:

1. **アラートのニュース窓**: 「前回参照以降のニュースだけ引用」する窓のアンカーが**アラート発火ごとに前進**（`shockWindow.noteAlert` ← `emitAlert`）。だが説明文生成は**クライアント側で間引かれる**（`LLM_AUTO_INTERVAL_MS` 未満なら /api/explain を呼ばず `(API節約モード…)` プレースホルダ表示。テクニカル系は固定文で /api/explain を呼ばない）。→ **ユーザーがニュースを見ていないのに窓が前進**し、次に説明する時に取りこぼす。
2. **チャットのニュース**: `formatNewsForChat` が**直近15件を無条件**注入（会話文脈と無関係）。
3. **Web検索なし**: チャットは静的コンテキストのみ。最新情報を取りに行けない。

## 2. 確定仕様（ユーザー回答）

- **①(b)**: アラートのニュース窓を「**説明が実際に生成された時のみ前進**」へ。アンカー＝直近説明で**実提示したニュースの最大 publishedAt**。節約モード/テクニカル固定文（=/api/explain 未呼び出し）では据置。
- **②(B)**: チャットに **function-calling の `web_search` ツール**を追加。バックエンド＝**Tavily**。全プロバイダ（Gemini-compat/Groq/OpenAI）で動作。キー未設定時はツール無効＝従来動作。
- **③(b)**: チャットのローカル直近ニュースを**最新発話のキーワードで関連度フィルタ**して注入（関連なければ直近フォールバック）＋②のWeb検索。

## 3. スコープ

### やること
1. ニュース窓アンカーを「実提示ニュースの最大publishedAt」に（`shockWindow` + `explain()` 戻り値 + `explain.ts`）。
2. `web_search`(Tavily) ツール + チャットのツール実行ループ（`server/llm/webSearch.ts` + `chat()`）。
3. チャットのローカルニュース関連度フィルタ（`formatNewsForChat` 改修）。
4. Tavily キーの設定（`configStore` + 設定UI + env）。

### やらないこと（YAGNI）
- アラート説明への Web 検索（アラートは既存のローカルニュース選別を維持。①は窓アンカーのみ変更）。
- 汎用web全文の高度な引用UI（チャット回答本文に検索結果を織り込むだけ。出典チップ等は最小）。
- Gemini グラウンディング（②=A は不採用。function-calling+Tavily に確定）。
- 検索結果のキャッシュ/永続化（毎回ライブ検索。低頻度の個人利用）。

## 4. ① アラートのニュース窓アンカー（実参照ベース）

### 4.1 `server/shockWindow.ts`
- 新カーソル `lastReferencedNewsAt`（既定0）。
- `noteReferencedNews(maxPublishedAt: number)`: `maxPublishedAt > lastReferencedNewsAt` の時だけ更新（単調）。
- `newsSinceForAlert()` を **`lastReferencedNewsAt` を返す**よう変更（旧 `prevAlertAt` ベースを廃止）。
- `noteAlert(t)` / `prevAlertAt` は news 用途では不要に。**他用途で未使用なら削除**（要 grep 確認: `newsSinceForAlert`/`noteAlert` の参照箇所）。`alertHistory` の `noteAlert` 呼び出しも併せて削除。
- `_reset()` は `lastReferencedNewsAt=0` も含める。

### 4.2 `server/llm/openai.ts` `explain()`
- 戻り値を **`{ text: string; newsMaxPublishedAt: number }`** に変更。
- 関数冒頭でニュースプールを一度だけ確定:
  ```ts
  const pool = selectNewsPool(input.news, now, input.newsSince ?? 0, input.newsWindowMs ?? NEWS_RECENT_WINDOW_MS);
  const newsMaxPublishedAt = pool.reduce((m, n) => Math.max(m, n.publishedAt), 0);
  ```
- `rankAndFormatNews` はこの `pool` を受け取る形に（プール再選別を避け一貫させる）。早期return（材料なし→テクニカル要因）も `pool.length === 0` を使う。
- 全 return パス（早期return含む）で `{ text, newsMaxPublishedAt }` を返す。材料なしreturnは `newsMaxPublishedAt=0`（=据置）。

### 4.3 `server/routes/explain.ts`
- `const result = await explain({...});`、`res.json({ explanation: result.text });`。
- 説明が実生成された後にカーソル前進: `if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);`（crash 含む。実提示したニュースは「参照済み」）。
- `newsSince: ...` は `newsSinceForAlert()`（=新カーソル）を使用（crash は従来どおり `0`）。

### 4.4 効果
- 節約モード/テクニカル固定文 → /api/explain 未呼び出し → カーソル据置 → 次の説明で取りこぼさない。
- 🔄/crash/通常説明 → /api/explain 実走 → 実提示ニュース最大時刻で前進 → 「ユーザーが実際に見たニュース以降」だけが既参照。

## 5. ② チャット Web検索（function-calling + Tavily）

### 5.1 `server/llm/webSearch.ts`（新規）
```ts
export interface SearchHit { title: string; url: string; content: string; publishedDate?: string; }
export function isWebSearchEnabled(): boolean;   // Tavily キー有無
export async function tavilySearch(query: string, maxResults = 5): Promise<SearchHit[]>;
```
- `fetch('https://api.tavily.com/search', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` }, body: JSON.stringify({ query, max_results, search_depth:'basic', topic:'general' }) })`。
- 応答 `{ results: [{title,url,content,published_date?}] }` を `SearchHit[]` へ。失敗/非200 は `[]` を返し warn ログ（チャットは継続）。
- キーは `resolveTavilyKey()`（§7）。

### 5.2 `chat()` ツールループ（`server/llm/openai.ts`）
- `isWebSearchEnabled()` が真の時のみ `tools` を付与:
  ```ts
  const tools = [{ type:'function', function:{ name:'web_search',
    description:'最新の市況・ニュース・出来事を調べる。価格や材料を聞かれて手元のコンテキストに無い時に使う。',
    parameters:{ type:'object', properties:{ query:{ type:'string', description:'検索クエリ(日本語可)' } }, required:['query'] } } }];
  ```
- ループ（`callWithFallback` の task 内、最大 `MAX_TOOL_ROUNDS=3`）:
  1. `chat.completions.create({ model, temperature:0.5, max_tokens:8000, messages, tools, tool_choice:'auto' })`
  2. `msg.tool_calls` が無ければ `msg.content` を返す。
  3. 有れば `messages.push(assistantMsg)`、各 tool_call で `tavilySearch(JSON.parse(args).query)` → `messages.push({ role:'tool', tool_call_id, content: formatHits(hits) })`。
  4. 上限到達時は `tools` 無しで最終回答を1回生成して返す。
- キー無し（`isWebSearchEnabled()` 偽）は **tools を付けず現行の単発呼び出し**（後方互換）。
- 全プロバイダのOpenAI互換 function-calling を利用（Gemini-compat/Groq/OpenAI すべて対応）。

### 5.3 注意
- `callWithFallback` は task 全体（ループ含む）を 429 時に次プロバイダで最初からやり直す（許容）。
- システムプロンプトに「web_search で得た最新情報は『◯◯によると』と出典/日時を添える。手元コンテキストで足りる時は無理に検索しない」を追記。

## 6. ③ チャットのローカルニュース関連度フィルタ

`server/llm/openai.ts` `formatNewsForChat(news, now, queryText?)`:
- `queryText` = 最新 user メッセージ本文（`chat()` で `input.messages` の末尾 user を抽出して渡す）。
- スコア = ニュースタイトル語と `queryText` の重なり数（簡易トークン一致・大小無視）。`> 0` のものをスコア降順→同点は新しい順で上位12件。
- 関連ヒットが0件なら**従来どおり直近15件**にフォールバック。
- これにより会話文脈に沿ったローカルニュースを優先注入（Web検索と相補）。

## 7. Tavily キーの設定

- `server/configStore.ts`: `UserConfig` に `tavilyKey?: string`。`resolveTavilyKey(): string|undefined`（config.tavilyKey → env `TAVILY_API_KEY`）。
- 設定UI（`/api/config` の保存対象 + 設定モーダル）に Tavily キー入力欄を追加（既存 gemini/groq/openai キー欄に倣う）。保存後 `webSearch` は次回チャットから有効。
- キー未設定でもチャットは動作（検索ツールを出さないだけ）。

## 8. エラー処理・安全策
- `tavilySearch` 失敗 → `[]` 返却 + warn。モデルは「検索できなかった」前提で回答可。
- ツールループ上限（3）で暴走防止。最終は tools 無しで必ず1回答。
- ①: `newsMaxPublishedAt=0`（材料なし）の時はカーソル不前進（据置）。`noteReferencedNews` は単調。
- 既存のプロバイダ failover / circuit breaker はそのまま（ツールも各プロバイダで実行）。

## 9. テスト
- `shockWindow`: `noteReferencedNews` 単調更新 / `newsSinceForAlert` が新カーソルを返す / `_reset`。
- `explain()`: 戻り値が `{text, newsMaxPublishedAt}`、プール最大publishedAt が正しい / 材料なしで 0。（LLM 呼び出しはモック or 既存テスト方針に合わせる。プール選別/最大算出は純粋部分として単体化。）
- `webSearch.tavilySearch`: fetch をスタブし正常パース / 非200で `[]`。`isWebSearchEnabled` のキー有無。
- `chat()` ツールループ: provider client をスタブし、(a) tool_calls 無し=単発 (b) 1回 tool_call→検索→最終回答 (c) キー無しで tools 非付与。
- `formatNewsForChat` 関連度: クエリ一致で関連ニュース優先 / 0件で直近フォールバック。
- 既存テスト緑。

## 10. リリース
- monitor 版 v0.6.23 → **v0.6.24**（package.json 等、monitor の版運用に従う）。署名鍵=無パスフレーズ。
- 検知変更ではないため `alert-audit.mts` は対象外。
- 署名ビルド → GitHub リリース（monitor のリリース手順）。

## 11. 受け入れ基準
- 節約モード中に出たニュースが、次に🔄/通常説明した時にちゃんと参照される（窓が飛ばない）。
- チャットで最新の出来事を聞くと web_search が走り、回答に最新情報（出典付き）が反映される。Tavilyキー無しでも従来どおり回答。
- チャットのローカルニュースが質問文脈に沿って選ばれる。
- 既存テスト緑・tsc クリーン・新規テスト緑。
