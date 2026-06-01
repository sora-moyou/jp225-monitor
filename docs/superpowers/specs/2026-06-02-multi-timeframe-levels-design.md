# SP2: 多時間軸メド生成（セッションH/L＋フィボ戻し）設計

作成日: 2026-06-02
対象サブプロジェクト: **SP2** — データ永続化ロードマップ第2段（SP1 基盤の上に乗る）
前提: SP1（collector v0.4.00 + bars_1m 永続化 + 起動時ウォームアップ）完了・モニター v0.4.0 で出荷済み。

---

## 1. 背景と目標

モニターの上値/下値メド（`server/chatContext.ts` の `buildNikkeiTechnical`）は現状、
**メモリ上の当日リアルタイム足のみ**（最大4時間=240本）を見ており、前日も DB も使っていない。
そのため「前日高安」「複数セッションにまたがる節目」「大きなスイングの戻り」が構造的に出せない。

ユーザーは**セッショントレード**を行い、経験的に「**過去セッション足の OHLC、特に H/L が利く**」と判断している。

**目標**: SP1 で貯めた `bars_1m`（session_date+session タグ付き）を **セッション単位**で集計し、
**過去セッションの H/L を主軸**に、コンフルエンス（重なり）とフィボナッチ戻しを加えた
上値/下値メドを生成。**AI チャットと UI の両方**に出す。

**非目標（後続SP）**: チャートへの水平線オーバーレイ（SP後続）、アラート履歴/事後値動き（SP3）、
予測・バックテスト（SP4）。本 spec は「レベル生成 + AI/UI への最小統合」に絞る。

---

## 2. レベルの定義（確定値）

すべて NIY=F（日経225先物）を対象。価格は円。`current`=現値。

### 2.1 セッション H/L（主役）
- `bars_1m` から **セッション別 OHLC** を集計（後述クエリ）。
- 直近 **10 完了セッション**（≒5営業日, Day+Night）の **High / Low** を候補に。Open/Close は補助ラベル。
- **当日（進行中セッション）** の High / Low / Open はリアルタイム（メモリ足 + DB の当日分）。
- 直近10セッションの **最高値 / 最安値**（大きな天底）もマーカーにする。

### 2.2 コンフルエンス★（強レベル）
- 候補レベル群を価格でクラスタリング。**±30円以内**で重なるものを1つに束ね、
  束ねた本数 ≥2 を「**強レベル ★**」とする（H/L が複数セッションで一致する価格＝効きやすい、を最大活用）。
- 束ねた代表価格 = メンバー価格の中央値。ラベルはメンバーを連結（例「前日Day高・3日前Night高」）。
- `±30円` は `CONFLUENCE_TOL` 定数（knob、後で調整可）。

### 2.3 フィボナッチ戻し（直近5Sスイング）
- スイング窓 = **直近5完了セッション**（当日進行中は含めない）。窓内の **最高値 H・最安値 L** を両端に。
- **方向は極値の新しさで決定**（各極値が出た bar の `t` を比較）：
  - **安値が新しい = 下げ脚（H→L）** → 戻しは上方向。`level(r) = L + r·(H−L)`
  - **高値が新しい = 上げ脚（L→H）** → 戻しは下方向。`level(r) = H − r·(H−L)`
- 戻し率 = **38.2% / 50% / 61.8%** の3本。
- **50% = 「方向転換ライン」**として強調フラグ。判定ルール：
  - 下げ脚: `current > level(0.5)` → 上方向への転換目安を満たす
  - 上げ脚: `current < level(0.5)` → 下方向への転換目安を満たす
- スイングが退化（H==L）や履歴不足（5S未満）の場合はフィボを省略。

### 2.4 節目グリッド（軽い補助）
- 既存の **250円グリッド**（`GRID=250`）を流用。現値直近の上下各1本を候補に混ぜる。

### 2.5 近傍選抜
- 上記すべてを候補プールに集約 → **現値からの距離**で、上値側 上位4・下値側 上位4 を選抜（遠いものは隠す）。
- フィボ50%（方向転換ライン）は近傍4に入らなくても**必ず含める**（重要シグナルのため）。

---

## 3. アーキテクチャ

```
collector(常駐) → bars_1m(SQLite) ─┐
                                    │  getSessionOHLC()         computeLevels()       /api/levels (REST)
当日リアルタイム足(メモリ feedBars) ─┴→ store.ts ───────→ server/levels.ts ───→ cache ──→ SSE 'levels'
                                                          (純粋関数)                        │
                                                                                            ├→ UI レベルパネル
                                                                                            └→ AI: chatContext が呼ぶ
```

- **`server/levels.ts`**（新規・純粋関数群）: レベル計算の本体。DB I/O を持たず、注入された
  「セッションOHLC配列 + 現値」から候補を組み立てる → 単体テスト容易。
