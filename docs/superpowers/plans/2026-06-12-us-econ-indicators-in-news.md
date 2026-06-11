# 米経済指標をNEWSに取り込む（結果＋反応）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`).

**Goal:** 米高インパクト経済指標の結果(actual)を NEWS にインライン表示し、NK225夜間先物の発表後10分の反応(pt)を付ける。予想値は出さない。新規APIキー不要。

**Architecture:** 無料の ForexFactory系週次JSON(faireconomy・キー不要)を取得→US/High×発表済みを抽出→価格DB(`getBarCloseNear`,'NIY=F')で発表後10分の反応算出→`NewsItem` 化して既存ニュースへマージ。SSE/描画/AI文脈は既存を再利用。

**Tech Stack:** TypeScript(NodeNext ESM・.js import)、vitest、node:sqlite、fetch。

---

## ファイル構成
- 新規: `server/sources/economicCalendar.ts` — 取得・抽出・反応・NewsItem変換。
- 改修: `server/loops/newsLoop.ts` — RSS と経済指標をマージして配信。
- 新規: `server/sources/economicCalendar.test.ts` — 純関数のユニットテスト。
- (任意) `web/components/newsFeed.ts` or `web/style.css` — `米経済指標` 項目の軽い装飾（MVPは 📊 で識別可・CSS最小）。

---

## Task 1: economicCalendar.ts の純関数（パース・整形・反応）

**Files:** Create `server/sources/economicCalendar.ts`, Test `server/sources/economicCalendar.test.ts`

- [ ] **Step 1: 失敗するテストを書く**

`server/sources/economicCalendar.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { parseFfCalendar, toNewsItem, computeReaction, type EconEvent } from './economicCalendar.js';

const SAMPLE = [
  { title: 'CPI m/m', country: 'USD', date: '2026-06-11T08:30:00-04:00', impact: 'High', forecast: '0.2%', previous: '0.3%', actual: '0.2%' },
  { title: 'Core CPI m/m', country: 'USD', date: '2026-06-11T08:30:00-04:00', impact: 'High', forecast: '0.3%', previous: '0.3%', actual: '' },   // 未発表→除外
  { title: 'Retail Sales m/m', country: 'EUR', date: '2026-06-11T05:00:00-04:00', impact: 'High', forecast: '', previous: '', actual: '0.1%' },   // 非US→除外
  { title: 'Flash PMI', country: 'USD', date: '2026-06-11T09:45:00-04:00', impact: 'Medium', forecast: '', previous: '52', actual: '51' },        // Medium(既定除外)
];

describe('parseFfCalendar', () => {
  it('US×High×発表済みのみ抽出する(既定)', () => {
    const evs = parseFfCalendar(SAMPLE, { includeMedium: false });
    expect(evs.map(e => e.title)).toEqual(['CPI m/m']);
    expect(evs[0]!.actual).toBe('0.2%');
    expect(evs[0]!.previous).toBe('0.3%');
    expect(evs[0]!.releaseAt).toBe(Date.parse('2026-06-11T08:30:00-04:00'));
  });
  it('includeMedium=true で Medium も含む(発表済みUS)', () => {
    const evs = parseFfCalendar(SAMPLE, { includeMedium: true });
    expect(evs.map(e => e.title).sort()).toEqual(['CPI m/m', 'Flash PMI']);
  });
  it('壊れた入力は空配列', () => {
    expect(parseFfCalendar(null, { includeMedium: false })).toEqual([]);
    expect(parseFfCalendar('x', { includeMedium: false })).toEqual([]);
  });
});

describe('computeReaction', () => {
  it('+10分の終値差(符号付)', () => {
    expect(computeReaction(38000, 38045)).toBe(45);
    expect(computeReaction(38000, 37950)).toBe(-50);
  });
  it('いずれか欠損なら null', () => {
    expect(computeReaction(null, 38000)).toBeNull();
    expect(computeReaction(38000, null)).toBeNull();
  });
});

describe('toNewsItem', () => {
  const ev: EconEvent = { title: 'CPI m/m', releaseAt: Date.parse('2026-06-11T08:30:00-04:00'), actual: '0.2%', previous: '0.3%', impact: 'High' };
  it('反応なし: 結果と前回のみ・予想は出さない', () => {
    const n = toNewsItem(ev, null);
    expect(n.title).toContain('結果 0.2%');
    expect(n.title).toContain('前回 0.3%');
    expect(n.title).not.toContain('予想');
    expect(n.title).not.toContain('反応');
    expect(n.source).toBe('米経済指標');
    expect(n.lang).toBe('ja');
    expect(n.publishedAt).toBe(ev.releaseAt);
    expect(n.id).toBe(`econ:CPI m/m:${ev.releaseAt}`);
  });
  it('反応あり: → NK225 +45pt(10分)', () => {
    const n = toNewsItem(ev, 45);
    expect(n.title).toContain('→ NK225 +45pt(10分)');
  });
  it('反応マイナス: 符号付', () => {
    expect(toNewsItem(ev, -30).title).toContain('→ NK225 -30pt(10分)');
  });
  it('日本語名マップ: CPI m/m → 消費者物価指数(前月比)', () => {
    expect(toNewsItem(ev, null).title).toContain('消費者物価指数(前月比)');
  });
});
```

