# JP225 Monitor

[![Latest Release](https://img.shields.io/github/v/release/sora-moyou/jp225-monitor)](https://github.com/sora-moyou/jp225-monitor/releases/latest)

日経225先物トレード中のマーケット監視を支援する、Windows デスクトップアプリです。
8 銘柄をリアルタイム監視し、急変動を自動検知 → AI が日本語で「なぜ動いたか」を説明します。

## ✨ ダウンロード

**[最新版をダウンロード →](https://github.com/sora-moyou/jp225-monitor/releases/latest)**

「Assets」セクションから `JP225.Monitor_X.X.X_x64-setup.exe` をクリック。

## 📖 使い方

**👉 [USER_GUIDE.md (利用マニュアル)](./USER_GUIDE.md)**

初心者向けに、インストール → API キー設定 → 各機能の使い方 → トラブルシューティングまで網羅しています。

## ✨ 主な機能

- 📊 **8 銘柄リアルタイム監視** (NK=F, NQ=F, YM=F, ES=F, JPY=X, CL=F, ^VIX, ^TNX) を 2 秒間隔で
- 🚨 **ハイブリッド急変検知** (5 分窓 magnitude + 30 秒窓 slope)
- 🤖 **LLM 自動説明** (Gemini → Groq → OpenAI 自動フォールバック、無料枠で十分)
- 📰 **21 ニュースソース集約** (日本 7 + 英語 14)、英語見出しはワンクリック日本語翻訳
- 💬 **AI チャット**: 現在の全銘柄価格 + 直近 15 件ニュースをコンテキストに自由質問
- 📈 **TradingView チャート埋め込み** (日経 225)
- 🔔 **音声アラート** (Web Audio API、上昇=高音/下落=低音)
- 🔄 **自動アップデート** (起動 5 秒後にチェック、新版あれば右上トースト)
- 🎛 **API ポーリング間隔の可変設定**、稼働状況の topbar 可視化

## 🖼 スクリーンショット

(後日追加予定)

## 🛠 動作環境

- **Windows 10 / 11** (64-bit)
- **WebView2 Runtime** (Win 11 標準同梱、Win 10 でも近年の Windows Update で含まれる)
- **LLM API キー** (Gemini 推奨、無料): https://aistudio.google.com/apikey

API キー未設定でも価格監視・アラート音・チャートは動きます。AI 説明と AI チャットだけが無効になります。

## 🧰 開発者向け

### スタック

- **フロント**: Vanilla TypeScript + Vite (フレームワーク無し、ライト志向)
- **バック**: Express + SSE on Node.js
- **デスクトップ**: Tauri 2.x (Rust 本体 + Node SEA サイドカー)
- **テスト**: Vitest
- **配布**: NSIS インストーラ + minisign 署名付き updater

### dev 起動

```powershell
npm install
cp .env.example .env  # LLM API キーを入力 (任意)
npm run dev           # Vite (5173) + Express (3000) を並行起動
```

### Tauri ネイティブ dev 起動

```powershell
npm run tauri:dev
```

### リリースビルド

```powershell
npm run release:build       # 署名付き .exe + .sig を生成
npm run release:latest-json # updater 用 latest.json を release/ に出力
gh release create v0.x.x --title "..." --notes "..." `
  "src-tauri/target/release/bundle/nsis/JP225 Monitor_0.x.x_x64-setup.exe" `
  "src-tauri/target/release/bundle/nsis/JP225 Monitor_0.x.x_x64-setup.exe.sig" `
  "release/latest.json"
```

### テスト

```powershell
npm test         # vitest 全 19 テスト (configStore, logBuffer, changeDetector)
npm run typecheck
```

### アーキテクチャ

```
server/                Express + SSE (Tauri sidecar)
├── loops/             priceLoop (2s, Yahoo→Investing fallback)
│                      newsLoop (60s, 21 RSS feeds)
├── sources/           yahooFinance / investingScrape / rssAggregator
├── llm/openai.ts      multi-provider fallback + circuit breaker
├── routes/            /api/stream /api/explain /api/chat /api/translate
│                      /api/settings /api/status /api/logs /api/version
├── configStore.ts     ~/.jp225-monitor/config.json 永続化
└── logBuffer.ts       200 行 ring buffer (console wrap)

web/                   Vanilla TS フロント
├── lib/               stream / api / changeDetector / apiBase / updater
├── components/        priceGrid / newsFeed / alertBanner / chatBoard
│                      settingsModal / logsModal / apiStatusPane / updateToast
└── main.ts

src-tauri/             Tauri Rust scaffold + サイドカー spawn
```

### 設計ドキュメント

- 初期設計: `docs/superpowers/specs/2026-05-28-finance-monitor-design.md`
- Phase 4 (tunable params + status UI): `docs/superpowers/specs/2026-05-29-tunable-params-and-status-ui-design.md`
- Tauri 配布手順: `docs/tauri-setup.md`

## 📝 ライセンス

このプロジェクトは個人利用を想定しています。
コードは自由に閲覧・参考にしていただいて構いません。

## 🤝 サポート

- バグ報告 / 機能要望: [Issues](https://github.com/sora-moyou/jp225-monitor/issues)
