# Tunable Params & Status UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3 つのパラメータ (price/news poll 間隔 + port) を settings から変更可能にし、API 状態とサーバログをダッシュボードに露出、Tauri updater をカスタム UI に置換する。

**Architecture:** 既存の `~/.jp225-monitor/config.json` を拡張し、`server/configStore.ts` に resolver を追加。priceLoop/newsLoop を restartable にして設定 POST 時に reload。新規 `logBuffer` で console を wrap してリングバッファ化し `/api/logs` で配信。新規 `/api/status` で Yahoo + LLM の状態を集約、フロントは 5 秒 polling で topbar に表示。Tauri 標準ダイアログを無効化し、`@tauri-apps/plugin-updater` を JS から呼ぶカスタムトーストに差し替え。

**Tech Stack:** Node.js + Express + TypeScript (既存)、Vitest (既存)、Vanilla TS フロント (既存)、@tauri-apps/plugin-updater (既存依存)

**Spec:** `docs/superpowers/specs/2026-05-29-tunable-params-and-status-ui-design.md`

---

## File Structure

### 新規ファイル

| Path | 責務 |
|---|---|
| `server/logBuffer.ts` | console.log/warn/error を wrap し 200 件のリングバッファ |
| `server/logBuffer.test.ts` | リングバッファの単体テスト |
| `server/configStore.test.ts` | resolver の優先順 + 範囲チェックの単体テスト |
| `server/routes/status.ts` | `/api/status` ハンドラ |
| `server/routes/logs.ts` | `/api/logs` ハンドラ |
| `web/components/apiStatusPane.ts` | topbar 4 ドット表示 + tooltip |
| `web/components/logsModal.ts` | ログ閲覧モーダル |
| `web/components/updateToast.ts` | アップデート通知 toast |
| `web/lib/updater.ts` | `@tauri-apps/plugin-updater` 安全ラッパ |

### 変更ファイル

| Path | 変更内容 |
|---|---|
| `server/configStore.ts` | `UserConfig` に 3 フィールド + `resolvePricePollMs/NewsPollMs/Port` を export |
| `server/loops/priceLoop.ts` | `intervalMs` を state に + `restartPriceLoop()` `getYahooStatus()` export |
| `server/loops/newsLoop.ts` | 同様に `restartNewsLoop()` export |
| `server/routes/settings.ts` | POST に 3 フィールド検証 + 範囲外 reject + restart 呼び出し + response に portRequiresRestart |
| `server/index.ts` | `installLogCapture()` 呼び出し + `resolvePort()` で PORT 解決 + status/logs ルート登録 |
| `web/components/settingsModal.ts` | 3 input 追加 + portRequiresRestart バナー |
| `web/main.ts` | API status pane init / ログボタン hook / updater 5 秒後 check |
| `web/index.html` | API status pane / ログボタン / log modal / update toast HTML |
| `web/styles.css` | 上記新 UI のスタイル |
| `src-tauri/tauri.conf.json` | `updater.dialog: true → false` |

---

## Task 1: configStore に 3 フィールドと resolver を追加 (TDD)

**Files:**
- Modify: `server/configStore.ts`
- Create: `server/configStore.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `server/configStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolvePricePollMs, resolveNewsPollMs, resolvePort,
  validateParam, resetConfigCache,
} from './configStore.js';

// configStore は homedir() を内部で呼ぶ。HOME / USERPROFILE を一時 dir に差し替えてテストする
const ORIG_HOME = process.env.HOME;
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_PORT = process.env.PORT;
let tmpHome: string;

describe('configStore resolvers', () => {
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'jp225-test-'));
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    delete process.env.PORT;
    resetConfigCache();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (ORIG_HOME !== undefined) process.env.HOME = ORIG_HOME; else delete process.env.HOME;
    if (ORIG_USERPROFILE !== undefined) process.env.USERPROFILE = ORIG_USERPROFILE; else delete process.env.USERPROFILE;
    if (ORIG_PORT !== undefined) process.env.PORT = ORIG_PORT; else delete process.env.PORT;
    resetConfigCache();
  });

  function writeFileConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(tmpHome, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(tmpHome, '.jp225-monitor', 'config.json'), JSON.stringify(obj));
    resetConfigCache();
  }

  it('resolvePricePollMs returns default (2000) when no config', () => {
    expect(resolvePricePollMs()).toBe(2000);
  });

  it('resolvePricePollMs reads config.json when set', () => {
    writeFileConfig({ pricePollMs: 5000 });
    expect(resolvePricePollMs()).toBe(5000);
  });

  it('resolveNewsPollMs returns default (60000) when no config', () => {
    expect(resolveNewsPollMs()).toBe(60_000);
  });

  it('resolvePort: env PORT overrides default but config overrides env', () => {
    process.env.PORT = '4000';
    resetConfigCache();
    expect(resolvePort()).toBe(4000);

    writeFileConfig({ port: 5000 });
    expect(resolvePort()).toBe(5000);
  });

  it('validateParam returns null for valid range', () => {
    expect(validateParam('pricePollMs', 5000)).toBeNull();
    expect(validateParam('newsPollMs', 30000)).toBeNull();
    expect(validateParam('port', 3000)).toBeNull();
  });

  it('validateParam returns error message for out-of-range', () => {
    expect(validateParam('pricePollMs', 100)).toMatch(/pricePollMs/);
    expect(validateParam('pricePollMs', 999999)).toMatch(/pricePollMs/);
    expect(validateParam('port', 100)).toMatch(/port/);
    expect(validateParam('port', 99999)).toMatch(/port/);
  });
});
```

- [ ] **Step 2: テストを走らせて失敗を確認**

Run: `npm test -- configStore`
Expected: FAIL (`resolvePricePollMs is not a function` etc.)

- [ ] **Step 3: configStore.ts を拡張**

Replace `server/configStore.ts` 全体 with:

```ts
// ユーザー設定の永続化: ~/.jp225-monitor/config.json
// .env よりも優先。配布版でも .env なしで動かせる。

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CONFIG_DIR = () => join(homedir(), '.jp225-monitor');
const CONFIG_FILE = () => join(CONFIG_DIR(), 'config.json');

export interface UserConfig {
  geminiKey?: string;
  groqKey?: string;
  openaiKey?: string;
  pricePollMs?: number;
  newsPollMs?: number;
  port?: number;
}

type ProviderName = 'gemini' | 'groq' | 'openai';

// 各パラメータの範囲とデフォルト
export const PARAM_BOUNDS = {
  pricePollMs: { min: 500, max: 60_000, default: 2000 },
  newsPollMs:  { min: 10_000, max: 600_000, default: 60_000 },
  port:        { min: 1024, max: 65_535, default: 3000 },
} as const;

let cached: UserConfig | null = null;

export function loadConfig(): UserConfig {
  if (cached) return cached;
  const file = CONFIG_FILE();
  if (!existsSync(file)) { cached = {}; return cached; }
  try {
    cached = JSON.parse(readFileSync(file, 'utf-8')) as UserConfig;
    return cached;
  } catch (err) {
    console.error('[configStore] load failed:', err);
    cached = {}; return cached;
  }
}

export function saveConfig(config: UserConfig): void {
  mkdirSync(CONFIG_DIR(), { recursive: true });
  writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2), 'utf-8');
  cached = config;
  console.log(`[configStore] saved to ${CONFIG_FILE()}`);
}

