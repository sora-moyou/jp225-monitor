// xlsx(1minシート) → basedata-1min.ndjson.gz → GitHub Release(basedata-latest) にアップロード。
// 使い方: npm run basedata:publish -- "C:\path\to\N225minif_2026.xlsx" [--dry]
//   --dry: gz/meta を dist に書くだけで GitHub へはアップロードしない(検証用)。
// 日付変換は server/basedataDate.ts:rowToBar が唯一の正準実装(取り込み側と共有・SSOT)。
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import XLSX from 'xlsx';
import { rowToBar, type BaseBar } from '../server/basedataDate.js';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const xlsxPath = argv.find(a => !a.startsWith('--'));
if (!xlsxPath) { console.error('usage: npm run basedata:publish -- <path-to-xlsx> [--dry]'); process.exit(1); }

const JST = 9 * 3600_000;

console.log('reading', xlsxPath);
const wb = XLSX.readFile(xlsxPath, { cellDates: false });
const ws = wb.Sheets['1min'];
if (!ws) { console.error('sheet "1min" not found'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as any[][];
const bars: BaseBar[] = [];
for (let i = 1; i < rows.length; i++) {
  const [d, tm, o, h, l, c, v] = rows[i];
  if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
  bars.push(rowToBar(d, tm, o, h, l, c, typeof v === 'number' ? v : null));
}
bars.sort((a, b) => a.t - b.t);
if (bars.length === 0) { console.error('no data rows parsed'); process.exit(1); }

// 未来日時のバーは「取り込みエラー(=日付バグ)」として publish を中止する(黙殺せず顕在化)。方針は
// 取り込み方法に合わせる(server/basedata.ts:importBars が未来バーをドロップ+error ログする基準実装)。
// 正しくマッピングできていれば未来バーは出ないはず。
const nowT = Date.now();
const future = bars.filter(b => b.t > nowT + 2 * 60_000);
if (future.length > 0) {
  const sample = future.slice(0, 3).map(b => new Date(b.t + JST).toISOString().replace('T', ' ').slice(0, 16)).join(', ');
  console.error(`[basedata] ERROR: ${future.length} future-dated bars detected (e.g. ${sample} JST). `
    + `Aborting publish. server/basedataDate.ts の日付マッピング or ソースデータを確認してください。`);
  process.exit(1);
}
console.log(`parsed ${bars.length} bars (${new Date(bars[0].t + JST).toISOString().slice(0, 10)} .. `
  + `${new Date(bars.at(-1)!.t + JST).toISOString().replace('T', ' ').slice(0, 16)})`);

const ndjson = bars.map(b => JSON.stringify(b)).join('\n') + '\n';
mkdirSync('dist', { recursive: true });
const out = 'dist/basedata-1min.ndjson.gz';
writeFileSync(out, gzipSync(Buffer.from(ndjson, 'utf-8')));
console.log('wrote', out);

// 取り込み版管理用メタ。モニターは generatedAt を比較して「新着」を判定する。
const metaOut = 'dist/basedata-1min.meta.json';
const meta = { generatedAt: new Date().toISOString(), firstBar: bars[0].t, lastBar: bars.at(-1)!.t, count: bars.length };
writeFileSync(metaOut, JSON.stringify(meta));
console.log('wrote', metaOut, meta);

if (dry) { console.log('--dry: skip GitHub upload'); process.exit(0); }

try { execSync('gh release view basedata-latest', { stdio: 'ignore' }); }
catch { execSync('gh release create basedata-latest --title "Base data (N225 mini 1min)" --notes "Auto-published base data. Updated weekly."', { stdio: 'inherit' }); }
execSync(`gh release upload basedata-latest ${out} ${metaOut} --clobber`, { stdio: 'inherit' });
console.log('✅ uploaded gz + meta to release basedata-latest');
