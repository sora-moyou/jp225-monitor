#!/usr/bin/env node
// xlsx(1minシート) → basedata-1min.ndjson.gz → GitHub Release(basedata-latest) にアップロード。
// 使い方: npm run basedata:publish -- "C:\path\to\N225minif_2026.xlsx"
import { writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import XLSX from 'xlsx';   // SheetJS は CJS: default import で module.exports(readFile/utils 等)を得る

const xlsxPath = process.argv[2];
if (!xlsxPath) { console.error('usage: npm run basedata:publish -- <path-to-xlsx>'); process.exit(1); }

const EXCEL_1970 = 25569, JST = 9 * 3600_000;   // 25569 = 1970-01-01 の Excel シリアル(標準1900日付系)
function rowToBar(serial, frac, o, h, l, c, v) {
  // 日付列はセッション開始日。夜間立会の翌朝(< 7:00)は実カレンダー日が翌日 → +1日補正。
  const carryDay = frac < 7 / 24 ? 86400_000 : 0;
  const dayMs = (serial - EXCEL_1970) * 86400_000 + carryDay;
  const minMs = Math.round((frac * 86400_000) / 60_000) * 60_000;
  return { t: dayMs + minMs - JST, o, h, l, c, v: typeof v === 'number' ? v : null };
}

console.log('reading', xlsxPath);
const wb = XLSX.readFile(xlsxPath, { cellDates: false });
const ws = wb.Sheets['1min'];
if (!ws) { console.error('sheet "1min" not found'); process.exit(1); }
const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
const bars = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const [d, tm, o, h, l, c, v] = r;
  if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
  bars.push(rowToBar(d, tm, o, h, l, c, v));
}
bars.sort((a, b) => a.t - b.t);
if (bars.length === 0) { console.error('no data rows parsed'); process.exit(1); }

// 未来日時のバーを除外。N225mini の Excel は夜間セッションの最後(06:00)まで枠を確保し、未到来ぶんを
// 最終値で埋めている(プレースホルダ)。これを取り込むと feed に未来バーが入り未来時刻のアラートが出る。
const nowT = Date.now();
const futureCount = bars.length - bars.filter(b => b.t <= nowT).length;
const real = bars.filter(b => b.t <= nowT);
if (futureCount > 0) console.log(`dropped ${futureCount} future-dated (placeholder) bars beyond now`);
if (real.length === 0) { console.error('all bars are future-dated?'); process.exit(1); }
console.log(`parsed ${real.length} bars (${new Date(real[0].t + JST).toISOString().slice(0,10)} .. ${new Date(real.at(-1).t + JST).toISOString().slice(0,16)})`);

const out_bars = real;
const ndjson = out_bars.map(b => JSON.stringify(b)).join('\n') + '\n';
mkdirSync('dist', { recursive: true });
const out = 'dist/basedata-1min.ndjson.gz';
writeFileSync(out, gzipSync(Buffer.from(ndjson, 'utf-8')));
console.log('wrote', out);

// 取り込み版管理用メタ。モニターは generatedAt を比較して「新着」を判定する。
const metaOut = 'dist/basedata-1min.meta.json';
const meta = { generatedAt: new Date().toISOString(), firstBar: out_bars[0].t, lastBar: out_bars.at(-1).t, count: out_bars.length };
writeFileSync(metaOut, JSON.stringify(meta));
console.log('wrote', metaOut, meta);

try { execSync('gh release view basedata-latest', { stdio: 'ignore' }); }
catch { execSync('gh release create basedata-latest --title "Base data (N225 mini 1min)" --notes "Auto-published base data. Updated weekly."', { stdio: 'inherit' }); }
execSync(`gh release upload basedata-latest ${out} ${metaOut} --clobber`, { stdio: 'inherit' });
console.log('✅ uploaded gz + meta to release basedata-latest');
