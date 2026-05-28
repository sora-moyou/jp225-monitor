# Tunable Parameters & Status UI — Design

**Date:** 2026-05-29
**Scope:** Phase 4 maintenance (D 系タスク) — 既存機能の運用性向上
**Related:** [[2026-05-28-finance-monitor-design]]

## 目的

現在の運用上の問題:

1. **定期 API 利用 (Yahoo Finance) で 429 が多発** している。現在 2 秒ポーリングがハードコード。ユーザーが間隔を緩められない
2. **API 障害時の自動再試行は実装済みだが UI に出ていない** — ユーザーは「いつ復旧するか」を見えない
3. **サーバログ (priceLoop, LLM 429 等) はサーバ stdout のみ** — Tauri 配布版ではユーザーが見られない
4. **Tauri 標準 updater ダイアログは UI が浮く** — アプリ全体のダーク UI と統一感を持たせたい
5. **sidecar port が hardcoded** — 3000 が他アプリと衝突するユーザーが詰む

これらをまとめて解決する。

## 非ゴール

- LLM pause ladder / Yahoo fallback 期間 / backoff ladder のチューニング — **デフォルトのままで十分**。最小パラメータ化に留める
- magnitude/slope detection 閾値の UI 化 — 別件
- ログのファイル永続化 — リングバッファのみ
- ログレベル切替 / フィルタ機能 — まずは全表示

## 全体アーキテクチャ

```
~/.jp225-monitor/config.json
├── geminiKey, groqKey, openaiKey  (既存)
├── pricePollMs    新規  ──┐
├── newsPollMs     新規    │
└── port           新規    │
                           ▼
                    server/configStore.ts
                           │
        ┌──────────┬───────┼─────────┐
        ▼          ▼       ▼         ▼
   priceLoop.ts newsLoop  index.ts  /api/settings
   (restart可)  (restart可)  (PORT)  (POST で reload)

server/logBuffer.ts          server/status.ts
   ring buffer 200            集約 GET /api/status
   console wrap                Yahoo skipUntil
        │                       LLM provider status
        ▼                              │
   GET /api/logs                       ▼
                              frontend status pane
                              (topbar API ドット)

frontend:
- settings modal: +3 inputs (pricePollMs, newsPollMs, port)
- topbar: API status ドット 4 つ (Yahoo + 3 LLM)
- topbar: 📋 ログボタン → log modal
- updater toast (Tauri runtime only): 右上 toast
```

---

## 1. 設定スキーマ拡張 (項目 ① + ⑤)

### 1.1 UserConfig 型

`server/configStore.ts`:

```ts
export interface UserConfig {
  // 既存
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
  // 新規
  pricePollMs?: number;  // default 2000, min 500, max 60_000
  newsPollMs?: number;   // default 60_000, min 10_000, max 600_000
  port?: number;         // default 3000, min 1024, max 65_535
}

// 解決ヘルパ (env → config → default の優先順)
export function resolvePricePollMs(): number;
export function resolveNewsPollMs(): number;
export function resolvePort(): number;
```

### 1.2 検証

POST `/api/settings/keys` (リネームせず流用) のリクエストボディに新フィールドを追加。サーバ側で範囲外は **clip ではなく 400 で reject** (ユーザーに気づかせる)。

### 1.3 ループ再開化

`server/loops/priceLoop.ts`:
- 内部の `let intervalMs = resolvePricePollMs();` を関数スコープから state に格上げ
- `export function restartPriceLoop(): void` — 現タイマー clear → 新間隔で reschedule
- `tick()` の `return PRICE_POLL_INTERVAL_MS` を `return intervalMs` に置換

`server/loops/newsLoop.ts`: 同様に `restartNewsLoop()`。

設定 POST ハンドラで `if (intervalChanged) restartPriceLoop()` を呼ぶ。

### 1.4 Port 解決

`server/index.ts`:

```ts
import { resolvePort } from './configStore.js';
const PORT = resolvePort();  // config → env PORT → 3000
```

**Port 変更時の挙動**: 設定保存は成功するが、サーバ再起動が必要。POST レスポンスに `portRequiresRestart: true` を載せ、フロントでバナー表示。Tauri 配布版ではアプリ再起動を促す。

**Dev モードの制約**: `vite.config.ts` のプロキシ target は `localhost:3000` ハードコード。port 変更は **Tauri / 単一バイナリ運用時のみ意味を持つ**。dev モードでの port 変更は保存できるが警告を出す。

---

## 2. API 状態集約 + UI (項目 ②)

### 2.1 Yahoo 状態の export

`server/loops/priceLoop.ts` に `yahooSkipUntil` を内部スコープから export 可能な形に:

```ts
export function getYahooStatus(): { fallback: boolean; skipUntil: number } {
  return { fallback: Date.now() < yahooSkipUntil, skipUntil: yahooSkipUntil };
}
```

### 2.2 統合ステータスエンドポイント

`server/routes/status.ts` (新規):

