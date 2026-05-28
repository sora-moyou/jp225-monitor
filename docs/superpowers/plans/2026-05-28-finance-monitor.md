# Finance Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 日経先物トレーダー向けのローカル軽量市場ダッシュボード。8銘柄をSSEで2秒間隔配信、変動幅+傾きハイブリッド検知で急変アラート（視覚+音）、OpenAI GPT-4o-miniで「なぜ動いた」を日本語生成。

**Architecture:** Express server（バックグラウンドで Yahoo Finance を2秒ポーリング、RSS を60秒集約）→ SSE で全クライアントへブロードキャスト。Vanilla TypeScript + Vite フロントエンドが EventSource で受信、changeDetector が判定して即座にアラート発火、並行で `/api/explain` を呼んで LLM 説明を取得。

**Tech Stack:** Node.js + Express + TypeScript + Vite + yahoo-finance2 + rss-parser + cheerio + openai + Vitest

**Spec:** `docs/superpowers/specs/2026-05-28-finance-monitor-design.md`

---

## File Structure (確定版)

```
Finance_Monitor/
├── package.json              # 依存とスクリプト
├── .env / .env.example       # OPENAI_API_KEY
├── .gitignore
├── tsconfig.json             # TS設定（server + web共通）
├── vite.config.ts            # フロント用 + /api プロキシ
├── README.md                 # 起動方法 + 手動テスト手順
│
├── server/
│   ├── index.ts              # Express起動 + ループ起動
│   ├── config.ts             # 銘柄定義、RSS URL、閾値、プロンプト
│   ├── types.ts              # 共有型 (Price, NewsItem, AlertEvent)
│   ├── cache.ts              # 最新値保持（接続時の初期送信用）
│   ├── sse/broker.ts         # SSE接続管理 + broadcast
│   ├── loops/priceLoop.ts    # 2秒ループ + 指数バックオフ
│   ├── loops/newsLoop.ts     # 60秒ループ
│   ├── sources/yahooFinance.ts   # 一括クォート
│   ├── sources/investingScrape.ts # フォールバック
│   ├── sources/rssAggregator.ts  # RSS集約
│   ├── llm/openai.ts             # 「なぜ動いた」生成
│   └── routes/
│       ├── stream.ts         # GET /api/stream (SSE)
│       └── explain.ts        # POST /api/explain
│
└── web/
    ├── index.html
    ├── main.ts               # エントリ + SSE購読 + 全体配線
    ├── styles.css            # ダークテーマ + アラートアニメ
    ├── types.ts              # サーバと共有
    ├── lib/
    │   ├── stream.ts         # EventSource ラッパー（自動再接続）
    │   ├── api.ts            # /api/explain呼び出し
    │   ├── changeDetector.ts # ハイブリッド判定（テスト対象）
    │   ├── changeDetector.test.ts
    │   └── i18n.ts           # 日英ラベル
    └── components/
        ├── priceGrid.ts      # 8カード（3×3、1枠空き）
        ├── newsFeed.ts       # ニュース一覧
        ├── alertBanner.ts    # 上部バナー
        └── soundPlayer.ts    # Web Audio APIビープ
```

---

## Task 1: プロジェクト初期化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`

- [ ] **Step 1: gitリポジトリ初期化**

Run:
```bash
cd C:/Users/user/Desktop/Finance_Monitor
git init
```
Expected: `Initialized empty Git repository`

- [ ] **Step 2: package.json 作成**

Create `package.json`:
```json
{
  "name": "finance-monitor",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -k -n SRV,WEB -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "tsx watch server/index.ts",
    "dev:web": "vite",
    "build": "vite build && tsc -p tsconfig.server.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "express": "^4.19.0",
    "yahoo-finance2": "^2.11.0",
    "rss-parser": "^3.13.0",
    "cheerio": "^1.0.0",
    "openai": "^4.50.0"
  },
  "devDependencies": {
    "vite": "^5.4.0",
    "typescript": "^5.5.0",
    "tsx": "^4.16.0",
    "concurrently": "^8.2.0",
    "vitest": "^1.6.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.14.0"
  }
}
```

- [ ] **Step 3: tsconfig.json 作成**

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "web/**/*.ts"]
}
```

- [ ] **Step 4: vite.config.ts 作成**

Create `vite.config.ts`:
```ts
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    fs: {
      // server/ ディレクトリの共有型を web/ から import するため、ルートの一つ上を許可
      allow: [projectRoot],
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/api/stream': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        // SSE をバッファせず流す
        ws: false,
      },
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 5: .gitignore + .env.example 作成**

Create `.gitignore`:
```
node_modules/
dist/
.env
*.log
.DS_Store
```

Create `.env.example`:
```
OPENAI_API_KEY=sk-your-key-here
PORT=3000
```

- [ ] **Step 6: README.md 雛形作成**

Create `README.md`:
```markdown
# Finance Monitor

日経先物トレーダー向け軽量市場ダッシュボード。

## 起動

\`\`\`bash
npm install
cp .env.example .env  # OPENAI_API_KEY を設定（省略可、LLM説明が無効化されるだけ）
npm run dev
\`\`\`

ブラウザで http://localhost:5173 を開く。

## 設計

`docs/superpowers/specs/2026-05-28-finance-monitor-design.md` を参照。
```

- [ ] **Step 7: 依存パッケージインストール**

Run: `npm install`
Expected: `added N packages, no vulnerabilities`

- [ ] **Step 8: 型チェック確認（まだ空なのでパスする）**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 9: コミット**

```bash
git add .
git commit -m "chore: project scaffolding (package.json, tsconfig, vite, gitignore)"
```

---

## Task 2: サーバ共有型と設定

**Files:**
- Create: `server/types.ts`
- Create: `server/config.ts`

- [ ] **Step 1: 共有型定義**

Create `server/types.ts`:
```ts
export type Symbol =
  | 'NK=F' | 'NQ=F' | 'YM=F' | 'ES=F'
  | 'JPY=X' | 'CL=F' | '^VIX' | '^TNX';

export interface Price {
  symbol: Symbol;
  price: number;
  changePercent: number;
  timestamp: number;
  stale: boolean;
}

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  lang: 'ja' | 'en';
  url: string;
  publishedAt: number;
}

export interface InstrumentMeta {
  symbol: Symbol;
  labelJa: string;
  labelEn: string;
  magnitudeThreshold: number;
  slopeThreshold: number;
  unit: 'percent' | 'bp';
}

export type SSEEvent =
  | { type: 'prices'; payload: Price[] }
  | { type: 'news'; payload: NewsItem[] };
```