- **`store.ts`**（拡張）: `getSessionOHLC(symbol, limit)` を追加（GROUP BY 集計）。
- **`server/loops/levelsLoop.ts`**（新規・薄い）: 60秒ごと＋セッション境界で `getSessionOHLC` →
  `computeLevels` → cache 更新 → SSE 'levels' 配信。
- **`server/routes/levels.ts`**（新規）: `GET /api/levels` で最新キャッシュを返す（UI 初回取得用）。
- **`chatContext.ts`**（拡張）: `buildNikkeiTechnical` が `computeLevels` の結果を technical ブロックに反映。

---

## 4. DB クエリ（セッションOHLC）

`bars_1m(symbol, session_date, session, t, o, h, l, c)` から、セッション単位の OHLC を求める。
O = セッション内 `t` 最小の bar の `o`、C = `t` 最大の bar の `c`、H = `MAX(h)`、L = `MIN(l)`、
さらに H/L が出た bar の `t`（フィボの方向判定用）も返す。

```sql
-- セッションごとの OHLC + H/L 発生時刻
SELECT session_date, session,
       MAX(h) AS high, MIN(l) AS low,
       (SELECT o FROM bars_1m b2 WHERE b2.symbol=b.symbol AND b2.session_date=b.session_date
          AND b2.session=b.session ORDER BY t ASC  LIMIT 1) AS open,
       (SELECT c FROM bars_1m b3 WHERE b3.symbol=b.symbol AND b3.session_date=b.session_date
          AND b3.session=b.session ORDER BY t DESC LIMIT 1) AS close,
       (SELECT t FROM bars_1m b4 WHERE b4.symbol=b.symbol AND b4.session_date=b.session_date
          AND b4.session=b.session ORDER BY h DESC, t ASC LIMIT 1) AS high_t,
       (SELECT t FROM bars_1m b5 WHERE b5.symbol=b.symbol AND b5.session_date=b.session_date
          AND b5.session=b.session ORDER BY l ASC,  t ASC LIMIT 1) AS low_t
FROM bars_1m b
WHERE symbol = ?
GROUP BY session_date, session
ORDER BY MIN(t) DESC
LIMIT ?;
```

返り値型 `SessionOHLC { sessionDate, session, open, high, low, close, highT, lowT }`。
`limit` は呼び出し側（直近10〜必要分）。当日進行中セッションも含まれる（H/L は途中値）。

---

## 5. levels.ts（純粋関数設計）

```ts
export interface SessionOHLC {
  sessionDate: string; session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number;
}
export interface Level {
  price: number;            // 代表価格(コンフルエンスは中央値)
  dist: number;             // price - current (5円丸め)
  labels: string[];         // 例 ["前日Day高","3日前Night高"]
  strong: boolean;          // コンフルエンス(>=2本)
  fib?: 0.382 | 0.5 | 0.618;
  reversalLine?: boolean;   // fib50% の方向転換ライン
}
export interface LevelsResult {
  current: number;
  up: Level[];              // 現値より上, 近い順, 最大4(+必ず含むfib50)
  down: Level[];            // 現値より下, 近い順, 最大4(+必ず含むfib50)
  swing: { high: number; low: number; leg: 'up' | 'down' } | null; // フィボの根拠
  reversalSatisfied: boolean; // 現値が50%戻しの転換側にあるか
  asOf: number;
}

export function computeLevels(
  sessions: SessionOHLC[],   // getSessionOHLC の結果(新しい順)。当日含む可
  current: number,
  asOf: number,
): LevelsResult;
```

**進行中セッションの識別**: `computeLevels` は `classifySession(asOf)`（collector/session.ts の純粋関数）で
現在のセッション（sessionDate+session）を求め、`sessions[新しい順]` の先頭がそれと一致すれば
**当日（進行中）**、それ以外は**完了セッション**として扱う。場外（classifySession=null）の場合は全て完了扱い。
これにより levels.ts は I/O を持たず純粋なまま。

内部ステップ（すべて純粋・テスト対象）：
1. **候補生成**: 完了セッション直近10Sの各 H/L（ラベル「N日前Day/Night高/安」）、進行中セッションの H/L/始値、
   完了10Sの最高/最安、節目上下1本。
2. **フィボ**: **完了**セッションの直近5Sから H・L・leg を求め（§2.3）、38.2/50/61.8 を候補追加。50%に reversalLine。
3. **コンフルエンス**: 候補を価格ソート→ `CONFLUENCE_TOL=30円` でクラスタリング→代表価格(中央値)・labels連結・strong判定。
4. **分割/選抜**: 現値で up/down に分割、|dist| 昇順、各最大4。fib50 は強制包含。
5. `reversalSatisfied` を §2.3 のルールで算出。

ラベルの「N日前」表記は `asOf` のセッションを 0 とした相対セッション差から生成（Day/Night 区別付き）。

---

