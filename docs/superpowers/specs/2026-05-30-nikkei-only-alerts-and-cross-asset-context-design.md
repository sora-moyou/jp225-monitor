# 日経先物のみアラート + 大変動他銘柄を AI 元ネタに — 設計

- 日付: 2026-05-30
- 対象: JP225 Monitor v0.3.18 時点
- 目的:
  1. 設定モーダルの「最新かチェック」ボタンをボタンと認識できる見た目にする。
  2. アラート表示を **日経225先物 (NIY=F) のみ** に絞る。他銘柄は、無視できない
     大きな変動 (z ≥ 4.0) があったものだけを、NIY=F アラートの AI 説明の
     「元ネタ(急変材料候補)」として使う。

## 背景 (現状)

- `server/loops/alertLoop.ts` が 60 秒ごとに **全 13 銘柄**(8 主要 + 5 値がさ株)を
  評価し、burst(1分 z)/ trend(5分 z)で発火 → `broadcast({type:'alert'})`。
- `server/tickDetector.ts` は既に **NIY=F 限定** の超短期(5s/10s)検知。
- AI 説明 `server/llm/openai.ts:explain()` は、発火銘柄自身の価格文脈 + ニュースのみを
  プロンプト化。**他銘柄の値動きは未使用**。
- 日経平均先物 = `NIY=F`(`server/config.ts`、labelJa「日経225先物」)。
- 設定の「最新かチェック」ボタンは `.btn-secondary`(背景透明・文字色=通常テキスト・
  薄い枠 `var(--border)`)で、暗色テーマ上ではプレーンテキストに見えやすい。

## 変更点

### ① 「最新かチェック」ボタンの視認性 (web/styles.css)

`#settings-check-update` に専用スタイルを与える(`.btn-secondary` は他で使うため不変):

```css
#settings-check-update {
  color: #58a6ff;
  border-color: #58a6ff;
}
#settings-check-update:hover { background: rgba(88, 166, 255, 0.12); }
```

`web/index.html` のボタンは `class="btn-secondary"` のまま(id セレクタで上書き)。
文字色がアクセント青になり、枠も同系色 + hover で薄く塗られ、明確にボタンと分かる。

### ②-(a) アラート発火を NIY=F のみに (server/loops/alertLoop.ts)

- `refreshAllBars()` は **変更なし**(全 13 銘柄の分足を取得し続ける。他銘柄を
  AI 元ネタに使うため `barsCache` に全銘柄分が必要)。
- `evaluateAndFire()` の評価ループを **NIY=F のみ** に制限する。実装は、ループ先頭で
  `if (sym !== 'NIY=F') continue;` を追加(`SYMBOLS` 反復構造は維持し、差分を最小化)。
- これにより値がさ株を含む他銘柄のアラート broadcast は止まる。
- `tickDetector.ts` は既に NIY=F 限定のため変更なし。
- フロント (`web/components/alertBanner.ts` / `web/main.ts`) は変更しない
  (サーバが NIY=F しか送らないため。二重フィルタは YAGNI)。

### ②-(b) barsCache 読み取りアクセサ (既存・変更不要)

`alertLoop.ts:25-27` に既に存在する:

```ts
export function getCachedBars(symbol: string): Bar[] {
  return barsCache.get(symbol) ?? [];
}
```

(欠損時は空配列を返す。`barsCache` は module-private のまま、書き込みは alertLoop だけ。
`Bar` 型は `server/correlation.ts` から export されている。)

### ②-(c) 大変動他銘柄スナップショット (新規 server/marketSnapshot.ts)

責務: 「指定銘柄を除く全銘柄のうち、|z| ≥ 閾値で大きく動いたものの一覧」を返す。
DOM もネットワークも持たず、`getCachedBars` と `alertDetector` の純粋関数だけに依存。
z 算出は `detectBurst`/`detectTrend` の z 部分(静寂前提・横断確認は無し)を忠実にミラー。

```ts
import { INSTRUMENTS } from './config.js';
import { getCachedBars } from './loops/alertLoop.js';
import { returns, stdDev, returns5m, DEFAULT_PARAMS } from './alertDetector.js';
import type { Bar } from './correlation.js';

export const CROSS_ASSET_Z_THRESHOLD = 4.0;

export interface Mover {
  symbol: string;
  label: string;
  changePercent: number;   // 採用された窓のリターン (%)
  windowSeconds: number;   // 60 または 300
  z: number;               // 採用された |z|
  direction: 'up' | 'down';
}

// excludeSymbol を除く全銘柄を評価し、|z| >= threshold のものを
// |z| 降順で返す。getBars はテスト用に注入可(既定は getCachedBars)。
export function getSignificantMovers(
  excludeSymbol: string,
  threshold: number = CROSS_ASSET_Z_THRESHOLD,
  getBars: (symbol: string) => Bar[] = getCachedBars,
): Mover[];
```

