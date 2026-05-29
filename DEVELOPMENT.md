# 開発者向けドキュメント

JP225 Monitor のソースから動かしたり、機能追加したい場合の情報をまとめています。

## スタック

- **フロント**: Vanilla TypeScript + Vite (フレームワーク無し、ライト志向)
- **バック**: Express + SSE on Node.js
- **デスクトップ**: Tauri 2.x (Rust 本体 + Node SEA サイドカー)
- **テスト**: Vitest
- **配布**: NSIS インストーラ + minisign 署名付き updater

## dev 起動

```powershell
npm install
cp .env.example .env  # LLM API キーを入力 (任意)
npm run dev           # Vite (5173) + Express (3000) を並行起動
```

## Tauri ネイティブ dev 起動

```powershell
npm run tauri:dev
```

## リリースビルド

```powershell
npm run release:build       # 署名付き .exe + .sig を生成
npm run release:latest-json # updater 用 latest.json を release/ に出力
gh release create v0.x.x --title "..." --notes "..." `
  "src-tauri/target/release/bundle/nsis/JP225 Monitor_0.x.x_x64-setup.exe" `
  "src-tauri/target/release/bundle/nsis/JP225 Monitor_0.x.x_x64-setup.exe.sig" `
  "release/latest.json"
```

## テスト

```powershell
npm test         # vitest 全 19 テスト (configStore, logBuffer, changeDetector)
npm run typecheck
```

## アーキテクチャ

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

## 設計ドキュメント

- 初期設計: `docs/superpowers/specs/2026-05-28-finance-monitor-design.md`
- Phase 4 (tunable params + status UI): `docs/superpowers/specs/2026-05-29-tunable-params-and-status-ui-design.md`
- Tauri 配布手順: `docs/tauri-setup.md`

## 📝 ライセンス

このプロジェクトは個人利用を想定しています。
コードは自由に閲覧・参考にしていただいて構いません。

## 🤝 サポート

- バグ報告 / 機能要望: [Issues](https://github.com/sora-moyou/jp225-monitor/issues)
