// scripts/news-window-measure.mts — 「取得結果の窓(newest NEWS_MAX_ITEMS 件)が続く時間」を実測する。
//
// ★なぜ要るか:
//   ニュース翻訳の再試行バックオフ(server/newsTranslate.ts の TRANSLATE_RETRY_BACKOFF_MS)は
//   「累計の待ち時間 < 窓が続く時間」でなければ意味が無い(待っている間に記事が窓から消える)。
//   その窓の長さは **データ次第** なので、コードに書いた定数 NEWS_FETCH_WINDOW_MIN_MS が
//   現実と合っているかを **いつでも測り直せる** ようにしておく。
//   定数をテストで固定しただけだと循環(未検証の値を自分で正しいと言い張る)になる。
//
// 使い方(DB を読むだけ・書き込み無し):
//   npx tsx scripts/news-window-measure.mts                       # 既定 = %APPDATA%/jp225-monitor/jp225.db
//   npx tsx scripts/news-window-measure.mts <path-to-jp225.db>    # 同期フォルダのコピー等
//
// 出力の読み方: **min** がバックオフ累計の上限。median ではない(median を根拠にすると半分は救えない)。

// ★import は **葉モジュールだけ**。newsTranslate.js を読むと LLM プロバイダ一式が構築され、
//   「窓の長さを測るだけ」のスクリプトが API キーを読んでしまう。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolveAppDataDir } from '../server/appDataDir.js';
import { NEWS_MAX_ITEMS } from '../server/config.js';
import {
  TRANSLATE_RETRY_BACKOFF_MS, NEWS_FETCH_WINDOW_MIN_MS,
} from '../server/newsRetryPolicy.js';

const path = process.argv[2] ?? join(resolveAppDataDir(), 'jp225.db');
const db = new DatabaseSync(path, { readOnly: true });

const ts = (db.prepare('SELECT published_at AS t FROM news ORDER BY published_at DESC').all() as Array<{ t: number }>)
  .map(r => r.t);
if (ts.length < NEWS_MAX_ITEMS) {
  console.log(`news が ${ts.length} 件しかありません(窓 ${NEWS_MAX_ITEMS} 件に満たない)。測定できません。`);
  process.exit(0);
}

// 各アンカー i について「i 番目の記事が窓から押し出されるまでの時間」= 200件ぶんが張る時間。
const spans: number[] = [];
for (let i = 0; i + NEWS_MAX_ITEMS - 1 < ts.length; i++) {
  spans.push((ts[i]! - ts[i + NEWS_MAX_ITEMS - 1]!) / 60_000);
}
spans.sort((a, b) => a - b);
const at = (p: number) => spans[Math.floor((spans.length - 1) * p)]!;

console.log(`DB: ${path}`);
console.log(`窓 = 新しい順 ${NEWS_MAX_ITEMS} 件(NEWS_MAX_ITEMS)/ アンカー数 ${spans.length}`);
console.log(`窓が続く時間[分]: min ${at(0).toFixed(0)} / p05 ${at(0.05).toFixed(0)} / p25 ${at(0.25).toFixed(0)}`
  + ` / median ${at(0.5).toFixed(0)} / p75 ${at(0.75).toFixed(0)} / max ${at(1).toFixed(0)}`);

let cum = 0;
console.log('\n再試行ごとの累計待ちが窓に収まる割合:');
for (const [i, wait] of TRANSLATE_RETRY_BACKOFF_MS.entries()) {
  cum += wait;
  const fits = spans.filter(s => s > cum / 60_000).length / spans.length;
  console.log(`  再試行${i + 1}回目: 累計 ${(cum / 60_000).toFixed(0)}分 → ${(fits * 100).toFixed(1)}% のアンカーで間に合う`);
}

const measuredMin = at(0);
const declared = NEWS_FETCH_WINDOW_MIN_MS / 60_000;
console.log(`\nコードの宣言値 NEWS_FETCH_WINDOW_MIN_MS = ${declared.toFixed(0)}分 / 実測 min = ${measuredMin.toFixed(0)}分`);
if (measuredMin < declared) {
  console.log('★宣言値が実測より長い = バックオフが窓を超えうる。newsTranslate.ts の定数とラダーを見直すこと。');
  process.exitCode = 1;
} else if (cum / 60_000 >= measuredMin) {
  console.log('★バックオフ累計が実測 min 以上 = 最悪ケースで救済できない。ラダーを短くすること。');
  process.exitCode = 1;
} else {
  console.log(`OK: 累計 ${(cum / 60_000).toFixed(0)}分 < 実測 min ${measuredMin.toFixed(0)}分(余裕 ${(measuredMin / (cum / 60_000)).toFixed(1)}倍)`);
}