- [ ] **Step 2: 失敗を確認** — `npx vitest run server/sources/economicCalendar.test.ts` → FAIL（モジュール未定義）

- [ ] **Step 3: 実装** — `server/sources/economicCalendar.ts`:
```typescript
import type { DatabaseSync } from 'node:sqlite';
import { openDb, resolveDbPath, getBarCloseNear } from '../db/store.js';
import type { NewsItem } from '../types.js';

const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const REACTION_SYMBOL = 'NIY=F';          // NK225 夜間先物(指数値)
const REACTION_WINDOW_MS = 10 * 60_000;   // 発表後10分
const NEAR_TOL_MS = 3 * 60_000;           // 終値近傍許容(欠損足対策)

export interface EconEvent {
  title: string;          // FF の英語タイトル(例 'CPI m/m')
  releaseAt: number;      // epoch ms
  actual: string;         // 結果(発表済みのみ)
  previous: string;       // 前回
  impact: 'High' | 'Medium';
}

interface FfRow { title?: unknown; country?: unknown; date?: unknown; impact?: unknown; previous?: unknown; actual?: unknown; }

// 主要指標の日本語名(無いものは英語タイトルのまま)。
const JP_NAME: Record<string, string> = {
  'CPI m/m': '消費者物価指数(前月比)',
  'CPI y/y': '消費者物価指数(前年比)',
  'Core CPI m/m': 'コア消費者物価指数(前月比)',
  'PPI m/m': '生産者物価指数(前月比)',
  'Core PPI m/m': 'コア生産者物価指数(前月比)',
  'Core PCE Price Index m/m': 'コアPCE物価指数(前月比)',
  'Non-Farm Employment Change': '非農業部門雇用者数',
  'Unemployment Rate': '失業率',
  'Average Hourly Earnings m/m': '平均時給(前月比)',
  'Federal Funds Rate': 'FF金利',
  'Core Retail Sales m/m': 'コア小売売上高(前月比)',
  'Retail Sales m/m': '小売売上高(前月比)',
  'Advance GDP q/q': 'GDP速報(前期比)',
  'ISM Manufacturing PMI': 'ISM製造業景況指数',
  'ISM Services PMI': 'ISM非製造業景況指数',
  'Unemployment Claims': '新規失業保険申請件数',
};

function jpName(title: string): string { return JP_NAME[title] ?? title; }

/** 週次JSON配列から US × (High[+Medium]) × 発表済み(actual非空) を抽出。壊れた入力は []。 */
export function parseFfCalendar(json: unknown, opts: { includeMedium: boolean }): EconEvent[] {
  if (!Array.isArray(json)) return [];
  const out: EconEvent[] = [];
  for (const r of json as FfRow[]) {
    if (!r || typeof r !== 'object') continue;
    if (r.country !== 'USD') continue;
    const impact = r.impact === 'High' ? 'High' : r.impact === 'Medium' ? 'Medium' : null;
    if (impact === null) continue;
    if (impact === 'Medium' && !opts.includeMedium) continue;
    const actual = typeof r.actual === 'string' ? r.actual.trim() : '';
    if (actual === '') continue;                         // 未発表は除外
    const releaseAt = typeof r.date === 'string' ? Date.parse(r.date) : NaN;
    if (!Number.isFinite(releaseAt)) continue;
    out.push({
      title: typeof r.title === 'string' ? r.title : '(指標)',
      releaseAt, actual,
      previous: typeof r.previous === 'string' ? r.previous.trim() : '',
      impact,
    });
  }
  return out;
}

/** 発表時点と +10分時点の終値差(pt・符号付)。いずれか欠損なら null。 */
export function computeReaction(baseClose: number | null, afterClose: number | null): number | null {
  if (baseClose === null || afterClose === null) return null;
  if (!Number.isFinite(baseClose) || !Number.isFinite(afterClose)) return null;
  return Math.round(afterClose - baseClose);
}

/** EconEvent を NewsItem に整形(予想値は出さない)。 */
export function toNewsItem(ev: EconEvent, reaction: number | null): NewsItem {
  const name = jpName(ev.title);
  const prev = ev.previous ? `（前回 ${ev.previous}）` : '';
  const react = reaction === null ? '' : ` → NK225 ${reaction >= 0 ? '+' : ''}${reaction}pt(10分)`;
  return {
    id: `econ:${ev.title}:${ev.releaseAt}`,
    title: `📊 米指標 ${name}: 結果 ${ev.actual}${prev}${react}`,
    source: '米経済指標',
    lang: 'ja',
    url: '',
    publishedAt: ev.releaseAt,
  };
}

// --- 取得 + 反応算出(副作用あり) ---
let _db: DatabaseSync | null = null;
function db(): DatabaseSync { return (_db ??= openDb(resolveDbPath())); }
const _reactionMemo = new Map<string, number>();   // id → reaction(算出済みは再計算しない)

/** 週次JSONを取得し、発表済み米指標を NewsItem[] で返す。失敗時は []。 */
export async function fetchEconomicNews(now: number, opts: { includeMedium: boolean } = { includeMedium: false }): Promise<NewsItem[]> {
  let json: unknown;
  try {
    const res = await fetch(FF_URL, { headers: { 'User-Agent': 'jp225-monitor/1.0' } });
    if (!res.ok) return [];
    json = await res.json();
  } catch { return []; }

  const events = parseFfCalendar(json, opts);
  const items: NewsItem[] = [];
  for (const ev of events) {
    let reaction: number | null = _reactionMemo.get(toNewsItem(ev, null).id) ?? null;
    if (reaction === null && now >= ev.releaseAt + REACTION_WINDOW_MS) {
      try {
        const base = getBarCloseNear(db(), REACTION_SYMBOL, ev.releaseAt, NEAR_TOL_MS);
        const after = getBarCloseNear(db(), REACTION_SYMBOL, ev.releaseAt + REACTION_WINDOW_MS, NEAR_TOL_MS);
        reaction = computeReaction(base, after);
        if (reaction !== null) _reactionMemo.set(`econ:${ev.title}:${ev.releaseAt}`, reaction);
      } catch { reaction = null; }
    }
    items.push(toNewsItem(ev, reaction));
  }
  return items;
}
```

