> **【2026-06-12 改訂】**
> 1. 当初の faireconomy 週次JSONは **actual(結果)を含まず予想専用**と判明（エバリュエーター実フェッチ確認）→ 不採用。
> 2. ユーザー指示で **nikkei225jp.com 総合ニュース**を一般ニュース源として広く取り込み（`server/sources/nikkei225jp.ts`）。
> 3. 指標は **無料ソース限定**の指示で **minkabu 経済指標カレンダー**(`https://fx.minkabu.jp/indicators`・robots許可)を採用し、
>    当初の「結果＋反応」を復活。`server/sources/econIndicators.ts` が US×★4+×発表済みを抽出し、
>    結果・予想・前回 ＋ NK225夜間先物の発表後10分の反応(pt) を NewsItem 化して NEWS にマージ。
>    `?date=YYYY-MM-DD&days=1&importance=4` で単日取得、`data_country="US"` 行を抽出、CPI のサブ種別[前月比/前年比/コア]は名前に残す。
> 下記は当初(faireconomy前提)設計の記録。反応算出(NK225夜間+10分・getBarCloseNear)は minkabu 版でもそのまま採用。

# 米経済指標をNEWSに取り込む（結果＋反応）設計

- 日付: 2026-06-12
- 対象: jp225-monitor（Finance_Monitor）
- 関連: 既存 news パイプライン（rssAggregator / newsLoop / cache / SSE / newsFeed）

## 1. 目的（ユーザー確定）

monitor の NEWS に **米経済指標の結果(actual)** を取り込む。各指標に **NK225夜間先物の発表後10分の反応(pt)** を付ける。
**予想値(consensus)は表示しない**（ユーザー選択=C）。新規 API キー/サインアップ不要で実現する。

## 2. データソース（キー不要）

**ForexFactory系の無料週次カレンダー JSON**（faireconomy ミラー）:
`https://nfs.faireconomy.media/ff_calendar_thisweek.json`

- 形式（要素例）: `{ title, country, date(ISO+TZ), impact, forecast, previous, actual }`
  - `country` は通貨コード表記（米 = `"USD"`）。`impact` = `High|Medium|Low|Holiday`。
  - `actual` は発表前は空文字、発表後に値が入る（数分遅れることあり）。
- フィルタ: `country==='USD'` かつ `impact` が `High`（既定。設定で Medium も可）。
- キー不要・MT4/5 EA で広く使われる事実上の標準フィード。`User-Agent` を付けて取得。
- **フォールバック**: 取得失敗時は無音でスキップ（既存 RSS ニュースは従来どおり流れる）。

> 予想値は本フィードに無料で含まれるが、本仕様では**表示しない**（将来 ON 可能なよう内部では保持）。

## 3. 反応(reaction)の算出

- 指標の発表時刻 `releaseAt`（= `date`）に対し、**NK225夜間先物の `releaseAt` → `releaseAt+10分` の値動き**を価格DBから算出。
  - `reaction = price(releaseAt+10min) − price(releaseAt)`（pt、符号付き）。
  - 価格は `server/db/store.ts` の `getRecentBars(db, <NK225夜間シンボル>, releaseAt-数分)` で取得し、`releaseAt` 直近の bar と `+10分` 直近の bar の終値差。
  - シンボルは実装時に DB 実データで確認（NK225 夜間先物。例: `NIY=F` 等）。
- **算出タイミング**: 発表から10分経過し、かつ DB に該当区間の bar がある時のみ計算（無ければ `reaction=undefined` のまま）。米高インパクト指標(CPI/NFP等)は 21:30/22:30 JST=夜間ザラ場のため通常取得可能。
- 各ポーリングで未算出のものを再評価（10分経過後に自然に埋まる）。算出済みは memo して再計算しない。
- 反応は**ポイント差のみ**（¥換算しない。NK225 の pt をそのまま）。

## 4. NEWSへの統合方式（既存パイプライン再利用）

