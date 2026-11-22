# バックテスト用DB(backtest-multiyear.db)の使い方

日経225先物(mini)の **1分足** を 2017年末から蓄えた SQLite ファイル。複数のプロジェクト(Node/TS・Python)から読む前提で書く。
この説明書は追記スクリプトが毎回 DB の隣へコピーする(`backtest-multiyear.README.md`)。元は Finance_Monitor リポジトリの `docs/backtest-db.md`。

> 数字の出所: 特に断りが無いものは、2026-11-23 に本番DBの写し(VACUUM INTO)へ修復と補充をかけた状態を数えた値。
> 最新の件数・期間は DB 内の `dataset_info` 表を見ること(追記のたびに数え直して書かれる)。

## 1. 場所と中身

| 項目 | 値 |
|---|---|
| パス | `C:\Users\user\Desktop\backtest-multiyear.db`(**パスは変えない**。分析スクリプト13本以上と別プロジェクトが直に参照している) |
| 表 | `bars_1m`(1行 = 1分足)。ほかに monitor と同じ空の表(ticks, alerts, news, meta …)があるが **使わない** |
| 銘柄 | `symbol = 'NIY=F'` の1種類だけ(名前は monitor の都合。中身は OSE の日経225mini) |
| 件数 | 2,588,658 本 / セッション 4,440(日中 2,220・夜間 2,220) |
| 期間 | 2017-12-29 17:00 〜 2026-11-21 05:59 JST(日中は 2018-01-04 〜 2026-11-20) |
| 大きさ | 本番ファイル約 200 MB(200,540,160 バイト・2026-11-21 時点)。VACUUM INTO の写しは約 193 MB |
| 出所 | 225labo の `N225minif_YYYY.xlsx`(`1min` シート)。2026-11-16 以降は GitHub release `basedata-latest`(同じ xlsx を変換したもの)から自動追記 |

### bars_1m の列

| 列 | 型 | 意味 |
|---|---|---|
| `symbol` | TEXT | 常に `'NIY=F'` |
| `session_date` | TEXT | `'YYYY-MM-DD'`。**そのセッションが始まった日**(下記「時刻の規約」) |
| `session` | TEXT | `'Day'`(日中)/ `'Night'`(夜間) |
| `t` | INTEGER | **足の開始時刻**。エポックミリ秒(UTC)。分ちょうど |
| `o` `h` `l` `c` | REAL | 始値・高値・安値・終値(円) |
| `volume` | INTEGER | 出来高(枚)。NULL は 0 本。**0 は 28,716 本ある**(日中 9,246・夜間 19,470。値が動かず約定の無い分) |
| `src` | TEXT | NULL = 初回構築(xlsx)由来 2,579,478 本 / `'base'` = 追記・補充由来 9,180 本。分析上の区別は不要 |

主キーは `(symbol, t)`。索引はこれだけ(`t` の範囲検索は速い。`session_date` の絞り込みは全表走査で 0.5 秒程度)。
**この表の列と主キーは変えない**(jp225-Trade の ReplayFeed がこの形のまま読む)。

## 2. 時刻の規約(ここを間違えると全部ずれる)

- `t` は **UTC のエポックミリ秒**、足の **開始** 時刻。JST は `t + 9時間`(日本に夏時間は無い)。
  例: `t = 1767051900000` → 2025-12-30 08:45 JST の足(08:45:00〜08:45:59)。
- `session_date` は **セッションが始まった日**。夜間(17:00〜翌6:00)の 0:00〜6:00 の足も **前日の日付** になる。
  例: 2025-12-31 05:59 JST の足は `session_date='2025-12-30', session='Night'`。
  ★取引所の「取引日」(夜間は翌営業日に属する)とは逆。xlsx の A 列(取引日ラベル)とも逆。