- [ ] **Step 4: 成功を確認** — `npx vitest run server/sources/economicCalendar.test.ts` → PASS

- [ ] **Step 5: コミット**
```bash
git add server/sources/economicCalendar.ts server/sources/economicCalendar.test.ts
git commit -m "feat(news): 米経済指標の取得・反応算出・NewsItem変換(economicCalendar)"
```

---

## Task 2: newsLoop が RSS と経済指標をマージ配信

**Files:** Modify `server/loops/newsLoop.ts`

- [ ] **Step 1: 実装** — `tick()` を改修:
```typescript
import { fetchAllNews } from '../sources/rssAggregator.js';
import { fetchEconomicNews } from '../sources/economicCalendar.js';
import { inPollWindow } from '../../collector/session.js';
import { broadcast } from '../sse/broker.js';
import { setNews, getNews } from '../cache.js';
import { resolveNewsPollMs } from '../configStore.js';

let timer: NodeJS.Timeout | null = null;
let running = false;
let intervalMs = resolveNewsPollMs();

async function tick(): Promise<void> {
  if (!inPollWindow(Date.now())) return;   // 取引時間外は何もしない(軽量化)
  try {
    const now = Date.now();
    // RSS と 米経済指標を並行取得(指標が落ちても RSS は出す)。
    const [rss, econ] = await Promise.all([
      fetchAllNews(),
      fetchEconomicNews(now).catch(() => []),
    ]);
    // RSS 全失敗かつ既存ありなら据置(指標のみでボードを置換しない)。
    if (rss.length === 0 && econ.length === 0 && getNews().length > 0) {
      console.warn('[newsLoop] fetched 0 items; keeping previous news');
      return;
    }
    const merged = [...econ, ...rss].sort((a, b) => b.publishedAt - a.publishedAt);
    setNews(merged);
    broadcast({ type: 'news', payload: merged });
  } catch (err) {
    console.error('[newsLoop] error:', err instanceof Error ? err.message : err);
  }
}
// schedule/start/stop/restart は不変(既存のまま)。
```