発表済みの米指標を **NewsItem 形に変換して既存ニュース一覧へマージ**する。SSE チャンネル・描画・AI文脈は既存をそのまま使う（新規surface最小）。

- `server/sources/economicCalendar.ts`（新規）:
  - `fetchEconomicNews(db, now): Promise<NewsItem[]>` — 週次JSON取得→US/High×発表済みを抽出→反応算出→NewsItem化。
  - NewsItem 変換:
    - `title`: `📊 米指標 {名称}: 結果 {actual}（前回 {previous}）{反応がある場合 → ' → NK225 ' + 符号付pt + 'pt(10分)'}`
      - 例: `📊 米指標 CPI(前月比): 結果 0.2%（前回 0.3%） → NK225 +45pt(10分)`
    - `source`: `'米経済指標'`、`lang`: `'ja'`、`publishedAt`: `releaseAt`、`url`: 空（または ff のリンク）、`id`: `econ:{title}:{releaseAt}`。
  - モジュール内 memo（id→{reaction}）で反応の再計算回避。状態は再起動で消えるが、週次フィード＋価格DBから再構築可能。
- `server/loops/newsLoop.ts`（改修）:
  - 既存 `fetchAllNews()` に加え `fetchEconomicNews(db, now)` を呼び、**両者をマージして `publishedAt` 降順**で `setNews()` → 既存どおり broadcast。
  - 取得失敗は握りつぶし（econ が落ちても RSS ニュースは出す）。
  - `db` ハンドルを newsLoop に渡す（未配線なら startNewsLoop の引数に追加）。
- 結果: 指標は**既存 NEWS パネルにインラインで**表示され、AIチャット/アラート文脈(`formatNewsForChat`)にも自動で入る。

## 5. 表示（フロント）

- 既存 `web/components/newsFeed.ts` の描画をそのまま使う（source ラベル `米経済指標` が出る）。
- 視認性のため、`source==='米経済指標'` の項目に軽いバッジ/色付け（任意・CSS のみ）。MVPでは絵文字 `📊` で区別できるので CSS は最小 or 無し。

## 6. 設定

- `config.json` / 設定UI に任意で:
  - `econIndicatorsEnabled`（既定 true）
  - `econImpactMedium`（既定 false = High のみ）
- API キーは不要。`fetch` のみ。

## 7. ガード・負荷

- newsLoop は既に `inPollWindow` ゲート済み（時間外は取得しない）。econ も同ループ内なので追加ゲート不要。
- 週次JSONは小さい（数十KB）。ポーリング間隔は news と共通（既定60s）。
- 反応算出は DB 読み取りのみ（既存 getRecentBars）。重い処理なし。

## 8. テスト

- `economicCalendar` の純関数を分離してユニットテスト:
  - `parseFfCalendar(json)` → US/High×発表済み抽出（country/impact/actual空 のフィルタ）。
  - `toNewsItem(event, reaction?)` → title 整形（反応有/無の両パターン・予想は出さない）。
  - `computeReaction(bars, releaseAt)` → +10分の終値差（bar 欠損時 undefined・境界）。
- newsLoop マージ: econ＋rss が publishedAt 降順で1本化されること（fetch をスタブ）。
- 既存 news テスト緑（パイプライン不変）。

## 9. 受け入れ基準

- 発表済みの米高インパクト指標が NEWS にインライン表示され、`結果` と `前回` が出る。
- 発表後10分で `→ NK225 ±pt(10分)` の反応が付く（夜間ザラ場で価格がある場合）。
- 予想値は表示されない。
- 取得失敗・価格欠損でも既存ニュースは正常、UIは壊れない。
- 既存テスト緑・tsc クリーン・新規ユニットテスト緑。

## 10. リリース

- monitor 版 0.7.5 → **0.7.6**（package.json/tauri.conf/Cargo.toml + Cargo.lock）。署名鍵=無パスフレーズ。ブランチ=master。
- 検知ロジック変更ではない（news 追加）ため `alert-audit.mts` は非対象。
- 署名ビルド→ GitHub リリース（monitor の手順）。
