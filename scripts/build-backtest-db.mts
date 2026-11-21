// Build a multi-year backtest DB from the 4 NIY=F 1-min xlsx files.
// Parses each xlsx '1min' sheet, CONCATENATES the rows of all files, then maps them via the
// canonical rowsToBars (server/basedataDate.ts). Rows must be concatenated first: the night
// session's real date is derived from the previous label present in the data, and for the
// first night of a year that label lives in the previous year's file.
// ★This script DELETES and rebuilds the output DB.
//   Run: npx tsx scripts/build-backtest-db.mts [--out <db path>] [xlsx ...]
//   (defaults: DEFAULT_DB_PATH / DEFAULT_XLSX_FILES below).
// inserts all bars as NIY=F into a FRESH sqlite DB using the SAME schema + upsertBar
// path the monitor uses, so jp225-Trade's ReplayFeed reads it identically.
//
// Date convention / future-bar handling matches scripts/basedata-publish.mts and
// server/basedata.ts:importBars — out-of-session bars (classifySession==null) are skipped,
// future-dated bars ABORT the build (= date-mapping bug).
import { existsSync, rmSync } from 'node:fs';
import XLSX from 'xlsx';
import { rowsToBars, sheetAoaToRows, type BaseRow } from '../server/basedataDate.js';
import { openDb, upsertBar } from '../server/db/store.js';
import { classifySession } from '../core/session.js';

const JST = 9 * 3600_000;
const SYMBOL = 'NIY=F';
const DEFAULT_DB_PATH = 'C:\\Users\\user\\Desktop\\backtest-multiyear.db';
const DEFAULT_XLSX_FILES = [
  'C:\\Users\\user\\Downloads\\N225minif_2018.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2019.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2020.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2021.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2022.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2023\\N225minif_2023.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2024\\N225minif_2024.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2025\\N225minif_2025.xlsx',
  'C:\\Users\\user\\Downloads\\N225minif_2026\\N225minif_2026.xlsx',
];

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
if (outIdx >= 0 && !argv[outIdx + 1]) { console.error('--out needs a path'); process.exit(1); }
const DB_PATH = outIdx >= 0 ? argv[outIdx + 1]! : DEFAULT_DB_PATH;
const positional = argv.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1));
const XLSX_FILES = positional.length > 0 ? positional : DEFAULT_XLSX_FILES;

function parseXlsx(path: string): BaseRow[] {
  console.log('reading', path);
  const wb = XLSX.readFile(path, { cellDates: false });
  const ws = wb.Sheets['1min'];
  if (!ws) { console.error(`sheet "1min" not found in ${path}`); process.exit(1); }
  const rows = sheetAoaToRows(XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as unknown[][]);
  console.log(`  parsed ${rows.length} numeric rows`);
  return rows;
}

function jstStr(t: number): string {
  return new Date(t + JST).toISOString().replace('T', ' ').slice(0, 16);
}

// ── parse all files, CONCATENATE rows, then map (labels span files), sort by t ──
let allRows: BaseRow[] = [];
for (const f of XLSX_FILES) allRows = allRows.concat(parseXlsx(f));
const mapped = rowsToBars(allRows);
for (const w of mapped.warnings) console.warn(`[backtest-db] WARN: ${w}`);
const all = mapped.bars;
all.sort((a, b) => a.t - b.t);
if (all.length === 0) { console.error('no data rows parsed across all files'); process.exit(1); }

// ── ABORT on future-dated bars (= date-mapping bug), like basedata-publish ──
const nowT = Date.now();
const future = all.filter(b => b.t > nowT + 2 * 60_000);
if (future.length > 0) {
  const sample = future.slice(0, 5).map(b => jstStr(b.t)).join(', ');
  console.error(`[backtest-db] ERROR: ${future.length} future-dated bars detected `
    + `(e.g. ${sample} JST, now ${jstStr(nowT)} JST). Aborting build. `
    + `server/basedataDate.ts の日付マッピング or ソースデータを確認してください。`);
  process.exit(1);
}

// ── fresh DB ───────────────────────────────────────────────────────────────
for (const ext of ['', '-wal', '-shm']) {
  const p = DB_PATH + ext;
  if (existsSync(p)) rmSync(p);
}
const db = openDb(DB_PATH);

// ── insert (single transaction, skip out-of-session like importBars) ────────
let inserted = 0, skipped = 0, minT = Infinity, maxT = -Infinity;
db.exec('BEGIN');
try {
  for (const b of all) {
    const s = classifySession(b.t);
    if (!s) { skipped++; continue; }   // out-of-session / weekend / holiday → skip (importBars convention)
    upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
    inserted++;
    if (b.t < minT) minT = b.t;
    if (b.t > maxT) maxT = b.t;
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

console.log('');
console.log(`DB: ${DB_PATH}`);
console.log(`total parsed rows: ${all.length}`);
console.log(`inserted bars:     ${inserted}`);
console.log(`skipped (off-session/weekend/holiday): ${skipped}`);
console.log(`date span (JST):   ${jstStr(minT)} .. ${jstStr(maxT)}`);

// ── verify: bar count + price range per calendar year (JST) ─────────────────
// derive calendar year from t in JST so the leader can see regimes.
const yearStats = db.prepare(`
  SELECT
    strftime('%Y', datetime((t + ${JST}) / 1000, 'unixepoch')) AS yr,
    COUNT(*) AS n,
    MIN(l) AS lo,
    MAX(h) AS hi,
    MIN(t) AS mint,
    MAX(t) AS maxt
  FROM bars_1m
  WHERE symbol = ?
  GROUP BY yr
  ORDER BY yr
`).all(SYMBOL) as Array<{ yr: string; n: number; lo: number; hi: number; mint: number; maxt: number }>;

console.log('');
console.log('Per calendar year (JST):');
console.log('  year | bars   | low    | high   | range  | first bar        | last bar');
for (const r of yearStats) {
  const range = r.hi - r.lo;
  console.log(
    `  ${r.yr} | ${String(r.n).padStart(6)} | ${String(r.lo).padStart(6)} | ${String(r.hi).padStart(6)} `
    + `| ${String(range).padStart(6)} | ${jstStr(r.mint)} | ${jstStr(r.maxt)}`,
  );
}

db.close();
console.log('\ndone.');