## 6. AI 統合（chatContext.ts）

- `buildNikkeiTechnical` を拡張。十分な DB セッションがあるときは `computeLevels` の結果を採用し、
  technical ブロックに以下を追記（既存の trend/SMA 行は維持）：
  - `上値メド:` up を価格＋ラベル＋距離で（★は「(強)」）
  - `下値メド:` down を同様に
  - `フィボ戻し: 50% {price}円 = 方向転換ライン。現値は {上/下}回り → {上/下}方向の転換目安を{満たす/満たさない}`
- DB セッションが不足（新規PC等）なら従来の `gridOnly`/メモリ足ロジックにフォールバック（既存挙動を壊さない）。
- 価格表示の作法（「+80円」でなく「67,000円」）は既存ルールを踏襲（`openai.ts` のシステムプロンプト）。

---

## 7. UI 統合

- 新コンポーネント `web/components/levelsPanel.ts`。チャート脇（左カラム、チャートとAIチャットの間 or 上）に
  コンパクトなレベル一覧。現値ラインを挟んで up/down を近い順に表示。
- 各行: `価格 / 距離 / ラベル`。**★強レベルは強調**（太字＋色）、**フィボ50%は転換ラインとして別色＋⚑**。
- データ取得: 初回 `GET /api/levels`、以降 SSE `levels` イベントで集合を更新。
  **距離は既存の価格SSE（prices）でリアルタイム再計算**（レベル集合の再配信を待たない）。
- レベルが空（履歴不足）のときはパネルに「蓄積中」を表示。
- スタイルは既存 `.alert` 等のトーンに合わせる（Vanilla TS、依存追加なし）。

---

## 8. データフロー・更新タイミング

- `levelsLoop`: 起動時1回 + **60秒間隔** + セッション境界（`classifySession` の変化検知）で再計算。
- レベル集合は緩やかにしか変わらない（H/L は更新時のみ、フィボはスイング更新時のみ）。
  現値追従の距離計算は UI 側で価格ストリームから行うため、SSE 'levels' は集合変化時のみで十分。
- AI チャット要求時は `chatContext` がキャッシュ済みレベル（または即時 `computeLevels`）を読む。

---

## 9. エラーハンドリング / フォールバック

- `getSessionOHLC` が 0 行（DB空）: `computeLevels` は `up=[],down=[],swing=null` を返す → UI「蓄積中」、AI は従来フォールバック。
- セッション数 < 5: フィボ省略（H/L レベルは可能な分だけ出す）。
- DB 読み取り例外: ログのみ、前回キャッシュを保持（UI/AI は古い集合で継続、クラッシュさせない）。
- 当日 H/L はメモリ足とDB当日分のうち新しい方を採用（SP1 のウォームアップ整合）。

---

## 10. テスト

- `levels.test.ts`（純粋関数、注入 SessionOHLC[]）:
  - セッションH/L候補の生成とラベル相対表記
  - コンフルエンス束ね（±30円, 中央値, strong, labels連結）
  - フィボ: 下げ脚/上げ脚の方向判定（highT/lowT の新旧）、38.2/50/61.8 の値、reversalLine
  - `reversalSatisfied`: 50%戻しの上/下での真偽（両脚）
  - 近傍選抜（up/down 各最大4、fib50 強制包含）
  - 退化/不足時のフォールバック（空・5S未満）
- `store.test.ts`: `getSessionOHLC` の OHLC/high_t/low_t 集計（既存 DB テスト基盤に追加）。
- `chatContext.test.ts`: DB十分時はレベル反映、不足時は従来フォールバック。

---

## 11. 完了条件（Definition of Done）

1. `getSessionOHLC` がセッション別 OHLC + high_t/low_t を返す（テスト緑）。
2. `computeLevels` がセッションH/L＋コンフルエンス＋フィボ（38.2/50/61.8, 50%転換）＋近傍選抜を返す（テスト緑）。
3. `levelsLoop` + `GET /api/levels` + SSE 'levels' が動く。
4. UI レベルパネルが現値近傍を近い順に表示、★強レベル・⚑フィボ50%を区別、距離リアルタイム更新。
5. AI チャットの technical に上値/下値メド＋フィボ50%転換判定が反映、履歴不足時は従来フォールバック。
6. 全テスト緑・typecheck 通過。

---

## 12. 調整ノブ（後でチューニング可能）

- `LOOKBACK_SESSIONS = 10`（H/L 候補のセッション数）
- `FIB_SWING_SESSIONS = 5`（フィボのスイング窓）
- `CONFLUENCE_TOL = 30`（円, 強レベル束ねの近接許容）
- `GRID = 250`（既存節目）
- `NEAR_N = 4`（up/down 各表示本数）
- フィボ率 `[0.382, 0.5, 0.618]`

Related: SP1 spec `2026-06-01-data-collector-and-persistence-design.md`
