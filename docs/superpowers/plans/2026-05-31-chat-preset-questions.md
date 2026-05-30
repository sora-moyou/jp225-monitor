# AI チャットの定型質問ボタン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 既存 AI チャットに定型質問ボタン2つ(+番号ショートカット)を足し、表示文(簡潔)と送信文(詳細)を分離。①②の精度向上のためチャット文脈に日経225先物の簡易テクニカル要約を追加する。

**Architecture:** フロント `chatBoard.ts` が PRESETS(label/prompt)を持ち、`Message.display` で吹き出し表示と LLM 送信を分離。サーバは新規 `chatContext.ts` が `getCachedBars`+`computeContext` から NIY=F のテクニカル要約を組み立て、`chat()` のシステムプロンプトに差し込む。

**Tech Stack:** Vanilla TypeScript + Vite, Express, vitest。外部ライブラリ追加なし。ESM (`.js` 拡張子付き import)。

---

## File Structure

- `server/chatContext.ts` (Create): NIY=F テクニカル要約の文字列化。`getCachedBars`/`computeContext` に依存。
- `server/chatContext.test.ts` (Create): bars 注入で要約/`null` を検証。
- `server/llm/openai.ts` (Modify): `ChatInput.technical` 追加 + `chat()` プロンプトに差し込み。
- `server/routes/chat.ts` (Modify): `buildNikkeiTechnical()` を呼び `chat()` へ渡す。
- `web/components/chatBoard.ts` (Modify/rewrite): PRESETS, `Message.display`, `send()` リファクタ, 番号ショートカット, preset ボタン。
- `web/index.html` (Modify): 定型ボタン行を追加。
- `web/main.ts` (Modify): preset ボタン群を `initChat` に渡す。
- `web/styles.css` (Modify): `.chat-presets` / `.chat-preset` スタイル。

依存方向: `chat.ts → chatContext.ts → alertLoop(getCachedBars)/alertDetector(computeContext)`。循環なし。

---

### Task 1: server/chatContext.ts — NIY=F テクニカル要約

**Files:**
- Create: `server/chatContext.ts`
- Test: `server/chatContext.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/chatContext.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildNikkeiTechnical } from './chatContext.js';
import type { Bar } from './correlation.js';

// 単調増加 70 本: 現値 > 5分平均 > 60分平均 → 上昇寄り
function rising(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10000 + i * 10 }));
}

describe('buildNikkeiTechnical', () => {
  it('summarizes current price, 1h range, 15m change and trend for a rising series', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars);
    expect(out).not.toBeNull();
    expect(out!).toContain('日経225先物');
    expect(out!).toContain('現値');
    expect(out!).toContain('1時間');
    expect(out!).toContain('15分変化率');
    expect(out!).toContain('傾向: 上昇寄り');
  });

  it('returns null when there are too few bars', () => {
    const getBars = () => Array.from({ length: 10 }, (_, i) => ({ t: i, close: 100 }));
    expect(buildNikkeiTechnical(getBars)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- server/chatContext.test.ts`
Expected: FAIL — cannot find module `./chatContext.js`.

- [ ] **Step 3: Implement `server/chatContext.ts`**

```ts
import { getCachedBars } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
export function buildNikkeiTechnical(
  getBars: (symbol: string) => Bar[] = getCachedBars,
): string | null {
  const bars = getBars(NIKKEI);
  if (bars.length < 62) return null;
  const closes = bars.map(b => b.close);
  const cur = closes[closes.length - 1]!;
  const sma = (n: number): number => {
    const s = closes.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const smaShort = sma(5);
  const smaLong = sma(60);
  const { change15min, range1h } = computeContext(bars);
  const trend =
    cur > smaShort && smaShort > smaLong ? '上昇寄り' :
    cur < smaShort && smaShort < smaLong ? '下降寄り' : 'レンジ/もみ合い';
  const lines = [
    `現値 ${cur.toFixed(1)}`,
    range1h ? `1時間 高値 ${range1h.high.toFixed(1)} / 安値 ${range1h.low.toFixed(1)}` : null,
    change15min !== null ? `15分変化率 ${change15min >= 0 ? '+' : ''}${change15min.toFixed(2)}%` : null,
    `短期(5分平均) ${smaShort.toFixed(1)} / 長期(60分平均) ${smaLong.toFixed(1)} → 傾向: ${trend}`,
  ].filter((x): x is string => x !== null);
  return `■ 日経225先物 (NIY=F) テクニカル:\n${lines.join('\n')}`;
}
```

