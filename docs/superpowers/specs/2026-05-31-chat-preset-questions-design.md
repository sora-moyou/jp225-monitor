# AI チャットの定型質問ボタン — 設計

- 日付: 2026-05-31
- 対象: JP225 Monitor v0.3.20 時点
- 目的: 既存の AI チャットに「定型質問」を用意し、ボタン or 番号で素早く送れるようにする。
  表示文は簡潔、LLM へ送る文は詳細、と分離する。①②(トレンド・上値下値)の回答精度を上げる
  ため、チャットの市場文脈に日経225先物の簡易テクニカル要約を足す。

## 確定仕様(ユーザー承認済み)

- ボタンは **2 つ**(④「その他」は自由入力=従来チャットなのでボタン無し):
  - **[1]** 表示:「現在のトレンド方向と上値/下値のメド」
    送信:「今の日経225先物のトレンド方向(上昇/下降/レンジ)と根拠、当面の上値メド・下値メドを、
    直近の値動き・1時間高安・節目から具体的に。」
  - **[2]** 表示:「急変の理由を詳しく」
    送信:「直近で起きた急変の理由を、ニュース・他資産の動き・テクニカルの観点から、結論→根拠の
    順で詳しく説明して。」
- **操作**: ボタンクリックで即送信。加えて、チャット入力欄に「1」「2」だけを打って Enter でも同じ
  (完全一致のときのみ定型に変換)。それ以外の自由入力はそのまま送信。
- **表示と送信の分離**: チャット履歴の吹き出しには **表示文(簡潔)** を出し、サーバ(LLM)には
  **送信文(詳細)** を渡す。

## 変更点

### 1. フロント: `web/components/chatBoard.ts`

- `interface Message` に任意フィールド `display?: string` を追加。
  - レンダリング時は `m.display ?? m.content` を表示。
  - サーバ送信(`realMessages`)は従来どおり `content`(=送信文)を送る。
  - 自由入力は `display` を付けない(`content` がそのまま表示&送信)。
- 定型質問の定義(モジュール先頭の定数):
  ```ts
  interface Preset { key: string; label: string; prompt: string; }
  const PRESETS: Preset[] = [
    { key: '1',
      label: '現在のトレンド方向と上値/下値のメド',
      prompt: '今の日経225先物のトレンド方向(上昇/下降/レンジ)と根拠、当面の上値メド・下値メドを、直近の値動き・1時間高安・節目から具体的に。' },
    { key: '2',
      label: '急変の理由を詳しく',
      prompt: '直近で起きた急変の理由を、ニュース・他資産の動き・テクニカルの観点から、結論→根拠の順で詳しく説明して。' },
  ];
  ```
- `submit()` を「ユーザーメッセージ 1 件を送る」コア `send(userMsg: Message)` にリファクタ。
  - `submit()`: 入力欄の `text = inputEl.value.trim()` を取得。
    - `text` が `PRESETS` の `key` と完全一致 → 該当 preset を
      `send({ role:'user', content: preset.prompt, display: preset.label })`。
    - それ以外 → `send({ role:'user', content: text })`。
    - 空なら無視(従来どおり)。
  - `send(userMsg)`: 従来の submit 本体(push → `__thinking__` → 送信 → 差し替え → 再描画)。
- 定型ボタンの初期化: `initChat` の引数に `presetButtons: HTMLButtonElement[]` を追加し、各ボタンの
  `click` で対応 preset を `send(...)`。`disabled` 制御は送信中フラグを共有(sendBtn と同様)。

### 2. フロント: `web/index.html`

- チャット入力フォームの直前(または messages とフォームの間)に、定型ボタン行を追加:
  ```html
  <div class="chat-presets">
    <button type="button" class="chat-preset" data-preset="1">① 現在のトレンド方向と上値/下値のメド</button>
    <button type="button" class="chat-preset" data-preset="2">② 急変の理由を詳しく</button>
  </div>
  ```
  (ボタン文言は表示用ラベルに番号プレフィックス ①② を付けたもの。実際に送る詳細文は
  `chatBoard.ts` の `PRESETS[].prompt`。)

### 3. フロント: `web/main.ts`

- `initChat(...)` 呼び出しに preset ボタン群を渡す:
  `Array.from(document.querySelectorAll('.chat-preset')) as HTMLButtonElement[]`。

### 4. フロント: `web/styles.css`

- `.chat-presets`(横並び・折り返し・小さめ)、`.chat-preset`(チップ風ボタン、既存トーンに合わせる)
  のスタイルを追加。

### 5. サーバ: 新規 `server/chatContext.ts` — 日経225先物の簡易テクニカル要約

責務: チャット文脈に載せる NIY=F のテクニカル要約文字列を組み立てる。`getCachedBars` と
`computeContext` を再利用、外部ライブラリ無し。DOM 非依存・純粋寄り(barsCache の読み取りのみ)。

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
  if (bars.length < 62) return null;             // computeContext / SMA に足る本数
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

### 6. サーバ: `server/routes/chat.ts`

- `buildNikkeiTechnical()` を呼び、`chat({ messages, prices, news, technical })` に渡す。

### 7. サーバ: `server/llm/openai.ts`

- `ChatInput` に `technical?: string | null` を追加。
- `chat()` の `systemPrompt` 組み立てで、現在価格セクションの直後に technical を挿入:
  ```ts
    `■ 現在価格:\n${formatPricesForChat(input.prices)}\n\n` +
    (input.technical ? `${input.technical}\n\n` : '') +
    `■ 直近ニュース (上位15件):\n${formatNewsForChat(input.news, now)}`;
  ```

## ユニット境界

- `chatBoard.ts`: UI と送信フロー。PRESETS と display/content 分離を持つ。
- `server/chatContext.ts`: NIY=F テクニカル要約の文字列化のみ。`getCachedBars`(alertLoop)と
  `computeContext`(alertDetector)に依存。explain 用の `marketSnapshot.ts` とは別概念。
- `chat.ts`: HTTP 境界。technical を集めて `chat()` へ。
- `openai.ts`: プロンプト生成。technical をそのまま差し込むだけ。
- 依存方向: `chat.ts → chatContext.ts → alertLoop(getCachedBars)/alertDetector(computeContext)`。循環なし。

## テスト方針

- `server/chatContext.test.ts`(新規): bars を仕込んで `buildNikkeiTechnical()` を検証する設計に
  するため、`buildNikkeiTechnical(getBars = getCachedBars)` のように **bars 取得関数を注入可能**にする。
  - 十分な本数で「現値/1時間高安/15分変化率/傾向」を含む文字列を返す。
  - 本数不足(<62)で `null` を返す。
  - 上昇配列で `傾向: 上昇寄り` になる。
- フロントのボタン/番号ショートカットは型と手動確認(`npm run dev`)で担保:
  - ボタン2つが表示され、クリックで簡潔な吹き出し + AI 応答。
  - 入力欄に「1」「2」で同じ挙動。自由文はそのまま。
- `npm run typecheck` / `npm run test`(全緑)。

## 非対象 (YAGNI)

- 定型質問の追加 UI / ユーザー編集(プリセットは固定 2 つ)。
- テクニカル指標の本格実装(RSI/MACD/BB の数値算出やチャート描画)。今回は SMA + 高安 + 変化率の
  軽量要約のみ。
- TradingView 連携・外部 MCP(実行時アプリからは呼べないため対象外)。