- [ ] **Step 2: 設定ファイル**

Create `server/config.ts`:
```ts
import type { InstrumentMeta } from './types.js';

export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NK=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'ES=F',  labelJa: 'S&P500先物',     labelEn: 'S&P500 Fut',     magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.07, unit: 'percent' },
  { symbol: 'CL=F',  labelJa: 'WTI原油',        labelEn: 'WTI Crude',      magnitudeThreshold: 0.50, slopeThreshold: 0.20, unit: 'percent' },
  { symbol: '^VIX',  labelJa: 'VIX',            labelEn: 'VIX',            magnitudeThreshold: 5.00, slopeThreshold: 2.00, unit: 'percent' },
  { symbol: '^TNX',  labelJa: '米10年債利回り',   labelEn: 'US 10Y Yield',   magnitudeThreshold: 2.00, slopeThreshold: 1.00, unit: 'bp' },
];

export const RSS_FEEDS = {
  ja: [
    { name: '日経',           url: 'https://www.nikkei.com/news/feed/' },
    { name: 'Reuters JP',     url: 'https://jp.reuters.com/rssFeed/businessNews' },
    { name: 'Bloomberg JP',   url: 'https://www.bloomberg.co.jp/feeds/bbiz/sitemap_news.xml' },
    { name: 'みんかぶ',        url: 'https://minkabu.jp/news.rss' },
  ],
  en: [
    { name: 'CNBC',           url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
    { name: 'Reuters',        url: 'https://feeds.reuters.com/reuters/businessNews' },
    { name: 'MarketWatch',    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories' },
    { name: 'Yahoo Finance',  url: 'https://finance.yahoo.com/news/rssindex' },
    { name: 'Investing.com',  url: 'https://www.investing.com/rss/news.rss' },
    { name: 'ZeroHedge',      url: 'https://feeds.feedburner.com/zerohedge/feed' },
  ],
} as const;

export const PRICE_POLL_INTERVAL_MS = 2000;
export const NEWS_POLL_INTERVAL_MS = 60_000;
export const PRICE_BACKOFF_MS = [5000, 10_000, 30_000, 60_000];
export const NEWS_MAX_ITEMS = 100;
export const NEWS_RECENT_WINDOW_MS = 30 * 60 * 1000;

export const LLM_SYSTEM_PROMPT = `あなたは日経先物トレーダー向けの市場分析アシスタントです。日本語で1〜2文、結論先出しで簡潔に答えてください。該当しそうなニュースがなければ「明確な材料なし」と返してください。`;

export const LLM_MODEL = 'gpt-4o-mini';
```

- [ ] **Step 3: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: コミット**

```bash
git add server/types.ts server/config.ts
git commit -m "feat(server): add shared types and config (instruments, RSS feeds, thresholds)"
```

---

## Task 3: Yahoo Finance データソース

**Files:**
- Create: `server/sources/yahooFinance.ts`

- [ ] **Step 1: 実装**

Create `server/sources/yahooFinance.ts`:
```ts
import yahooFinance from 'yahoo-finance2';
import type { Price, Symbol } from '../types.js';
import { INSTRUMENTS } from '../config.js';

// yahoo-finance2 のサバイバル設定: ログ抑制と通知無効化
yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']);

export async function fetchYahooPrices(): Promise<Price[]> {
  const symbols = INSTRUMENTS.map(i => i.symbol);
  const quotes = await yahooFinance.quote(symbols);
  const list = Array.isArray(quotes) ? quotes : [quotes];

  return list
    .filter(q => typeof q.regularMarketPrice === 'number')
    .map(q => ({
      symbol: q.symbol as Symbol,
      price: q.regularMarketPrice as number,
      changePercent: q.regularMarketChangePercent ?? 0,
      timestamp: (q.regularMarketTime instanceof Date
        ? q.regularMarketTime.getTime()
        : Date.now()),
      stale: false,
    }));
}
```

- [ ] **Step 2: 手動疎通テスト用スクリプト追加（dev-only、コミット対象外）**

Create temporary `scratch/test-yahoo.ts`:
```ts
import { fetchYahooPrices } from '../server/sources/yahooFinance.js';
fetchYahooPrices().then(r => console.log(JSON.stringify(r, null, 2))).catch(console.error);
```

Run: `npx tsx scratch/test-yahoo.ts`
Expected: 8銘柄分のJSON出力（一部欠ける可能性あり、ネットワーク次第）

- [ ] **Step 3: 一時スクリプト削除**

Run: `rm -rf scratch`

- [ ] **Step 4: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 5: コミット**

```bash
git add server/sources/yahooFinance.ts
git commit -m "feat(server): add Yahoo Finance source for bulk quote fetch"
```

---

## Task 4: Investing.com スクレイピング（フォールバック）

**Files:**
- Create: `server/sources/investingScrape.ts`

- [ ] **Step 1: 実装**

Create `server/sources/investingScrape.ts`:
```ts
import * as cheerio from 'cheerio';
import type { Price, Symbol } from '../types.js';

const INVESTING_URLS: Partial<Record<Symbol, string>> = {
  'NK=F':  'https://www.investing.com/indices/japan-225-futures',
  'NQ=F':  'https://www.investing.com/indices/nq-100-futures',
  'YM=F':  'https://www.investing.com/indices/us-30-futures',
  'ES=F':  'https://www.investing.com/indices/us-spx-500-futures',
  'JPY=X': 'https://www.investing.com/currencies/usd-jpy',
  'CL=F':  'https://www.investing.com/commodities/crude-oil',
  '^VIX':  'https://www.investing.com/indices/volatility-s-p-500',
  '^TNX':  'https://www.investing.com/rates-bonds/u.s.-10-year-bond-yield',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FinanceMonitor/0.1',
  'Accept': 'text/html',
};

async function scrapeOne(symbol: Symbol): Promise<Price | null> {
  const url = INVESTING_URLS[symbol];
  if (!url) return null;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) return null;
  const html = await res.text();
  const $ = cheerio.load(html);
  const priceText = $('[data-test="instrument-price-last"]').first().text().replace(/,/g, '');
  const changePctText = $('[data-test="instrument-price-change-percent"]').first().text()
    .replace(/[%()+]/g, '').trim();
  const price = parseFloat(priceText);
  const changePercent = parseFloat(changePctText);
  if (!Number.isFinite(price)) return null;
  return {
    symbol,
    price,
    changePercent: Number.isFinite(changePercent) ? changePercent : 0,
    timestamp: Date.now(),
    stale: true,
  };
}

export async function fetchInvestingPrices(symbols: Symbol[]): Promise<Price[]> {
  const results = await Promise.allSettled(symbols.map(scrapeOne));
  return results.flatMap(r =>
    r.status === 'fulfilled' && r.value ? [r.value] : []
  );
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/sources/investingScrape.ts
git commit -m "feat(server): add Investing.com scrape fallback for prices"
```