// APIキー解決: config.json 優先 → 環境変数 fallback
export function resolveApiKey(provider: ProviderName): string | undefined {
  const config = loadConfig();
  const fromConfig =
    provider === 'gemini' ? config.geminiKey
  : provider === 'groq'   ? config.groqKey
  : config.openaiKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  const envName =
    provider === 'gemini' ? 'GEMINI_API_KEY'
  : provider === 'groq'   ? 'GROQ_API_KEY'
  : 'OPENAI_API_KEY';
  return process.env[envName]?.trim();
}

// 3 つの数値パラメータ resolver
// 優先順: config > env (port のみ) > default
export function resolvePricePollMs(): number {
  const v = loadConfig().pricePollMs;
  return typeof v === 'number' ? v : PARAM_BOUNDS.pricePollMs.default;
}

export function resolveNewsPollMs(): number {
  const v = loadConfig().newsPollMs;
  return typeof v === 'number' ? v : PARAM_BOUNDS.newsPollMs.default;
}

export function resolvePort(): number {
  const v = loadConfig().port;
  if (typeof v === 'number') return v;
  const env = Number(process.env.PORT);
  if (Number.isFinite(env) && env > 0) return env;
  return PARAM_BOUNDS.port.default;
}

// 範囲外なら理由を文字列で返す。OK なら null。
export function validateParam(
  name: 'pricePollMs' | 'newsPollMs' | 'port',
  value: unknown,
): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return `${name} must be a number`;
  }
  const b = PARAM_BOUNDS[name];
  if (value < b.min || value > b.max) {
    return `${name} out of range (${b.min}-${b.max})`;
  }
  return null;
}

export function configFilePath(): string { return CONFIG_FILE(); }

// テスト用 / 設定変更後のキャッシュリセット
export function resetConfigCache(): void {
  cached = null;
}
```

注: `CONFIG_DIR` / `CONFIG_FILE` をモジュールトップで評価していたのを関数化。テストで `homedir()` (= `HOME`/`USERPROFILE`) を差し替えやすくするため。
注: `resetConfigCache()` を export してテストで都度キャッシュをクリアできるようにする。

- [ ] **Step 4: テスト通過を確認**

Run: `npm test -- configStore`
Expected: PASS (6 tests)

- [ ] **Step 5: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: コミット**

```bash
git add server/configStore.ts server/configStore.test.ts
git commit -m "feat(config): add resolvers for pricePollMs/newsPollMs/port with range validation"
```

---

## Task 2: logBuffer モジュール (TDD)

**Files:**
- Create: `server/logBuffer.ts`
- Create: `server/logBuffer.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

Create `server/logBuffer.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { installLogCapture, getLogs, resetLogBuffer, BUFFER_SIZE } from './logBuffer.js';

describe('logBuffer', () => {
  beforeEach(() => {
    resetLogBuffer();
  });

  it('captures console.log into buffer', () => {
    installLogCapture();
    console.log('hello world');
    const logs = getLogs();
    const last = logs[logs.length - 1];
    expect(last?.msg).toContain('hello world');
    expect(last?.level).toBe('log');
    expect(typeof last?.ts).toBe('number');
  });

  it('captures console.warn and console.error with correct level', () => {
    installLogCapture();
    console.warn('a warning');
    console.error('an error');
    const logs = getLogs();
    expect(logs[logs.length - 2]?.level).toBe('warn');
    expect(logs[logs.length - 1]?.level).toBe('error');
  });

  it('keeps at most BUFFER_SIZE entries (ring)', () => {
    installLogCapture();
    for (let i = 0; i < BUFFER_SIZE + 50; i++) console.log(`entry ${i}`);
    const logs = getLogs();
    expect(logs.length).toBe(BUFFER_SIZE);
    expect(logs[0]?.msg).toContain(`entry 50`);
    expect(logs[logs.length - 1]?.msg).toContain(`entry ${BUFFER_SIZE + 49}`);
  });

  it('formats objects via util.format', () => {
    installLogCapture();
    console.log('user', { id: 1 });
    const last = getLogs()[getLogs().length - 1];
    expect(last?.msg).toContain('user');
    expect(last?.msg).toContain("id: 1");
  });

  it('installLogCapture is idempotent (calling twice does not double-wrap)', () => {
    installLogCapture();
    installLogCapture();
    console.log('once');
    const matching = getLogs().filter(l => l.msg.includes('once'));
    expect(matching.length).toBe(1);
  });

  it('getLogs(since) filters by timestamp', async () => {
    installLogCapture();
    console.log('old');
    await new Promise(r => setTimeout(r, 5));
    const cutoff = Date.now();
    await new Promise(r => setTimeout(r, 5));
    console.log('new');
    const recent = getLogs(cutoff);
    expect(recent.some(l => l.msg.includes('new'))).toBe(true);
    expect(recent.some(l => l.msg.includes('old'))).toBe(false);
  });
});
```

- [ ] **Step 2: テスト失敗を確認**

Run: `npm test -- logBuffer`
Expected: FAIL (`Cannot find module './logBuffer.js'`)

- [ ] **Step 3: logBuffer.ts を実装**

Create `server/logBuffer.ts`:

```ts
// console.log/warn/error をリングバッファに蓄積し、フロントへ /api/logs で配信する。
// 元の stdout/stderr 出力は維持する。

import { format } from 'node:util';

export interface LogEntry {
  ts: number;
  level: 'log' | 'warn' | 'error';
  msg: string;
}

export const BUFFER_SIZE = 200;

let buffer: LogEntry[] = [];
let installed = false;

interface Originals {
  log: typeof console.log;
  warn: typeof console.warn;
  error: typeof console.error;
}
let originals: Originals | null = null;

function push(level: LogEntry['level'], args: unknown[]): void {
  const msg = format(...args);
  buffer.push({ ts: Date.now(), level, msg });
  if (buffer.length > BUFFER_SIZE) buffer.shift();
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;
  originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  console.log = (...args: unknown[]) => { push('log', args); originals!.log(...args); };
  console.warn = (...args: unknown[]) => { push('warn', args); originals!.warn(...args); };
  console.error = (...args: unknown[]) => { push('error', args); originals!.error(...args); };
}

export function getLogs(since?: number): LogEntry[] {
  if (typeof since !== 'number') return [...buffer];
  return buffer.filter(e => e.ts > since);
}

// テスト用
export function resetLogBuffer(): void {
  buffer = [];
  if (installed && originals) {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
  }
  installed = false;
  originals = null;
}
```

- [ ] **Step 4: テスト通過を確認**

Run: `npm test -- logBuffer`
Expected: PASS (6 tests)

- [ ] **Step 5: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: コミット**

```bash
git add server/logBuffer.ts server/logBuffer.test.ts
git commit -m "feat(logs): add ring-buffer log capture (200 entries, console wrap, util.format)"
```

---

## Task 3: priceLoop を restartable + Yahoo 状態 export

**Files:**
- Modify: `server/loops/priceLoop.ts`

- [ ] **Step 1: priceLoop.ts を書き換え**

Replace `server/loops/priceLoop.ts` 全体 with:

```ts
import { fetchYahooPrices } from '../sources/yahooFinance.js';
import { fetchInvestingPrices } from '../sources/investingScrape.js';
import { broadcast } from '../sse/broker.js';
import { setPrices, getPrices } from '../cache.js';
import { INSTRUMENTS, PRICE_BACKOFF_MS } from '../config.js';
import { resolvePricePollMs } from '../configStore.js';
import type { Price } from '../types.js';

const YAHOO_SKIP_AFTER_FAIL_MS = 5 * 60 * 1000;

let backoffIndex = -1;
let timer: NodeJS.Timeout | null = null;
let running = false;
let yahooSkipUntil = 0;
let intervalMs = resolvePricePollMs();

function mergeWithCached(fresh: Price[]): Price[] {
  const map = new Map(getPrices().map(p => [p.symbol, { ...p, stale: true }]));
  for (const p of fresh) map.set(p.symbol, p);
  return INSTRUMENTS
    .map(i => map.get(i.symbol))
    .filter((p): p is Price => p !== undefined);
}

async function tick(): Promise<number> {
  try {
    let prices: Price[] = [];
    const now = Date.now();

    if (now >= yahooSkipUntil) {
      try {
        prices = await fetchYahooPrices();
        if (yahooSkipUntil > 0) {
          console.log('[priceLoop] Yahoo recovered, back to primary source');
          yahooSkipUntil = 0;
        }
      } catch (err) {
        if (yahooSkipUntil === 0) {
          console.warn(`[priceLoop] Yahoo unavailable (${err instanceof Error ? err.message : err}), using Investing.com for next 5 min`);
        }
        yahooSkipUntil = now + YAHOO_SKIP_AFTER_FAIL_MS;
      }
    }

    const missing = INSTRUMENTS
      .map(i => i.symbol)
      .filter(s => !prices.find(p => p.symbol === s));
    if (missing.length > 0) {
      const fallback = await fetchInvestingPrices(missing);
      prices = [...prices, ...fallback];
    }

    if (prices.length === 0) throw new Error('No prices fetched (Yahoo + Investing.com both failed)');

    const merged = mergeWithCached(prices);
    setPrices(merged);
    broadcast({ type: 'prices', payload: merged });
    backoffIndex = -1;
    return intervalMs;
  } catch (err) {
    backoffIndex = Math.min(backoffIndex + 1, PRICE_BACKOFF_MS.length - 1);
    const wait = PRICE_BACKOFF_MS[backoffIndex] ?? intervalMs;
    console.error(`[priceLoop] error, backing off ${wait}ms:`, err instanceof Error ? err.message : err);
    return wait;
  }
}

function schedule(): void {
  if (!running) return;
  void (async () => {
    const wait = await tick();
    if (running) {
      timer = setTimeout(schedule, wait);
    }
  })();
}

export function startPriceLoop(): void {
  if (running) return;
  running = true;
  intervalMs = resolvePricePollMs();
  backoffIndex = -1;
  schedule();
}

export function stopPriceLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

// 設定変更後の即時 reload。次の tick から新間隔で動く。
export function restartPriceLoop(): void {
  stopPriceLoop();
  startPriceLoop();
}

export function getYahooStatus(): { fallback: boolean; skipUntil: number } {
  return { fallback: Date.now() < yahooSkipUntil, skipUntil: yahooSkipUntil };
}
```

注: 既存の `PRICE_POLL_INTERVAL_MS` への参照は削除。`config.ts` 側の定数も削除する (Task 5)。

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0 (config.ts の export を一時的に残しているので import エラー無し)

- [ ] **Step 3: コミット**

```bash
git add server/loops/priceLoop.ts
git commit -m "feat(priceLoop): make interval restartable + export Yahoo fallback status"
```

---

## Task 4: newsLoop を restartable

**Files:**
- Modify: `server/loops/newsLoop.ts`

- [ ] **Step 1: newsLoop.ts を書き換え**

Replace `server/loops/newsLoop.ts` 全体 with:

```ts
import { fetchAllNews } from '../sources/rssAggregator.js';
import { broadcast } from '../sse/broker.js';
import { setNews } from '../cache.js';
import { resolveNewsPollMs } from '../configStore.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

async function tick(): Promise<void> {
  try {
    const news = await fetchAllNews();
    setNews(news);
    broadcast({ type: 'news', payload: news });
  } catch (err) {
    console.error('[newsLoop] error:', err instanceof Error ? err.message : err);
  }
}

function schedule(): void {
  if (!running) return;
  void (async () => {
    await tick();
    if (running) {
      timer = setTimeout(schedule, intervalMs);
    }
  })();
}

export function startNewsLoop(): void {
  if (running) return;
  running = true;
  intervalMs = resolveNewsPollMs();
  schedule();
}

export function stopNewsLoop(): void {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

export function restartNewsLoop(): void {
  stopNewsLoop();
  startNewsLoop();
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/loops/newsLoop.ts
git commit -m "feat(newsLoop): make interval restartable + read from configStore"
```

---

## Task 5: config.ts から重複定数を削除

**Files:**
- Modify: `server/config.ts`

- [ ] **Step 1: 不要な定数を削除**

In `server/config.ts`, replace the lines:

```ts
export const PRICE_POLL_INTERVAL_MS = 2000;
export const NEWS_POLL_INTERVAL_MS = 60_000;
```

with:

```ts
// PRICE_POLL_INTERVAL_MS / NEWS_POLL_INTERVAL_MS は configStore に移動。
// 直接定数を参照していた箇所は resolvePricePollMs() / resolveNewsPollMs() を使う。
```

PRICE_BACKOFF_MS, NEWS_MAX_ITEMS, NEWS_RECENT_WINDOW_MS, NEWS_RECENCY_DECAY_MIN はそのまま残す。

- [ ] **Step 2: 型チェック (参照漏れの検出)**

Run: `npm run typecheck`
Expected: exit 0 (priceLoop/newsLoop は Task 3-4 で既に新方式に移行済み)

- [ ] **Step 3: 全テスト確認**

Run: `npm test`
Expected: 全 PASS

- [ ] **Step 4: コミット**

```bash
git add server/config.ts
git commit -m "refactor(config): remove PRICE/NEWS_POLL_INTERVAL_MS constants (moved to configStore)"
```

---

## Task 6: settings ルートで 3 フィールド検証 + restart 連携

**Files:**
- Modify: `server/routes/settings.ts`

- [ ] **Step 1: settings.ts を書き換え**

Replace `server/routes/settings.ts` 全体 with:

```ts
import type { Request, Response } from 'express';
import {
  loadConfig, saveConfig, configFilePath, validateParam,
  resolvePricePollMs, resolveNewsPollMs, resolvePort,
  type UserConfig,
} from '../configStore.js';
import { reloadProviders, getProviderStatus } from '../llm/openai.js';
import { restartPriceLoop } from '../loops/priceLoop.js';
import { restartNewsLoop } from '../loops/newsLoop.js';

export function getSettingsHandler(_req: Request, res: Response): void {
  const config = loadConfig();
  res.json({
    geminiSet: !!config.geminiKey,
    groqSet: !!config.groqKey,
    openaiSet: !!config.openaiKey,
    geminiFromEnv: !config.geminiKey && !!process.env.GEMINI_API_KEY?.trim(),
    groqFromEnv: !config.groqKey && !!process.env.GROQ_API_KEY?.trim(),
    openaiFromEnv: !config.openaiKey && !!process.env.OPENAI_API_KEY?.trim(),
    pricePollMs: resolvePricePollMs(),
    newsPollMs: resolveNewsPollMs(),
    port: resolvePort(),
    providers: getProviderStatus(),
    configFile: configFilePath(),
  });
}

interface SettingsBody {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  pricePollMs?: number | null;   // null = リセット (= default に戻す), number = 上書き, undefined = 変更なし
  newsPollMs?: number | null;
  port?: number | null;
}

function applyStringField(existing: string | undefined, incoming: unknown): string | undefined {
  if (incoming === undefined) return existing;
  if (incoming === null) return undefined;
  if (typeof incoming !== 'string') return existing;
  const trimmed = incoming.trim();
  return trimmed === '' ? existing : trimmed;
}

function applyNumberField(
  name: 'pricePollMs' | 'newsPollMs' | 'port',
  existing: number | undefined,
  incoming: unknown,
): { value: number | undefined; error: string | null; changed: boolean } {
  if (incoming === undefined) return { value: existing, error: null, changed: false };
  if (incoming === null) return { value: undefined, error: null, changed: existing !== undefined };
  const err = validateParam(name, incoming);
  if (err) return { value: existing, error: err, changed: false };
  return { value: incoming as number, error: null, changed: existing !== incoming };
}

export function postSettingsHandler(req: Request, res: Response): void {
  const body = req.body as SettingsBody;
  const existing = loadConfig();

  const priceResult = applyNumberField('pricePollMs', existing.pricePollMs, body.pricePollMs);
  const newsResult = applyNumberField('newsPollMs', existing.newsPollMs, body.newsPollMs);
  const portResult = applyNumberField('port', existing.port, body.port);

  const errors = [priceResult.error, newsResult.error, portResult.error].filter((e): e is string => e !== null);
  if (errors.length > 0) {
    res.status(400).json({ error: errors.join('; ') });
    return;
  }

  const next: UserConfig = {
    geminiKey: applyStringField(existing.geminiKey, body.geminiKey),
    groqKey: applyStringField(existing.groqKey, body.groqKey),
    openaiKey: applyStringField(existing.openaiKey, body.openaiKey),
    pricePollMs: priceResult.value,
    newsPollMs: newsResult.value,
    port: portResult.value,
  };
  saveConfig(next);
  reloadProviders();

  if (priceResult.changed) restartPriceLoop();
  if (newsResult.changed) restartNewsLoop();

  res.json({
    ok: true,
    providers: getProviderStatus(),
    portRequiresRestart: portResult.changed,
  });
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: 起動疎通 (手動)**

Run (別ターミナル): `npm run dev:server`
Expected: `[server] listening on http://localhost:3000` (configStore に何も設定されていないので default port)

Run: `curl http://localhost:3000/api/settings`
Expected: JSON に `pricePollMs: 2000, newsPollMs: 60000, port: 3000` を含む

Run:
```bash
curl -X POST http://localhost:3000/api/settings/keys -H "Content-Type: application/json" -d '{"pricePollMs": 100}'
```
Expected: `{"error":"pricePollMs out of range (500-60000)"}` (HTTP 400)

Run:
```bash
curl -X POST http://localhost:3000/api/settings/keys -H "Content-Type: application/json" -d '{"pricePollMs": 5000}'
```
Expected: `{"ok":true, ...}`、サーバログに `[configStore] saved` が出る

サーバを Ctrl+C で止める。

- [ ] **Step 4: コミット**

```bash
git add server/routes/settings.ts
git commit -m "feat(settings): accept pricePollMs/newsPollMs/port with range validation and live reload"
```

---

## Task 7: /api/status ルート

**Files:**
- Create: `server/routes/status.ts`

- [ ] **Step 1: status.ts を作成**

Create `server/routes/status.ts`:

```ts
import type { Request, Response } from 'express';
import { getYahooStatus } from '../loops/priceLoop.js';
import { getProviderStatus } from '../llm/openai.js';

export function statusHandler(_req: Request, res: Response): void {
  res.json({
    yahoo: getYahooStatus(),
    llm: getProviderStatus(),
  });
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/routes/status.ts
git commit -m "feat(api): add /api/status aggregating Yahoo + LLM provider state"
```

---

## Task 8: /api/logs ルート

**Files:**
- Create: `server/routes/logs.ts`

- [ ] **Step 1: logs.ts を作成**

Create `server/routes/logs.ts`:

```ts
import type { Request, Response } from 'express';
import { getLogs } from '../logBuffer.js';

export function logsHandler(req: Request, res: Response): void {
  const sinceRaw = req.query['since'];
  const since = typeof sinceRaw === 'string' ? Number(sinceRaw) : NaN;
  const logs = Number.isFinite(since) ? getLogs(since) : getLogs();
  res.json({ logs });
}
```

- [ ] **Step 2: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 3: コミット**

```bash
git add server/routes/logs.ts
git commit -m "feat(api): add /api/logs with optional ?since= filter"
```

---

## Task 9: server/index.ts に組み込み

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: index.ts を書き換え**

Replace `server/index.ts` 全体 with:

```ts
import express from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installLogCapture } from './logBuffer.js';
installLogCapture();   // 最初に install してすべての console を捕捉

import { streamHandler } from './routes/stream.js';
import { explainHandler } from './routes/explain.js';
import { chatHandler } from './routes/chat.js';
import { getSettingsHandler, postSettingsHandler } from './routes/settings.js';
import { statusHandler } from './routes/status.js';
import { logsHandler } from './routes/logs.js';
import { startPriceLoop } from './loops/priceLoop.js';
import { startNewsLoop } from './loops/newsLoop.js';
import { isLLMEnabled } from './llm/openai.js';
import { resolvePort } from './configStore.js';

declare const __APP_VERSION__: string | undefined;

const PORT = resolvePort();

const APP_VERSION: string = (typeof __APP_VERSION__ === 'string')
  ? __APP_VERSION__
  : (() => {
      const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as { version: string };
      return pkg.version;
    })();

console.log(`[server] JP225 Monitor v${APP_VERSION}`);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.get('/api/stream', streamHandler);
app.post('/api/explain', explainHandler);
app.post('/api/chat', chatHandler);
app.get('/api/settings', getSettingsHandler);
app.post('/api/settings/keys', postSettingsHandler);
app.get('/api/status', statusHandler);
app.get('/api/logs', logsHandler);
app.get('/api/health', (_req, res) => res.json({ ok: true, llm: isLLMEnabled(), version: APP_VERSION }));
app.get('/api/version', (_req, res) => res.json({ version: APP_VERSION, name: 'JP225 Monitor' }));

const isPkg = (process as unknown as { pkg?: unknown }).pkg !== undefined;
const distWeb = isPkg
  ? join(dirname(process.execPath), 'web')
  : join(process.cwd(), 'dist', 'web');
if (existsSync(distWeb)) {
  app.use(express.static(distWeb));
  console.log(`[server] serving static frontend from ${distWeb}`);
}

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (LLM ${isLLMEnabled() ? 'enabled' : 'disabled'})`);
  startPriceLoop();
  startNewsLoop();
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} already in use — another jp225-monitor is running. Exiting.`);
    process.exit(0);
  }
  console.error('[server] fatal listen error:', err);
  process.exit(1);
});
```

注: `installLogCapture()` を **route import より前** に呼ぶ。理由 — route ファイルの import 時に走る初期化ログ (`[LLM] enabled providers: ...` 等) も捕捉するため。

- [ ] **Step 2: 起動疎通**

Run (別ターミナル): `npm run dev:server`
Expected ログ:
```
[server] JP225 Monitor v0.3.0
[LLM] enabled providers: ...
[server] listening on http://localhost:3000 ...
```

