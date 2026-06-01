# SP3: 基礎データ連携（Excel履歴 → GitHub → ローカルDB取り込み）設計

作成日: 2026-06-02
対象サブプロジェクト: **SP3** — データ永続化ロードマップ。SP1(収集基盤)/SP2(レベル生成)の上に乗る。
前提: `bars_1m`(SQLite) と `collector/session.ts` の `classifySession` が既存。

---

## 1. 背景と目標

ユーザーは N225 mini 先物の**履歴 OHLCV を Excel で保有**（`N225minif_YYYY.xlsx`、毎週末に最新化、形式固定）。
1min シートだけで ~128,000 行（複数か月の1分足）。これを取り込めば SP2 の上値/下値メドの
**履歴の深さ・スパンが一気に増す**（再起動直後でも厚い履歴、任意スパンのメド精度向上）。

**Excel 形式（確認済み）**: 12シート(`1min,3min,…,60min` + 日足4種)。列 = 日付/時間/始値/高値/安値/終値/出来高。
- 日付 = Excel シリアル値(例 46021)、時間 = 1日の小数(例 0.70833=17:00)。OHLC=整数、出来高=整数。
- 銘柄は N225 mini ＝ モニターの `NIY=F`(OSE mini) と同一。

**目標**: (A) Excel を **GitHub で配布**できる仕組み、(B) ユーザーが **自分のローカル DB に取り込める**仕組み。
基礎データを「正」とし、**追加・修正**できる（週末に最新版へ更新→再取り込み）。

**取り込み方針（重要・ユーザー指定）**:
- **upsert のみ。基礎データより新しいデータ(collector が貯めた直近)は削除しない。**
  全消し→再投入は厳禁。基礎データの期間内の同一時刻だけ上書き(基礎=正)、期間外/欠落部の既存行は不変。
- 基礎データ以降に**欠落**があり得る前提で、メド計算は欠落に強い（あるバーだけで集計、件数が薄い
  セッションも算出はする）。

---

## 2. スコープ（YAGNI）

- 取り込むのは **1min シートのみ**。3min〜日足は SP2 同様 `bars_1m` から SQL 集計で導出（冗長保存しない）。
- 出来高(volume)は将来用に **`bars_1m.volume`(nullable) を追加**して保持（メド計算では未使用）。
- 銘柄は `NIY=F` のみ（Excel は N225 mini）。

**非目標(後続)**: 複数銘柄の基礎データ、Excel 内日足シートの直接利用、差分配信、自動定期取り込み。

---

## 3. アーキテクチャ

```
[ユーザー] N225minif_YYYY.xlsx (週末更新)
   │  npm run basedata:publish
   ▼
scripts/basedata-publish.mjs   (SheetJS は devDependency。アプリ本体には非同梱)
   ├ 1min シート読込 → 各行 {t,o,h,l,c,v} に変換 (Excel serial+fraction → JST epoch ms)
   ├ gzip NDJSON 化 → dist/basedata-1min.ndjson.gz  (~1–2 MB)
   └ gh release upload basedata-latest dist/basedata-1min.ndjson.gz --clobber
   ▼
GitHub Release  tag=basedata-latest  asset=basedata-1min.ndjson.gz
   │  モニター設定「基礎データを取り込む」ボタン
   ▼
server  POST /api/basedata/import
   ├ asset を DL → gunzip → NDJSON を行ストリーム
   ├ 各行: classifySession(t) で {sessionDate, session} 付与
   ├ bars_1m に UPSERT (key=(symbol='NIY=F', t))  ← 既存の新しい行は触らない
   └ 取り込み件数/期間を返す（進捗ログ）
```

- **配布**: 生 xlsx(10.7MB) は git に置かず、**変換済み gzip NDJSON を GitHub Release アセット**として配布
  （アプリ本体と同じ仕組み。タグ `basedata-latest` を週末に `--clobber` で上書き）。
- **変換**: xlsx パースは publish スクリプトのみで SheetJS を使う（devDependency）。モニター／collector の
  実行バイナリには xlsx ライブラリを含めない（軽量維持）。

---

## 4. データ変換（Excel → bar）

各 1min 行 → `{ t, o, h, l, c, v }`:
- `t`(epoch ms) = 日付シリアル `D` と時間小数 `F` から:
  `t = (D - 25569) * 86400000 + round(F * 86400000 / 60000) * 60000 - JST_OFFSET`
  - `25569` = 1970-01-01 の Excel シリアル。`JST_OFFSET = 9*3600000`(壁時計は JST)。
  - `F*86400000` を**分に丸め**(1分足なので)。例 D=46021,F=0.70833 → 2026-01-05 17:00 JST。
- `o,h,l,c` = C/D/E/F 列の数値、`v` = G 列(出来高)。
- ヘッダ行(r=1, 文字列セル)はスキップ。空/非数値行はスキップ。

変換は純粋関数 `rowToBar(serialDate, timeFrac, o,h,l,c,v): Bar1mFull` に切り出してテスト。

---

## 5. DB 変更

### 5.1 `bars_1m.volume` 列追加（nullable）
`store.ts` の既存マイグレーション（`PRAGMA table_info` → 無ければ `ALTER TABLE`）に倣い、`volume INTEGER` を追加。
既存行・collector の書き込みは volume=NULL のまま（feed に出来高が無いため）。

### 5.2 `upsertBar`（store.ts 追加）
```ts
export function upsertBar(db, symbol, t, o, h, l, c, volume, sessionDate, session): void
```
`INSERT INTO bars_1m(...) VALUES(...) ON CONFLICT(symbol, t) DO UPDATE SET o=…,h=…,l=…,c=…,volume=…,
session_date=…,session=…`。**o/h/l/c を全上書き**（基礎=正。collector の `recordTick` は max(h)/min(l)
だが、基礎取り込みは確定値で置換）。`t` は分床(`Math.floor(t/60000)*60000`)に正規化（collector と同一キー）。

