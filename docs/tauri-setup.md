# Tauri 配布パッケージング手順

## 前提

- **Rust toolchain** インストール済み (https://rustup.rs/)
- **Visual Studio Build Tools** インストール済み (Windows: rustup-init の指示通り)
- macOS 配布: Xcode Command Line Tools
- Linux 配布: webkit2gtk, build-essential 等 (Tauri公式ドキュメント参照)

確認:
```powershell
cargo --version    # 1.x が表示されればOK
rustc --version
```

## 初回セットアップ — Updater 署名鍵生成

自動アップデート用に **公開鍵/秘密鍵ペア** を1回だけ生成します。

```powershell
# 1. 鍵生成 (パスフレーズを入力する)
npm run tauri:signer
# → ~/.tauri/jp225-monitor.key (秘密鍵) と
#   ~/.tauri/jp225-monitor.key.pub (公開鍵) が作成される

# 2. 公開鍵を tauri.conf.json に貼り付け
cat ~/.tauri/jp225-monitor.key.pub
# → 出力をコピーし、src-tauri/tauri.conf.json の
#   "plugins.updater.pubkey" の "REPLACE_AFTER_..." を置換
```

⚠️ **秘密鍵 (`~/.tauri/jp225-monitor.key`) は厳重保管。Gitに絶対コミットしない。** CI に置く場合は GitHub Secrets 等の暗号化ストアへ。

## 開発モード

ホットリロードしながらネイティブウィンドウで動作確認:

```powershell
npm run tauri:dev
```

内部処理:
1. SEAバイナリビルド (`npm run package`)
2. sidecarフォルダにコピー
3. `tauri dev` 起動 → Rust コンパイル → Vite dev server + Tauri ウィンドウ

初回は Rust 依存のコンパイルに **数分〜10分** かかります。2回目以降は速い。

## リリースビルド

```powershell
npm run tauri:build
```

成果物:
- `src-tauri/target/release/bundle/nsis/JP225 Monitor_0.3.0_x64-setup.exe` (NSIS インストーラ)
- `src-tauri/target/release/bundle/msi/JP225 Monitor_0.3.0_x64_en-US.msi` (MSI)

これを GitHub Releases にアップロードすれば配布完了。

## 自動アップデート フロー (Phase 5 完成後)

```
ユーザーアプリ起動
  → updater が tauri.conf.json の endpoints を fetch
  → https://github.com/USER/jp225-monitor/releases/latest/download/latest.json
  → JSON が現在バージョンより新しければ通知バー (右上「v0.4.0 利用可」緑)
  → クリック → ダウンロード+署名検証+自動再起動
```

`latest.json` の形式:
```json
{
  "version": "0.4.0",
  "notes": "更新内容",
  "pub_date": "2026-06-15T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<署名文字列>",
      "url": "https://github.com/USER/jp225-monitor/releases/download/v0.4.0/JP225.Monitor_0.4.0_x64-setup.exe"
    }
  }
}
```

署名は `npm run tauri:build` 時に環境変数 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 経由で秘密鍵を読み取り自動付与。

## トラブルシュート

| 症状 | 原因 / 対処 |
|------|-----------|
| `link.exe not found` | VS Build Tools 未インストール |
| `failed to spawn sidecar` | `npm run sidecar:copy` を忘れている、または bin/ に `npm run package` 結果がない |
| `pubkey is invalid` | tauri.conf.json の `pubkey` がデフォルト文字列のまま → `npm run tauri:signer` で生成し置換 |
| ウィンドウ真っ白 | dist/web が古い → `npm run build:web` 再実行 |
| サイドカーポート競合 | 別のアプリが 3000 使用中 → サイドカーを別ポートで起動する変更が必要 |