Run: `curl http://localhost:3000/api/status`
Expected: JSON `{"yahoo":{...},"llm":[...]}`

Run: `curl http://localhost:3000/api/logs`
Expected: JSON `{"logs":[{ts,level,msg}, ...]}` (起動ログが含まれる)

サーバ停止: Ctrl+C

- [ ] **Step 3: 全テスト確認**

Run: `npm test && npm run typecheck`
Expected: 全 PASS、exit 0

- [ ] **Step 4: コミット**

```bash
git add server/index.ts
git commit -m "feat(server): install log capture + wire status/logs routes + resolvePort"
```

---

## Task 10: settings modal に 3 入力 + portRequiresRestart バナー

**Files:**
- Modify: `web/components/settingsModal.ts`
- Modify: `web/index.html`
- Modify: `web/styles.css`

- [ ] **Step 1: HTML に入力フィールドを追加**

In `web/index.html`, find the settings modal block and add the params section. Locate the existing modal `<form>` or `<div>` containing the API key inputs and add **before** the save button:

```html
<fieldset class="settings-section">
  <legend>定期 API ポーリング設定</legend>
  <label>
    Price polling (ms, 500–60000)
    <input type="number" id="settings-price-poll" min="500" max="60000" step="500" />
  </label>
  <label>
    News polling (ms, 10000–600000)
    <input type="number" id="settings-news-poll" min="10000" max="600000" step="1000" />
  </label>
  <label>
    Sidecar port (1024–65535)
    <input type="number" id="settings-port" min="1024" max="65535" step="1" />
  </label>
  <div id="settings-port-warning" class="settings-warning hidden">
    ⚠ port を変更しました。サーバを再起動するまで反映されません。
  </div>
</fieldset>
```

(具体的な挿入位置は既存ファイルの構造に合わせて調整。`<button id="settings-save">` の直前が目安)

- [ ] **Step 2: CSS を追加**

Append to `web/styles.css`:

```css
.settings-section {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px 14px;
  margin: 12px 0;
}
.settings-section legend {
  padding: 0 8px;
  color: var(--muted);
  font-size: 12px;
}
.settings-section label {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}
.settings-section input[type="number"] {
  width: 120px;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 13px;
}
.settings-warning {
  background: rgba(248, 81, 73, 0.15);
  color: #ff9b9b;
  padding: 6px 10px;
  border-radius: 4px;
  margin-top: 8px;
  font-size: 12px;
}
.hidden { display: none; }
```

- [ ] **Step 3: settingsModal.ts を拡張**

Replace `web/components/settingsModal.ts` 全体 with the following (置換前のロジックを保ちつつ、3 input + warning を追加):

```ts
interface SettingsResponse {
  geminiSet: boolean; groqSet: boolean; openaiSet: boolean;
  geminiFromEnv: boolean; groqFromEnv: boolean; openaiFromEnv: boolean;
  pricePollMs: number; newsPollMs: number; port: number;
  providers: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
  configFile: string;
}

interface SaveResponse {
  ok: boolean;
  portRequiresRestart?: boolean;
}

async function fetchSettings(): Promise<SettingsResponse | null> {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return null;
    return await res.json() as SettingsResponse;
  } catch { return null; }
}

interface SavePayload {
  geminiKey?: string | null;
  groqKey?: string | null;
  openaiKey?: string | null;
  pricePollMs?: number | null;
  newsPollMs?: number | null;
  port?: number | null;
}

async function saveSettings(body: SavePayload): Promise<{ ok: boolean; error?: string; portRequiresRestart?: boolean }> {
  try {
    const res = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json() as SaveResponse & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, portRequiresRestart: data.portRequiresRestart };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
  }
}

function renderStatus(s: SettingsResponse | null): string {
  if (!s) return '<div class="settings-status err">設定取得失敗</div>';
  const items = s.providers.map(p => {
    const dot = p.enabled
      ? (p.paused ? '🟡' : '🟢')
      : '⚪';
    const note = p.paused
      ? ` (${Math.max(0, Math.round((p.pausedUntil - Date.now()) / 1000))}秒待機中)`
      : p.enabled ? '' : ' 未設定';
    return `<div>${dot} ${p.name}${note}</div>`;
  }).join('');
  return `<div class="settings-status">${items}</div>`;
}

export interface SettingsElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  saveBtn: HTMLButtonElement;
  inputGemini: HTMLInputElement;
  inputGroq: HTMLInputElement;
  inputOpenai: HTMLInputElement;
  inputPricePoll: HTMLInputElement;
  inputNewsPoll: HTMLInputElement;
  inputPort: HTMLInputElement;
  portWarning: HTMLElement;
  statusArea: HTMLElement;
  backdrop: HTMLElement;
}

export function initSettingsModal(el: SettingsElements): void {
  let current: SettingsResponse | null = null;

  async function refresh() {
    current = await fetchSettings();
    el.statusArea.innerHTML = renderStatus(current);
    el.inputGemini.placeholder = current?.geminiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.geminiFromEnv ? '環境変数から読込中 (上書きするにはここに入力)' : 'AIza...';
    el.inputGroq.placeholder = current?.groqSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.groqFromEnv ? '環境変数から読込中' : 'gsk_...';
    el.inputOpenai.placeholder = current?.openaiSet
      ? '設定済み (上書きする場合のみ入力)'
      : current?.openaiFromEnv ? '環境変数から読込中' : 'sk-...';
    if (current) {
      el.inputPricePoll.value = String(current.pricePollMs);
      el.inputNewsPoll.value = String(current.newsPollMs);
      el.inputPort.value = String(current.port);
    }
    el.portWarning.classList.add('hidden');
  }

  async function open() {
    el.modal.classList.remove('hidden');
    await refresh();
    el.inputGemini.focus();
  }
  function close() {
    el.modal.classList.add('hidden');
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);

  el.saveBtn.addEventListener('click', async () => {
    const body: SavePayload = {};
    const gv = el.inputGemini.value.trim();
    const grv = el.inputGroq.value.trim();
    const ov = el.inputOpenai.value.trim();
    if (gv) body.geminiKey = gv;
    if (grv) body.groqKey = grv;
    if (ov) body.openaiKey = ov;

    const pp = Number(el.inputPricePoll.value);
    const np = Number(el.inputNewsPoll.value);
    const pt = Number(el.inputPort.value);
    if (current && pp !== current.pricePollMs) body.pricePollMs = pp;
    if (current && np !== current.newsPollMs) body.newsPollMs = np;
    if (current && pt !== current.port) body.port = pt;

    const result = await saveSettings(body);
    if (!result.ok) {
      el.statusArea.innerHTML = `<div class="settings-status err">${result.error ?? '保存失敗'}</div>`;
      return;
    }
    el.inputGemini.value = '';
    el.inputGroq.value = '';
    el.inputOpenai.value = '';
    await refresh();
    if (result.portRequiresRestart) {
      el.portWarning.classList.remove('hidden');
    }
  });
}
```

- [ ] **Step 4: main.ts の呼び出し側を新シグネチャに合わせる**

In `web/main.ts`, find the call to `initSettingsModal(...)` and update it:

```ts
// 旧シグネチャ:
// initSettingsModal(openBtn, modal, closeBtn, saveBtn, inputGemini, inputGroq, inputOpenai, statusArea, backdrop);

// 新シグネチャ:
initSettingsModal({
  openBtn:        document.getElementById('settings-open') as HTMLButtonElement,
  modal:          document.getElementById('settings-modal') as HTMLElement,
  closeBtn:       document.getElementById('settings-close') as HTMLButtonElement,
  saveBtn:        document.getElementById('settings-save') as HTMLButtonElement,
  inputGemini:    document.getElementById('settings-gemini') as HTMLInputElement,
  inputGroq:      document.getElementById('settings-groq') as HTMLInputElement,
  inputOpenai:    document.getElementById('settings-openai') as HTMLInputElement,
  inputPricePoll: document.getElementById('settings-price-poll') as HTMLInputElement,
  inputNewsPoll:  document.getElementById('settings-news-poll') as HTMLInputElement,
  inputPort:      document.getElementById('settings-port') as HTMLInputElement,
  portWarning:    document.getElementById('settings-port-warning') as HTMLElement,
  statusArea:     document.getElementById('settings-status') as HTMLElement,
  backdrop:       document.getElementById('settings-backdrop') as HTMLElement,
});
```

(`document.getElementById` の文字列は既存 main.ts の値に合わせる。確認のため一度 `web/main.ts` を `grep settings-` で見てから合わせる)

- [ ] **Step 5: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: 手動検証**

Run: `npm run dev`
- ブラウザで http://localhost:5173 を開く
- ⚙️ 設定ボタンを開く
- "定期 API ポーリング設定" セクションが見える
- pricePollMs を 5000 に変更 → 保存 → モーダル閉じてから DevTools Network で `/api/stream` の `prices` イベント間隔が 5 秒になっているか確認
- port を 3001 に変更 → 保存 → モーダル内に "⚠ port を変更しました…" バナーが出る
- ⚙️ で再度開くと、値が保存されていること、バナーは消えていること

サーバ停止: Ctrl+C

- [ ] **Step 7: コミット**

```bash
git add web/components/settingsModal.ts web/main.ts web/index.html web/styles.css
git commit -m "feat(settings-ui): add price/news poll & port inputs with port-restart warning"
```

---

## Task 11: API status pane (topbar 4 ドット)

**Files:**
- Create: `web/components/apiStatusPane.ts`
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/main.ts`

- [ ] **Step 1: HTML に container 追加**

In `web/index.html`, find the `<span id="connection-status">` element and add **immediately after** it:

```html
<div id="api-status" class="api-status"></div>
```

- [ ] **Step 2: CSS 追加**

Append to `web/styles.css`:

```css
.api-status {
  display: inline-flex;
  gap: 6px;
  margin-left: 12px;
  align-items: center;
  font-size: 13px;
}
.api-status .dot {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  cursor: help;
}
.api-status .dot .label { color: var(--muted); font-size: 11px; }
```

- [ ] **Step 3: apiStatusPane.ts 作成**

Create `web/components/apiStatusPane.ts`:

```ts
interface StatusResponse {
  yahoo: { fallback: boolean; skipUntil: number };
  llm: Array<{ name: string; enabled: boolean; paused: boolean; pausedUntil: number }>;
}