---

## Task 5: RSS集約

**Files:**
- Create: `server/sources/rssAggregator.ts`

- [ ] **Step 1: 実装**

Create `server/sources/rssAggregator.ts`:
```ts
import Parser from 'rss-parser';
import type { NewsItem } from '../types.js';
import { RSS_FEEDS, NEWS_MAX_ITEMS } from '../config.js';

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'FinanceMonitor/0.1' },
});

async function fetchFeed(name: string, url: string, lang: 'ja' | 'en'): Promise<NewsItem[]> {
  const feed = await parser.parseURL(url);
  return (feed.items ?? []).flatMap(item => {
    const published = item.isoDate ? Date.parse(item.isoDate) : Date.now();
    if (!item.title || !item.link) return [];
    return [{
      id: `${name}:${item.guid ?? item.link}`,
      title: item.title,
      source: name,
      lang,
      url: item.link,
      publishedAt: published,
    }];
  });
}

export async function fetchAllNews(): Promise<NewsItem[]> {
  const tasks: Promise<NewsItem[]>[] = [];
  for (const f of RSS_FEEDS.ja) tasks.push(fetchFeed(f.name, f.url, 'ja'));
  for (const f of RSS_FEEDS.en) tasks.push(fetchFeed(f.name, f.url, 'en'));
  const results = await Promise.allSettled(tasks);
  const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  return items
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, NEWS_MAX_ITEMS);
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/sources/rssAggregator.ts
git commit -m "feat(server): add RSS aggregator (10 feeds, parallel allSettled)"
```

---

## Task 6: SSE Broker

**Files:**
- Create: `server/sse/broker.ts`
- Create: `server/cache.ts`

- [ ] **Step 1: 最新値キャッシュ**

Create `server/cache.ts`:
```ts
import type { Price, NewsItem } from './types.js';

let latestPrices: Price[] = [];
let latestNews: NewsItem[] = [];

export function setPrices(p: Price[]) { latestPrices = p; }
export function getPrices(): Price[] { return latestPrices; }
export function setNews(n: NewsItem[]) { latestNews = n; }
export function getNews(): NewsItem[] { return latestNews; }
```

- [ ] **Step 2: SSE Broker**

Create `server/sse/broker.ts`:
```ts
import type { Response } from 'express';
import type { SSEEvent } from '../types.js';

const clients = new Set<Response>();

export function register(res: Response): void {
  clients.add(res);
}

export function unregister(res: Response): void {
  clients.delete(res);
}

export function broadcast(event: SSEEvent): void {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

export function clientCount(): number {
  return clients.size;
}
```

- [ ] **Step 3: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 4: コミット**

```bash
git add server/sse/broker.ts server/cache.ts
git commit -m "feat(server): add SSE broker + latest-value cache"
```

---

## Task 7: Price Loop（バックオフ付き）

**Files:**
- Create: `server/loops/priceLoop.ts`

- [ ] **Step 1: 実装**

Create `server/loops/priceLoop.ts`:
```ts
import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchInvestingPrices } from '../sources/investingScrape.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_POLL_INTERVAL_MS, PRICE_BACKOFF_MS } from '../config.js';
import type { Price, Symbol } from '../types.js';

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;

function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

async function tick(): Promise<number> {
  try {
    let prices = await fetchYahooPrices();

    const missing = INSTRUMENTS
      .map(i => i.symbol)
      .filter(s => !prices.find(p => p.symbol === s));
    if (missing.length > 0) {
      const fallback = await fetchInvestingPrices(missing);
      prices = [...prices, ...fallback];
    }

    if (prices.length === 0) throw new Error('No prices fetched');

    const merged = mergeWithCached(prices);
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    backoffIndex = -1;
    return PRICE_POLL_INTERVAL_MS;
  } catch (err) {
    backoffIndex = Math.min(backoffIndex + 1, PRICE_BACKOFF_MS.length - 1);
    const wait = PRICE_BACKOFF_MS[backoffIndex] ?? PRICE_POLL_INTERVAL_MS;
    console.error(`[priceLoop] error, backing off ${wait}ms:`, err instanceof Error ? err.message : err);
    return wait;
  }
}

export function startPriceLoop(): void {
  const schedule = async () => {
    const wait = await tick();
    timer = setTimeout(schedule, wait);
  };
  void schedule();
}

export function stopPriceLoop(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/loops/priceLoop.ts
git commit -m "feat(server): add price loop with Investing.com fallback and exponential backoff"
```

---

## Task 8: News Loop

**Files:**
- Create: `server/loops/newsLoop.ts`

- [ ] **Step 1: 実装**

Create `server/loops/newsLoop.ts`:
```ts
import { fetchAllNews } from '../sources/rssAggregator.js';
import { broadcast } from '../sse/broker.js';
import { setNews } from '../cache.js';
import { NEWS_POLL_INTERVAL_MS } from '../config.js';

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    const news = await fetchAllNews();
    setNews(news);
    broadcast({ type: 'news', payload: news });
  } catch (err) {
    console.error('[newsLoop] error:', err instanceof Error ? err.message : err);
  }
}

export function startNewsLoop(): void {
  const schedule = async () => {
    await tick();
    timer = setTimeout(schedule, NEWS_POLL_INTERVAL_MS);
  };
  void schedule();
}

export function stopNewsLoop(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}
```

