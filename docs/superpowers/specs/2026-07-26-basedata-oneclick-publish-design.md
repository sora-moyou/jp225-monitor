# 225labo から基礎データをワンボタン公開(monitor2専用)

日付: 2026-07-26 / 対象: monitor(server + web) / 種別: 新機能(メンテナ運用の自動化)

## 1. 目的・背景

基礎データ(N225 mini 1分足)の公開は現状 **2層**:

- **publish(メンテナ手動)**: 225labo から xlsx を手動DL → `npm run basedata:publish -- <xlsx>` → GitHub `basedata-latest` リリース(公開リポ `sora-moyou/jp225-monitor`)へ gz+meta をアップロード。
- **import(全ユーザー・既存)**: アプリが公開リリースから gz を取得 → ローカルDB(`server/routes/basedata.ts` の status/import、UI「更新をチェック」)。

本機能は上段の **メンテナ手動作業をアプリ内ボタン1つに自動化**する。225labo の資格情報を設定に保存し、ボタンで「ログイン→xlsx取得→パース→gz→`gh` 公開→このPCへ即取込」まで実行する。**公開方式は現状と同一**(`gh` CLI で `basedata-latest` へ `--clobber` アップロード)。

## 2. 原則・スコープ

- **monitor2(フル版)専用**。lite には UI を出さない(lite ユーザーは従来どおりリリースから取り込むだけ=publish 権限不要)。variant で UI をゲート。
- 資格情報は **ローカルのみ・秘密扱い**(`~/.jp225-monitor/config.json`、既存 API キーと同じモデル。外部送信は 225labo と GitHub のみ=本機能の目的そのもの)。
- 日付マッピングは既存 `server/basedataDate.ts:rowToBar` が唯一の正準(SSOT)。未来バー混入時は publish 中止(既存スクリプトと同じガード)。
- 既存の import 経路・スクリプト CLI・公開先リポ/リリース名は不変。

## 3. アーキテクチャ / データフロー

ボタン押下 → `POST /api/basedata/publish` →

1. config から `basedataUser` / `basedataPass` を読む(未設定→400)。
2. **225labo ログイン**(`server/basedata/labo225.ts`): GET `user.php`(PHPSESSID 取得)→ POST `user.php`(`op=login`, `xoops_redirect=/`, `uname`, `pass`)→ 認証セッション cookie 取得。ログイン失敗を検知(下記§6)。
3. **ダウンロード**: cookie 付きで GET `https://225labo.com/modules/downloads_data/index.php?page=visit&cid=3&lid=160`。XOOPS downloads の `page=visit` は通常ファイルURLへ 302 → 追従してバイナリ取得。**取得物は ZIP アーカイブ**(例 `N225minif_2026 (11).zip`)で、中に xlsx が入っている。HTML(=未ログイン/ログインページ)が返ったら失敗として扱う。
4. **解凍→パース**: `extractXlsxFromZip(buf)` で ZIP から `.xlsx` エントリを取り出す(xlsx 自体も ZIP=`PK` マジックが同じなので、エントリ名/中身で判別: `.xlsx` エントリがあれば wrapper zip→内側を返す/`xl/workbook.xml` を含めば既に xlsx→そのまま)。次に `xlsxBufferToBars(innerXlsx)`: '1min' シート → `rowToBar` → ソート → 未来バーガード(throw)。ZIP 解凍は軽量依存(既存になければ `fflate`)。
5. **gz+meta**(`barsToGzMeta`): `dist/basedata-1min.ndjson.gz` + `dist/basedata-1min.meta.json`。
6. **公開**(`ghPublish`): `gh release view/create/upload ... --repo sora-moyou/jp225-monitor --clobber`(現行スクリプトと同一コマンド)。
7. **ローカル即取込**: パース済み bars を既存 `importBars` でこのPCの DB に upsert し、`basedata_generatedAt` メタを新 `generatedAt` に更新(公開直後にこのPCも最新化)。
8. 応答 `{ ok, count, firstDate, lastDate, generatedAt }`。

225labo の HTTP は Node `fetch`(cookie は手動管理: `set-cookie` を保持して次リクエストに付与)。XOOPS フォームに CSRF トークン欄が無いことは実地確認済み(`op`/`xoops_redirect`/`uname`/`pass` のみ)。

## 4. コンポーネント(SSOT リファクタ含む)

現状 `scripts/basedata-publish.mts` に一体化しているロジックを抽出し、**スクリプトとサーバが同一コアを共有**する:

- `server/basedata/publishCore.ts`(新規・純粋寄り):
  - `xlsxBufferToBars(buf: Buffer): BaseBar[]` — '1min' シート読取→`rowToBar`→ソート→**未来バーで throw**(空データでも throw)。
  - `barsToGzMeta(bars): { gz: Buffer; meta: BaseMeta; ndjson: string }` — gz と `{generatedAt, firstBar, lastBar, count}`。`generatedAt` は呼び出し側から `nowIso` を注入(テスト決定性)。
  - `ghPublish(gzPath, metaPath): void` — `gh` へアップロード(repo/release ハードコード維持)。