```ts
GET /api/status →
{
  yahoo: { fallback: boolean, skipUntil: number },
  llm: [
    { name: 'gemini', enabled: bool, paused: bool, pausedUntil: number },
    { name: 'groq',   ... },
    { name: 'openai', ... }
  ],
  version: string
}
```

(既存 `/api/settings` の providers 部分を流用、Yahoo 情報を追加)

### 2.3 フロント表示

- topbar の `<span id="connection-status">` の **右隣** に `<div id="api-status">` を配置
- 4 つのドット (Y / G / Gr / O) を横並び、色 🟢正常 / 🟡待機中 / ⚪未設定
- 各ドットに `title` 属性で hover ツールチップ:
  - 正常: 「Yahoo: 利用可」
  - 待機中: 「Yahoo: 残 2:35 (13:47:50 復旧)」
- 5 秒ごとに `GET /api/status` を polling して更新

**理由 (SSE にしない)**: 状態変化頻度は分単位、ユーザー認知遅延 5 秒で十分。SSE channel を増やすより polling が単純。

### 2.4 settings modal 内表示の改修

既存 `renderStatus()` を `/api/status` 結果に切替 (二重定義の解消)。

---

## 3. ログ閲覧 UI (項目 ③)

### 3.1 ring buffer

`server/logBuffer.ts` (新規):

```ts
interface LogEntry {
  ts: number;           // epoch ms
  level: 'log' | 'warn' | 'error';
  msg: string;          // util.format した文字列
}

const BUFFER_SIZE = 200;
let buffer: LogEntry[] = [];

export function installLogCapture(): void {
  // console.log/warn/error を wrap
  // 元の出力は維持 (stdout/stderr に依然出る)
  // buffer に push、超えたら shift
}

export function getLogs(): LogEntry[];
```

`server/index.ts` の冒頭で `installLogCapture()` を呼ぶ。

### 3.2 エンドポイント

`server/routes/logs.ts` (新規):

```ts
GET /api/logs → LogEntry[]
GET /api/logs?since=<ts> → ts より新しいもののみ
```

### 3.3 フロント UI

- topbar に `<button id="open-logs">📋</button>` 追加
- 新規モーダル `web/components/logsModal.ts` (settings modal と同じ overlay スタイル)
- 中身: `<pre>` で各行表示、レベルで色付け (warn=黄, error=赤)
- 「自動更新 ☑」チェックボックスで 2 秒ごと polling、デフォルト ON
- 「クリア表示」ボタン (サーバ buffer は触らない、フロント表示のみリセット)
- スクロール最下行へ自動追従、ユーザーが上にスクロールしたら追従停止

---

## 4. Updater カスタム UI (項目 ④)

### 4.1 Tauri 設定変更

`src-tauri/tauri.conf.json`:
```diff
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [...],
    "pubkey": "...",
-   "dialog": true
+   "dialog": false
  }
}
```

### 4.2 フロント updater モジュール

`web/lib/updater.ts` (新規):

```ts
export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

// Tauri 環境のみで動作。それ以外は黙って null を返す
export async function checkForUpdate(): Promise<UpdateInfo | null>;

// ダウンロード + インストール (再起動含む)
export async function installUpdate(): Promise<void>;
```

`@tauri-apps/plugin-updater` の dynamic import を try/catch で包む。`window.__TAURI__` 不在なら no-op。

### 4.3 トースト UI

`web/components/updateToast.ts` (新規):

- 右上に固定配置 (`position: fixed; top: 60px; right: 20px`)
- 内容: 「🆙 **v0.4.0** が利用可能です」+ [更新] [後で] ボタン
- [更新] クリック: `installUpdate()` → ダウンロード進捗バー表示 → 完了で「再起動して適用」プロンプト
- [後で]: 24 時間 localStorage に「dismissed at」を記録、その間は表示しない
- アプリ起動 5 秒後に 1 回 `checkForUpdate()` 呼ぶ

### 4.4 失敗時の挙動

- ネットワークエラー / 4xx / 5xx: 静かにログだけ (logBuffer に push)
- `pubkey` が placeholder: updater 自体が初期化失敗 → 静かに無視
- `npm run dev` (Tauri 不在): `window.__TAURI__` 不在で `null` 返し、トースト出さない

---

## 5. データフロー

```
[ユーザー設定変更]
   ↓
[settings modal が POST /api/settings/keys]
   ↓
[saveConfig] → cached 更新 → ファイル書き込み
   ↓
[intervalChanged なら restartPriceLoop/NewsLoop]
   ↓
[portChanged なら portRequiresRestart: true を返却]
   ↓
[フロント: バナー表示 "port変更には再起動が必要"]

[ステータス監視]
[フロント 5秒ごと polling] → GET /api/status
   → topbar ドット色 + tooltip 更新
   → (modal 開いていれば) 同じデータで反映

[ログ閲覧]
[ユーザー 📋 クリック] → モーダル表示
   → GET /api/logs (初回)
   → 自動更新 ON なら 2 秒ごと GET /api/logs?since=lastTs

[Updater (Tauri のみ)]
[起動 5 秒後] → checkForUpdate()
   → Tauri runtime あり: updater plugin で endpoint fetch
     → アップデートあり: トースト表示
     → なし: 何もしない
   → Tauri runtime なし (dev / web): no-op
```

