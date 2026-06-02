# SP: 予測系（ADRベース予測メド ＋ 時間帯シーズナリティ）設計

作成日: 2026-06-02
対象: ロードマップ SP4(予測系) のうち実用2機能。バックテスト/ボラ連動閾値は今回スコープ外。
前提: SP1〜3。`bars_1m`(NIY=F 1分足, 基礎データで数か月), `getSessionOHLC`(openT/highT/lowT付き),
`classifySession`, `isSessionComplete`(寄り欠け判定, levels.ts), 主要レベルパネル(levelsLoop→SSE 'levels')。

---

## 1. 目的
蓄積した履歴から「**この後どこまで動きやすいか(ADR)**」「**今の時間帯はどう動きやすいか(シーズナリティ)**」を
予測し、上値/下値メドの精度とトレード判断を上げる。日経225先物(NIY=F)のみ。

## 2. 機能A: ADRベース予測メド
セッションの値幅統計から、**当日の寄り基準で到達しやすい上値/下値**を投影する。

- **ADR算出**: 直近 `ADR_SESSIONS`(=20) の**寄りから揃った完了セッション**(isSessionComplete)について、
  `upRange = high - open`, `downRange = open - low` を取り、それぞれの**中央値**(外れ値に強い)を ADR とする。
  Day/Night は値幅特性が違うため**セッション種別ごとに別々**に算出。
- **投影**: 当日(進行中)セッションが寄りから揃っているとき、`projHigh = open + adrUp`, `projLow = open - adrDown`。
  さらに「残り余地」= projHigh − 現値 / 現値 − projLow も持つ。
- **表示**: 主要レベルパネルに `ADR上限(予測)` / `ADR下限(予測)` のレベルとして追加(既存の H/L 等と一緒に近傍選抜・
  クラスタリングに乗せる)。ラベルで予測由来と分かるようにする。AI(chatContext)にも「ADR予測」を渡す。
- **純粋関数**: `computeADR(sessions, n, session) → { adrUp, adrDown, samples }`,
  `projectTargets(open, adr) → { projHigh, projLow }`。テスト容易。

## 3. 機能B: 時間帯シーズナリティ
時間帯(JSTの30分スロット)ごとの過去の値動き傾向を集計し、現在＋次スロットの傾向を示す。

- **集計**: 直近 `SEAS_SESSIONS`(=20 取引日) の bars_1m を、JST時刻の `SLOT_MIN`(=30) 分スロットにバケツ分け。
  各スロット(例 09:00, 09:30, …, 各セッション内)について、その日のそのスロットの `slotReturn = (slot最終close − slot最初open)/open*100`、
  `slotRange = (slot高 − slot安)/open*100` を日ごとに出し、**スロット横断で平均/上昇率**を取る:
  - `avgReturn`(平均リターン%), `upRate`(上昇した日の割合), `avgRange`(平均値幅%), `samples`(日数)。
- **表示**: 現在時刻のスロットと次スロットの傾向を**コンパクト1〜2行**(主要レベルパネル上部 or 専用小欄)で表示。
  例「13:00台: 平均 +0.04% / 上昇 60% / 値幅 0.18%(過去18日)」。AI(chatContext)にも現在スロット傾向を渡す。
- **純粋関数**: `computeSeasonality(bars, slotMin, asOf) → SlotStat[]`(スロット時刻昇順),
  `slotKey(epochMs, slotMin) → 'HH:MM'`, `currentAndNextSlot(stats, asOf)`。テスト容易。

## 4. アーキテクチャ
```
bars_1m / getSessionOHLC ──┐
                           │ forecastLoop(数分間隔)         /api/forecast (REST)
classifySession/complete ──┴→ server/forecast.ts ──→ cache ──┬→ UI: 予測表示(ADRメド/シーズナリティ)
                              (computeADR/projectTargets/                └→ AI: chatContext に予測ブロック
                               computeSeasonality)
ADR上限/下限は levels にも注入(levelsLoop が forecast を参照しレベル候補に追加)
```
- **`server/forecast.ts`**(純粋関数 + I/O薄ラッパ): computeADR / projectTargets / computeSeasonality / slotKey。
- **`server/loops/forecastLoop.ts`**: 自前DBハンドル, 60〜180秒ごとに getSessionOHLC + bars(直近N日) →
  forecast を算出してキャッシュ。`getForecastSnapshot()` を export。
- **`server/routes/forecast.ts`**: `GET /api/forecast` → キャッシュを返す。
- **levels 連携**: `levelsLoop`(または computeLevels の呼び出し側)で forecast の projHigh/projLow をレベル候補に
  混ぜる。簡潔のため **levelsLoop で forecast 由来の ADR レベルを別途 result に足す**形にし、computeLevels 自体は変更最小。
  → 実装容易さ優先: computeLevels に `extraLevels?: {price,label}[]` を渡せるようにして ADR上限/下限を渡す。
- **UI**: 主要レベルパネル上部にシーズナリティ1行＋ADRメドはレベル行として表示(ラベルで判別)。`web/components/levelsPanel.ts`
  か小コンポーネントで `/api/forecast` を初回取得＋SSEは使わず数分ポーリング(変化が遅いため)。
- **AI**: `chatContext.buildNikkeiTechnical`(または別ブロック)に forecast を追記し、定型質問①(テクニカル)が使えるように。

## 5. 主要な数値/ノブ
`ADR_SESSIONS=20`, `SEAS_SESSIONS=20`, `SLOT_MIN=30`, ADR=中央値, シーズナリティ最小samples=5(未満は非表示)。

## 6. エラー/運用
- データ不足(完了セッション < 5 / スロットsamples < 5)は該当予測を出さない(寄り欠け同様、誤誘導を避ける)。
- 当日が寄り欠けなら ADR 投影もしない(open が正しくないため)。
- forecast は緩やかにしか変わらないので数分ポーリングで十分。AI/levels はキャッシュ参照。

## 7. テスト
- `forecast.test.ts`: computeADR(中央値, セッション種別フィルタ, 寄り欠け除外), projectTargets,
  slotKey(JST 30分丸め), computeSeasonality(注入barsでスロット集計・upRate・samples), currentAndNextSlot。
- levels 連携: computeLevels の extraLevels がクラスタ/選抜に乗ることを1ケース。
- 既存テストは壊さない(computeLevels の extraLevels は任意引数, 既定 [])。

## 8. 完了条件
1. forecast.ts の純粋関数群がテスト緑(ADR/シーズナリティ)。
2. forecastLoop + `/api/forecast` が動く。
3. 主要レベルに ADR上限/下限(予測)が出る(寄り揃い時のみ)。
4. パネルにシーズナリティ1行、AI(①)に予測が反映。
5. 全テスト緑・typecheck・build:web 通過。

Related: SP1/SP2/SP3 spec。