- [ ] **Step 2: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add server/loops/newsLoop.ts
git commit -m "feat(server): add news loop (60s RSS aggregation)"
```

---

## Task 9: OpenAI LLM モジュール

**Files:**
- Create: `server/llm/openai.ts`

- [ ] **Step 1: 実装**

Create `server/llm/openai.ts`:
```ts
import OpenAI from 'openai';
import type { NewsItem } from '../types.js';
import { LLM_MODEL, LLM_SYSTEM_PROMPT, NEWS_RECENT_WINDOW_MS } from '../config.js';

const apiKey = process.env.OPENAI_API_KEY;
const client = apiKey ? new OpenAI({ apiKey }) : null;

export function isLLMEnabled(): boolean { return client !== null; }

export interface ExplainInput {
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: 'magnitude' | 'slope';
  news: NewsItem[];
}

function formatNewsForPrompt(news: NewsItem[]): string {
  const cutoff = Date.now() - NEWS_RECENT_WINDOW_MS;
  return news
    .filter(n => n.publishedAt >= cutoff)
    .slice(0, 20)
    .map(n => {
      const t = new Date(n.publishedAt).toISOString().slice(11, 16);
      return `- [${t}] [${n.source}] ${n.title}`;
    })
    .join('\n');
}

export async function explain(input: ExplainInput): Promise<string> {
  if (!client) return '(LLM disabled — OPENAI_API_KEY 未設定)';

  const kindLabel = input.detectionKind === 'slope' ? 'フラッシュ' : 'トレンド';
  const userPrompt =
    `【急変・${kindLabel}】${input.symbolLabel} が ${input.windowSeconds}秒で ${input.changePercent.toFixed(2)}% 動きました。\n` +
    `【関連ニュース直近30分】\n${formatNewsForPrompt(input.news) || '(なし)'}\n\n` +
    `この値動きの最も可能性の高い理由を1〜2文で説明してください。`;

  const completion = await client.chat.completions.create({
    model: LLM_MODEL,
    temperature: 0.3,
    max_tokens: 150,
    messages: [
      { role: 'system', content: LLM_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });
  return completion.choices[0]?.message?.content?.trim() ?? '(no response)';
}
```

- [ ] **Step 2: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add server/llm/openai.ts
git commit -m "feat(server): add OpenAI explain module (degrades gracefully without API key)"
```

---

## Task 10: HTTP ルートと Express bootstrap

**Files:**
- Create: `server/routes/stream.ts`
- Create: `server/routes/explain.ts`
- Create: `server/index.ts`

- [ ] **Step 1: stream ルート**

Create `server/routes/stream.ts`:
```ts
import type { Request, Response } from 'express';
import { register, unregister } from '../sse/broker.js';
import { getPrices, getNews } from '../cache.js';

export function streamHandler(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 接続直後に最新値を一回送る
  const prices = getPrices();
  if (prices.length > 0) {
    res.write(`event: prices\ndata: ${JSON.stringify(prices)}\n\n`);
  }
  const news = getNews();
  if (news.length > 0) {
    res.write(`event: news\ndata: ${JSON.stringify(news)}\n\n`);
  }

  register(res);
  req.on('close', () => unregister(res));
}
```

- [ ] **Step 2: explain ルート**

Create `server/routes/explain.ts`:
```ts
import type { Request, Response } from 'express';
import { explain } from '../llm/openai.js';
import { getNews } from '../cache.js';

interface ExplainBody {
  symbolLabel?: string;
  changePercent?: number;
  windowSeconds?: number;
  detectionKind?: 'magnitude' | 'slope';
}

export async function explainHandler(req: Request, res: Response): Promise<void> {
  const body = req.body as ExplainBody;
  if (typeof body.symbolLabel !== 'string'
      || typeof body.changePercent !== 'number'
      || typeof body.windowSeconds !== 'number'
      || (body.detectionKind !== 'magnitude' && body.detectionKind !== 'slope')) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  try {
    const text = await explain({
      symbolLabel: body.symbolLabel,
      changePercent: body.changePercent,
      windowSeconds: body.windowSeconds,
      detectionKind: body.detectionKind,
      news: getNews(),
    });
    res.json({ explanation: text });
  } catch (err) {
    console.error('[explain] error:', err);
    res.status(500).json({ explanation: '(説明取得失敗)' });
  }
}
```

- [ ] **Step 3: Express bootstrap**

Create `server/index.ts`:
```ts
import express from 'express';
import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';

const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.use(express.json());
app.get('/api/stream', streamHandler);
app.post('/api/explain', explainHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled() }));

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});
```

- [ ] **Step 4: dotenv読み込みのため起動コマンド修正**

Edit `package.json` の `dev:server` を以下に変更:
```json
"dev:server": "tsx watch --env-file=.env server/index.ts",
```

- [ ] **Step 5: .env を作成（空でOK）**

Run:
```bash
cp .env.example .env
```

- [ ] **Step 6: サーバ起動確認**

Run (別ターミナルで): `npm run dev:server`
Expected log: `[server] listening on http://localhost:3000 (LLM disabled)` および数秒後に `[priceLoop]` のエラーがなければOK。

Run: `curl http://localhost:3000/api/health`
Expected: `{"ok":true,"llm":false}`

サーバ停止: Ctrl+C

- [ ] **Step 7: コミット**

```bash
git add server/routes/ server/index.ts package.json .env.example
git commit -m "feat(server): wire up Express with /api/stream, /api/explain, /api/health"
```

---

## Task 11: フロントエンド HTML + CSS

**Files:**
- Create: `web/index.html`
- Create: `web/styles.css`

- [ ] **Step 1: HTML骨格**

Create `web/index.html`:
```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <title>Finance Monitor</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <header class="topbar">
    <h1>Finance Monitor</h1>
    <div class="status">
      <span id="clock"></span>
      <span id="connection-status" class="badge offline">offline</span>
    </div>
  </header>

  <main>
    <section id="alert-banner" class="alert-banner"></section>

    <div class="main-grid">
      <section id="price-grid" class="price-grid"></section>
      <aside id="news-feed" class="news-feed">
        <h2>News</h2>
        <ul id="news-list"></ul>
      </aside>
    </div>
  </main>

  <button id="enable-sound" class="enable-sound">🔔 サウンドを有効化</button>

  <script type="module" src="./main.ts"></script>
</body>
</html>
```

- [ ] **Step 2: CSS（ダークテーマ + アラートアニメ）**

Create `web/styles.css`:
```css
:root {
  --bg: #0d1117;
  --panel: #161b22;
  --border: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --up: #3fb950;
  --down: #f85149;
  --flash-up: rgba(63, 185, 80, 0.4);
  --flash-down: rgba(248, 81, 73, 0.4);
}

* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Segoe UI', 'Hiragino Sans', sans-serif;
  background: var(--bg);
  color: var(--text);
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
}
.topbar h1 { font-size: 18px; margin: 0; }
.status { display: flex; gap: 12px; align-items: center; }
.badge {
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
}
.badge.online { background: var(--up); color: black; }
.badge.offline { background: var(--down); color: white; }

.alert-banner {
  padding: 0 20px;
}
.alert {
  background: var(--panel);
  border-left: 4px solid var(--down);
  border-radius: 4px;
  margin: 8px 0;
  padding: 10px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.alert.up { border-left-color: var(--up); }
.alert .close { cursor: pointer; color: var(--muted); background: none; border: none; font-size: 18px; }

.main-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  padding: 16px 20px;
}

.price-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.price-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 14px 16px;
  min-height: 100px;
}
.price-card .label { color: var(--muted); font-size: 13px; }
.price-card .price { font-size: 24px; font-weight: 600; margin: 6px 0; }
.price-card .change { font-size: 14px; }
.price-card.up .price, .price-card.up .change { color: var(--up); }
.price-card.down .price, .price-card.down .change { color: var(--down); }
.price-card.stale { opacity: 0.6; }
.price-card.flash-up { animation: flashUp 500ms 2; }
.price-card.flash-down { animation: flashDown 500ms 2; }

@keyframes flashUp {
  0%, 100% { background: var(--panel); }
  50% { background: var(--flash-up); }
}
@keyframes flashDown {
  0%, 100% { background: var(--panel); }
  50% { background: var(--flash-down); }
}

.news-feed {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  max-height: 80vh;
  overflow-y: auto;
}
.news-feed h2 { font-size: 14px; margin: 0 0 8px; color: var(--muted); }
.news-feed ul { list-style: none; padding: 0; margin: 0; }
.news-feed li { padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.news-feed li .meta { color: var(--muted); font-size: 11px; }
.news-feed li a { color: var(--text); text-decoration: none; }
.news-feed li a:hover { text-decoration: underline; }

.enable-sound {
  position: fixed;
  bottom: 20px;
  right: 20px;
  padding: 10px 16px;
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}
.enable-sound.hidden { display: none; }
```

- [ ] **Step 3: コミット**

```bash
git add web/index.html web/styles.css
git commit -m "feat(web): add HTML scaffold and dark theme CSS with alert flash animation"
```

---

## Task 12: 共有型と i18n

**Files:**
- Create: `web/types.ts`
- Create: `web/lib/i18n.ts`

- [ ] **Step 1: web 側の型を server と整合**

Create `web/types.ts`:
```ts
export type { Symbol, Price, NewsItem, InstrumentMeta, SSEEvent } from '../server/types.js';

export type DetectionKind = 'magnitude' | 'slope';

export interface AlertEvent {
  symbol: string;
  symbolLabel: string;
  changePercent: number;
  windowSeconds: number;
  detectionKind: DetectionKind;
  direction: 'up' | 'down';
  triggeredAt: number;
}
```

- [ ] **Step 2: i18n ラベル**

Create `web/lib/i18n.ts`:
```ts
import { INSTRUMENTS } from '../../server/config.js';
import type { Symbol } from '../types.js';

const LABEL_MAP = new Map(INSTRUMENTS.map(i => [i.symbol, i]));

export function labelOf(symbol: Symbol): string {
  return LABEL_MAP.get(symbol)?.labelJa ?? symbol;
}

export function metaOf(symbol: Symbol) {
  return LABEL_MAP.get(symbol);
}

export const UI = {
  ja: {
    news: 'ニュース',
    connecting: '接続中…',
    online: '受信中',
    offline: '切断',
    explanationLoading: '(説明取得中…)',
    explanationFailed: '(説明取得失敗)',
    flash: 'フラッシュ',
    trend: 'トレンド',
    enableSound: '🔔 サウンドを有効化',
  },
};
```

- [ ] **Step 3: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add web/types.ts web/lib/i18n.ts
git commit -m "feat(web): add shared types and Japanese i18n labels"
```

---

## Task 13: changeDetector（TDD）

**Files:**
- Create: `web/lib/changeDetector.ts`
- Create: `web/lib/changeDetector.test.ts`

- [ ] **Step 1: テストファイル作成（失敗するテストを書く）**

Create `web/lib/changeDetector.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { ChangeDetector } from './changeDetector.js';
import type { Price, InstrumentMeta } from '../types.js';

const NK_META: InstrumentMeta = {
  symbol: 'NK=F', labelJa: '日経225', labelEn: 'Nikkei',
  magnitudeThreshold: 0.30, slopeThreshold: 0.10, unit: 'percent',
};

function makePrice(symbol: any, price: number, tMs: number): Price {
  return { symbol, price, changePercent: 0, timestamp: tMs, stale: false };
}

describe('ChangeDetector', () => {
  it('returns empty array when buffer too small (single sample)', () => {
    const d = new ChangeDetector([NK_META]);
    expect(d.feed(makePrice('NK=F', 38000, 0))).toEqual([]);
  });

  it('fires slope alert when 30s move >= threshold', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    const alerts = d.feed(makePrice('NK=F', 38000 * (1 - 0.0011), 25_000));
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.detectionKind).toBe('slope');
    expect(alerts[0]?.direction).toBe('down');
  });

  it('fires magnitude alert when 5min move >= threshold but slope didnt', () => {
    const d = new ChangeDetector([NK_META]);
    // 段階的に動かして傾き閾値に達さず、5分窓だけ超える
    d.feed(makePrice('NK=F', 38000, 0));
    d.feed(makePrice('NK=F', 38000 * 1.001, 60_000));    // +0.1% / 1min  → 30sでは超えない
    d.feed(makePrice('NK=F', 38000 * 1.002, 120_000));   // 累積+0.2%
    const alerts = d.feed(makePrice('NK=F', 38000 * 1.0031, 240_000));
    expect(alerts.length).toBe(1);
    expect(alerts[0]?.detectionKind).toBe('magnitude');
  });

  it('does not fire when both within threshold', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    expect(d.feed(makePrice('NK=F', 38010, 10_000))).toEqual([]); // +0.026%
  });

  it('does not double-fire within cooldown', () => {
    const d = new ChangeDetector([NK_META], { cooldownMs: 60_000 });
    d.feed(makePrice('NK=F', 38000, 0));
    d.feed(makePrice('NK=F', 38000 * 0.9985, 20_000)); // -0.15% / 20s → slope発火
    const second = d.feed(makePrice('NK=F', 38000 * 0.998, 30_000));
    expect(second).toEqual([]);
  });

  it('drops samples older than the 5-minute window', () => {
    const d = new ChangeDetector([NK_META]);
    d.feed(makePrice('NK=F', 38000, 0));
    // 6分後に来た同じ値は、古いサンプルが破棄され閾値判定の基準にならない
    const alerts = d.feed(makePrice('NK=F', 38000 * 0.997, 6 * 60 * 1000));
    expect(alerts).toEqual([]);
  });
});
```

- [ ] **Step 2: テスト実行（失敗確認）**

Run: `npm test`
Expected: `ChangeDetector` 関連が全て失敗（`Cannot find module './changeDetector.js'`）

- [ ] **Step 3: 最小実装**

Create `web/lib/changeDetector.ts`:
```ts
import type { Price, Symbol, InstrumentMeta } from '../types.js';
import type { AlertEvent, DetectionKind } from '../types.js';

