# 設定画面のバージョンチェック機能 — 設計

- 日付: 2026-05-30
- 対象: JP225 Monitor (finance-monitor) v0.3.17 時点
- 目的: 設定画面から手動で「現在動作中のバージョンが最新かどうか」を確認できるようにする。

## 背景

- 既に Tauri updater プラグイン経由で、起動 5 秒後に GitHub Release の `latest.json`
  をチェックし、更新があれば `updateToast` を表示する仕組みがある
  (`web/lib/updater.ts`, `web/components/updateToast.ts`)。
- 起動中バージョンは `/api/version` から取得でき、ヘッダの `#app-version` に
  `v0.3.17` と常時表示されている。
- しかし「今が最新かどうか」をユーザーが任意のタイミングで確認する手段がない。
  起動トーストは「更新がある時だけ」出るため、「最新であること」の確認はできない。

## 判定方法

既存の Tauri updater を再利用する(サーバ経由で latest.json を別途取得する案は採らない)。
理由: 本アプリは主にパッケージ版(Tauri アプリ)として動作し、署名検証込みの
チェック/インストール経路が既に存在するため、ロジックの二重化を避ける。

## 唯一の障害

現状の `checkForUpdate()` は次の 3 状態を区別できない:

- 更新あり → `UpdateInfo` を返す
- 最新 → `null`
- Tauri 外(ブラウザ開発版) → `null`

設定画面では「最新です」と「チェック不可(開発モード)」を区別して表示したいため、
状態を明示する関数を新設する。

## 変更点

### 1. `web/lib/updater.ts` — 状態を区別する関数を追加

`checkForUpdate()`(トーストが使用)はそのまま残し、設定画面用に以下を追加する:

```ts
export type UpdateStatus =
  | { state: 'unsupported' }                  // Tauri 外 (npm run dev のブラウザ)
  | { state: 'latest' }                       // 最新
  | { state: 'available'; info: UpdateInfo }  // 更新あり
  | { state: 'error'; message: string };      // チェック失敗 (ネットワーク等)

export async function getUpdateStatus(): Promise<UpdateStatus>;
```

実装方針:

- `inTauri()` が false → `{ state: 'unsupported' }`
- `import('@tauri-apps/plugin-updater')` の `check()` を呼ぶ
  - 例外 → `{ state: 'error', message }`
  - `null` → `{ state: 'latest' }`
  - update オブジェクト → `{ state: 'available', info: { version, notes, date } }`
- `checkForUpdate()` は `getUpdateStatus()` に委譲し、`available` の時だけ
  `info` を返す薄いラッパへリファクタ(トーストの挙動は不変)。
- `installUpdate(onProgress)` は既存のものをそのまま再利用する(変更なし)。

### 2. `web/index.html` — 設定モーダルに「バージョン」セクション追加

既存の `fieldset.settings-section` と同じ体裁で、保存ボタン群の前に追加する:

- `現在のバージョン: <span id="settings-current-version">…</span>`
- `<button id="settings-check-update">最新かチェック</button>`
- `<div id="settings-update-result"></div>`(初期は空)

### 3. `web/components/settingsModal.ts` — チェック & 更新の制御

- `SettingsElements` に `checkUpdateBtn` / `updateResult` / `currentVersion` を追加。
- モーダルを開いた時(`refresh()`)、`/api/version` を取得して
  `currentVersion` に `v0.3.17` を表示。更新結果エリアはクリアする。
- 「最新かチェック」押下時の流れ:
  1. ボタンを `チェック中...` に変え disabled、結果エリアにスピナー/「確認中...」
  2. `getUpdateStatus()` を呼ぶ
  3. 結果に応じて結果エリアを描画:
     - `latest` → `✅ 最新です (v0.3.17)`
     - `available` → `🆙 新しいバージョン vX.Y.Z があります` + `[更新]` ボタン
       (notes があれば併記)
     - `unsupported` → `⚠️ 開発モードのためチェックできません(パッケージ版でのみ動作)`
     - `error` → `❌ チェック失敗: <message>`
  4. ボタンを元に戻す
- `available` 時の `[更新]` ボタン押下 → `installUpdate()` を呼ぶ。
  進捗を `ダウンロード中… NN%` で結果エリアに表示。完了時は updater 内で
  `relaunch()` されるため通常そのまま再起動。失敗時は `❌ 更新失敗: <message>`。
  (updateToast.ts の既存ロジックと同じ。表示先が結果エリアに変わるだけ。)
- HTML はエスケープして埋め込む(version/notes/message)。

### 4. `web/main.ts` — 配線

`initSettingsModal({...})` の呼び出しに新 3 要素を追加:

```ts
checkUpdateBtn: document.getElementById('settings-check-update') as HTMLButtonElement,
updateResult:   document.getElementById('settings-update-result') as HTMLElement,
currentVersion: document.getElementById('settings-current-version') as HTMLElement,
```

### 5. `web/styles.css`

更新結果エリアの状態別の色(成功=緑/警告=黄/エラー=赤)と、更新ボタン/
進捗テキストの最小スタイルを追加。既存の `.settings-status` / `.update-toast-*`
のトーンに合わせる。

## ユニット境界

- `web/lib/updater.ts`: Tauri との唯一の接点。状態の取得とインストールのみを担う。
  DOM を知らない。
- `web/components/settingsModal.ts`: `updater.ts` の結果を受けて描画するだけ。
  Tauri API を直接触らない。
- 依存方向: `settingsModal.ts → updater.ts`(一方向、循環なし)。

## テスト方針

- ブラウザ開発版(`npm run dev`)で設定を開き、現在バージョン表示と
  「開発モードのためチェック不可」表示を目視確認。
- 型/ビルド: `npm run typecheck`。
- `getUpdateStatus()` の分岐(unsupported / latest / available / error)は
  純粋に近いが Tauri 動的 import に依存するため、ユニットテストは
  `inTauri()` false ケース(unsupported)のみ vitest で確認可能なら追加。
  それ以外はパッケージ版での手動確認に委ねる。

## 非対象 (YAGNI)

- サーバ経由の latest.json 取得・バージョン比較。
- 自動定期チェックの設定 UI(起動時トーストの既存挙動は維持)。
- 更新チャンネル(stable/beta)切り替え。