- 並べるときは **必ず `ORDER BY t`**。`session_date` で並べると夜間の 0:00〜6:00 が前に来ない/日付順と時刻順が食い違う。
- セッション単位で扱うときは `(session_date, session)` でまとめ、**`min(t)` の順** に並べる(同じ日付の Day → Night の順になる)。
- 取引時間(データに入っている範囲、実測。各セッションの本数は期間ごとに **全セッション同じ** = 約定の無い分も出来高0の足として埋まっている):

| 期間 | 日中 | 夜間 |
|---|---|---|
| 〜2021-09-16 | 08:45〜15:15(391本) | 17:00〜05:30(751本) |
| 2021-09-21〜2024-11-01 | 08:45〜15:15(391本) | 17:00〜05:59(780本) |
| 2024-11-05〜 | 08:45〜15:44(420本) | 17:00〜05:59(780本) |

  ★注意(未確認の疑い): 2024-11-05 より前の夜間は実際には 16:30 開始だったはずだが、**16:30〜16:59 の足がこのDBに1本も無い**
  (全夜間の開始が 17:00)。構築時に現行の取引時間で「場外」として捨てられた可能性が高い(元の xlsx が手元に無く未確認)。
  同様に 2021-09 以降の 06:00 の足、2024-11 以降の 15:45 の足(引けの板寄せ)は入っていない。夜間の寄り付き直後を調べるときは注意。

## 3. 足して使えるもの(ビューと dataset_info)

既存の表は変えずに、次の3つを足してある(`scripts/backtest-db/` と追記スクリプトが毎回作り直す。冪等)。

### ビュー `bars_jst` — JST の文字列つき
`bars_1m` の全列 + `ts_jst`('YYYY-MM-DD HH:MM')・`date_jst`(暦日)・`time_jst`('HH:MM')。
`t` で絞れば主キーの索引が効く(1日分 1,200 本で 3ms)。`ts_jst` で絞ると全表走査になるので遅い。

```sql
SELECT ts_jst, session_date, session, o, h, l, c, volume
FROM bars_jst
WHERE symbol = 'NIY=F' AND t >= 1767051900000 AND t < 1767139200000   -- 2025-12-30 08:45 〜 12-31 09:00 JST
ORDER BY t;
```

### ビュー `sessions` — セッション単位の OHLC
列: `symbol, session_date, session, start_t, end_t, start_jst, end_jst, open, high, low, close, volume, bars`。
`open` は最初の足の始値、`close` は最後の足の終値(主キーで引く)。`start_t` 順に並ぶ。
**全件(4,440 行)で約 2.3 秒**(実測 3 回: 2,432 / 2,316 / 2,302 ms)。`WHERE session_date BETWEEN ...` で絞ると 1年分で約 0.46 秒。
`start_t` で絞っても速くならない(集計の後で絞るため)。何度も使うなら一度読んで手元に持つこと。

```sql
SELECT * FROM sessions WHERE session_date BETWEEN '2025-01-01' AND '2025-12-31';
```

### 表 `dataset_info`(key TEXT PRIMARY KEY, value TEXT) — DB の自己紹介と更新記録
| key | 中身 |
|---|---|
| `schema_version` | この付加スキーマの版(今は `1`) |
| `description` `source` `symbol` `time_convention` | 説明 |
| `bar_count` `session_count` `first_bar_jst` `last_bar_jst` `first_bar_t` `last_bar_t` `stats_counted_at_jst` | 最後に数えた件数と期間 |
| `last_append_at_jst` | 最後に追記スクリプトが走った時刻 |
| `last_append_status` | `ok` / `ok(WARN n 件・ログ参照)` / `error: 理由` |
| `last_append_inserted` `last_append_release_generated_at` `last_append_log` | 追記した本数・取得元の生成時刻・ログの場所 |
| `repaired_holiday_nights*` | 祝日前夜の修復の記録(件数・本数・日時・移動元→移動先の一覧) |
| `filled_sessions*` | xlsx から補ったセッションの記録 |

```sql
SELECT key, value FROM dataset_info ORDER BY key;
```

## 4. 自動更新

