# OpenAIでもWeb検索可＋設定UI再編(無料/有料・モデル欄独立) (design)

日付: 2026-07-17 / 対象: monitor(Finance_Monitor) のみ / 非実弾(チャット/Web検索/設定UI)

## 目的
1. **OpenAIキーだけでもチャットのWeb検索を可能に**(Gemini枠切れ/未設定でも OpenAI 検索へフォールバック)。
2. **APIキー設定を 無料→有料 の順にグループ表示**(無料2種=Gemini/Groq、有料2種=OpenAI/Web検索キー)。
3. **モデル設定欄を独立セクション化し、各欄に説明(hint)を必須**で付ける。

## 1. OpenAI Web検索フォールバック(`server/llm/webSearch.ts` + configStore)
- 現状: `webSearch(query)` は Gemini グラウンディング(`geminiGroundedSearch`)のみ。`resolveWebSearchKey()`=webSearchKey→geminiKey→env(Gemini専用)。
- 追加: OpenAI 検索経路 `openaiWebSearch(query, key, model)`。OpenAI の web 検索対応モデル(chat.completions・`gpt-4o-mini-search-preview` 等)で検索し、answer＋引用(annotations/citations)を `GroundedResult` に。openai SDK は既存。key=`resolveApiKey('openai')`。search-preview モデルは temperature 等の非対応があるので最小パラメータで呼び、失敗は空(=チャットは検索なしで継続)。
- ルーティング `webSearch(query)`: **Gemini キー解決可 → Gemini グラウンディング / それが無く OpenAI キーあり → OpenAI 検索**。両方無し → `(web検索は未設定です)`。
- `isWebSearchEnabled()` = **Gemini キー解決可 OR OpenAI キーあり**(どちらかで有効)。
- 設定: `UserConfig.webSearchOpenaiModel?`(既定 **`gpt-4o-mini-search-preview`**)＋ `resolveWebSearchOpenaiModel()`。既存 `webSearchModel`(Gemini)は不変。
- 純関数(parse/format/ルーティング判定)をテスト。fetch/SDK はモック。

## 2. 設定UI: キーを 無料/有料 でグループ表示(`web/index.html`)
- 順序: **【無料】Gemini → Groq / 【有料】OpenAI → Web検索キー**(現状の並びに `無料`/`有料` の小見出し[legend/divider]を追加。各行の個別マーク(v0.7.48)は維持)。
- Web検索キーは「有料(課金Gemini or OpenAI検索で使用)」と位置づけを明記。

## 3. モデル設定を独立セクション化＋説明必須(`web/index.html` + settingsModal + settings route)
- キー欄とは別の **「Web検索モデル」セクション(fieldset)** を新設し、そこへ移動:
  - **Web検索モデル(Gemini グラウンディング用)** `webSearchModel`(既定 gemini-flash-latest)＋**説明必須**(例: 「Gemini キーで Web 検索する時のモデル。grounding 対応(Gemini 3.x)。」)。
  - **OpenAI Web検索モデル** `webSearchOpenaiModel`(既定 gpt-4o-mini-search-preview)＋**説明必須**(例: 「Gemini キーが無い/枠切れのとき OpenAI で Web 検索するモデル。」)。
  - どちらも可視フィールド(空欄=既定に戻す)・settings GET/POST に配線。
- settings.ts: `webSearchOpenaiModel` を GET(現値)/POST(applyVisibleField)に追加。settingsModal.ts: 入力要素＋load/save 配線＋説明表示。

## 制約/温存
- 検知/SSE/アラート/scalp-plan/売買は不変。変更は Web検索経路・設定UI・設定保存のみ(alert-audit 非対象)。
- 既存 Gemini グラウンディング挙動は不変(Gemini キーがあれば従来どおり)。既存テスト緑＋新規テスト。

## テスト/受入
- `webSearch`: Gemini キーあり→Gemini経路 / Gemini無くOpenAIあり→OpenAI経路 / 両方無し→未設定文言。`openaiWebSearch` のパース(answer/引用)・失敗時空。`isWebSearchEnabled` の OR。
- 設定: `webSearchOpenaiModel` の resolver/既定/保存(空欄=既定)・GET 現値。UI に無料/有料グループ・モデル独立セクション・各モデル欄の説明が表示。
- `npx tsc --noEmit` 0 / `npx vitest run` 全緑 / `npm run build:web` 緑。
- マニュアル(USER_GUIDE md/html)更新: 「OpenAI だけでも Web 検索可(Gemini 枠切れ/未設定時にフォールバック)」・キーの無料/有料整理・モデル欄の説明。

## リリース
- monitor v0.7.49。署名ビルド→公開→メモリ更新。