判定ロジック(各銘柄、`detectBurst`/`detectTrend` と同じ窓の取り方):
- 対象は `INSTRUMENTS.map(i => i.symbol)` から `excludeSymbol` を除いた全銘柄。
- `bars = getBars(sym)`。
- **1分バースト z**(`detectBurst` ミラー、`L = DEFAULT_PARAMS.baselineLookback = 60`):
  - `bars.length < L + 1` ならこの窓はスキップ。
  - `baseline = bars.slice(-(L + 1), -1)`; `br = returns(baseline)`;
    `br.length < 10` ならスキップ; `sigmaB = stdDev(br)`。
  - `prev = bars.at(-2).close`, `cur = bars.at(-1).close`; `prev <= 0` ならスキップ;
    `retB = (cur - prev) / prev`; `zB = sigmaB > 0 ? Math.abs(retB) / sigmaB : 0`; 窓=60。
- **5分トレンド z**(`detectTrend` ミラー):
  - `bars.length < L + 5` ならこの窓はスキップ。
  - `r5 = returns5m(bars)`; `r5.length < 10` ならスキップ;
    `sigmaT = stdDev(r5.slice(0, -1))`; `retT = r5.at(-1)`;
    `zT = sigmaT > 0 ? Math.abs(retT) / sigmaT : 0`; 窓=300。
- 2つの窓のうち **|z| が大きい方**を採用候補(両方算出不可ならその銘柄はスキップ)。
- 採用候補の `z >= threshold` なら Mover を生成:
  `changePercent = 採用ret * 100`, `direction = 採用ret >= 0 ? 'up' : 'down'`,
  `z = 採用z`, `windowSeconds = 採用窓`,
  `label = INSTRUMENTS.find(i => i.symbol === sym)?.labelJa ?? sym`。
- 集めた Mover を `z` 降順で並べて返す。

> 確認済み: `returns` / `stdDev` / `returns5m` / `DEFAULT_PARAMS` は `alertDetector.ts`
> から、`Bar` は `correlation.ts` から、`INSTRUMENTS` は `config.ts` から export 済み。
> 追加 export は不要。

### ②-(d) explain への注入 (server/routes/explain.ts, server/llm/openai.ts)

- `explain.ts`: 既存の `getNews()` と同様に、ハンドラ内で
  `const movers = getSignificantMovers(body.symbol);` を呼び、`explain({... , crossAsset: movers})`
  に渡す。フロントからの payload は変更しない(算出はサーバ側完結)。
- `openai.ts`:
  - `import type { Mover } from '../marketSnapshot.js';`(**型のみ** import。
    コンパイル時に消えるため実行時の依存辺は生まれず、循環の心配なし)。
  - `ExplainInput` に `crossAsset?: Mover[]` を追加。
  - プロンプトのニュースセクションの直前に「他資産の急変」セクションを追加:
    - movers が 1 件以上: 
      ```
      【同時刻に大きく動いた他資産(z>=4.0)】
      - ナスダック100先物 ▼ -1.85% (5分, z=4.3)
      - ドル円 ▲ +0.42% (1分, z=4.1)
      ```
      行は `direction` の矢印(▲/▼)、`changePercent.toFixed(2)`、窓(`windowSeconds>=300?'5分':'1分'`)、
      `z.toFixed(1)`。
    - movers が 0 件: `【他資産】同時刻に目立った連動なし。`
  - 既存の手順文に1項を追記(他資産が一致方向に動いていれば連動として優先的に言及)。

## ユニット境界

- `server/marketSnapshot.ts`: 「大きく動いた他銘柄」の算出のみ。`getCachedBars` と
  `alertDetector` の純粋関数に依存。テスト可能(バー配列を仕込めば z 判定を検証可)。
- `alertLoop.ts`: バー取得 + NIY=F 評価 + `getCachedBars` 公開。
- `explain.ts`: HTTP 境界。movers と news を集めて `explain()` へ。
- `openai.ts`: プロンプト生成 + LLM 呼び出し。movers を表示するだけで z 判定は持たない。
- 依存方向: `explain.ts → marketSnapshot.ts → alertLoop.ts(getCachedBars)/alertDetector.ts`。
  `marketSnapshot.ts → openai.ts(型 Mover)` は型のみ(Mover は marketSnapshot で定義し
  openai が import)。循環なし。

## テスト方針

- `server/marketSnapshot.test.ts`(新規):
  - バーを仕込み、|z| ≥ 4.0 の銘柄が採用され、未満が除外されることを検証。
  - `excludeSymbol`(NIY=F)が結果に含まれないこと。
  - バー不足銘柄がスキップされること。
  - `getCachedBars` は本物の barsCache を使うため、テストでは barsCache に直接
    値を入れる手段が必要 → marketSnapshot を「bars 取得関数を引数注入できる」設計に
    するか、テスト専用の seed 関数を alertLoop に置く。**実装では `getSignificantMovers`
    の内部 bars 取得を差し替え可能にする**(第3引数に `getBars = getCachedBars` を
    デフォルト注入)ことで、純粋にテストする。
- `npm run typecheck` / `npm run test`(全テスト緑)。
- 手動: ブラウザ dev で他銘柄バナーが出ないこと、NIY=F のみ出ることを確認
  (他資産連動の文面はパッケージ/実データ依存のため目視は任意)。

## 非対象 (YAGNI)

- フロント側のアラート二重フィルタ(サーバが NIY=F のみ送るため不要)。
- 他銘柄ごとの個別閾値設定 UI(z 閾値は定数 `CROSS_ASSET_Z_THRESHOLD = 4.0`)。
- 他銘柄のチャート/カード表示の変更(表示は現状維持、アラートのみ NIY=F 化)。