- Windows タスク「JP225 backtest OHLC append」が **平日 08:30 と 16:00** に `npx tsx scripts/append-backtest-db.mts` を実行する(Finance_Monitor リポジトリ)。
- GitHub release `basedata-latest` の `basedata-1min.ndjson.gz` から、**DB の最終足より新しい足だけ** を追記する(既存行は書き換えない。場外の足は捨てる)。
  取得に失敗したら 20 秒・60 秒あけて計 3 回試す。
- 元データ(225labo の xlsx)の更新は前営業日分までなので、DB の最終足はおおむね **直近の夜間の 05:59** になる。
- release の中の「場外の足」のうち 06:00 / 15:45(引けの板寄せ・毎日ある)以外は、日付ずれで休場日に置かれた疑いとして件数と日付の内訳を `WARN` に出す。
  実例: generatedAt 2026-11-19T23:04Z の release は 2025-12-30 夜間の 780 本を 2026-01-02 / 01-03(休場日)に置いている(旧変換の誤り)。
  release が作り直されるまで、毎回この WARN が出る(`last_append_status` が `ok(WARN 1 件…)` になる)。
  DB の期間内で「release にあって DB に無い場内の足」も件数を `WARN` に出す(追記はしない。`fill-from-xlsx.mts` で補う)。
- 追記のあと整合チェック(セッションの時間の重なり・「平日で日中が無いのに夜間がある」日の増加・未来の足)をして、異常はログに `WARN:` を出し `last_append_status` に WARN 件数を書く。
- ログ: `C:\Users\user\Desktop\backtest-results\append-ohlc.log`(1回ごとに `--- 時刻 JST` で区切って追記)。
- 最後にこの説明書を DB の隣へコピーする。

### 更新が止まっていないかの確かめ方
1. `SELECT value FROM dataset_info WHERE key IN ('last_append_at_jst','last_append_status','last_bar_jst');`
   - `last_append_at_jst` が直近の平日 08:30 / 16:00 より古い → タスクが動いていない。
   - `last_append_status` が `error:` で始まる → ログの該当回を見る。
   - `last_bar_jst` が2営業日以上古い → 元データの公開が止まっている可能性(monitor 側 `basedata:publish` / 自動公開)。
2. ログの末尾を見る: `Get-Content C:\Users\user\Desktop\backtest-results\append-ohlc.log -Tail 20`

## 5. 開き方(読み取り専用で)

DB は WAL モード。追記中(数秒)に読んでも壊れないが、**読むだけなら必ず読み取り専用で開く**。

- **コピーするとき**: `.db` だけを持ち出すと、`-wal` にまだ書き戻されていない分が欠ける。
  `backtest-multiyear.db-wal` も一緒にコピーするか、**`VACUUM INTO` で1ファイルに書き出す**(推奨。読み取り専用の接続でも実行できる):
  - Finance_Monitor から: `npx tsx scripts/backtest-db/snapshot.mts --db C:\Users\user\Desktop\backtest-multiyear.db --out D:\work\bt-copy.db`
  - Python から: `sqlite3.connect('file:C:/Users/user/Desktop/backtest-multiyear.db?mode=ro', uri=True).execute("VACUUM INTO 'D:/work/bt-copy.db'")`
  - 実測: 約 193 MB の書き出しで約 3 秒。
- 別PCから `\\DELLMAIN\Users\user\Desktop\backtest-multiyear.db` を直接開くのは避け、写しを作ってから読む(ネットワーク越しの SQLite はロックが不確か)。

### Node(node:sqlite, Node 22.5+)
```js
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('C:/Users/user/Desktop/backtest-multiyear.db', { readOnly: true });
const JST = 9 * 3600_000;
const from = Date.parse('2025-12-30T08:45:00+09:00');      // JST をそのまま書ける
const to   = Date.parse('2025-12-31T06:00:00+09:00');
const bars = db.prepare(
  `SELECT t, session_date, session, o, h, l, c, volume FROM bars_1m
   WHERE symbol = 'NIY=F' AND t >= ? AND t < ? ORDER BY t`).all(from, to);
console.log(bars.length, new Date(bars[0].t + JST).toISOString().slice(0, 16));  // 1200 '2025-12-30T08:45'
console.log(db.prepare(`SELECT value FROM dataset_info WHERE key = 'last_bar_jst'`).get().value);
db.close();
```