- `server/basedata/labo225.ts`(新規・server専用):
  - `buildLoginBody(uname, pass): string` — `op=login&xoops_redirect=%2F&uname=...&pass=...`(純関数=テスト対象)。
  - `classifyDownload(contentType, firstBytes): 'zip' | 'xlsx' | 'html' | 'unknown'` — 応答分類(純関数=テスト対象)。ZIP と xlsx は同じ `PK` マジックのため、`PK` は zip コンテナ扱いにしてエントリで判別。
  - `extractXlsxFromZip(buf): Buffer` — ZIP から `.xlsx` を取り出す(wrapper zip なら内側を返す/既に xlsx ならそのまま/`.xlsx` 無しは throw)。純関数=テスト対象。
  - `login(uname, pass): Promise<string /*cookie*/>` / `downloadXlsx(cookie): Promise<Buffer>`(ネット・非単体テスト)。
- `scripts/basedata-publish.mts` — 上記コアを呼ぶ**薄い CLI ラッパ**に置換(`--dry` 挙動と出力は現状維持=リグレッションなし)。
- `server/routes/basedata.ts` — `basedataPublishHandler`(`POST /api/basedata/publish`)追加。in-flight フラグで多重起動防止。fetch は AbortController でタイムアウト。
- `server/configStore.ts` — `UserConfig` に `basedataUser?` / `basedataPass?`。`resolveBasedataCreds()` ヘルパ(config→env `LABO225_USER`/`LABO225_PASS` フォールバック)。
- `server/routes/settings.ts` — GET に `basedataUserSet`/`basedataPassSet`(真偽のみ)。`SettingsBody` に両フィールド、POST apply は `applyStringField`(空欄=変更なし)。
- UI:
  - `web/index.html` — 設定に新 fieldset `#basedata-publish-fieldset`(legend「基礎データ(225labo)」): `#labo-user`(text)/`#labo-pass`(password)/ボタン `#basedata-publish-btn` + 結果欄 `#basedata-publish-result`。
  - `web/components/settings/{types,form}.ts` — `basedataUserSet/PassSet` を型/反映に、保存ペイロードに `basedataUser/Pass`。
  - `web/components/settingsModal.ts` — 入力の取得/クリア、ボタンの click→`POST /api/basedata/publish`→結果/エラー表示(スピナー・二度押し防止)。
  - `web/lib/variant.ts` — `VariantElements` に `basedataPublishFieldset` を追加し lite で非表示。`web/main.ts` で要素を配線。

## 5. UI 挙動

「基礎データ(225labo)」セクション: ユーザー名・パスワード(既存キー欄と同じ「設定済み」プレースホルダ)+「基礎データを更新」ボタン。押下→ボタン無効化+スピナー→成功で「176,273本(2025-12-29〜2026-07-25)公開+取込完了」、失敗でエラー文言(§6)。既存「更新」セクションの近くに配置。

## 6. エラーハンドリング / エッジ

- creds 未設定 → 400「225labo のユーザー名/パスワードが未設定」。
- ログイン失敗 → POST 応答が再度ログインフォーム/認証 cookie 未取得/ダウンロードが HTML を返す、のいずれかで検知 →「ログイン失敗(認証情報を確認してください)」。
- ダウンロード失敗(非xlsx=HTML) →「基礎データの取得に失敗(未ログインの可能性)」。ZIP 内に xlsx が無い →「アーカイブに xlsx が見つかりません」。
- 未来バー混入 → 中止「未来日時のバーを検出(日付マッピング/ソースを確認)」(既存ガードの文言に整合)。
- `gh` 未検出/未認証 → 「GitHub 公開に失敗(gh の認証を確認)」。
- 多重起動 → 409「実行中です」。
- ネットワーク/タイムアウト → 502 と理由。
- いずれも UI に日本語で明示。**部分失敗の不整合を避ける**: 公開(⑥)成功後にのみローカル取込(⑦)を行う(公開前に取込だけ進めない)。

## 7. テスト

- 純関数(vitest): `xlsxBufferToBars`(小 xlsx fixture でパース・未来行で throw・空で throw)、`barsToGzMeta`(注入 `nowIso` で決定的な meta)、`buildLoginBody`(body に op/xoops_redirect/uname/pass・URLエンコード)、`classifyDownload`(xlsx マジックバイト `PK` vs `<html`)。
- 応答分類・ログイン body 構築は fetch を使わず純粋に検証。実ネット/実 creds のログイン・`gh` 公開は単体テスト対象外(手動/ドライで確認)。
- `scripts/basedata-publish.mts --dry` が従来と同じ件数/日付/ファイルを出すことでコア抽出のリグレッション無しを確認。
- tsc green・既存テスト green を維持。

## 8. リリース

monitor(monitor2 + lite)を1版上げて同時リリース(既存フロー)。lite では UI 非表示・endpoint は存在するが lite で叩く導線なし(安全)。検知/SSE 不変=alert-audit 非対象。

## 9. セキュリティ注記

資格情報は平文でローカル `config.json` に保存(既存 API キーと同一モデル)。送信先は 225labo(ログイン/DL)と GitHub(`gh`)のみ。ログに creds を出さない。monitor2 のメンテナ自身の運用に限定。