function fmtRemaining(target: number, now: number): string {
  const sec = Math.max(0, Math.round((target - now) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function fmtClock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function renderDot(label: string, state: 'ok' | 'paused' | 'off', tooltip: string): string {
  const emoji = state === 'ok' ? '🟢' : state === 'paused' ? '🟡' : '⚪';
  return `<span class="dot" title="${tooltip}">${emoji}<span class="label">${label}</span></span>`;
}

export async function refreshApiStatus(container: HTMLElement): Promise<void> {
  let data: StatusResponse;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) { container.textContent = ''; return; }
    data = await res.json() as StatusResponse;
  } catch {
    container.textContent = '';
    return;
  }
  const now = Date.now();
  const yahooState: 'ok' | 'paused' = data.yahoo.fallback ? 'paused' : 'ok';
  const yahooTip = data.yahoo.fallback
    ? `Yahoo: fallback中 (残${fmtRemaining(data.yahoo.skipUntil, now)} / ${fmtClock(data.yahoo.skipUntil)} 復帰予定)`
    : 'Yahoo: 利用可';
  const yahoo = renderDot('Y', yahooState, yahooTip);
  const llm = data.llm.map(p => {
    const state: 'ok' | 'paused' | 'off' = !p.enabled ? 'off' : p.paused ? 'paused' : 'ok';
    const tooltip = !p.enabled
      ? `${p.name}: 未設定`
      : p.paused
        ? `${p.name}: 待機中 (残${fmtRemaining(p.pausedUntil, now)} / ${fmtClock(p.pausedUntil)} 復帰予定)`
        : `${p.name}: 利用可`;
    const labelShort = p.name === 'gemini' ? 'G' : p.name === 'groq' ? 'Gr' : 'O';
    return renderDot(labelShort, state, tooltip);
  }).join('');
  container.innerHTML = yahoo + llm;
}

export function initApiStatusPane(container: HTMLElement, intervalMs: number = 5000): void {
  void refreshApiStatus(container);
  setInterval(() => { void refreshApiStatus(container); }, intervalMs);
}
```

- [ ] **Step 4: main.ts に組込**

In `web/main.ts`, add at the top with other imports:

```ts
import { initApiStatusPane } from './components/apiStatusPane.js';
```

After the existing topbar / connection status wiring (適切な init 順序の場所), add:

```ts
const apiStatusEl = document.getElementById('api-status');
if (apiStatusEl) initApiStatusPane(apiStatusEl);
```

- [ ] **Step 5: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: 手動検証**

Run: `npm run dev`
- ブラウザで http://localhost:5173 を開く
- topbar 右側に 4 つのドット (Y, G, Gr, O) が表示される
- API キー未設定なら G/Gr/O は ⚪
- Yahoo が普通に動いていれば Y は 🟢
- Yahoo に hover すると tooltip が「Yahoo: 利用可」
- (Yahoo を一時的に失敗させる: `server/sources/yahooFinance.ts` の `fetchYahooPrices` の冒頭に `throw new Error('test');` を入れて 5 秒待つ → Y が 🟡 に → 削除して元に戻す)

サーバ停止: Ctrl+C

- [ ] **Step 7: コミット**

```bash
git add web/components/apiStatusPane.ts web/main.ts web/index.html web/styles.css
git commit -m "feat(ui): add topbar API status pane with 5s polling and hover tooltips"
```

---

## Task 12: ログモーダル

**Files:**
- Create: `web/components/logsModal.ts`
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/main.ts`

- [ ] **Step 1: HTML 追加**

In `web/index.html`, find the topbar section. Add a button **immediately before** the existing settings button (`#settings-open` or whatever it's named):

```html
<button id="open-logs" class="topbar-btn" title="サーバログを見る">📋</button>
```

At an appropriate location (after the settings modal HTML), add the logs modal:

```html
<div id="logs-modal" class="modal hidden">
  <div class="modal-backdrop" id="logs-backdrop"></div>
  <div class="modal-content modal-content-wide">
    <div class="modal-header">
      <h2>サーバログ</h2>
      <button id="logs-close" class="modal-close">✕</button>
    </div>
    <div class="modal-controls">
      <label><input type="checkbox" id="logs-auto" checked /> 自動更新 (2 秒)</label>
      <button id="logs-clear">表示をクリア</button>
    </div>
    <pre id="logs-content" class="logs-content"></pre>
  </div>
</div>
```

- [ ] **Step 2: CSS 追加**

Append to `web/styles.css`:

```css
.topbar-btn {
  background: var(--panel);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  cursor: pointer;
  font-size: 14px;
  margin-right: 6px;
}
.topbar-btn:hover { background: var(--border); }

.modal-content-wide { max-width: 900px; width: 90vw; }
.modal-controls {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}
.modal-controls button {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 3px 10px;
  cursor: pointer;
}
.logs-content {
  background: #000;
  color: #c0c0c0;
  font-family: 'Consolas', 'Menlo', monospace;
  font-size: 12px;
  padding: 12px;
  margin: 0;
  height: 60vh;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
.logs-content .log-warn { color: #f0d000; }
.logs-content .log-error { color: #ff7d75; }
.logs-content .log-ts { color: #6a737d; margin-right: 6px; }
```

(`.modal` `.modal-backdrop` `.modal-content` `.modal-header` `.modal-close` は settings modal で既存と想定。同じスタイルを使い回す。もし命名が異なる場合は既存に合わせる)

- [ ] **Step 3: logsModal.ts 作成**

Create `web/components/logsModal.ts`:

```ts
interface LogEntry { ts: number; level: 'log' | 'warn' | 'error'; msg: string; }
interface LogsResponse { logs: LogEntry[]; }

function fmtTs(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

function renderLine(e: LogEntry): string {
  const cls = e.level === 'warn' ? 'log-warn' : e.level === 'error' ? 'log-error' : '';
  return `<span class="log-ts">${fmtTs(e.ts)}</span><span class="${cls}">${escapeHtml(e.msg)}</span>\n`;
}

export interface LogsModalElements {
  openBtn: HTMLButtonElement;
  modal: HTMLElement;
  closeBtn: HTMLButtonElement;
  backdrop: HTMLElement;
  contentEl: HTMLElement;
  autoCheckbox: HTMLInputElement;
  clearBtn: HTMLButtonElement;
}

export function initLogsModal(el: LogsModalElements): void {
  let pollTimer: number | null = null;
  let lastTs = 0;
  let followBottom = true;

  el.contentEl.addEventListener('scroll', () => {
    const atBottom = el.contentEl.scrollTop + el.contentEl.clientHeight >= el.contentEl.scrollHeight - 5;
    followBottom = atBottom;
  });

  async function fetchAndAppend(initial: boolean): Promise<void> {
    try {
      const url = initial ? '/api/logs' : `/api/logs?since=${lastTs}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as LogsResponse;
      if (initial) {
        el.contentEl.innerHTML = data.logs.map(renderLine).join('');
      } else if (data.logs.length > 0) {
        el.contentEl.innerHTML += data.logs.map(renderLine).join('');
      }
      if (data.logs.length > 0) {
        lastTs = data.logs[data.logs.length - 1]!.ts;
      }
      if (followBottom) {
        el.contentEl.scrollTop = el.contentEl.scrollHeight;
      }
    } catch { /* ignore */ }
  }

  function startPolling() {
    if (pollTimer !== null) return;
    pollTimer = window.setInterval(() => { void fetchAndAppend(false); }, 2000);
  }
  function stopPolling() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  async function open() {
    el.modal.classList.remove('hidden');
    lastTs = 0;
    followBottom = true;
    await fetchAndAppend(true);
    if (el.autoCheckbox.checked) startPolling();
  }
  function close() {
    el.modal.classList.add('hidden');
    stopPolling();
  }

  el.openBtn.addEventListener('click', () => { void open(); });
  el.closeBtn.addEventListener('click', close);
  el.backdrop.addEventListener('click', close);
  el.autoCheckbox.addEventListener('change', () => {
    if (el.autoCheckbox.checked) startPolling(); else stopPolling();
  });
  el.clearBtn.addEventListener('click', () => {
    el.contentEl.innerHTML = '';
    lastTs = Date.now();
  });
}
```

- [ ] **Step 4: main.ts に組込**

In `web/main.ts`, add:

```ts
import { initLogsModal } from './components/logsModal.js';
```

And wire:

```ts
const logsOpenBtn = document.getElementById('open-logs') as HTMLButtonElement | null;
if (logsOpenBtn) {
  initLogsModal({
    openBtn: logsOpenBtn,
    modal: document.getElementById('logs-modal') as HTMLElement,
    closeBtn: document.getElementById('logs-close') as HTMLButtonElement,
    backdrop: document.getElementById('logs-backdrop') as HTMLElement,
    contentEl: document.getElementById('logs-content') as HTMLElement,
    autoCheckbox: document.getElementById('logs-auto') as HTMLInputElement,
    clearBtn: document.getElementById('logs-clear') as HTMLButtonElement,
  });
}
```

- [ ] **Step 5: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 6: 手動検証**

Run: `npm run dev`
- ブラウザで http://localhost:5173 を開く
- topbar の 📋 ボタンをクリック
- ログモーダルが開き、起動時ログ (`[server] JP225 Monitor v0.3.0` 等) が表示される
- 自動更新 ☑ オンの状態で新しい priceLoop / status の console.log が約 2 秒後に下に追加される
- 「表示をクリア」で空に
- 上にスクロールすると追尾が止まる、最下行に戻ると追尾再開
- ✕ または背景クリックで閉じる

サーバ停止: Ctrl+C

- [ ] **Step 7: コミット**

```bash
git add web/components/logsModal.ts web/main.ts web/index.html web/styles.css
git commit -m "feat(ui): add server log viewer modal with 2s auto-refresh and scroll-follow"
```

---

## Task 13: Updater 安全ラッパ + Toast UI + tauri.conf 更新

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `web/lib/updater.ts`
- Create: `web/components/updateToast.ts`
- Modify: `web/index.html`
- Modify: `web/styles.css`
- Modify: `web/main.ts`

- [ ] **Step 1: tauri.conf.json で dialog を無効化**

Edit `src-tauri/tauri.conf.json`. Find the `"updater"` block and change:

```diff
   "updater": {
     "active": true,
     "endpoints": [...],
     "pubkey": "...",
-    "dialog": true
+    "dialog": false
   }
```

- [ ] **Step 2: updater.ts ラッパ作成**

Create `web/lib/updater.ts`:

```ts
// Tauri runtime のみで動作。Tauri 外 (npm run dev / web) では null/no-op。

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

declare global {
  interface Window { __TAURI__?: unknown; }
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && window.__TAURI__ !== undefined;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!inTauri()) return null;
  try {
    const mod = await import('@tauri-apps/plugin-updater');
    const update = await mod.check();
    if (!update) return null;
    return {
      version: update.version,
      notes: update.body ?? undefined,
      date: update.date ?? undefined,
    };
  } catch (err) {
    console.warn('[updater] check failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ダウンロード+インストール (再起動含む)。進捗コールバック可。
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  if (!inTauri()) throw new Error('Tauri runtime not available');
  const updaterMod = await import('@tauri-apps/plugin-updater');
  const processMod = await import('@tauri-apps/plugin-process');
  const update = await updaterMod.check();
  if (!update) throw new Error('no update available');
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => {
    if (event.event === 'Started') {
      total = event.data?.contentLength ?? null;
    } else if (event.event === 'Progress') {
      downloaded += event.data?.chunkLength ?? 0;
      onProgress?.(downloaded, total);
    }
  });
  await processMod.relaunch();
}
```

- [ ] **Step 3: updateToast.ts 作成**

Create `web/components/updateToast.ts`:

```ts
import { checkForUpdate, installUpdate, type UpdateInfo } from '../lib/updater.js';