interface Sample { t: number; price: number; }

const MAGNITUDE_WINDOW_MS = 5 * 60 * 1000;
const SLOPE_WINDOW_MS = 30 * 1000;
const DEFAULT_COOLDOWN_MS = 60 * 1000;

interface State {
  meta: InstrumentMeta;
  buffer: Sample[];          // 時系列順、最大5分
  lastAlertAt: number;
}

export interface DetectorOptions {
  cooldownMs?: number;
}

export class ChangeDetector {
  private states: Map<Symbol, State>;
  private cooldownMs: number;

  constructor(instruments: InstrumentMeta[], opts: DetectorOptions = {}) {
    this.states = new Map(
      instruments.map(meta => [meta.symbol, { meta, buffer: [], lastAlertAt: 0 }])
    );
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  feed(price: Price): AlertEvent[] {
    const state = this.states.get(price.symbol);
    if (!state) return [];

    state.buffer.push({ t: price.timestamp, price: price.price });

    // 古いサンプルを破棄
    const cutoff = price.timestamp - MAGNITUDE_WINDOW_MS;
    while (state.buffer.length > 0 && (state.buffer[0]?.t ?? 0) < cutoff) {
      state.buffer.shift();
    }
    if (state.buffer.length < 2) return [];

    // クールダウン中は判定スキップ
    if (price.timestamp - state.lastAlertAt < this.cooldownMs) return [];

    // 傾き判定（30秒窓の最古値と比較）
    const slopeCutoff = price.timestamp - SLOPE_WINDOW_MS;
    const slopeBase = state.buffer.find(s => s.t >= slopeCutoff);
    if (slopeBase && slopeBase !== state.buffer[state.buffer.length - 1]) {
      const pct = pctChange(slopeBase.price, price.price);
      const window = (price.timestamp - slopeBase.t) / 1000;
      if (Math.abs(pct) >= state.meta.slopeThreshold) {
        return [this.fireAlert(state, price, pct, window, 'slope')];
      }
    }

    // 変動幅判定（5分窓の最古値と比較）
    const magBase = state.buffer[0];
    if (magBase && magBase !== state.buffer[state.buffer.length - 1]) {
      const pct = pctChange(magBase.price, price.price);
      const window = (price.timestamp - magBase.t) / 1000;
      if (Math.abs(pct) >= state.meta.magnitudeThreshold) {
        return [this.fireAlert(state, price, pct, window, 'magnitude')];
      }
    }

    return [];
  }

  private fireAlert(
    state: State, price: Price, pct: number, windowSec: number, kind: DetectionKind
  ): AlertEvent {
    state.lastAlertAt = price.timestamp;
    return {
      symbol: state.meta.symbol,
      symbolLabel: state.meta.labelJa,
      changePercent: pct,
      windowSeconds: Math.round(windowSec),
      detectionKind: kind,
      direction: pct >= 0 ? 'up' : 'down',
      triggeredAt: price.timestamp,
    };
  }
}

function pctChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}
```

- [ ] **Step 4: テスト実行（パス確認）**

Run: `npm test`
Expected: 全6テストPASS

- [ ] **Step 5: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add web/lib/changeDetector.ts web/lib/changeDetector.test.ts
git commit -m "feat(web): add changeDetector with hybrid magnitude+slope detection and cooldown"
```

