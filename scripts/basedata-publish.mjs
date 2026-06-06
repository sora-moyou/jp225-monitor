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

// A列=セッション日付(業務日)であって実日付ではない(ライブDB突合で確定 2026-06-06)。OSE 夜間は翌営業日に属する
// ため、実時刻へ変換する。例: 金曜夜の取引は A=月曜 とラベルされる → 実日付は金曜夕方〜土曜朝。
// 夕方(16:00〜) = D の前営業日 / 早朝(〜08:00) = 前営業日+1暦日 / 日中(08:45〜15:45) = D。
function isWeekendSerial(serial) {
  const dow = new Date((serial - EXCEL_1970) * 86400_000).getUTCDay();   // 0=日, 6=土
  return dow === 0 || dow === 6;
}
function prevBusinessDaySerial(serial) {
  let s = serial - 1;
  while (isWeekendSerial(s)) s--;   // 週末をスキップ(祝日は未対応=近似)
  return s;
}
function rowToBar(serial, frac, o, h, l, c, v) {
  let realSerial;
  if (frac >= 16 / 24) realSerial = prevBusinessDaySerial(serial);        // 夕方(夜間17:00〜)= 前営業日
  else if (frac < 8 / 24) realSerial = prevBusinessDaySerial(serial) + 1; // 早朝(00:00〜06:00)= 前営業日+1暦日
  else realSerial = serial;                                               // 日中(08:45〜15:45)= D
  const dayMs = (realSerial - EXCEL_1970) * 86400_000;
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

// 未来日時のバーがあれば「取り込みエラー」として扱う(黙って無視しない=バグやデータ異常を顕在化)。
// A列を実日付として正しくパースできていれば未来バーは出ないはず。出たらエラーをログに残して中止。
const nowT = Date.now();
const future = bars.filter(b => b.t > nowT + 2 * 60_000);
if (future.length > 0) {
  const sample = future.slice(0, 3).map(b => new Date(b.t + JST).toISOString().replace('T', ' ').slice(0, 16)).join(', ');
  console.error(`[basedata] ERROR: ${future.length} future-dated bars detected (e.g. ${sample} JST). `
    + `Aborting publish. A列は実カレンダー日付として解釈すること。日付解析 or ソースデータを確認してください。`);
  process.exit(1);
}
console.log(`parsed ${bars.length} bars (${new Date(bars[0].t + JST).toISOString().slice(0,10)} .. ${new Date(bars.at(-1).t + JST).toISOString().replace('T', ' ').slice(0,16)})`);

const out_bars = bars;
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
