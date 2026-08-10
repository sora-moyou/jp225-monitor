import type { InstrumentMeta } from './types.js';

// v0.3.32: 監視銘柄を「リアルタイム取得可能なもの + 値がさ株5」に再設計。
// v0.7.20(全銘柄 HTTP 化): 価格源を公開 HTTP(ajax_cme.js / ajax_fx.js)のみに統一。この 2 エンドポイントで
// ~24h ライブに取れる 4 銘柄に絞る: NIY=F(136)/YM=F(731)/NQ=F(737)/JPY=X(511)。
// ^HSI(香港ハンセン)/CL=F(WTI原油)/^TNX(米10年債)は socket 廃止に伴いドロップ(HTTP 源が無い/cash コードは
// 立会外で stale)。順序・ラベルは残る 4 銘柄で維持。
// STEP 2 リファクタ: 実行時定数 INSTRUMENTS を core へ移設(依存は core/types.ts のみ=非循環)。
// server/config.ts は本モジュールから再export し、web は本モジュールを直接 import する(web→server 実行時依存の解消)。
//
// ── 値がさ株7(6861.T/9983.T/6146.T/6273.T/8035.T/9984.T/285A.T)を削除した理由 ──────────────────
// v0.7.18/0.7.19(2026-07-07)で価格経路を公開 HTTP 2本(ajax_cme.js / ajax_fx.js)へ統一したとき、
// ^HSI/CL=F/^TNX は「落とす」と上に**明記して**消したのに、**値がさ株7だけは取得経路が理由の記載なく
// 消え、この配列に宣言だけが残った**。画面にも警告にも何も出ず、1か月以上「取れているつもり」が続いた。
//
// ★測ったのは **稼働機**(本番 monitor の jp225.db スナップショット = Documents/trade/prices_kabu.db)。
//   開発機の %APPDATA%/jp225-monitor/jp225.db は 2026-06-19 止まりだが、それは **この機体で monitor を
//   動かしていない** だけで、欠測の日付の正ではない。日付を直すときは必ず稼働機の DB で測ること。
//
//   ・最終記録: **2026-07-07 15:30 JST**(稼働機 bars_1m・7銘柄 計 9,344 行)。
//   ・**連続記録ではなかった**: 2026-06-19〜07-07 の平日 13 日のうち記録があるのは **5 日だけ**(8 日はゼロ)。
//     記録のある日は 1 銘柄あたり約 320 本 = 立会 330 分(9:00-11:30 + 12:30-15:30)をほぼ丸ごと一括で
//     埋めており、部分的なのは 1 日(06-25 が約 66 本)だけ。
//   ・この「1 日分をまとめて埋める」形になる理由は、bars_1m の **.T 行の**唯一の書き手が collector の
//     **起動時 Yahoo backfill** だったから(bars_1m そのものには collector/record.ts の recordTick や
//     server/basedata.ts の upsertBar も書く。限定を外して読まないこと)。
//     根拠: `git show ad755db~1:collector/index.ts` の起動時 1 回だけの
//     `backfillBars(db, sym, await fetchMinuteBars(sym))` が全銘柄を回す一方、2 秒ポールの
//     `fetchFeedPrices()`(旧 server/sources/nikkei225jpFeed.ts)の `SYMBOL_CODES` には .T が 1 つも
//     無い = **collector の足記録の**ライブ経路には最初から乗っていなかった。
//     ★誤読注意: 「.T は一度も画面に出ていなかった」という意味ではない。monitor 本体の priceLoop は
//       v0.7.19 の Yahoo 全廃まで `fetchYahooChartPrices(SYMBOLS)` で .T の**現在値**を取っていた
//       (`git show 6d8d1e2~1:server/loops/priceLoop.ts`)。消えたのは分足の記録と、その現在値の両方。
//   ・2026-07-07 の HTTP 統一で backfill 自体が消え、以後は **恒久的にゼロ**。
//
// 復活を検討したが、取得元の候補(Yahoo)の robots.txt が `User-agent: * / Disallow: /`(全面禁止)で
// あり、**記録しない**と判断した。過去に記録済みの1分足(稼働機 9,344 行 / 開発機 19,603 行)は
// どちらの DB にもそのまま残してある(記録は記録。削除も移動もしない)。
//
// ★ここに銘柄を足すときは、**必ず取得経路(server/sources/*)も同時に足すこと**。
//   宣言と取得経路のズレは server/sources/instrumentPriceRoutes.test.ts が赤で止める
//   (銘柄だけ足す/経路だけ消す のどちらでも落ちる)。
export const INSTRUMENTS: InstrumentMeta[] = [
  { symbol: 'NIY=F',  labelJa: '日経225先物',    labelEn: 'Nikkei 225 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'NQ=F',  labelJa: 'ナスダック100先物', labelEn: 'Nasdaq 100 Fut', magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'YM=F',  labelJa: 'ダウ先物',        labelEn: 'Dow Fut',        magnitudeThreshold: 0.30, slopeThreshold: 0.15, unit: 'percent', category: 'main' },
  { symbol: 'JPY=X', labelJa: 'ドル円',          labelEn: 'USD/JPY',        magnitudeThreshold: 0.20, slopeThreshold: 0.10, unit: 'percent', category: 'main' },
];
