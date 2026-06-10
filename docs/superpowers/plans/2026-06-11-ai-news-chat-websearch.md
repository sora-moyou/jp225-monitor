# monitor AI ニュース改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アラートのニュース窓を「実提示ニュース以降」に正し、AIチャットに Tavily Web検索(function-calling)と会話文脈に沿ったローカルニュース選別を加える。

**Architecture:** ①`shockWindow` のアンカーを実説明生成時のみ前進(`explain()` が提示ニュースの最大publishedAtを返し `explain.ts` が更新)。②`web_search` ツール+`tavilySearch`、`chat()` にツール実行ループ。③`formatNewsForChat` を会話キーワードで関連度フィルタ。

**Tech Stack:** TypeScript(NodeNext ESM, `.js` import拡張子), vitest, express, openai SDK(各プロバイダのOpenAI互換), Tavily REST。

仕様: `docs/superpowers/specs/2026-06-11-ai-news-chat-websearch-design.md`

---

## File Structure

- Modify: `server/shockWindow.ts` — アンカーを `lastReferencedNewsAt` + `noteReferencedNews` に
- Modify: `server/alertHistory.ts` — 不要になった `noteAlert` 呼び出し/import 削除
- Modify: `server/llm/openai.ts` — `explain()` 戻り値変更 / `chat()` ツールループ / `formatNewsForChat` 関連度
- Modify: `server/routes/explain.ts` — 説明後にカーソル前進
- Create: `server/llm/webSearch.ts` — Tavily 検索 + `isWebSearchEnabled`
- Modify: `server/configStore.ts` — `tavilyKey` + `resolveTavilyKey`
- Modify: `server/routes/settings.ts` — Tavily キー status/保存
- Modify: `web/index.html`, `web/components/settingsModal.ts` — Tavily キー入力欄
- Tests: `server/shockWindow.test.ts`, `server/llm/webSearch.test.ts`, `server/llm/chatTools.test.ts`, `server/llm/newsSelect.test.ts`(新規/追記)

---

### Task 1: ① ニュース窓アンカーを実参照ベースへ（shockWindow）

**Files:**
- Modify: `server/shockWindow.ts`
- Modify: `server/alertHistory.ts:8,114`
- Test: `server/shockWindow.test.ts`

- [ ] **Step 1: Write the failing test**

`server/shockWindow.test.ts`（新規）:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { noteReferencedNews, newsSinceForAlert, _reset } from './shockWindow.js';

