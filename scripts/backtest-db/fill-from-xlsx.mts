// 基礎データ xlsx(N225minif_YYYY.xlsx の '1min' シート)と バックテスト用DB を全数で突き合わせ、
// DB に無いセッションを xlsx から補う。
//   ・突き合わせ(常に実行・書かない): xlsx の範囲で t と OHLCV を比較し、DBに無い足 / xlsxに無い足 /
//     値の不一致 / session_date・session の不一致 を件数で出す。
//   ・補充(--apply と --session の両方が要る): 指定セッションの足を挿入する。
//     そのセッションの足が DB に1本でもあれば中止(部分的に混ぜない)。既存行は書き換えない。
// 変換は正準実装 server/basedataDate.ts:rowsToBars(夜間の実日付 = データ内の1つ前のラベル)、
// セッション付けは core/session.ts:classifySession、挿入は server/db/store.ts:upsertBar(既存経路)。
//
// Run: npx tsx scripts/backtest-db/fill-from-xlsx.mts --db <path> --xlsx <file> [--session 2025-12-30/Night ...] [--apply]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import XLSX from 'xlsx';
import { rowsToBars, sheetAoaToRows } from '../../server/basedataDate.js';
import { upsertBar } from '../../server/db/store.js';
import { classifySession } from '../../core/session.js';
import { nightsWithoutDay, overlappingSessions } from '../../server/backtestDb/holidayNights.js';
import {
  BACKTEST_SYMBOL as SYMBOL, dbOpenOptions, ensureBacktestDbSchema, getDatasetInfo, jstMinute, jstSecond, loadSessionSpans, refreshDatasetStats, setDatasetInfo,
} from '../../server/backtestDb/schema.js';

const argv = process.argv.slice(2);
const val = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const DB_PATH = val('--db');
const XLSX_PATH = val('--xlsx');
const APPLY = argv.includes('--apply');
const SESSIONS = argv.flatMap((a, i) => a === '--session' && argv[i + 1] ? [argv[i + 1]!] : []);
if (!DB_PATH || !XLSX_PATH) { console.error('usage: fill-from-xlsx.mts --db <path> --xlsx <file> [--session YYYY-MM-DD/Night ...] [--apply]'); process.exit(2); }
for (const p of [DB_PATH, XLSX_PATH]) if (!existsSync(p)) { console.error(`無い: ${p}`); process.exit(2); }
if (APPLY && SESSIONS.length === 0) { console.error('--apply には --session が必要(何を足すかを明示する)'); process.exit(2); }
const fail = (msg: string): never => { console.error(`中止: ${msg}`); process.exit(1); };

// ── xlsx → 足 ──
const wb = XLSX.readFile(XLSX_PATH, { cellDates: false });
const ws = wb.Sheets['1min'];
if (!ws) fail(`シート '1min' が無い: ${XLSX_PATH}`);
const rows = sheetAoaToRows(XLSX.utils.sheet_to_json(ws!, { header: 1, blankrows: false }) as unknown[][]);
const mapped = rowsToBars(rows);
for (const w of mapped.warnings) console.log('  変換の警告: ' + w);
const xbars = mapped.bars.map(b => ({ ...b, t: Math.floor(b.t / 60_000) * 60_000 })).sort((a, b) => a.t - b.t);
const dupT = xbars.filter((b, i) => i > 0 && xbars[i - 1]!.t === b.t).length;
if (dupT) fail(`xlsx の変換結果に同じ時刻の足が ${dupT} 本(日付マッピング異常)`);
const future = xbars.filter(b => b.t > Date.now() + 2 * 60_000).length;
if (future) fail(`xlsx の変換結果に未来の足 ${future} 本`);
const xIn = xbars.map(b => ({ b, s: classifySession(b.t) }));
const offSession = xIn.filter(x => !x.s).length;
console.log(`xlsx ${XLSX_PATH}: 行 ${rows.length} → 足 ${xbars.length}(${jstMinute(xbars[0]!.t)}..${jstMinute(xbars[xbars.length - 1]!.t)} JST)、場外 ${offSession} 本は対象外`);

// ── DB ──
const db = new DatabaseSync(DB_PATH, dbOpenOptions(!APPLY));
db.exec('PRAGMA busy_timeout = 30000');
const head = db.prepare('SELECT COUNT(*) n, MIN(t) a, MAX(t) b FROM bars_1m WHERE symbol=?').get(SYMBOL) as any;
console.log(`DB ${DB_PATH}: ${head.n} bars ${jstMinute(head.a)}..${jstMinute(head.b)} JST ${APPLY ? '[apply]' : '[dry]'}`);