Before implementing, confirm `computeContext(bars)` returns `{ change15min: number | null, range1h: { high: number; low: number } | null, ... }` by reading `server/alertDetector.ts` (it is destructured the same way in `server/loops/alertLoop.ts`). `Bar` is `{ t: number; close: number }` from `server/correlation.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- server/chatContext.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/chatContext.ts server/chatContext.test.ts
git commit -m "feat(chat): NIY=F technical summary for chat context"
```

---

### Task 2: openai.ts — ChatInput.technical + プロンプト差し込み

**Files:**
- Modify: `server/llm/openai.ts:253` (ChatInput) and `:287-291` (chat systemPrompt)

- [ ] **Step 1: Add the `technical` field to ChatInput**

In `server/llm/openai.ts`, change:
```ts
export interface ChatInput { messages: ChatMessage[]; prices: Price[]; news: NewsItem[]; }
```
to:
```ts
export interface ChatInput { messages: ChatMessage[]; prices: Price[]; news: NewsItem[]; technical?: string | null; }
```

- [ ] **Step 2: Inject technical into the system prompt**

In `chat()`, change the `systemPrompt` assignment:
```ts
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices)}\n\n` +
    `■ 直近ニュース (上位15件):\n${formatNewsForChat(input.news, now)}`;
```
to (insert technical between prices and news):
```ts
  const systemPrompt =
    `${CHAT_SYSTEM_PROMPT}\n\n` +
    `【市場の現状 ${new Date(now).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}】\n\n` +
    `■ 現在価格:\n${formatPricesForChat(input.prices)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    `■ 直近ニュース (上位15件):\n${formatNewsForChat(input.news, now)}`;
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck` → no errors.
Run: `npm run test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add server/llm/openai.ts
git commit -m "feat(chat): accept optional technical context in chat prompt"
```

---

### Task 3: chat.ts — テクニカル要約を渡す

**Files:**
- Modify: `server/routes/chat.ts:2-3` (import), `:26-30` (chat call)

- [ ] **Step 1: Add the import**

In `server/routes/chat.ts`, below `import { getPrices, getNews } from '../cache.js';` add:
```ts
import { buildNikkeiTechnical } from '../chatContext.js';
```

- [ ] **Step 2: Pass technical into the chat() call**

Change:
```ts
    const reply = await chat({
      messages,
      prices: getPrices(),
      news: getNews(),
    });
```
to:
```ts
    const reply = await chat({
      messages,
      prices: getPrices(),
      news: getNews(),
      technical: buildNikkeiTechnical(),
    });
```

- [ ] **Step 3: Typecheck + full test suite**

Run: `npm run typecheck` → no errors.
Run: `npm run test` → all pass.

- [ ] **Step 4: Commit**

```bash
git add server/routes/chat.ts
git commit -m "feat(chat): attach NIY=F technical summary to chat requests"
```

---

### Task 4: chatBoard.ts — PRESETS + display/送信分離 + 番号ショートカット

**Files:**
- Modify (full rewrite): `web/components/chatBoard.ts`

- [ ] **Step 1: Replace the entire file with the new implementation**

Overwrite `web/components/chatBoard.ts` with:

```ts
// シンプルなAIチャット (セッション内のみ、ページリロードで消える)

import { apiUrl } from '../lib/apiBase.js';

interface Message { role: 'user' | 'assistant'; content: string; display?: string; }

interface Preset { key: string; label: string; prompt: string; }

const PRESETS: Preset[] = [
  { key: '1',
    label: '現在のトレンド方向と上値/下値のメド',
    prompt: '今の日経225先物のトレンド方向(上昇/下降/レンジ)と根拠、当面の上値メド・下値メドを、直近の値動き・1時間高安・節目から具体的に。' },
  { key: '2',
    label: '急変の理由を詳しく',
    prompt: '直近で起きた急変の理由を、ニュース・他資産の動き・テクニカルの観点から、結論→根拠の順で詳しく説明して。' },
];

const history: Message[] = [];

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c] as string));
}

function renderMessages(messagesEl: HTMLElement, hintEl: HTMLElement | null): void {
  if (hintEl) hintEl.style.display = history.length === 0 ? '' : 'none';
  Array.from(messagesEl.children).forEach(c => {
    if (!c.classList.contains('chat-hint')) c.remove();
  });
  for (const m of history) {
    const div = document.createElement('div');
    div.className = `chat-msg ${m.role}`;
    if (m.content === '__thinking__') {
      div.classList.add('thinking');
      div.textContent = '考え中...';
    } else {
      div.innerHTML = escapeHtml(m.display ?? m.content);
    }
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function sendToServer(messages: Message[]): Promise<string> {
  const res = await fetch(apiUrl('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: messages.map(m => ({ role: m.role, content: m.content })) }),
  });
  const data = (await res.json().catch(() => ({} as { reply?: string }))) as { reply?: string };
  if (data.reply) return data.reply;
  throw new Error(`chat ${res.status}`);
}

export function initChat(
  messagesEl: HTMLElement,
  formEl: HTMLFormElement,
  inputEl: HTMLTextAreaElement,
  sendBtn: HTMLButtonElement,
  clearBtn: HTMLButtonElement,
  presetButtons: HTMLButtonElement[],
): void {
  const hintEl = messagesEl.querySelector('.chat-hint') as HTMLElement | null;

  function setBusy(busy: boolean): void {
    sendBtn.disabled = busy;
    presetButtons.forEach(b => { b.disabled = busy; });
  }

  async function send(userMsg: Message): Promise<void> {
    setBusy(true);
    history.push(userMsg);
    history.push({ role: 'assistant', content: '__thinking__' });
    renderMessages(messagesEl, hintEl);
    try {
      const realMessages = history.slice(0, -1);
      const reply = await sendToServer(realMessages);
      history[history.length - 1] = { role: 'assistant', content: reply };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      history[history.length - 1] = { role: 'assistant', content: `(エラー: ${msg})` };
    } finally {
      renderMessages(messagesEl, hintEl);
      setBusy(false);
      inputEl.focus();
    }
  }

  function submitFromInput(): void {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    const preset = PRESETS.find(p => p.key === text);
    if (preset) {
      void send({ role: 'user', content: preset.prompt, display: preset.label });
    } else {
      void send({ role: 'user', content: text });
    }
  }

  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    submitFromInput();
  });

  // Enter送信、Shift+Enter改行
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitFromInput();
    }
  });

  presetButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.preset;
      const preset = PRESETS.find(p => p.key === key);
      if (!preset) return;
      void send({ role: 'user', content: preset.prompt, display: preset.label });
    });
  });

  clearBtn.addEventListener('click', () => {
    history.length = 0;
    renderMessages(messagesEl, hintEl);
  });
}
```

Key points vs the old file: `Message` gains `display?`; `renderMessages` shows `m.display ?? m.content`; `sendToServer` maps to `{role, content}` only (so the LLM gets the detailed `content`, never `display`); `send(userMsg)` is the shared core; `submitFromInput()` maps a bare `"1"`/`"2"` to the matching preset; preset buttons call `send` with `content: prompt, display: label`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `initChat` now needs 6 args but `web/main.ts` passes 5. (Fixed in Task 5.) If you implement Task 5 first this passes; otherwise expect this specific arity error only.

- [ ] **Step 3: Commit**

```bash
git add web/components/chatBoard.ts
git commit -m "feat(chat): preset questions with display/prompt split + number shortcut"
```

---

### Task 5: index.html + main.ts + styles.css — ボタン UI と配線

**Files:**
- Modify: `web/index.html` (chat 内に preset 行), `web/main.ts` (initChat 引数), `web/styles.css` (スタイル)

- [ ] **Step 1: Add the preset buttons row in index.html**