### Python(sqlite3 標準ライブラリ)
```python
import sqlite3
from datetime import datetime, timezone, timedelta
JST = timezone(timedelta(hours=9))
con = sqlite3.connect('file:C:/Users/user/Desktop/backtest-multiyear.db?mode=ro', uri=True)
con.row_factory = sqlite3.Row
ms = lambda s: int(datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=JST).timestamp() * 1000)
rows = con.execute(
    "SELECT t, session_date, session, o, h, l, c, volume FROM bars_1m "
    "WHERE symbol = 'NIY=F' AND t >= ? AND t < ? ORDER BY t",
    (ms('2025-12-30 08:45'), ms('2025-12-31 06:00'))).fetchall()
print(len(rows), datetime.fromtimestamp(rows[0]['t'] / 1000, JST))   # 1200 2025-12-30 08:45:00+09:00
print(dict(con.execute("SELECT key, value FROM dataset_info").fetchall())['last_bar_jst'])
# pandas を使うなら: pd.read_sql_query("SELECT * FROM bars_jst WHERE t >= ? AND t < ? ORDER BY t", con, params=(a, b))
con.close()
```

## 6. よく使う SQL

### 期間を JST で指定して抜き出す
SQLite の中で JST → UTC ms に直す(`unixepoch` は秒なので ×1000、JST から 9 時間引く):
```sql
SELECT * FROM bars_jst
WHERE symbol = 'NIY=F'
  AND t >= (strftime('%s', '2025-01-06 08:45') - 9*3600) * 1000
  AND t <  (strftime('%s', '2025-01-10 06:00') - 9*3600) * 1000
ORDER BY t;
```

### セッション OHLC(日中だけ・夜間だけ)
```sql
SELECT session_date, open, high, low, close, volume FROM sessions
WHERE session = 'Day' AND session_date >= '2025-01-01' ORDER BY start_t;
```

### セッション起点の4時間足
セッションの最初の足から 4 時間ごとに区切る(日中は 08:45〜12:44 と 12:45〜引け、夜間は 17:00〜 / 21:00〜 / 01:00〜 / 05:00〜)。
```sql
WITH s AS (
  SELECT session_date, session, MIN(t) AS st FROM bars_1m
  WHERE symbol = 'NIY=F' AND session_date BETWEEN '2025-01-01' AND '2025-01-31'
  GROUP BY session_date, session
), g AS (
  SELECT x.session_date, x.session, (x.t - s.st) / 14400000 AS k,
         MIN(x.t) AS start_t, MAX(x.t) AS end_t, MAX(x.h) AS high, MIN(x.l) AS low, SUM(x.volume) AS volume
  FROM bars_1m x JOIN s ON s.session_date = x.session_date AND s.session = x.session
  WHERE x.symbol = 'NIY=F'
  GROUP BY x.session_date, x.session, k
)
SELECT g.session_date, g.session, g.k,
       strftime('%Y-%m-%d %H:%M', g.start_t / 1000 + 32400, 'unixepoch') AS start_jst,
       (SELECT o FROM bars_1m WHERE symbol = 'NIY=F' AND t = g.start_t) AS open,
       g.high, g.low,
       (SELECT c FROM bars_1m WHERE symbol = 'NIY=F' AND t = g.end_t) AS close,
       g.volume
FROM g ORDER BY g.start_t;
```
(`14400000` を `3600000` にすれば1時間足。セッションをまたいで区切りたくない限りこの形が安全。1か月分で約 0.9 秒。)