// ── 全数突き合わせ(xlsx の在場の足 ⇔ DB の同じ範囲の足) ──
const lo = xbars[0]!.t, hi = xbars[xbars.length - 1]!.t;
const dbRows = db.prepare('SELECT t, session_date sd, session s, o, h, l, c, volume v FROM bars_1m WHERE symbol=? AND t BETWEEN ? AND ?').all(SYMBOL, lo, hi) as any[];
const dbByT = new Map<number, any>(dbRows.map(r => [r.t, r]));
const xByT = new Set(xIn.filter(x => x.s).map(x => x.b.t));
let same = 0, ohlcMis = 0, volMis = 0, labelMis = 0;
const missing = new Map<string, typeof xbars>();   // DB に無い足(セッション別)
const ex: string[] = [];
for (const { b, s } of xIn) {
  if (!s) continue;
  const r = dbByT.get(b.t);
  if (!r) { const k = `${s.sessionDate}/${s.session}`; (missing.get(k) ?? missing.set(k, []).get(k)!).push(b); continue; }
  const o = r.o !== b.o || r.h !== b.h || r.l !== b.l || r.c !== b.c;
  const v = (r.v ?? null) !== (b.v ?? null);
  const lab = r.sd !== s.sessionDate || r.s !== s.session;
  if (o) ohlcMis++; if (v) volMis++; if (lab) labelMis++;
  if (!o && !v && !lab) same++;
  else if (ex.length < 10) ex.push(`${jstMinute(b.t)} db=${r.o}/${r.h}/${r.l}/${r.c}/${r.v} ${r.sd}${r.s} xlsx=${b.o}/${b.h}/${b.l}/${b.c}/${b.v} ${s.sessionDate}${s.session}`);
}
const dbOnly = dbRows.filter(r => !xByT.has(r.t));
const dbOnlyBy = new Map<string, number>();
for (const r of dbOnly) dbOnlyBy.set(`${r.sd}/${r.s}`, (dbOnlyBy.get(`${r.sd}/${r.s}`) ?? 0) + 1);
console.log(`突き合わせ(xlsx 範囲 ${jstMinute(lo)}..${jstMinute(hi)}): 一致 ${same} / OHLC不一致 ${ohlcMis} / 出来高不一致 ${volMis} / 日付・セッション不一致 ${labelMis}`);
for (const e of ex) console.log('  例: ' + e);
console.log(`  DBに無い足: ${[...missing.values()].reduce((a, x) => a + x.length, 0)} 本 / ${missing.size} セッション`);
for (const [k, xs] of missing) console.log(`    ${k}: ${xs.length} 本 ${jstMinute(xs[0]!.t)}..${jstMinute(xs[xs.length - 1]!.t)}`);
console.log(`  xlsxに無い足(DBだけ): ${dbOnly.length} 本 / ${dbOnlyBy.size} セッション ${[...dbOnlyBy].slice(0, 20).map(([k, n]) => `${k}:${n}`).join(' ')}`);

if (!APPLY) { console.log('[dry] 書き込みなし。補うには --session <日付/Night> --apply'); db.close(); process.exit(0); }

// ── 補充 ──
const exists = db.prepare('SELECT COUNT(*) n FROM bars_1m WHERE symbol=? AND session_date=? AND session=?');
const plan: { key: string; bars: typeof xbars }[] = [];
for (const key of SESSIONS) {
  const [sd, s] = key.split('/');
  if (!sd || !s) fail(`--session の形式は YYYY-MM-DD/Night: ${key}`);
  const n = (exists.get(SYMBOL, sd!, s!) as any).n;
  const xlsxN = xIn.filter(x => x.s && `${x.s.sessionDate}/${x.s.session}` === key).length;
  // 冪等: 既に xlsx と同じ本数が入っていて欠けが無ければ何もしない(2回目は 0 件)
  if (n > 0 && n === xlsxN && !missing.has(key)) { console.log(`${key}: 既に ${n} 本ある(xlsx と同数)→ 0 件`); continue; }
  if (n !== 0) fail(`${key}: DB に既に ${n} 本ある(xlsx は ${xlsxN} 本・部分的に混ぜない)`);
  const xs = missing.get(key);
  if (!xs?.length) fail(`${key}: xlsx に該当の足が無い`);
  plan.push({ key, bars: xs! });
}
if (plan.length === 0) { console.log('挿入 0 件'); db.close(); process.exit(0); }
const nwdBefore = nightsWithoutDay(loadSessionSpans(db), { excludeFirst: true }).length;
db.exec('BEGIN IMMEDIATE');
try {
  ensureBacktestDbSchema(db);
  let ins = 0;
  for (const p of plan) for (const b of p.bars) {
    const s = classifySession(b.t)!;
    upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
    ins++;
  }
  const after = loadSessionSpans(db);
  const ov = overlappingSessions(after);
  const nwd = nightsWithoutDay(after, { excludeFirst: true }).length;
  if (ov.length) throw new Error(`挿入後にセッション重なり ${ov.length} 件`);
  if (nwd > nwdBefore) throw new Error(`挿入後に「平日で日中なし夜間あり」が ${nwdBefore}→${nwd} に増えた`);
  const prev = getDatasetInfo(db).filled_sessions;
  const list = new Set<string>(prev ? JSON.parse(prev) as string[] : []);
  for (const p of plan) list.add(p.key);
  setDatasetInfo(db, {
    filled_sessions: JSON.stringify([...list].sort()),
    filled_sessions_at_jst: jstSecond(Date.now()),
    filled_sessions_source: XLSX_PATH,
  });
  const st = refreshDatasetStats(db);
  db.exec('COMMIT');
  console.log(`COMMIT: ${plan.map(p => `${p.key}(${p.bars.length})`).join(', ')} 計 ${ins} 本を挿入。DB ${st.bars} bars / ${st.sessions} sessions`);
} catch (e) {
  db.exec('ROLLBACK');
  fail(`ROLLBACK(${(e as Error).message})`);
}
db.close();
