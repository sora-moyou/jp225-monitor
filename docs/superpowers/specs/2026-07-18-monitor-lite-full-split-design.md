# monitor を 2製品に分離(monitor2=フル / monitor=表示縮小) (design)

日付: 2026-07-18 / 対象: monitor(1コードベース→2製品ビルド) / 初版=v0.8.1(=ユーザー表記 v0.8.01)

## 目的(ユーザー指示)
1コードベースから2製品を出す。**monitor利用者が細部設定を変更できないようにするのが主眼**。
- **monitor2(フル)**: 全UI・trade2連携もこちら。**開発はここ**(private repo `jp225-monitor2` / 配布 public `jp225-monitor2-releases`・trade2方式)。
- **monitor(lite=表示縮小)**: 同一エンジン・同一版・**表示のみ削減**。既存 public `jp225-monitor`(identifier 継続=既存利用者は自動更新でliteを受領)。
- ③版・動作は完全同一(差はDISPLAYのみ) / ⑥常に同時リリース / ⑦同時起動不可・monitor2優先。

## variant の伝播(1 Web バンドル・二重管理なし)
- **Rust(lib.rs)** が起動時に `app.config().identifier` を見て variant を決定: `app.jp225monitor2`→`full` / それ以外(`app.jp225monitor`)→`lite`。
- Rust がサイドカー spawn 時に **`.env("MONITOR_VARIANT", variant)`** を渡す。
- **server**: `MONITOR_VARIANT`(未設定=`full`)を読み、`GET /api/version` 応答に **`variant:'full'|'lite'`** を追加(既存 {version,name} に追記)。
- **web(main.ts)**: 起動時 `/api/version` を取得し `variant==='lite'` なら下記UIを隠す(full は従来どおり全表示)。

## lite で隠すUI(④⑤)
- ④トップバー: **アラート履歴(#alerts-history-btn)・サーバログ(#open-logs)・詳細パラメータ(#params-btn)** を非表示(かつ params モーダルを開けない)。
- ⑤設定モーダル: **「AIエントリー」fieldset(legend=AIエントリー・#scalp-* 一式)** を非表示。
- ★他(📈トレードシグナル履歴・⚙️APIキー設定の他ブロック等)は表示のまま。隠すのは display のみ=DOM を hidden/削除(サーバ挙動・設定値は不変=monitor2 が設定した値で同一動作)。
- データ/設定は両製品で共有(server は `~/.jp225-monitor` / `%APPDATA%/jp225-monitor` 固定=identifier非依存)。lite は AI設定を「見せない/触らせない」だけでエンジンは同じ config を使う。

## ⑦相互排他(共有ロック・monitor2優先)
- 共有ロックファイル: `%APPDATA%/jp225-monitor/app-instance.lock`(JSON `{variant,pid}`)。両製品共通パス。
- Rust setup 冒頭:
  - **full(monitor2)**: ロックが lite の生存プロセス(pid のイメージ名が "JP225 Monitor.exe")なら **taskkill /PID <pid> /F /T でliteを終了**→ロックを自分(full,pid)で上書き→続行(=優先)。ロックが無い/自分→そのまま取得。
  - **lite**: ロックが full(monitor2)の生存プロセスなら **ダイアログ「monitor2 が起動中のため monitor は起動できません」→ app.exit(0)**(=起動しない)。無い/死んでる→自分で取得。
  - 生存判定は pid のプロセス実在＋イメージ名一致(誤kill防止)。ロックは Exit で自分の時のみ削除。
- ★taskkill は既存 stop_collector と同じ手法。**イメージ名検証必須**(pid再利用の誤kill防止)。collector は各PIDロックで単一=不変。

## Tauri 設定(2製品)
- **base `tauri.conf.json`=monitor2(フル)** に変更: productName **"JP225 Monitor2"** / identifier **"app.jp225monitor2"** / version **0.8.1** / updater endpoint **`https://github.com/sora-moyou/jp225-monitor2-releases/releases/latest/download/latest.json`** / pubkey **`dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFBMEZCQjgzQkRGMDQ3MDIKUldRQ1IvQzlnN3NQcW9nZmoxb2tuY3pyZ0MvR09PY0xCdWZjVEFlYUdDSXVsV1EzcG9OWUJPOWQK`**。
- **lite 上書き `src-tauri/tauri.lite.conf.json`**(base への差分・`tauri build --config` で適用): productName **"JP225 Monitor"** / identifier **"app.jp225monitor"** / version 0.8.1 / endpoint **`https://github.com/sora-moyou/jp225-monitor/releases/latest/download/latest.json`** / pubkey **`dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEEzRDI4RjlCQ0NFN0Q0NDIKUldSQzFPZk1tNC9TbzR5SHRuaHhWcWI4UWNmaHFES2VzOXBhY2paemIveFNHL3ZqbjNkVmZXTUwK`**。
- externalBin(jp225-sidecar/jp225-collector)・window・NSIS 等は共通。version は3ファイル(package.json/tauri.conf/Cargo.toml)＋lite override を 0.8.1 で揃える。

## リリーススクリプト(2製品対応)
- `scripts/release-build.mjs`・`scripts/make-latest-json.mjs` に **`PRODUCT=monitor2|lite`**(既定 monitor2)を追加:
  - monitor2: 鍵 `~/.tauri/jp225-monitor2.key`(無パスフレーズ)・config=base・exe `JP225 Monitor2_<v>_x64-setup.exe`・release repo `sora-moyou/jp225-monitor2-releases`・URL base 同左。
  - lite: 鍵 `~/.tauri/jp225-monitor.key`(無パスフレーズ)・config=`tauri.lite.conf.json`(`tauri build --config`)・exe `JP225 Monitor_<v>_x64-setup.exe`・release repo `sora-moyou/jp225-monitor`・URL base 同左。
  - ★署名鍵の env(TAURI_SIGNING_PRIVATE_KEY/…PASSWORD)を PRODUCT で切替。パスワードは両鍵とも空。
- ⑥同時リリース: リーダーが両 PRODUCT をビルド→両 latest.json→両 gh release を同一版で公開。

## テスト/受入
- server: `/api/version` が MONITOR_VARIANT で variant を返す(未設定=full)。
- web: variant='lite' で 4要素(履歴/ログ/params/AIエントリーfieldset)が hidden・'full' で全表示(純粋な表示関数を切り出しユニット化)。
- Rust mutex は手動確認(ビルド後): lite単独起動OK / monitor2起動でlite終了 / monitor2稼働中lite起動不可。
- tsc0/vitest緑/両 build 緑。**受入の肝**: (a)full は現行と完全同一動作、(b)lite は4要素非表示・他は同一、(c)相互排他が両方向で効く(monitor2優先)、(d)データ/設定は共有で同一エンジン、(e)2製品が別 identifier/pubkey/endpoint で正しく署名・自動更新される。

## 非対象/不変
- server のエンジン・AIエントリー・私的exit・trade2 連携は不変(liteは表示を隠すだけ)。trade2 は monitor2 に接続(既存どおり 127.0.0.1)。
