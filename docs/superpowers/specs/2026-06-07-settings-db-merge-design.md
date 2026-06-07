# 設定からの DB マージ機能 — 設計

- 日付: 2026-06-07
- 対象: jp225-monitor v0.6.17+（Tauri 単一アプリ）
- 目的: 別PCの `jp225.db` を、monitor の**設定画面から**ファイル選択ダイアログで選び、collector / jp225-Trade を
  停止した上で安全にマージし、**自動再起動**するまでを1操作で行えるようにする。
  (CLI `scripts/merge-db.mjs` の手順を GUI 化。)

## 0. 背景・制約

- マージ実行時、monitor アプリの sidecar(Node サーバ）が `%APPDATA%/jp225-monitor/jp225.db` を WAL で開いている。
- **node:sqlite は同期 API**。sidecar は単一スレッド・単一イベントループ。マージを**1つの同期関数**として実行すれば、
  その間イベントループはブロックされ、他の書き込み(priceLoop の tick/bar 記録、alertHistory の followup 等)が
  交錯しない=実質原子的。よって sidecar が**自分のプロセス内でマージ**できる(案A・採用)。
- v0.6.17 で alerts に UNIQUE 同一性インデックスがあるため、マージは `INSERT OR IGNORE` で重複が物理的に作れない。
- jp225-Trade は monitor DB を**読取専用**で参照(WAL は読み手と書き手の併存可)。マージ前に停止する(ユーザー要望)。

## 1. アーキテクチャ(案A: sidecar in-process マージ)

```
[設定UI] --(Tauri dialog でファイル選択)--> source path
   --(POST /api/merge {source})--> [sidecar server]
        1) source 検証(存在・alerts/bars_1m/ticks を持つ jp225 DB か)
        2) collector 停止(collector.pid を taskkill)+ jp225-Trade 停止(taskkill 名前指定)
        3) VACUUM INTO でライブ DB を安全バックアップ
        4) 同期マージ(ATTACH source → INSERT OR IGNORE → 件数集計)
        5) 結果 {ok, inserted:{alerts,bars,ticks}} を返す
   <--(成功)-- [設定UI] 件数トースト表示 → @tauri-apps/plugin-process relaunch() で自動再起動
```

## 2. コンポーネント

### 2.1 マージ・モジュール `server/db/mergeDb.ts`(新規・テスト可)
- `mergeFrom(db: DatabaseSync, sourcePath: string): { alerts: number; bars_1m: number; ticks: number }`
  - ATTACH source(読取)。1トランザクション内で:
    - alerts: id 以外の全列を `INSERT OR IGNORE`(UNIQUE 同一性索引が重複を弾く)
    - bars_1m / ticks: 列名明示で `INSERT OR IGNORE`(PK=(symbol,t)、列順差吸収)
  - 各 `.changes` を返す。例外時は ROLLBACK して投げる。
  - **純粋に DB 操作のみ**(プロセス停止・バックアップ・再起動は呼び出し側=server)。
- `scripts/merge-db.mjs` はこのモジュールを使うよう書き換え(CLI も同じロジック)。バックアップ・停止チェックは CLI 側に残す。

### 2.2 バックアップ `server/db/backupDb.ts`(または mergeDb 内)
- 開いた WAL DB を安全に複製: `db.exec("VACUUM INTO 'path'")`。パス=`<dbdir>/jp225.db.bak-merge-YYYYMMDD-HHMMSS`。
  (ファイルコピーは WAL 未反映分を取りこぼすため使わない。)

### 2.3 プロセス停止 `server/processControl.ts`(新規)
- `stopCollector(): void` — `%APPDATA%/jp225-monitor/collector.pid` を読み `taskkill /PID <pid> /T /F`、pid ファイル削除。
- `stopTrade(): void` — `taskkill /IM jp225-trade.exe /T /F` と `jp225-trade-sidecar.exe`(未起動は無視=エラー握り潰し)。
- Windows 前提(sidecar は Windows 実行)。`child_process.execFileSync('taskkill', ...)`、失敗は無視。

### 2.4 server エンドポイント `POST /api/merge`(server/index.ts)
- body: `{ source: string }`(JSON)。
- 検証: source 実在 / SQLite として開けて `alerts`,`bars_1m`,`ticks` テーブルを持つ(不正なら 400)。
- 手順: stopCollector() → stopTrade() → backup(VACUUM INTO) → mergeFrom(現行DB接続, source) → 200 `{ ok:true, inserted, backup }`。
- 失敗時: 500 `{ ok:false, error }`。**再起動はしない**(UI 側が成功時のみ relaunch)。collector/trade は停止済みである旨もメッセージに含める。
- **専用接続**を使う: `const db = openDb(resolveDbPath())` でバックアップ(VACUUM INTO)+ `mergeFrom(db, source)` を
  実行し、終わったら `db.close()`。同一プロセス内の他接続(alertHistory 等)とは WAL で併存可、かつマージは同期実行
  =イベントループをブロックするため他処理と非交錯(原子的)。

### 2.5 設定UI(web/components/settingsModal.ts + index.html）
- 「別PCのDBをマージ」ボタン(設定モーダル内・危険操作として区別表示)。
- 押下フロー(Tauri 内のみ。非Tauri=開発版は「パッケージ版でのみ利用可」表示):
  1. `@tauri-apps/plugin-dialog` の `open({ multiple:false, filters:[{name:'SQLite DB', extensions:['db']}] })` でファイル選択。
  2. キャンセルなら何もしない。
  3. 確認: 「collector と jp225-Trade を停止してマージし、自動で再起動します。よろしいですか?」(OK/キャンセル)。
  4. OK → ボタン無効化・「マージ中…(数十秒かかる場合があります)」表示 → `fetch POST /api/merge {source}`。
  5. 成功 → 「統合: alerts +N / bars +N / ticks +N。再起動します」トースト → 1.5秒後 `@tauri-apps/plugin-process` の `relaunch()`。
  6. 失敗 → エラー表示(再起動しない)。
- `web/lib/` に薄いラッパ(dialog/relaunch の動的 import・非Tauri ガード)を置く(updater.ts と同じ作法)。

### 2.6 Tauri 追加
- `tauri-plugin-dialog`(Cargo `tauri-plugin-dialog = "2"` + `.plugin(tauri_plugin_dialog::init())` を lib.rs に + npm `@tauri-apps/plugin-dialog`)。
- `capabilities/default.json` に `dialog:default`(または `dialog:allow-open`)を追加。relaunch は既存 `process:default` で可。

## 3. データフロー / 安全性

- マージは sidecar の単一スレッドで同期実行 → 原子的。collector/trade 停止で外部書き手も消す。
- UNIQUE 索引(v0.6.17)で alerts 重複は不能。bars/ticks は PK で OR IGNORE。
- バックアップ(VACUUM INTO)を必ず取ってからマージ。失敗時はバックアップから復旧可能。
- マージ後に **relaunch** で sidecar/collector を含め全部クリーン起動し直し(ユーザー要望の「全停止→再起動」を満たす)。

## 4. エラーハンドリング

- source が DB でない/必須テーブル欠如 → 400、停止・マージしない。
- マージ例外 → ROLLBACK、500。collector/trade は停止済み(メッセージで通知)。UI は再起動しない。
- 非Tauri(開発ブラウザ)→ dialog/relaunch 不可 → ボタン押下時に「パッケージ版でのみ利用可」。

## 5. テスト

- `mergeFrom` 単体(in-memory 2DB): alerts/bars/ticks が OR IGNORE で統合・重複が増えない・件数(changes)が正しい・
  別水準アラート保持・列順差のある bars でも列名指定で正しく入る。
- backup(VACUUM INTO): 一時ファイルに複製ができ alerts 件数が一致。
- processControl / dialog / relaunch は Tauri ランタイム依存 → 手動確認(`npm run tauri:dev`)。
- `POST /api/merge` の検証分岐(不正 source=400)は server テスト流儀で可能なら追加。
- 既存 288 テスト緑維持。

## 6. 非対象(YAGNI)

- 進捗バー(同期マージで一括・件数トーストで十分)。
- マージ結果の再起動後表示(トーストで足りる)。
- 複数ファイル同時マージ・ドラッグ&ドロップ。
- mac/linux のプロセス停止(monitor は Windows 配布)。
- 双方向同期(片方向の取り込みのみ)。