describe('shockWindow 実参照アンカー', () => {
  beforeEach(() => _reset());
  it('初期は 0', () => { expect(newsSinceForAlert()).toBe(0); });
  it('noteReferencedNews で単調前進', () => {
    noteReferencedNews(1000);
    expect(newsSinceForAlert()).toBe(1000);
    noteReferencedNews(500);                 // 過去は無視
    expect(newsSinceForAlert()).toBe(1000);
    noteReferencedNews(2000);
    expect(newsSinceForAlert()).toBe(2000);
  });
  it('0 は前進させない（材料なし）', () => {
    noteReferencedNews(1500);
    noteReferencedNews(0);
    expect(newsSinceForAlert()).toBe(1500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/Users/user/Desktop/Finance_Monitor && npx vitest run server/shockWindow.test.ts`
Expected: FAIL（`noteReferencedNews` 未エクスポート）

- [ ] **Step 3: 実装**

`server/shockWindow.ts` を全置換:

```ts
// アラート説明で「ユーザーが実際に提示されたニュース以降」だけを次回参照するためのアンカー。
// /api/explain が実際に説明を生成した時のみ前進する(API節約モード/テクニカル固定文では /api/explain を
// 呼ばないので据置)。値=直近説明で提示したニュースの最大 publishedAt。
let lastReferencedNewsAt = 0;

/** 説明で実提示したニュースの最大 publishedAt を記録(単調・0は無視)。 */
export function noteReferencedNews(maxPublishedAt: number): void {
  if (maxPublishedAt > lastReferencedNewsAt) lastReferencedNewsAt = maxPublishedAt;
}

/** 説明で参照すべきニュースの開始時刻(=直近で実提示したニュース以降)。0=まだ無し→従来の固定窓。 */
export function newsSinceForAlert(): number { return lastReferencedNewsAt; }

export function _reset(): void { lastReferencedNewsAt = 0; }
```

`server/alertHistory.ts`: `import { noteAlert } from './shockWindow.js';`（8行）を削除し、114行
`if (EXPLAINED_ALERT_KINDS.has(p.detectionKind)) noteAlert(p.triggeredAt);` を**削除**（アンカー前進は説明生成時に移譲）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/shockWindow.test.ts && npx tsc --noEmit`
Expected: PASS / tsc エラーなし（`noteAlert` 参照が消えていること）

- [ ] **Step 5: Commit**

```bash
git add server/shockWindow.ts server/alertHistory.ts server/shockWindow.test.ts
git commit -m "feat(news): アラートのニュース窓を実参照アンカーへ(noteReferencedNews)"
```

---

### Task 2: ① explain() が提示ニュース最大時刻を返し、explain.ts が前進

**Files:**
- Modify: `server/llm/openai.ts`（`explain()` 200-296, `rankAndFormatNews` 185-198）
- Modify: `server/routes/explain.ts`
- Modify: `server/llm/openai.test.ts`（既存 explain テストの戻り値追従）
- Test: `server/llm/newsSelect.test.ts`

> 既存 `server/llm/openai.test.ts:37-47` は `const text = await explain({...}); expect(text).toContain(...)` 形式。戻り値が `{text,...}` になるので **`const { text } = await explain({...})`** に修正する（Step 3 に含める）。grep で `explain(` の呼び出しは routes/explain.ts と openai.test.ts のみ。

- [ ] **Step 1: Write the failing test**

`server/llm/newsSelect.test.ts`（新規）。材料なしで explain が早期returnし `newsMaxPublishedAt=0` を返すことを検証（LLM未呼び出しパス）:

```ts
import { describe, it, expect } from 'vitest';
import { explain } from './openai.js';

describe('explain 戻り値(実参照アンカー)', () => {
  it('材料ニュースなし→テクニカル要因・newsMaxPublishedAt=0(LLM未呼び出し)', async () => {
    const r = await explain({
      symbol: 'NIY=F', symbolLabel: '日経平均先物', changePercent: 0.05, windowSeconds: 30,
      detectionKind: 'slope', direction: 'up', change15min: null, pa15min: null, range1h: null,
      news: [], crossAsset: [],
    });
    expect(r.newsMaxPublishedAt).toBe(0);
    expect(typeof r.text).toBe('string');
    expect(r.text).toContain('テクニカル');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/llm/newsSelect.test.ts`
Expected: FAIL（`r.newsMaxPublishedAt` undefined / explain が string を返す）

- [ ] **Step 3: 実装**

`server/llm/openai.ts` の `rankAndFormatNews` を **pool 受け取り**に変更:

```ts
function rankAndFormatNews(pool: NewsItem[], symbol: string, now: number): string {
  const keywords = INSTRUMENT_KEYWORDS[symbol] ?? [];
  const ranked = [...pool]
    .map(n => ({ n, s: scoreNews(n, keywords, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map(x => x.n);
  if (ranked.length === 0) return '(直近4時間のニュース取得なし)';
  return ranked.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}
```

`explain()` を `Promise<{ text: string; newsMaxPublishedAt: number }>` に変更。冒頭でプール確定:

```ts
export async function explain(input: ExplainInput): Promise<{ text: string; newsMaxPublishedAt: number }> {
  const now = Date.now();
  const pool = selectNewsPool(input.news, now, input.newsSince ?? 0, input.newsWindowMs ?? NEWS_RECENT_WINDOW_MS);
  const newsMaxPublishedAt = pool.reduce((m, n) => Math.max(m, n.publishedAt), 0);
  // …(kindLabel 等は既存のまま)…
```

材料なし早期returnを pool ベースに（253-257行）:

```ts
  if (!isTechnicalPattern && input.detectionKind !== 'crash' && pool.length === 0) {
    const l2 = input.l2Recent ? ` 直近のテクニカル状況: ${input.l2Recent}。` : '';
    return { text: `直前の急変以降、該当する材料ニュースなし → テクニカル要因の可能性。${l2}`, newsMaxPublishedAt };
  }
```

`userPrompt` 内の `rankAndFormatNews(input, now)`（266行）を `rankAndFormatNews(pool, input.symbol, now)` に。

`callWithFallback` の戻り（278-295行）を text と max でラップ:

```ts
  const text = await callWithFallback(async (p) => {
    const completion = await p.client!.chat.completions.create({
      model: p.config.model, temperature: 0.3, max_tokens: 1500,
      messages: [{ role: 'system', content: LLM_SYSTEM_PROMPT }, { role: 'user', content: userPrompt }],
    });
    const choice = completion.choices[0];
    const t = choice?.message?.content?.trim() ?? '(no response)';
    return choice?.finish_reason === 'length' ? t + ' …(token切れ)' : t;
  }, 'explain');
  return { text, newsMaxPublishedAt };
}
```

`server/routes/explain.ts`: import に `noteReferencedNews` 追加し、呼び出し結果を反映:

```ts
import { newsSinceForAlert, noteReferencedNews } from '../shockWindow.js';
// …
    const result = await explain({ /* …既存の引数… */ });
    if (result.newsMaxPublishedAt > 0) noteReferencedNews(result.newsMaxPublishedAt);   // 実提示で前進
    res.json({ explanation: result.text });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/llm/newsSelect.test.ts && npx tsc --noEmit`
Expected: PASS / tsc エラーなし

- [ ] **Step 5: Commit**

```bash
git add server/llm/openai.ts server/routes/explain.ts server/llm/newsSelect.test.ts
git commit -m "feat(news): explainが提示ニュース最大時刻を返し説明生成時のみアンカー前進"
```

---

### Task 3: ② Tavily 検索ユーティリティ + キー解決

**Files:**
- Create: `server/llm/webSearch.ts`
- Modify: `server/configStore.ts`（`UserConfig` 12-, `resolveApiKey` 付近）
- Test: `server/llm/webSearch.test.ts`

- [ ] **Step 1: Write the failing test**

`server/llm/webSearch.test.ts`（新規）。`fetch` をスタブ:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tavilySearch, formatHits } from './webSearch.js';

afterEach(() => vi.unstubAllGlobals());

describe('tavilySearch', () => {
  it('正常応答を SearchHit[] にパース', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'http://x', content: 'C', published_date: '2026-06-11' }] }),
    })));
    const hits = await tavilySearch('日経 急落', 5, 'KEY');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: 'T', url: 'http://x', content: 'C' });
  });
  it('非200は空配列', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await tavilySearch('q', 5, 'KEY')).toEqual([]);
  });
  it('formatHits は番号付きテキスト', () => {
    const s = formatHits([{ title: 'A', url: 'u', content: 'c' }]);
    expect(s).toContain('A');
    expect(s).toContain('u');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/llm/webSearch.test.ts`
Expected: FAIL（モジュール無し）

- [ ] **Step 3: 実装**

`server/configStore.ts`: `UserConfig` に `tavilyKey?: string;` を追加（geminiKey 等の隣、13行付近）。末尾の resolver 群に追加:

```ts
export function resolveTavilyKey(): string | undefined {
  const fromConfig = loadConfig().tavilyKey;
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  return process.env.TAVILY_API_KEY?.trim();
}
```

`server/llm/webSearch.ts`（新規）:

```ts
// チャットの web_search ツール用。Tavily REST を叩いて要約付き検索結果を返す。
// キー未設定/失敗時は空配列(チャットは検索なしで継続)。
import { resolveTavilyKey } from '../configStore.js';

export interface SearchHit { title: string; url: string; content: string; publishedDate?: string; }

export function isWebSearchEnabled(): boolean {
  return !!resolveTavilyKey();
}

export async function tavilySearch(query: string, maxResults = 5, key = resolveTavilyKey()): Promise<SearchHit[]> {
  if (!key) return [];
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', topic: 'general' }),
    });
    if (!r.ok) { console.warn(`[webSearch] Tavily ${r.status}`); return []; }
    const data = await r.json() as { results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }> };
    return (data.results ?? []).map(x => ({
      title: x.title ?? '', url: x.url ?? '', content: x.content ?? '', publishedDate: x.published_date,
    }));
  } catch (e) {
    console.warn(`[webSearch] error: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return '(検索結果なし)';
  return hits.map((h, i) => `${i + 1}. ${h.title}${h.publishedDate ? ` (${h.publishedDate})` : ''}\n   ${h.url}\n   ${h.content}`).join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/llm/webSearch.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/llm/webSearch.ts server/configStore.ts server/llm/webSearch.test.ts
git commit -m "feat(chat): Tavily web検索ユーティリティ + tavilyKey 解決"
```

---

### Task 4: ② chat() に web_search ツール実行ループ

**Files:**
- Modify: `server/llm/openai.ts`（`chat()` 358-388, `CHAT_SYSTEM_PROMPT`）
- Test: `server/llm/chatTools.test.ts`

- [ ] **Step 1: Write the failing test**

ツールループを純関数 `runChatWithTools` として抽出しテスト。`server/llm/chatTools.test.ts`（新規）:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runChatWithTools } from './openai.js';

function fakeCreate(seq: any[]) {
  let i = 0;
  return vi.fn(async () => seq[i++]);
}

describe('runChatWithTools', () => {
  it('tool_calls 無し→単発で content 返す', async () => {
    const create = fakeCreate([{ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }]);
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], async () => 'R', 3);
    expect(out).toBe('ok');
    expect(create).toHaveBeenCalledTimes(1);
  });
  it('1回 tool_call→検索→最終回答', async () => {
    const create = fakeCreate([
      { choices: [{ message: { content: null, tool_calls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"q"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [{ message: { content: '最終' }, finish_reason: 'stop' }] },
    ]);
    const search = vi.fn(async () => 'SEARCHED');
    const out = await runChatWithTools(create as any, [{ role: 'user', content: 'hi' }], [{}], search, 3);
    expect(out).toBe('最終');
    expect(search).toHaveBeenCalledWith('q');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/llm/chatTools.test.ts`
Expected: FAIL（`runChatWithTools` 未エクスポート）

- [ ] **Step 3: 実装**

`server/llm/openai.ts` に web検索 import とツールループ helper を追加（`chat()` の前）:

```ts
import { isWebSearchEnabled, tavilySearch, formatHits } from './webSearch.js';

const WEB_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description: '最新の市況・ニュース・出来事を調べる。価格や材料を聞かれて手元のコンテキストに無い/古い時に使う。',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '検索クエリ(日本語可)' } }, required: ['query'] },
  },
};
const MAX_TOOL_ROUNDS = 3;

type CreateFn = (params: Record<string, unknown>) => Promise<any>;

/** ツール実行ループ。tool_calls が出る限り検索→再投入。上限到達時は tools 無しで最終回答。テスト可能な純ループ。 */
export async function runChatWithTools(
  create: CreateFn, messages: any[], tools: unknown[], search: (q: string) => Promise<string>, maxRounds = MAX_TOOL_ROUNDS,
): Promise<string> {
  const msgs = [...messages];
  for (let round = 0; round < maxRounds; round++) {
    const completion = await create({ messages: msgs, tools, tool_choice: 'auto' });
    const choice = completion.choices?.[0];
    const msg = choice?.message;
    const calls = msg?.tool_calls;
    if (!calls || calls.length === 0) {
      const text = msg?.content?.trim() ?? '(no response)';
      return choice?.finish_reason === 'length' ? text + ' …(token切れ)' : text;
    }
    msgs.push(msg);
    for (const tc of calls) {
      let q = '';
      try { q = JSON.parse(tc.function?.arguments ?? '{}').query ?? ''; } catch { q = ''; }
      const result = q ? await search(q) : '(クエリ空)';
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }
  // 上限到達: tools 無しで必ず1回答
  const final = await create({ messages: msgs });
  return final.choices?.[0]?.message?.content?.trim() ?? '(no response)';
}
```

`CHAT_SYSTEM_PROMPT` 末尾に1行追記:

```
- web_search ツールが使える場合、手元の【市場の現状】で足りない最新の出来事・ニュースは検索して確認し、引用時は「(出典/日時)」を簡潔に添える。足りる時は無理に検索しない
```

`chat()` を helper 利用に改修（temperature/max_tokens は維持）:

```ts
  const useTools = isWebSearchEnabled();
  return callWithFallback(async (p) => {
    // 注: 静的オブジェクトに messages が無いと SDK オーバーロード解決で TS2769。as any でキャスト。
    const create: CreateFn = (params) => p.client!.chat.completions.create({
      model: p.config.chatModel, temperature: 0.5, max_tokens: 8000, ...params,
    } as any);
    if (!useTools) {
      const completion = await create({ messages: [{ role: 'system', content: systemPrompt }, ...input.messages] });
      const choice = completion.choices[0];
      const text = choice?.message?.content?.trim() ?? '(no response)';
      return choice?.finish_reason === 'length' ? text + ' …(token切れ)' : text;
    }
    return runChatWithTools(
      create,
      [{ role: 'system', content: systemPrompt }, ...input.messages],
      [WEB_SEARCH_TOOL],
      async (q) => formatHits(await tavilySearch(q)),
    );
  }, 'chat');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/llm/chatTools.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/llm/openai.ts server/llm/chatTools.test.ts
git commit -m "feat(chat): web_searchツール実行ループ(Tavily, 全プロバイダ対応)"
```

---

### Task 5: ③ チャットのローカルニュースを会話文脈で関連度フィルタ

**Files:**
- Modify: `server/llm/openai.ts`（`formatNewsForChat` 337-343, `chat()` 360-366）
- Test: `server/llm/newsSelect.test.ts`（追記）

- [ ] **Step 1: Write the failing test**

`server/llm/newsSelect.test.ts` に追記:

```ts
import { formatNewsForChat } from './openai.js';

describe('formatNewsForChat 文脈フィルタ', () => {
  const now = Date.now();
  const news = [
    { id: '1', title: 'トヨタ 通期見通し上方修正', source: 'X', lang: 'ja' as const, url: 'u1', publishedAt: now - 60000 },
    { id: '2', title: '米CPI 予想下回る', source: 'Y', lang: 'ja' as const, url: 'u2', publishedAt: now - 120000 },
  ];
  it('クエリ語に一致するニュースを優先', () => {
    const s = formatNewsForChat(news, now, 'トヨタの決算どう?');
    expect(s.indexOf('トヨタ')).toBeLessThan(s.indexOf('CPI') === -1 ? Infinity : s.indexOf('CPI'));
    expect(s).toContain('トヨタ');
  });
  it('一致ゼロなら直近にフォールバック', () => {
    const s = formatNewsForChat(news, now, '全く無関係なクエリ xyz');
    expect(s).toContain('トヨタ');
    expect(s).toContain('CPI');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/llm/newsSelect.test.ts`
Expected: FAIL（`formatNewsForChat` が queryText を取らない）

- [ ] **Step 3: 実装**

`server/llm/openai.ts` の `formatNewsForChat` を関連度対応に:

```ts
function formatNewsForChat(news: NewsItem[], now: number, queryText = ''): string {
  if (news.length === 0) return '(ニュースなし)';
  const terms = queryText.toLowerCase().split(/[\s、。,.!?？！「」（）()]+/).filter(t => t.length >= 2);
  const scored = news.map(n => {
    const title = n.title.toLowerCase();
    const hits = terms.reduce((c, t) => c + (title.includes(t) ? 1 : 0), 0);
    return { n, hits };
  });
  const relevant = scored.filter(s => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.n.publishedAt - a.n.publishedAt)
    .slice(0, 12)
    .map(s => s.n);
  const list = relevant.length > 0 ? relevant : news.slice(0, 15);   // 一致なし→直近フォールバック
  return list.map(n => {
    const ageMin = Math.max(0, Math.round((now - n.publishedAt) / 60000));
    return `- [${ageMin}分前] [${n.source}] ${n.title}`;
  }).join('\n');
}
```

`formatNewsForChat` を export（テスト用）に: `export function formatNewsForChat(...)`。

`chat()` で最新 user 発話を渡す（systemPrompt 構築箇所 360-366）:

```ts
  const lastUser = [...input.messages].reverse().find(m => m.role === 'user')?.content ?? '';
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices, now)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    (input.correlate ? `${formatCorrelate(input.correlate)}\n\n` : '') +
    `■ 関連ニュース:\n${formatNewsForChat(input.news, now, lastUser)}`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/llm/newsSelect.test.ts && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/llm/openai.ts server/llm/newsSelect.test.ts
git commit -m "feat(chat): ローカルニュースを会話文脈で関連度フィルタ"
```

---

### Task 6: Tavily キーの設定UI/API

**Files:**
- Modify: `server/routes/settings.ts`（27-32, 44-47, 93-97）
- Modify: `web/index.html`（key-openai 入力の隣。既存 trio=key-gemini/key-groq/key-openai に倣う）
- Modify: `web/components/settingsModal.ts`（status型 12-13, body型 42-44, el型 81-83, placeholder 103-111, clear 348-350, body 366-371）
- Modify: `web/main.ts`（**SettingsElements の構築は main.ts:146-148**。`inputTavily` をここで取得）

- [ ] **Step 1: 実装（UI配線。tscと手動で検証）**

`server/routes/settings.ts`:
- `getSettingsHandler` の返却に追加（32行の後）: `tavilySet: !!config.tavilyKey, tavilyFromEnv: !config.tavilyKey && !!process.env.TAVILY_API_KEY?.trim(),`
- `SettingsBody` に追加（47行の後）: `tavilyKey?: string | null;`
- `next` 構築に追加（96行の後）: `tavilyKey: applyStringField(existing.tavilyKey, body.tavilyKey),`

`web/index.html`: `<input ... id="key-groq" ...>` の入力ブロックを複製し Tavily 欄を追加（ラベル「Tavily(Web検索) — [キー取得 ↗](https://app.tavily.com)」、`<input type="password" id="key-tavily" autocomplete="off" />`）。

`web/components/settingsModal.ts`:
- status 型(12-13行)に `tavilySet: boolean; tavilyFromEnv: boolean;` 追加。
- body 型(42-44行)に `tavilyKey?: string | null;` 追加。
- el 型(81-83行)に `inputTavily: HTMLInputElement;` 追加。

`web/main.ts`（**SettingsElements 構築箇所 146-148行**）に追加: `inputTavily: document.getElementById('key-tavily') as HTMLInputElement,`（inputGemini と同じ場所）。
- placeholder(111行の後): 
  ```ts
  el.inputTavily.placeholder = current?.tavilySet ? '設定済み (変更するにはここに入力)'
    : current?.tavilyFromEnv ? '環境変数から読込中' : 'tvly-...';
  ```
- clear(350行の後): `el.inputTavily.value = '';`
- body 構築(371行の後): `const tv = el.inputTavily.value.trim(); if (tv) body.tavilyKey = tv;`

- [ ] **Step 2: 型チェック + ビルド健全性**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc エラーなし / 全テスト緑

- [ ] **Step 3: 手動確認（任意）**

Run: `npm run dev`（または既存の起動コマンド）→ 設定モーダルに Tavily 欄が出て保存できる。`/api/settings` の GET に `tavilySet` が含まれる。

- [ ] **Step 4: Commit**

```bash
git add server/routes/settings.ts web/index.html web/components/settingsModal.ts
git commit -m "feat(settings): Tavily APIキー設定欄(config/env)"
```

---

## リリース（実装完了後）

- [ ] 全テスト緑: `npx vitest run` ＋ `npx tsc --noEmit`
- [ ] エバリュエーター/コードレビュー（①アンカー前進の条件・②ツールループの停止性とプロバイダ横断・③フォールバック・キー未設定時の後方互換を重点）
- [ ] 版 0.7.3 → **0.7.4**（package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml）
- [ ] 署名ビルド（monitor 鍵=無パスフレーズ）→ GitHub リリース

---

## Self-Review メモ

- **Spec coverage:** §4①→Task1(shockWindow)+Task2(explain/explain.ts) / §5②→Task3(webSearch)+Task4(chatツール) / §6③→Task5 / §7キー→Task3(resolve)+Task6(UI)。
- **型整合:** `noteReferencedNews`/`newsSinceForAlert`(Task1) を Task2 explain.ts で使用。`explain()` 戻り `{text,newsMaxPublishedAt}`(Task2)。`SearchHit`/`tavilySearch`/`formatHits`/`isWebSearchEnabled`(Task3) を Task4 で使用。`runChatWithTools`(Task4) はテスト可能な純ループ。`formatNewsForChat(news,now,queryText)`(Task5)。`resolveTavilyKey`/`tavilyKey`(Task3) を Task6 settings で使用。
- **Placeholder:** なし。UI(Task6)は tsc + 手動確認（既存テスト無しの領域）。
- **注意:** `noteAlert` 撤去で `shockWindow` の旧 prevAlertAt 依存を完全に断つ(Task1 で alertHistory の呼び出しも削除)。