---

## 6. エラーハンドリング

| 状況 | 挙動 |
|---|---|
| `/api/settings POST` で範囲外 | 400 + `{ error: "pricePollMs out of range (500-60000)" }` |
| `/api/settings POST` で port 変更 | 200 + `{ portRequiresRestart: true }`、フロントでバナー |
| `/api/logs` でサーバ起動直後 (buffer 空) | `[]` を返す |
| `/api/status` で Yahoo skipUntil = 0 | `fallback: false`、UI は 🟢 |
| updater fetch fail | エラーを logBuffer に push、トースト出さず |
| updater 「更新」中にネット切断 | エラー toast を出して再試行可能に |

---

## 7. テスト計画

### 7.1 単体テスト (vitest)

- `server/configStore.test.ts` (新規):
  - `resolvePricePollMs()` の優先順位 (config > env > default)
  - 範囲チェック (POST handler 経由)
- `server/logBuffer.test.ts` (新規):
  - ring buffer の循環 (201 件 push → 200 件保持)
  - level 別格納
- `server/loops/priceLoop.test.ts` の追加ケース (任意): `restartPriceLoop()` でタイマーが置換されること

### 7.2 手動 E2E

1. `npm run dev` 起動 → settings 開いて pricePollMs=5000 に変更 → DevTools Network で `/api/stream` の `prices` イベントが 5 秒間隔になる
2. settings 開いて port=3001 に変更 → "再起動が必要" バナー → サーバ手動再起動 → `/api/health` が 3001 で応答
3. Yahoo を擬似的に失敗させ (yahooFinance.ts 内で throw)、topbar Y ドットが 🟡 + tooltip に残時間
4. アラート連発で LLM 429 を引き起こし、G ドットが 🟡 になり、復帰すると 🟢 に戻る
5. 📋 押下 → ログモーダル開く → 自動更新で新しいログが下に流れる
6. (Tauri) `tauri:dev` → 5 秒後に updater が check して endpoints へ HEAD/GET → placeholder URL は 404 なので静かに無視 → トースト出ず

---

## 8. 影響範囲

### 8.1 既存ファイル変更

| ファイル | 変更 |
|---|---|
| `server/configStore.ts` | `UserConfig` 拡張 + 3 つの resolver |
| `server/index.ts` | port 解決を resolvePort() に + installLogCapture() 呼び出し + `/api/status` `/api/logs` ルート追加 |
| `server/loops/priceLoop.ts` | `restartPriceLoop()` export + `getYahooStatus()` export |
| `server/loops/newsLoop.ts` | `restartNewsLoop()` export |
| `server/routes/settings.ts` | POST に 3 フィールド検証 + 範囲外 reject + restart 呼び出し |
| `server/llm/openai.ts` | `getProviderStatus()` は既存、UI 形に揃える程度 (差分小) |
| `src-tauri/tauri.conf.json` | `"dialog": false` |
| `web/components/settingsModal.ts` | 3 つの入力追加 + portRequiresRestart 表示 |
| `web/main.ts` | topbar status pane init + log button hook + updater check (5 秒後) |
| `web/index.html` | `<div id="api-status">` + `<button id="open-logs">` + log modal の HTML + update toast の HTML |
| `web/styles.css` | API ドット、log modal、update toast のスタイル |

### 8.2 新規ファイル

| ファイル | 役割 |
|---|---|
| `server/logBuffer.ts` | console wrap + ring buffer |
| `server/routes/status.ts` | `/api/status` ハンドラ |
| `server/routes/logs.ts` | `/api/logs` ハンドラ |
| `web/components/logsModal.ts` | ログモーダル UI |
| `web/components/apiStatusPane.ts` | topbar API ドット |
| `web/components/updateToast.ts` | アップデートトースト |
| `web/lib/updater.ts` | Tauri updater 安全ラッパ |
| `server/configStore.test.ts` | 単体テスト |
| `server/logBuffer.test.ts` | 単体テスト |

### 8.3 依存追加

なし。`@tauri-apps/plugin-updater` は既に `package.json` にある。

---

## 9. 成功基準

- [ ] `npm run dev` で settings modal から price poll を 5000ms に変えて保存 → 即時反映 (DevTools で確認)
- [ ] price/news/port を範囲外で保存しようとすると 400 が返り、UI でエラーが見える
- [ ] Yahoo を意図的に落とすと topbar Y ドットが 🟡 になり、tooltip に残時間表示
- [ ] 📋 でログモーダルが開き、自動更新中に新しい priceLoop ログが流れる
- [ ] `npm run typecheck` exit 0
- [ ] `npm test` 既存全 PASS + 新規 2 ファイルの新テスト PASS
- [ ] `npm run tauri:dev` で updater が initialize し、placeholder URL でも fork-bomb せずに静かに失敗
