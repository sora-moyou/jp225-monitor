// Build a multi-year backtest DB from the 4 NIY=F 1-min xlsx files.
// Parses each xlsx '1min' sheet via the canonical rowToBar (server/basedataDate.ts),
// inserts all bars as NIY=F into a FRESH sqlite DB using the SAME schema + upsertBar
// path the monitor uses, so jp225-Trade's ReplayFeed reads it identically.
//
// Run: npx tsx scripts/build-backtest-db.mts
//
// Date convention / future-bar handling matches scripts/basedata-publish.mts and
// server/basedata.ts:importBars — out-of-session bars (classifySession==null) are skipped,
// future-dated bars ABORT the build (= date-mapping bug).
import { existsSync, rmSync } from 'node:fs';
import XLSX from 'xlsx';
import { rowToBar, type BaseBar } from '../server/basedataDate.js';
import { openDb, upsertBar } from '../server/db/store.js';
import { classifySession } from '../collector/session.js';

const JST = 9 * 3600_000;
const SYMBOL = 'NIY=F';
const DB_PATH = 'C:\\Users\\user\\Desktop\\backtest-multiyear.db';
const XLSX_FILES = [
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

function parseXlsx(path: string): BaseBar[] {
  console.log('reading', path);
  const wb = XLSX.readFile(path, { cellDates: false });
  const ws = wb.Sheets['1min'];
  if (!ws) { console.error(`sheet "1min" not found in ${path}`); process.exit(1); }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as any[][];
  const bars: BaseBar[] = [];
  for (let i = 1; i < rows.length; i++) {
    const [d, tm, o, h, l, c, v] = rows[i];
    if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
    bars.push(rowToBar(d, tm, o, h, l, c, typeof v === 'number' ? v : null));
  }
  console.log(`  parsed ${bars.length} numeric rows`);
  return bars;
}

function jstStr(t: number): string {
  return new Date(t + JST).toISOString().replace('T', ' ').slice(0, 16);
}

// ── parse all files, merge, sort by t ───────────────────────────────────────
let all: BaseBar[] = [];
for (const f of XLSX_FILES) all = all.concat(parseXlsx(f));
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