(`schedule()` 以降は既存のまま。)

- [ ] **Step 2: 既存 news ループ系テストがあれば緑を確認**
Run: `npx vitest run server/` (該当があるもの)
Expected: 既存緑 + 破綻なし

- [ ] **Step 3: tsc**
Run: `npx tsc --noEmit`
Expected: エラーなし

- [ ] **Step 4: コミット**
```bash
git add server/loops/newsLoop.ts
git commit -m "feat(news): newsLoop で RSS と米経済指標をマージ配信"
```

---

## Task 3: フロント装飾（任意・最小）

**Files:** Modify `web/components/newsFeed.ts`（あれば）/ `web/style.css`

- [ ] **Step 1: source==='米経済指標' に淡い強調(任意)** — 既存 newsFeed の各項目描画で `item.source === '米経済指標'` のとき li に class `news-econ` を付与し、`web/style.css` に:
```css
.news-econ { border-left: 3px solid #d6a93a; padding-left: 6px; }
```
（MVPでは 📊 絵文字で識別できるため、CSSが面倒なら省略可。機能には影響しない。）

- [ ] **Step 2: tsc + 目視** — `npx tsc --noEmit` 緑。`npm run dev` で NEWS に 📊 項目が出ることを確認(夜間・指標発表時)。

- [ ] **Step 3: コミット**
```bash
git add web/components/newsFeed.ts web/style.css
git commit -m "feat(ui): NEWS の米経済指標項目を軽く強調"
```

---

## Task 4: 版を 0.7.6 に上げて署名リリース

**Files:** `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`(+`Cargo.lock`)

- [ ] **Step 1: 3(+1)ファイルの version を 0.7.6 に**
- [ ] **Step 2: 全テスト緑 + tsc** — `npx vitest run` / `npx tsc --noEmit`
- [ ] **Step 3: 署名ビルド(monitor 鍵=無パスフレーズ)** — monitor のリリース手順に従う(`npm run release:build` 等)。
- [ ] **Step 4: latest.json + GitHub リリース(monitor の releases リポジトリ・v0.7.6)**
- [ ] **Step 5: バージョンコミット** — `chore(release): bump version to 0.7.6`

---

## 受け入れ基準
- 発表済みの米高インパクト指標が NEWS にインライン表示(結果・前回)。
- 発表後10分で `→ NK225 ±pt(10分)` の反応が付く(夜間ザラ場で価格がある場合)。
- 予想値は表示されない。
- 取得失敗/価格欠損でも既存ニュースは正常・UI不変。
- 既存テスト緑・tsc クリーン・新規ユニットテスト緑。