### 日足相当(2通り)
- **取引所の取引日**(夜間は翌営業日に属する。xlsx/JPX の日足と同じ考え方): 夜間に「次の日中の日付」を付けてまとめる。
```sql
WITH s AS (
  SELECT *, CASE WHEN session = 'Night' THEN LEAD(session_date) OVER (ORDER BY start_t) ELSE session_date END AS trade_date
  FROM sessions
)
SELECT trade_date,
       (SELECT open  FROM s s2 WHERE s2.trade_date = s.trade_date ORDER BY start_t      LIMIT 1) AS open,
       MAX(high) AS high, MIN(low) AS low,
       (SELECT close FROM s s2 WHERE s2.trade_date = s.trade_date ORDER BY start_t DESC LIMIT 1) AS close,
       SUM(volume) AS volume
FROM s WHERE trade_date IS NOT NULL
GROUP BY trade_date ORDER BY trade_date;
```
  (最終行の夜間は次の日中がまだ無いので `trade_date` が NULL になり除外される。全期間 2,220 日で約 3.5 秒。)
- **日中だけの日足**(終値 = 日中の最後の足の終値。2024-11-01 以前は 15:15 の足=引けの約定値、2024-11-05 以降は **15:44 の足**。15:45 の引けの足は DB に無いので、いまの時代の正確な引け値は取れない。§2 参照): `SELECT session_date, open, high, low, close FROM sessions WHERE session='Day'`。

## 7. 既知の注意

- **祝日の前夜の夜間は修復済み**(修復日は `dataset_info.repaired_holiday_nights_at_jst`)。
  2018〜2025 年の「取引の無い祝日の前夜」の夜間 68 セッション(51,764 本。年別 2018:12 2019:12 2020:12 2021:11 2022:10 2023:3 2024:5 2025:3)が、
  旧変換の誤りで 1 営業日あと(祝日の夜)に置かれていた。例: 2018-01-05(金)の夜間が 2018-01-08(月・成人の日)17:00〜 にあった。
  修復で `t` を日数単位で前へずらし `session_date` を直前の日中の日付にした(OHLCV は不変)。
  ★先頭の夜間(旧 2018-01-03 夜)は 2017-12-29(大納会)の夜へ移した。直前の日中がデータに無いので規則では決まらず、
  「xlsx のラベル 2018-01-04 の1つ前の取引日 = 2017-12-29」という同じ規約(2026 版 xlsx で実例確認済み)と、
  翌日中始値との窓の大きさ(+320)から判断した。外部の値とは未照合。
  この修復より前に書き出した分析結果は、祝日前後の夜間の扱いがずれている可能性がある。
- **`C:\Users\user\Desktop\backtest-multiyear-alerts.db` は修復していない**(同じ系統の別ファイル。bars_1m 2,449,878 本・2018-01-03 17:00〜2026-06-13 05:59 と、alerts 263,915 行)。
  その bars_1m は修復前のこのDBと同範囲で全列一致し、**同じ 68 夜・51,764 本のずれをそのまま持つ**(repair の dry で 68 件と出る)。
  修復済みのこのDBと突き合わせると 51,764 行(移動分)と 2025-12-30 夜の 780 本が食い違う。ずれた夜の時間帯に入る alerts は 4,033 行。
  両方を混ぜて使わないこと。直すなら同じ手順(写しを取ってから `repair-holiday-nights.mts --db ...alerts.db`)が使えるが、
  alerts の `triggered_at` は動かないので、ずれた夜の alerts は足との対応が崩れる(未対応)。
- 2025-12-30(大納会)の夜間 780 本が欠けていたのを `N225minif_2026.xlsx` から補った(`dataset_info.filled_sessions`)。
- **2022-09-23 以降は祝日も取引がある**(祝日取引)。祝日に日中・夜間のセッションがあるのは正しい。
  それ以前は祝日に取引は無い(国民の祝日の平日で日中がある日は 2022-09-22 以前に 0 日 = Python の jpholiday で照合)。
  2022-09-23〜2026-11-20 の「祝日または年末年始の平日」は、日中あり 53 日・日中なし 17 日(jpholiday で照合。日中なし =
  2023-01-02, 2023-01-09, 2023-11-03, 2024-01-01, 01-02, 01-08, 08-12, 09-16, 11-04, 12-31, 2025-01-01, 01-02, 01-13, 09-15, 12-31, 2026-01-01, 01-02)。
  祝日取引が無かった日の理由(年末年始・BCP テスト等)の内訳は未確認。
  国民の祝日でない平日で日中が無い日は、**年末年始(12/31・1/2・1/3)を除くと 0 日**、含めると 14 日(すべて 12/31・1/2・1/3。jpholiday で照合)。