---

## Task 14: SSEクライアントラッパー + APIヘルパー

**Files:**
- Create: `web/lib/stream.ts`
- Create: `web/lib/api.ts`

- [ ] **Step 1: EventSourceラッパー**

Create `web/lib/stream.ts`:
```ts
import type { Price, NewsItem } from '../types.js';

interface StreamHandlers {
  onPrices: (prices: Price[]) => void;
  onNews: (news: NewsItem[]) => void;
  onStatusChange: (status: 'connecting' | 'online' | 'offline') => void;
}

export function connectStream(handlers: StreamHandlers): () => void {
  let es: EventSource | null = null;
  let closed = false;

  function open() {
    if (closed) return;
    handlers.onStatusChange('connecting');
    es = new EventSource('/api/stream');

    es.addEventListener('open', () => handlers.onStatusChange('online'));

    es.addEventListener('prices', (e) => {
      try { handlers.onPrices(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse prices', err); }
    });

    es.addEventListener('news', (e) => {
      try { handlers.onNews(JSON.parse((e as MessageEvent).data)); }
      catch (err) { console.error('parse news', err); }
    });

    es.addEventListener('error', () => {
      handlers.onStatusChange('offline');
      es?.close();
      es = null;
      // EventSource はブラウザが自動再接続するが、close 後は手動で再オープン
      if (!closed) setTimeout(open, 3000);
    });
  }

  open();
  return () => { closed = true; es?.close(); };
}
```

- [ ] **Step 2: explain呼び出し**