const DISMISS_KEY = 'jp225_update_dismissed_until';
const DISMISS_DURATION_MS = 24 * 3600 * 1000;

function isDismissed(version: string): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw) as { version: string; until: number };
    return obj.version === version && Date.now() < obj.until;
  } catch { return false; }
}

function markDismissed(version: string): void {
  localStorage.setItem(DISMISS_KEY, JSON.stringify({ version, until: Date.now() + DISMISS_DURATION_MS }));
}

function render(toast: HTMLElement, info: UpdateInfo): void {
  toast.innerHTML = `
    <div class="update-toast-body">
      🆙 <strong>v${info.version}</strong> が利用可能です
      ${info.notes ? `<div class="update-toast-notes">${info.notes.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]!))}</div>` : ''}
      <div class="update-toast-progress hidden"><div class="update-toast-bar"></div></div>
      <div class="update-toast-actions">
        <button id="update-toast-install" class="update-toast-btn primary">更新</button>
        <button id="update-toast-dismiss" class="update-toast-btn">後で</button>
      </div>
    </div>
  `;
  toast.classList.remove('hidden');

  const installBtn = toast.querySelector<HTMLButtonElement>('#update-toast-install')!;
  const dismissBtn = toast.querySelector<HTMLButtonElement>('#update-toast-dismiss')!;
  const progressEl = toast.querySelector<HTMLElement>('.update-toast-progress')!;
  const barEl = toast.querySelector<HTMLElement>('.update-toast-bar')!;

  dismissBtn.addEventListener('click', () => {
    markDismissed(info.version);
    toast.classList.add('hidden');
  });

  installBtn.addEventListener('click', async () => {
    installBtn.disabled = true;
    dismissBtn.disabled = true;
    progressEl.classList.remove('hidden');
    try {
      await installUpdate((dl, total) => {
        if (total && total > 0) {
          const pct = Math.round((dl / total) * 100);
          barEl.style.width = `${pct}%`;
        }
      });
      // installUpdate 内で relaunch されるので通常ここには来ない
    } catch (err) {
      toast.innerHTML = `<div class="update-toast-body err">更新失敗: ${err instanceof Error ? err.message : 'unknown'}</div>`;
    }
  });
}

export async function maybeShowUpdateToast(toastEl: HTMLElement, delayMs: number = 5000): Promise<void> {
  await new Promise(r => setTimeout(r, delayMs));
  const info = await checkForUpdate();
  if (!info) return;
  if (isDismissed(info.version)) return;
  render(toastEl, info);
}
```

- [ ] **Step 4: HTML 追加**

In `web/index.html`, near the `</body>` tag, add:

```html
<div id="update-toast" class="update-toast hidden"></div>
```

- [ ] **Step 5: CSS 追加**

Append to `web/styles.css`:

```css
.update-toast {
  position: fixed;
  top: 60px;
  right: 20px;
  z-index: 100;
  background: var(--panel);
  border: 1px solid var(--up);
  border-radius: 8px;
  padding: 12px 16px;
  max-width: 320px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  font-size: 13px;
}
.update-toast-body { display: flex; flex-direction: column; gap: 8px; }
.update-toast-body.err { color: var(--down); }
.update-toast-notes {
  font-size: 11px;
  color: var(--muted);
  max-height: 80px;
  overflow-y: auto;
}
.update-toast-actions { display: flex; gap: 8px; }
.update-toast-btn {
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: 12px;
}
.update-toast-btn.primary { background: var(--up); color: black; border-color: var(--up); }
.update-toast-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.update-toast-progress {
  background: var(--bg);
  border-radius: 4px;
  height: 6px;
  overflow: hidden;
}
.update-toast-bar {
  background: var(--up);
  height: 100%;
  width: 0%;
  transition: width 0.2s;
}
```

- [ ] **Step 6: main.ts に組込**

In `web/main.ts`, add:

```ts
import { maybeShowUpdateToast } from './components/updateToast.js';
```

At the end of init (after other components):

```ts
const updateToastEl = document.getElementById('update-toast');
if (updateToastEl) void maybeShowUpdateToast(updateToastEl, 5000);
```

- [ ] **Step 7: 型チェック**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 8: dev 環境での silent fail 確認**

Run: `npm run dev`
- ブラウザで http://localhost:5173 を開く
- 5 秒待っても update toast は出ない (Tauri 不在のため `checkForUpdate()` が null を返す)
- DevTools コンソールにエラー無し

サーバ停止: Ctrl+C

- [ ] **Step 9: コミット**

```bash
git add src-tauri/tauri.conf.json web/lib/updater.ts web/components/updateToast.ts web/main.ts web/index.html web/styles.css
git commit -m "feat(updater): custom toast UI replacing Tauri dialog (no-op outside Tauri runtime)"
```

---

## Task 14: 統合テスト + 仕様 Section 9 の成功基準を全項目確認

**Files:** なし (検証のみ)

- [ ] **Step 1: 全テスト + 型チェック**

Run: `npm test && npm run typecheck`
Expected: 全 PASS、exit 0

- [ ] **Step 2: 仕様 Section 9 の成功基準を一項目ずつ確認**

`docs/superpowers/specs/2026-05-29-tunable-params-and-status-ui-design.md` の §9 「成功基準」:

- [ ] `npm run dev` で settings modal から price poll を 5000ms に変えて保存 → 即時反映 (DevTools Network で `/api/stream` の `prices` イベントが 5 秒間隔)
- [ ] price/news/port を範囲外 (例: pricePollMs=100) で保存しようとすると 400 が返り、settings modal の status area にエラーが見える
- [ ] Yahoo を意図的に落とす (`server/sources/yahooFinance.ts` の `fetchYahooPrices` 冒頭に `throw new Error('test');`) → 5 秒以内に topbar Y ドットが 🟡 になり、tooltip に残時間表示 → 戻す
- [ ] 📋 で logsモーダルが開き、自動更新中に新しい priceLoop ログが下に流れる
- [ ] `npm run tauri:dev` で updater が initialize し、placeholder URL でも fork-bomb せずに静かに失敗 (toast 出ない、ログにも fatal 無し)

(注: 最後の項目は Tauri 起動が必要。fork-bomb の修正は既に commit 済みなので問題なく動くはず)

- [ ] **Step 3: 全コミットの確認**

Run: `git log --oneline -20`
Expected: Task 1〜13 のコミットが連なっている

- [ ] **Step 4: 完成判定コミット (任意、CHANGELOG 的)**

このタスクではコード変更がないため commit は不要。仕様達成のみ確認。

---

## 完成判定

- 全 Task 1-14 の Step が完了
- `npm test` 全 PASS (configStore + logBuffer の新規 2 ファイル含む)
- `npm run typecheck` exit 0
- 仕様 §9 成功基準 5 項目を全て確認済
- 設定モーダルから price/news/port を変更でき、即時反映 (price/news) / 再起動警告 (port) が動く
- topbar API ドット 4 つが 5 秒ごと更新
- 📋 でログモーダルが開き、ライブ表示 + フォロー追従
- Tauri 環境では updater が動作 (placeholder の現状では検出されないが、本物の release があれば toast が出る)