- 値が xlsx と食い違う足が 2026 年分に 4 本ある(OHLC 3・出来高 4。2026-02-11 00:21/00:22, 2026-05-15 02:06/02:07)。
  元データの訂正と思われるが、DB は既存行を書き換えない方針なので古い値のまま。
- 2017-12-29 17:00 が先頭なので、先頭の夜間だけは同じ日付の日中が無い(データ期間の端)。
- **2021-09-17(金)の夜間が無い**(日中はある)。夜間が無い日中はこの1日だけ。翌営業日 2021-09-21 から夜間の終わりが 05:30→06:00 に
  変わっているので取引所のシステム切替に伴う休止の可能性があるが **未確認**(元の xlsx が手元に無い)。

## 8. 再構築と修復の手順

スクリプトは Finance_Monitor リポジトリにある。**本番DBに書く前に、必ず Windows タスクを止めて退避を取る。**

| スクリプト | 用途 |
|---|---|
| `scripts/append-backtest-db.mts [--dry]` | 自動追記(タスクが実行)。環境変数 `APPEND_DB` / `APPEND_SRC_DIR` / `APPEND_LOG_DIR` / `APPEND_README_OUT` で差し替え可 |
| `scripts/backtest-db/repair-holiday-nights.mts --db <path> [--apply]` | 祝日前夜の修復。既定は計画を出すだけ。冪等(2回目は 0 件) |
| `scripts/backtest-db/fill-from-xlsx.mts --db <path> --xlsx <file> [--session YYYY-MM-DD/Night --apply]` | xlsx と全数突き合わせ。指定セッションが DB に無ければ補う |
| `scripts/build-backtest-db.mts --out <path> <xlsx...>` | 全年の xlsx から作り直す(**出力DBを削除して作る**)。2018〜2026 の xlsx が全部要る |
| `scripts/backtest-db/snapshot.mts --db <元> --out <写し>` | 読み取り専用で開いて VACUUM INTO で写しを作る(退避・持ち出し用。出力先が既にあれば中止) |

修復の流れ(例。Finance_Monitor のフォルダで):
```powershell
Disable-ScheduledTask -TaskName "JP225 backtest OHLC append"
npx tsx scripts/backtest-db/snapshot.mts --db C:\Users\user\Desktop\backtest-multiyear.db --out C:\Users\user\Desktop\backtest-multiyear.db.bak-YYYYMMDD
npx tsx scripts/backtest-db/repair-holiday-nights.mts --db C:\Users\user\Desktop\backtest-multiyear.db          # 計画を確認
npx tsx scripts/backtest-db/repair-holiday-nights.mts --db C:\Users\user\Desktop\backtest-multiyear.db --apply
Enable-ScheduledTask -TaskName "JP225 backtest OHLC append"
```
2025-12-30 夜間の補充も同じ要領(`fill-from-xlsx.mts --db ... --xlsx C:\Users\user\Downloads\N225minif_2026.xlsx` で突き合わせ → `--session 2025-12-30/Night --apply`)。

作り直した場合は、作り直し直後に `repair-holiday-nights.mts` と `append-backtest-db.mts` を1回ずつ走らせて `dataset_info` とビューを作ること。
v0.9.116 以降の変換(rowsToBars)で作り直せば祝日前夜の移動は出ないはずだが、先頭ラベルの夜間は前のラベルが無く近似で置かれるので、
先頭の 2018-01-03 夜間の 1 件は出る(どちらも作り直しは未実施・未検証)。