**前提（確認済み・追加移行不要）**: `bars_1m` は既に `PRIMARY KEY (symbol, t)` を持ち、`recordTick` も
`ON CONFLICT(symbol,t) DO UPDATE` で upsert している。よって UNIQUE 索引や重複解消の移行は**不要**。
本SPで必要な移行は **`volume` 列追加のみ**（§5.1）。

**削除はしない**。`upsertBar` は INSERT or UPDATE のみ。基礎データ取り込みは対象時刻だけ上書きし、
それ以外（collector が貯めた新しい行）は不変。

---

## 6. 取り込み（server）

### 6.1 `server/basedata.ts`（コア・テスト可）
- `parseNdjsonLine(line): Bar1mFull | null` — 1行 JSON を検証して bar に。
- `importBars(db, bars): { inserted, updated, from, to }` — 各 bar に `classifySession(b.t)` を付与し
  `upsertBar`。session=null(休場/欠落帯の異常データ)はスキップ。最古/最新 t を返す。

### 6.2 `server/routes/basedata.ts`
- `POST /api/basedata/import`:
  1. `https://github.com/sora-moyou/jp225-monitor/releases/download/basedata-latest/basedata-1min.ndjson.gz` を fetch
  2. gunzip(`node:zlib`) → 行分割 → `parseNdjsonLine` → `importBars`
  3. `{ ok, inserted, updated, from, to, total }` を返す
- 失敗時は 5xx + メッセージ（UI に表示）。大きいので**ストリーミング**で処理しメモリ肥大を避ける。

### 6.3 起動時
自動取り込みはしない（YAGNI/帯域）。ユーザーがボタンで実行。将来 DB 空なら勧める通知は検討（本SP外）。

---

## 7. UI

- 設定モーダルに「基礎データ」セクション: ボタン「基礎データを取り込む」＋結果表示。
- 押下 → `POST /api/basedata/import` → 「取り込み完了: N件 (YYYY-MM-DD〜YYYY-MM-DD)」を表示。実行中は
  ボタン無効＋「取り込み中…」。
- 取り込み後、levelsLoop の次サイクル(≤60s)で深い履歴が反映される（特別な再起動は不要）。

---

## 8. publish スクリプト

`scripts/basedata-publish.mjs`（`npm run basedata:publish -- <path-to-xlsx>`）:
1. 引数 or 既定パスの xlsx を SheetJS で開き `1min` シートを取得。
2. 各行 `rowToBar` → `{t,o,h,l,c,v}` の NDJSON 行に。t 昇順でソート。
3. `node:zlib` gzip → `dist/basedata-1min.ndjson.gz`。
4. `gh release create basedata-latest --title "..." || true` 後 `gh release upload basedata-latest <gz> --clobber`。
5. 件数/期間/サイズをログ。

SheetJS(`xlsx`) は **devDependencies** に追加（publish スクリプト専用、アプリ非同梱）。

---

## 9. エラー処理・整合性

- 取り込みは upsert のみ→**何度実行しても安全**（冪等）。中断しても部分適用で破損しない。
- `(symbol,t)` UNIQUE が無いと重複が増えるため、マイグレーションで索引を必ず張る。既存重複は移行時に集約。
- 取り込んだ後、基礎期間より新しい collector 行は**そのまま利用**（削除しない）。
- 基礎期間以降の**欠落**: getSessionOHLC/levels は「あるバーだけ」で集計するため算出は継続。
  欠落の多いセッションは H/L が薄い可能性があるが誤った値は出さない（存在するバーの真の H/L）。
  将来、セッションのバー件数を持って信頼度表示する案は SP4 候補。

---

## 10. テスト

- `basedata.test.ts`: `rowToBar`(Excel serial+fraction → 既知 JST epoch、分丸め)、`parseNdjsonLine`(不正行→null)、
  `importBars`(upsert で既存新しい行を消さない＝別時刻の既存行が残る、session 付与、from/to)。
- `store.test.ts`: `upsertBar`(同 (symbol,t) で UPDATE、別 t は併存)、volume 列、UNIQUE 索引。
- publish スクリプトは小さな固定 xlsx で `rowToBar` を流用し単体検証（スクリプト自体はスモークのみ）。

---

## 11. 完了条件（DoD）

1. `bars_1m.volume` 列 ＋ `(symbol,t)` UNIQUE 索引のマイグレーション（既存 DB も移行）。
2. `upsertBar` が UPSERT のみで動作（削除しない、テスト緑）。
3. `rowToBar`/`parseNdjsonLine`/`importBars` がテスト緑（Excel変換・session付与・非削除）。
4. `POST /api/basedata/import` が GitHub アセットを取り込み件数/期間を返す。
5. 設定 UI のボタンで取り込め、levelsLoop に反映。
6. `scripts/basedata-publish.mjs` で xlsx→gz→GitHub Release(basedata-latest) を公開できる。
7. 全テスト緑・typecheck 通過。

---

## 12. 調整ノブ / 運用

- 配布タグ: `basedata-latest`（週末 `--clobber` 更新）。アセット名 `basedata-1min.ndjson.gz`。
- 取り込み URL は固定（リポジトリの releases/download/basedata-latest/...）。
- 銘柄: `NIY=F` 固定。
- SheetJS: devDependency のみ。

Related: SP1 `2026-06-01-data-collector-and-persistence-design.md`, SP2 `2026-06-02-multi-timeframe-levels-design.md`