Create `web/lib/api.ts`:
```ts
import type { AlertEvent } from '../types.js';

export async function fetchExplanation(alert: AlertEvent): Promise<string> {
  const res = await fetch('/api/explain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbolLabel: alert.symbolLabel,
      changePercent: alert.changePercent,
      windowSeconds: alert.windowSeconds,
      detectionKind: alert.detectionKind,
    }),
  });
  if (!res.ok) throw new Error(`explain ${res.status}`);
  const data = (await res.json()) as { explanation: string };
  return data.explanation;
}
```

- [ ] **Step 3: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add web/lib/stream.ts web/lib/api.ts
git commit -m "feat(web): add EventSource wrapper with auto-reconnect and explain API client"
```

---

## Task 15: UIコンポーネント

**Files:**
- Create: `web/components/priceGrid.ts`
- Create: `web/components/newsFeed.ts`
- Create: `web/components/alertBanner.ts`
- Create: `web/components/soundPlayer.ts`

- [ ] **Step 1: 価格グリッド**

Create `web/components/priceGrid.ts`:
```ts
import type { Price, AlertEvent } from '../types.js';
import { INSTRUMENTS } from '../../server/config.js';

export function renderPriceGrid(container: HTMLElement, prices: Price[]): void {
  const priceMap = new Map(prices.map(p => [p.symbol, p]));
  container.innerHTML = '';
  for (const meta of INSTRUMENTS) {
    const p = priceMap.get(meta.symbol);
    const card = document.createElement('div');
    card.className = 'price-card';
    card.dataset.symbol = meta.symbol;
    if (p) {
      const dir = p.changePercent >= 0 ? 'up' : 'down';
      card.classList.add(dir);
      if (p.stale) card.classList.add('stale');
      const unit = meta.unit === 'bp' ? '' : '';
      card.innerHTML = `
        <div class="label">${meta.labelJa}</div>
        <div class="price">${p.price.toFixed(meta.unit === 'bp' ? 3 : 2)}${unit}</div>
        <div class="change">${p.changePercent >= 0 ? '+' : ''}${p.changePercent.toFixed(2)}%</div>
      `;
    } else {
      card.innerHTML = `<div class="label">${meta.labelJa}</div><div class="price">---</div>`;
    }
    container.appendChild(card);
  }
  // 8銘柄で3×3、最後1枠空き
  const filler = document.createElement('div');
  filler.style.visibility = 'hidden';
  container.appendChild(filler);
}

export function flashCard(container: HTMLElement, alert: AlertEvent): void {
  const card = container.querySelector(`[data-symbol="${alert.symbol}"]`);
  if (!(card instanceof HTMLElement)) return;
  const cls = alert.direction === 'up' ? 'flash-up' : 'flash-down';
  card.classList.remove('flash-up', 'flash-down');
  void card.offsetWidth; // reflow でアニメ再実行
  card.classList.add(cls);
}
```

- [ ] **Step 2: ニュースフィード**

Create `web/components/newsFeed.ts`:
```ts
import type { NewsItem } from '../types.js';

export function renderNews(listEl: HTMLElement, items: NewsItem[]): void {
  listEl.innerHTML = '';
  for (const n of items.slice(0, 50)) {
    const li = document.createElement('li');
    const t = new Date(n.publishedAt);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    li.innerHTML = `
      <div class="meta">[${n.lang.toUpperCase()}] ${n.source} ${time}</div>
      <a href="${n.url}" target="_blank" rel="noopener">${escapeHtml(n.title)}</a>
    `;
    listEl.appendChild(li);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}
```

- [ ] **Step 3: アラートバナー**

Create `web/components/alertBanner.ts`:
```ts
import type { AlertEvent } from '../types.js';
import { UI } from '../lib/i18n.js';

interface BannerItem {
  alert: AlertEvent;
  el: HTMLElement;
  explanationEl: HTMLElement;
}

const items = new Map<string, BannerItem>();
const MAX_BANNERS = 5;
const AUTO_DISMISS_MS = 5 * 60 * 1000;

export function addBanner(container: HTMLElement, alert: AlertEvent): BannerItem {
  const id = `${alert.symbol}-${alert.triggeredAt}`;
  if (items.has(id)) return items.get(id)!;

  const el = document.createElement('div');
  el.className = `alert ${alert.direction}`;
  const kindLabel = alert.detectionKind === 'slope' ? UI.ja.flash : UI.ja.trend;
  const arrow = alert.direction === 'up' ? '▲' : '▼';
  const main = document.createElement('div');
  main.innerHTML =
    `<strong>⚡ ${alert.symbolLabel}</strong> ` +
    `${arrow} ${alert.changePercent.toFixed(2)}% / ${alert.windowSeconds}秒 ` +
    `<span style="color:#8b949e">[${kindLabel}]</span> ` +
    `| <span class="explanation">${UI.ja.explanationLoading}</span>`;
  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '✕';
  close.onclick = () => removeBanner(id);
  el.appendChild(main);
  el.appendChild(close);
  container.prepend(el);

  const item: BannerItem = {
    alert,
    el,
    explanationEl: main.querySelector('.explanation') as HTMLElement,
  };
  items.set(id, item);

  // 上限超え時は古いものを削除
  if (items.size > MAX_BANNERS) {
    const oldest = [...items.keys()][0];
    if (oldest) removeBanner(oldest);
  }

  setTimeout(() => removeBanner(id), AUTO_DISMISS_MS);
  return item;
}

export function setExplanation(item: BannerItem, text: string): void {
  item.explanationEl.textContent = text;
}

function removeBanner(id: string): void {
  const item = items.get(id);
  if (!item) return;
  item.el.remove();
  items.delete(id);
}
```

- [ ] **Step 4: サウンドプレイヤー**

Create `web/components/soundPlayer.ts`:
```ts
let ctx: AudioContext | null = null;

export function enableSound(): void {
  if (ctx) return;
  ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
}

export function beep(freq = 880, durationMs = 200): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}

