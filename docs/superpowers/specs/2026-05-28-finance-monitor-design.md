# Finance Monitor — Design Spec

**Date**: 2026-05-28
**Target user**: 日経先物トレーダー1名（個人利用、ローカル実行）
**Reference**: [finance.worldmonitor.app](https://finance.worldmonitor.app/) — 必要要素のみを抜粋した軽量実装

---

## 1. Purpose / 目的

日経225先物のトレード中に、相場が急変した際に **「何が起きているか / なぜ動いたか」を最短数秒で把握** するためのローカル ダッシュボード。

- 価格モニター: 8銘柄（日本・米国の主要先物 + 為替 + 原油 + ボラ + 金利）
- ニュースフィード: 日英10ソースを集約
- 急変アラート: 視覚ハイライト + ビープ音
- LLMによる「なぜ動いた」説明: 急変時のみ on-demand 生成

非目的（明示的にスコープ外）:

- 発注機能なし（モニタリング専用）
- 過去データ分析・バックテストなし
- マルチユーザー対応なし
- モバイル対応なし（PCブラウザのみ）

## 2. Tracked instruments / 監視銘柄

| 銘柄 | Ticker (Yahoo Finance) | 変動幅閾値（5分ローリング窓） | 傾き閾値（30秒窓） | 補足 |
|------|------------------------|------------------|------------------|------|
| 日経225 | `NK=F` | ±0.30% | ±0.10% / 30s | CME Nikkei先物（jp225 CFD相当） |
| ナスダック100先物 | `NQ=F` | ±0.30% | ±0.10% / 30s | |
| ダウ先物 | `YM=F` | ±0.30% | ±0.10% / 30s | |
| S&P500先物 | `ES=F` | ±0.30% | ±0.10% / 30s | |
| USD/JPY | `JPY=X` | ±0.20%（約30銭） | ±0.07% / 30s（約10銭） | |
| WTI原油 | `CL=F` | ±0.50% | ±0.20% / 30s | |
| VIX | `^VIX` | ±5.00% | ±2.00% / 30s | |
| 米10年債利回り | `^TNX` | ±2bp | ±1bp / 30s | |

**ハイブリッド検知**: 変動幅 OR 傾き、どちらか一方でも閾値を超えれば発火。

- **変動幅**: 5分ローリング窓内の最古値と現在値の差 (%)。緩やかなトレンド系急変を捉える
- **傾き**: 30秒窓内の最古値と現在値の差 (%)。フラッシュ系急変を即時捉える（傾きは「% per 30s」で正規化、内部実装は単純差分）

両方とも `config.ts` に集約し、将来UIから変更可能にする余地を残す（初版はコード変更）。

## 3. Architecture / アーキテクチャ

```
┌─────────────────────────────────────────────────┐
│  Browser (localhost:5173)                        │
│  index.html + main.ts (Vanilla TS + Vite)       │
│   - 価格グリッド（8カード、3×3で1枠空き）         │
│   - ニュースフィード（右パネル）                   │
│   - 急変アラート（ハイライト + ビープ + バナー）  │
│   - SSE接続（プッシュ受信）                       │
└──────────────────────┬──────────────────────────┘
                       │ SSE: GET /api/stream  (text/event-stream)
                       │ HTTP REST: /api/explain （on-demand）
┌──────────────────────▼──────────────────────────┐
│  Express server (localhost:3000)                 │
│   GET  /api/stream    → SSE (prices 2s / news 60s) │
│   POST /api/explain   → OpenAI（急変時のみ）     │
│                                                  │
│   バックグラウンド ループ:                         │
│    ・priceLoop: 2秒ごとにYahoo一括取得→全SSEへpush│
│    ・newsLoop:  60秒ごとにRSS集約→全SSEへpush     │
│   429受信時: 5s→10s→30sの指数バックオフ後、復帰   │
└──────┬────────────┬────────────┬────────────────┘
       │            │            │
   Yahoo        RSS feeds    OpenAI
   Finance      (10本)       GPT-4o-mini
```

**設計原則**:

- フロントエンドはAPIキーを一切保持しない（Express経由のみ）
- 価格は単一エンドポイントで一括取得（リクエスト数最小化）
- **SSEで サーバ→ブラウザ にプッシュ**（ブラウザ側ポーリング不要、複数タブで1接続を共有しない場合でもサーバが上流APIを叩く回数は1）
- LLM呼び出しは急変時のみ → コスト最小化
- フォールバック付きデータソース（Yahoo失敗時はInvesting.comスクレイピング）

## 4. Alert flow / アラート フロー

```
サーバ priceLoop (2秒ごと)
        │
        ▼
Yahoo Finance一括取得 → 全SSEクライアントへ push
        │
        ▼
ブラウザ EventSource onmessage
        │
        ▼
価格更新 → changeDetector が2系統で並行判定
        │   ・変動幅判定: 5分ローリング窓内の最古値との差
        │   ・傾き判定:    30秒窓内の最古値との差
        │
        ├─ どちらか閾値超え（OR条件）
        │       │
        │       ├─① 即時発火（LLMを待たない）
        │       │     • セル赤/緑ハイライト点滅（CSS animation）
        │       │     • ビープ音再生（Web Audio API）
        │       │     • 上部バナー: 「⚡ 日経225 -0.12% / 25秒 [フラッシュ]」
        │       │       または「⚡ 日経225 -0.35% / 4分 [トレンド]」
        │       │
        │       └─② 並行して /api/explain
        │              入力: 銘柄名、変化率、検知種別（フラッシュ/トレンド）、直近30分のニュース
        │              出力（1〜2秒後）: 「FOMC議事録で利下げ後退観測。NQ-1%、TY+3bp連動。」
        │              バナーに追記表示
        │
        └─ どちらも閾値内 → カード更新のみ
```

**重要**: 視覚+音アラートは即座に発火し、LLM応答を待たない。説明テキストのみ遅延追記される。

## 5. UI layout / 画面構成

```
┌─────────────────────────────────────────────────────────────────┐
│ Finance Monitor                          JST 22:43:15  ●Live    │
│ ┌─ Alert Banner ────────────────────────────────────────────┐ │
│ │ ⚡ 日経225 -0.35% / 4分 [トレンド] | FOMC議事録で…    ✕  │ │
│ │ ⚡ NQ100   -0.12% / 25秒 [フラッシュ] | (説明取得中…) ✕  │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ ┌────────┬────────┬────────┐  ┌────────────────────────────┐  │
│ │ 日経225 │ NQ100  │ Dow    │  │ News                       │  │
│ │ 38,420 │ 21,850 │ 44,120 │  │ [JP] 日経新聞 14:32        │  │
│ │ -0.7%▼ │ -1.1%▼ │ -0.4%▼ │  │   日銀総裁、利上げ示唆…   │  │
│ ├────────┼────────┼────────┤  │ [EN] CNBC 14:30            │  │
│ │ S&P500 │USD/JPY │ WTI    │  │   FOMC minutes hawkish…   │  │
│ │ 5,620  │ 156.32 │ 78.45  │  │ [JP] Reuters 14:28         │  │
│ │ -0.9%▼ │ +0.3%▲ │ +0.1%▲ │  │   ドル円156円台半ば…      │  │
│ ├────────┼────────┼────────┤  │ ...                        │  │
│ │ VIX    │ 米10年 │        │  │                            │  │
│ │  18.42 │ 4.35%  │        │  │                            │  │
│ │ +8.3%▲ │ +5bp▲  │        │  │                            │  │
│ └────────┴────────┴────────┘  └────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

**配色**:

- 上昇=緑、下降=赤（東京市場とは逆だが米国・国際慣習に合わせる。後日 `config.ts` で反転可能に）
- 急変中はセル背景が点滅（500msごとに2回）
- ダークテーマ既定（トレーダー向けに目に優しく）

**言語ポリシー**:

- UIラベル: 日本語中心（「価格」「変化率」「ニュース」）
- 銘柄名: 日本語併記（"日経225 (NK=F)"）
- ニュース: タイトルは原文（[JP]/[EN]ラベル付き）
- LLM説明: 常に日本語出力（プロンプトで指定）

## 6. File structure / ファイル構成

```
Finance_Monitor/
├── package.json
├── .env                          # OPENAI_API_KEY
├── .env.example
├── .gitignore
├── tsconfig.json
├── vite.config.ts                # Vite + Express middleware統合
├── README.md
│
├── server/
│   ├── index.ts                  # Express起動 + Vite middleware
│   ├── routes/
│   │   ├── stream.ts             # GET /api/stream (SSE: prices + news)
│   │   └── explain.ts            # POST /api/explain
│   ├── loops/
│   │   ├── priceLoop.ts          # 2秒ごとYahoo一括取得、429時バックオフ
│   │   └── newsLoop.ts           # 60秒ごとRSS集約
│   ├── sse/
│   │   └── broker.ts             # 接続管理 + ブロードキャスト
│   ├── sources/
│   │   ├── yahooFinance.ts       # 一括クォート取得
│   │   ├── investingScrape.ts    # フォールバック
│   │   └── rssAggregator.ts      # RSS 10本集約
│   ├── llm/
│   │   └── openai.ts             # OpenAI + プロンプトテンプレート
│   └── config.ts                 # 銘柄定義、RSS URL、閾値、システムプロンプト
│
└── web/
    ├── index.html
    ├── main.ts                   # エントリ + SSE購読
    ├── styles.css                # ダークテーマ + アラートアニメ
    ├── components/
    │   ├── priceGrid.ts          # 8カード（3×3グリッド、1枠空き）レンダー
    │   ├── newsFeed.ts           # ニュース一覧
    │   ├── alertBanner.ts        # 上部バナー
    │   └── soundPlayer.ts        # Web Audio APIビープ
    ├── lib/
    │   ├── stream.ts             # EventSource ラッパー（自動再接続）
    │   ├── api.ts                # fetch ラッパー（/api/explain用）
    │   ├── changeDetector.ts     # 変動幅(5分窓) + 傾き(30秒窓) ハイブリッド判定（テスト対象）
    │   └── i18n.ts               # 日英ラベルマップ
    └── types.ts                  # server↔web 共有型
```

規模感: 約20ファイル、400〜500行。

## 7. Data sources / データソース詳細

### Prices (Yahoo Finance 非公式エンドポイント)

```
GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=NK=F,NQ=F,YM=F,ES=F,JPY=X,CL=F,^VIX,^TNX
```

レスポンスから `regularMarketPrice`, `regularMarketChangePercent`, `regularMarketTime` を抽出。

**フォールバック**: 失敗時は `investing.com/indices/japan-225-futures` 等を `cheerio` でスクレイピング（銘柄ごとに個別URL）。

### News (RSS)

日本語（4本）:

- 日経電子版マーケット: `https://www.nikkei.com/news/feed/`
- ロイター日本ビジネス: `https://jp.reuters.com/rssFeed/businessNews`
- ブルームバーグ日本: `https://www.bloomberg.co.jp/feeds/bbiz/sitemap_news.xml`
- みんかぶ: `https://minkabu.jp/news.rss`

英語（6本）:

- CNBC Top: `https://www.cnbc.com/id/100003114/device/rss/rss.html`
- Reuters Business: `https://feeds.reuters.com/reuters/businessNews`
- MarketWatch Top: `https://feeds.content.dowjones.io/public/rss/mw_topstories`
- Yahoo Finance: `https://finance.yahoo.com/news/rssindex`
- Investing.com: `https://www.investing.com/rss/news.rss`
- ZeroHedge: `https://feeds.feedburner.com/zerohedge/feed`

`Promise.allSettled` で並列取得、`rss-parser` でパース、`pubDate` でマージソート、直近100件保持。

### LLM (OpenAI GPT-4o-mini)

**プロンプト構造**:

```
System: あなたは日経先物トレーダー向けの市場分析アシスタントです。
        日本語で1〜2文、結論先出しで答えてください。

User:   【急変】{銘柄名} が {期間} で {変化率}% 動きました。
        【関連ニュース直近30分】
        - [時刻] [ソース] タイトル
        - ...
        この値動きの最も可能性の高い理由を1〜2文で説明してください。
        該当しそうなニュースがなければ「明確な材料なし」と返答してください。
```

`temperature: 0.3`, `max_tokens: 150`, ストリーミングなし（バナー追記タイミング統一のため）。

## 8. Error handling / エラーハンドリング

| 失敗ケース | 対応 |
|-----------|------|
| Yahoo Finance API失敗 | Investing.comスクレイピングへフォールバック。それも失敗時は当該銘柄を「---」表示、他は更新継続 |
| Yahoo Finance 429 (rate limit) | 指数バックオフ: 5s→10s→30s→60s。成功で2sへ復帰。期間中の値は最後の値を保持 |
| RSSフィード一部失敗 | `Promise.allSettled` で取得できた分のみ表示 |
| OpenAI失敗（rate limit / network） | バナーに「説明取得失敗」と表示。視覚+音アラートは通常通り発火 |
| SSE接続断 | EventSource標準の自動再接続（3秒間隔）。バナーに「再接続中」表示 |
| 全SSEクライアント切断時 | サーバ priceLoop/newsLoop は継続稼働（接続時にすぐ最新値を返せるよう、最後の値を保持） |
| `OPENAI_API_KEY` 未設定 | フロントは正常動作。`/api/explain` は即座に `{ explanation: "(LLM disabled)" }` を返す |
| ブラウザがオフライン | EventSourceがエラーを発火、バナーに「接続なし」表示。復帰時に自動再開 |
| サウンド再生失敗（ブラウザポリシー） | 初回はユーザークリックを要求するモーダル表示後に有効化 |

## 9. Testing / テスト方針

軽量原則に従い、回帰防止が必須な箇所のみテストする。

- **ユニットテスト** (Vitest): `web/lib/changeDetector.ts` のみ
  - 5分窓・30秒窓 両方のバッファリング動作
  - 変動幅判定（境界値、複数銘柄）
  - 傾き判定（フラッシュ系の即時検知、境界値）
  - OR条件の発火、両方同時発火時の重複抑制（最初の発火種別を優先）
  - クリア・リセット動作
- **手動テスト**: README に「市場急変時の動作確認手順」を記載
- **型チェック**: `npm run typecheck` で `tsc --noEmit` を実行可能に
- **E2Eなし**: 軽量原則

## 10. Out of scope / 明示的にスコープ外

以下は将来拡張候補だが初版には含めない:

- カスタム銘柄追加UI（コード変更で対応）
- アラート閾値のUIからの変更（コード変更で対応）
- OS デスクトップ通知（ハイライト+ビープのみ）
- チャート表示（数値とミニスパークラインなし、テキスト％のみ）
- 過去データ保存・分析
- 複数LLMプロバイダ切替（OpenAI固定）
- 経済指標カレンダー
- X (Twitter) フィード
- マルチユーザー / 認証
- モバイル対応

## 11. Dependencies / 依存パッケージ

```json
{
  "dependencies": {
    "express": "^4",
    "rss-parser": "^3",
    "cheerio": "^1",
    "openai": "^4"
  },
  "devDependencies": {
    "vite": "^5",
    "typescript": "^5",
    "@types/express": "^4",
    "@types/node": "^20",
    "vitest": "^1"
  }
}
```

計9パッケージ。worldmonitor（数十パッケージ）と比較して明確に軽量。

## 12. Success criteria / 完成判定

以下すべてを満たせば初版完成:

1. `npm install && npm run dev` でlocalhost:5173が起動し、8銘柄の価格が表示される
2. SSE経由で価格が約2秒ごとにブラウザに到達する（DevToolsのEventSourceで確認可能）
3. 日英ニュースが10ソースから集約表示される（60秒ごとに更新）
4. 日経225先物が ±0.30%/5分（変動幅）または ±0.10%/30秒（傾き）動くと、1秒以内にハイライト+ビープが発火する。バナーに [トレンド] / [フラッシュ] ラベルが表示される
5. アラート発火から2秒以内に「なぜ動いた」がバナーに追記される（OpenAI接続時）
6. APIキー未設定でも上記1〜4が正常動作する
7. Yahoo Finance障害時、Investing.comフォールバックで価格表示が継続する
8. ネットワーク切断後復旧で、SSEが自動再接続される