In `web/index.html`, the chat section currently is:
```html
        <div id="chat-messages" class="chat-messages">
          <div class="chat-hint">市場や銘柄について質問してください</div>
        </div>
        <form id="chat-form" class="chat-form">
```
Insert the preset row between the `</div>` (closing `#chat-messages`) and the `<form>`:
```html
        <div id="chat-messages" class="chat-messages">
          <div class="chat-hint">市場や銘柄について質問してください</div>
        </div>
        <div class="chat-presets">
          <button type="button" class="chat-preset" data-preset="1">① 現在のトレンド方向と上値/下値のメド</button>
          <button type="button" class="chat-preset" data-preset="2">② 急変の理由を詳しく</button>
        </div>
        <form id="chat-form" class="chat-form">
```

- [ ] **Step 2: Pass the preset buttons into initChat (main.ts)**

In `web/main.ts`, the call is:
```ts
initChat(
  document.getElementById('chat-messages')!,
  document.getElementById('chat-form') as HTMLFormElement,
  document.getElementById('chat-input') as HTMLTextAreaElement,
  document.getElementById('chat-send') as HTMLButtonElement,
  document.getElementById('chat-clear') as HTMLButtonElement,
);
```
Add a 6th argument before the closing `)`:
```ts
initChat(
  document.getElementById('chat-messages')!,
  document.getElementById('chat-form') as HTMLFormElement,
  document.getElementById('chat-input') as HTMLTextAreaElement,
  document.getElementById('chat-send') as HTMLButtonElement,
  document.getElementById('chat-clear') as HTMLButtonElement,
  Array.from(document.querySelectorAll('.chat-preset')) as HTMLButtonElement[],
);
```

- [ ] **Step 3: Add styles to styles.css**

Append to the end of `web/styles.css`:
```css
.chat-presets { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 8px 0; }
.chat-preset {
  font-size: 11px; padding: 4px 10px;
  background: var(--panel); color: var(--text);
  border: 1px solid var(--border); border-radius: 999px;
  cursor: pointer; white-space: nowrap;
}
.chat-preset:hover { border-color: #58a6ff; color: #58a6ff; }
.chat-preset:disabled { opacity: 0.5; cursor: not-allowed; }
```
(`--panel` / `--border` / `--text` are existing root variables.)

- [ ] **Step 4: Typecheck + full test suite + web build**

Run: `npm run typecheck` → no errors (arity now matches).
Run: `npm run test` → all pass.
Run: `npm run build:web` → built successfully (modules transformed).

- [ ] **Step 5: Manual check (browser dev)**

Run `npm run dev`, open the app:
- 2 つの定型ボタンがチャット入力欄の上に表示される。
- ボタン①クリック → 吹き出しに「現在のトレンド方向と上値/下値のメド」(簡潔文)が出て AI 応答。
- 入力欄に「1」+Enter → 同じ挙動。「2」も同様。
- 自由文(例「ドル円どう?」)はそのまま送信される。

- [ ] **Step 6: Commit**

```bash
git add web/index.html web/main.ts web/styles.css
git commit -m "feat(chat): preset question buttons UI + wiring"
```

---

## Self-Review

- **Spec coverage:**
  - 表示/送信分離 (`Message.display`, sendToServer maps to role/content) → Task 4 ✓
  - 2 ボタン(①+②統合, ③)→ Task 4 PRESETS + Task 5 HTML ✓
  - 番号ショートカット(完全一致 "1"/"2")→ Task 4 `submitFromInput` ✓
  - テクニカル文脈強化 → Task 1 (chatContext) + Task 2 (openai inject) + Task 3 (chat.ts wire) ✓
  - テスト(chatContext 注入テスト)→ Task 1 ✓
- **Placeholder scan:** なし(全ステップに実コード/実コマンド)。
- **Type consistency:** `initChat(...)` は Task 4 で 6 引数に、Task 5 で 6 引数を渡す(整合)。`Message.display?`、`Preset{key,label,prompt}`、`ChatInput.technical?` は定義と使用箇所で一致。`buildNikkeiTechnical(getBars?)` は Task 1 定義・テスト・Task 3 呼び出し(引数なし=既定)で整合。`computeContext` の `change15min`/`range1h` は alertLoop と同じ destructure。
