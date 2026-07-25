// xlsx(1minシート) → basedata-1min.ndjson.gz → GitHub Release(basedata-latest) にアップロード。
// 使い方: npm run basedata:publish -- "C:\path\to\N225minif_2026.xlsx" [--dry]
//   --dry: gz/meta を dist に書くだけで GitHub へはアップロードしない(検証用)。
// パース/gz/公開ロジックは server/basedata/publishCore.ts が唯一の正準実装(サーバのワンボタン公開と共有・SSOT)。
// 日付変換は server/basedataDate.ts:rowToBar が唯一の正準実装(取り込み側と共有・SSOT)。
import { readFileSync } from 'node:fs';
import { xlsxBufferToBars, barsToGzMeta, writeGzMeta, ghPublish, BASEDATA_REPO } from '../server/basedata/publishCore.js';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const xlsxPath = argv.find(a => !a.startsWith('--'));
if (!xlsxPath) { console.error('usage: npm run basedata:publish -- <path-to-xlsx> [--dry]'); process.exit(1); }

const JST = 9 * 3600_000;

console.log('reading', xlsxPath);
let bars;
try {
  bars = xlsxBufferToBars(readFileSync(xlsxPath));
} catch (err) {
  console.error(`[basedata] ERROR: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
console.log(`parsed ${bars.length} bars (${new Date(bars[0]!.t + JST).toISOString().slice(0, 10)} .. `
  + `${new Date(bars.at(-1)!.t + JST).toISOString().replace('T', ' ').slice(0, 16)})`);

const { gz, meta } = barsToGzMeta(bars, new Date().toISOString());
const { gzPath, metaPath } = writeGzMeta(gz, meta);
console.log('wrote', gzPath);
console.log('wrote', metaPath, meta);

if (dry) { console.log('--dry: skip GitHub upload'); process.exit(0); }

ghPublish(gzPath, metaPath);
console.log(`✅ uploaded gz + meta to release basedata-latest (${BASEDATA_REPO})`);