export function alertBeep(direction: 'up' | 'down'): void {
  beep(direction === 'up' ? 1046 : 659, 300);
}
```

- [ ] **Step 5: 型チェック + コミット**

Run: `npm run typecheck`

```bash
git add web/components/
git commit -m "feat(web): add price grid, news feed, alert banner, and sound player components"
```

---

## Task 16: main.ts 配線と統合動作確認

**Files:**
- Create: `web/main.ts`
- Modify: `README.md`

- [ ] **Step 1: エントリ配線**

Create `web/main.ts`:
```ts
import { INSTRUMENTS } from '../server/config.js';
import { ChangeDetector } from './lib/changeDetector.js';
import { connectStream } from './lib/stream.js';
import { fetchExplanation } from './lib/api.js';
import { renderPriceGrid, flashCard } from './components/priceGrid.js';
import { renderNews } from './components/newsFeed.js';
import { addBanner, setExplanation } from './components/alertBanner.js';
import { enableSound, alertBeep } from './components/soundPlayer.js';
import { UI } from './lib/i18n.js';

const detector = new ChangeDetector(INSTRUMENTS);

const priceGridEl = document.getElementById('price-grid')!;
const newsListEl = document.getElementById('news-list')!;
const bannerEl = document.getElementById('alert-banner')!;
const statusEl = document.getElementById('connection-status')!;
const clockEl = document.getElementById('clock')!;
const enableSoundBtn = document.getElementById('enable-sound') as HTMLButtonElement;

setInterval(() => {
  const d = new Date();
  clockEl.textContent = `JST ${d.toLocaleTimeString('ja-JP', { hour12: false })}`;
}, 1000);

enableSoundBtn.onclick = () => {
  enableSound();
  enableSoundBtn.classList.add('hidden');
};

function setStatus(status: 'connecting' | 'online' | 'offline') {
  statusEl.classList.remove('online', 'offline');
  if (status === 'online') {
    statusEl.textContent = UI.ja.online;
    statusEl.classList.add('online');
  } else {
    statusEl.textContent = status === 'connecting' ? UI.ja.connecting : UI.ja.offline;
    statusEl.classList.add('offline');
  }
}

connectStream({
  onStatusChange: setStatus,
  onPrices: (prices) => {
    renderPriceGrid(priceGridEl, prices);
    for (const p of prices) {
      const alerts = detector.feed(p);
      for (const alert of alerts) {
        flashCard(priceGridEl, alert);
        alertBeep(alert.direction);
        const banner = addBanner(bannerEl, alert);
        fetchExplanation(alert)
          .then(text => setExplanation(banner, text))
          .catch(() => setExplanation(banner, UI.ja.explanationFailed));
      }
    }
  },
  onNews: (news) => renderNews(newsListEl, news),
});
```

- [ ] **Step 2: README に手動テスト手順を追記**

Append to `README.md`:
```markdown

## 手動テスト手順

1. `npm run dev` 起動
2. http://localhost:5173 を開く
3. 右上のステータスが「受信中」になる
4. 8枚のカードに価格が表示される（数秒以内）
5. 「🔔 サウンドを有効化」をクリック → ボタンが消える
6. ニュースフィードに10ソースの記事が並ぶ
7. DevTools → Network → `/api/stream` を見て、EventSource 接続が `prices` イベントを継続受信していることを確認
8. アラート発火テスト: `web/lib/changeDetector.ts` の閾値を一時的に `0.001` に下げてリロード → 価格更新ごとにビープ + ハイライトが出る
9. LLM動作テスト: `.env` に `OPENAI_API_KEY` を設定 → 上記アラート時にバナーに日本語説明が追記される
10. 切断テスト: サーバを Ctrl+C で止める → ステータスが「切断」に変わる → 再起動で「受信中」へ復帰

## 既知の制限

- Yahoo Finance はレート制限・cookie要件の変化に弱い。`yahoo-finance2` がエラーを返した場合、Investing.com スクレイピングへフォールバック。両方失敗時はその銘柄が `---` 表示
- 米10年債は `^TNX` の小数点位置に注意（4.35 = 4.35%）
- 銘柄追加・閾値変更は `server/config.ts` を編集（UI からの変更は v0.1 では非対応）
```

- [ ] **Step 3: 全テスト + 型チェック**

Run: `npm test && npm run typecheck`
Expected: テスト全PASS、型エラーなし

- [ ] **Step 4: 統合動作確認**

Run: `npm run dev`
Expected:
- ターミナル: `[server] listening on http://localhost:3000` と `VITE v5.x ready`
- ブラウザで http://localhost:5173 を開いて上記「手動テスト手順」1〜7まで完走

確認後 Ctrl+C で停止。

- [ ] **Step 5: コミット**

```bash
git add web/main.ts README.md
git commit -m "feat(web): wire main entry with SSE, alerts, sound, and add manual test guide"
```

---

## Task 17: 最終チェックリスト

- [ ] **Step 1: package-lock.json をコミット**

```bash
git add package-lock.json
git commit -m "chore: lock dependencies"
```

- [ ] **Step 2: 全成功判定の手動確認**

仕様 `docs/superpowers/specs/2026-05-28-finance-monitor-design.md` の Section 12 を一項目ずつ確認:

1. ☐ `npm install && npm run dev` で localhost:5173 が起動し、8銘柄の価格が表示される
2. ☐ SSE経由で価格が約2秒ごとにブラウザに到達する（DevToolsの Network → /api/stream で確認）
3. ☐ 日英ニュースが10ソースから集約表示される（60秒ごとに更新）
4. ☐ 日経225先物が ±0.30%/5分（変動幅）または ±0.10%/30秒（傾き）動くと、1秒以内にハイライト+ビープが発火し、バナーに [トレンド] / [フラッシュ] ラベルが表示される（閾値一時的引下げで擬似発火）
5. ☐ アラート発火から2秒以内に「なぜ動いた」がバナーに追記される（OpenAI接続時）
6. ☐ APIキー未設定でも上記1〜4が正常動作する（`.env` から OPENAI_API_KEY を除いて再起動）
7. ☐ Yahoo Finance障害時、Investing.com フォールバックで価格表示が継続する（`server/sources/yahooFinance.ts` 内で `throw new Error('test')` を一時的に追加して確認）
8. ☐ ネットワーク切断後復旧で、SSEが自動再接続される（サーバ再起動で確認）

各項目クリアを確認したら、テストコードを元に戻して最終コミット:

```bash
git status  # 一時的変更が残っていないことを確認
git log --oneline -20  # コミット履歴を確認
```

---

## 完成判定

- 全Task 1-17の Step が全て完了
- `npm test` が全PASS
- `npm run typecheck` が exit 0
- 仕様 Section 12 の8項目を全て手動確認済
