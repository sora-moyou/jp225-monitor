// バックテスト用DB(Desktop/backtest-multiyear.db)に、公開済み基礎データの新しい1分足を追記する。
// Windows タスク「JP225 backtest OHLC append」が平日 08:30 / 16:00 に実行する。説明書: docs/backtest-db.md
//
// 出所: GitHub release `basedata-latest`(sora-moyou/jp225-monitor)の basedata-1min.ndjson.gz
//       = 225labo の N225minif xlsx を basedata:publish が変換したもの(build-backtest-db.mts と同じ系統)。
//       ライブフィードの足(jp225.db)は系統が違うので混ぜない。
// 規約: DB の最終足より新しい足だけを INSERT(既存行は書き換えない)。場外足は捨てる(importBars と同じ)。
//       重なり区間は値を突き合わせて不一致件数だけ報告する(上書きしない)。
// 記録: 結果(ok / error+理由)を DB の dataset_info 表に書く(失敗時も書けるかぎり書く)。
//       追記後に整合チェック(セッション重なり・平日で日中なし夜間あり・未来足)をして異常は WARN をログへ。
//       最後に docs/backtest-db.md を DB の隣(<DB名>.README.md)へコピーする(常に最新の説明書が隣にある)。
//
// Run: npx tsx scripts/append-backtest-db.mts [--dry]
// 環境変数(検証用の差し替え):
//   APPEND_DB         DB のパス(既定 ~/Desktop/backtest-multiyear.db)
//   APPEND_SRC_DIR    取得元(meta.json と ndjson.gz を置いたフォルダ。既定は GitHub release)
//   APPEND_LOG_DIR    ログの置き場(既定 ~/Desktop/backtest-results)
//   APPEND_README_OUT 説明書のコピー先(既定 = DB と同じフォルダの <DB名>.README.md)
import { gunzipSync } from 'node:zlib';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { parseNdjsonLine } from '../server/basedata.js';
import { openDb, upsertBar } from '../server/db/store.js';
import { classifySession } from '../core/session.js';
import { nightsWithoutDay, overlappingSessions } from '../server/backtestDb/holidayNights.js';
import { ensureBacktestDbSchema, jstSecond, loadSessionSpans, refreshDatasetStats, setDatasetInfo } from '../server/backtestDb/schema.js';

const SYMBOL = 'NIY=F';
const DB_PATH = process.env.APPEND_DB || join(homedir(), 'Desktop', 'backtest-multiyear.db');
const BASE = 'https://github.com/sora-moyou/jp225-monitor/releases/download/basedata-latest/';
const LOG_DIR = process.env.APPEND_LOG_DIR || join(homedir(), 'Desktop', 'backtest-results');
const README_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'backtest-db.md');
const README_OUT = process.env.APPEND_README_OUT
  || join(dirname(DB_PATH), basename(DB_PATH, extname(DB_PATH)) + '.README.md');
const DRY = process.argv.includes('--dry');
const JST = 9 * 3600_000;
const jst = (t: number) => new Date(t + JST).toISOString().replace('T', ' ').slice(0, 16);

const lines: string[] = [];
function log(s: string) { console.log(s); lines.push(s); }
function flushLog() {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'append-ohlc.log'),
      `--- ${jst(Date.now())} JST${DRY ? ' (dry)' : ''}\n${lines.join('\n')}\n`);
  } catch { /* ログ失敗で本処理を壊さない */ }
}

// 取得の一時失敗(2026-11-20 08:30 の "fetch failed" 等)に備えて、間隔を空けて 3 回まで試す。
const RETRY_WAIT_MS = [0, 20_000, 60_000];
async function get(name: string): Promise<Buffer> {
  if (process.env.APPEND_SRC_DIR) return readFileSync(join(process.env.APPEND_SRC_DIR, name));
  let last: unknown;
  for (let i = 0; i < RETRY_WAIT_MS.length; i++) {
    if (RETRY_WAIT_MS[i]) await new Promise(r => setTimeout(r, RETRY_WAIT_MS[i]));
    try {
      const r = await fetch(BASE + name, { redirect: 'follow' });
      if (!r.ok) throw new Error(`download ${name}: HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      log(`  取得失敗(${i + 1}/${RETRY_WAIT_MS.length}) ${name}: ${(e as Error)?.message ?? e}`);
    }
  }
  throw last;
}

let db: DatabaseSync | undefined;
let warnCount = 0;
function warn(s: string) { warnCount++; log(`WARN: ${s}`); }
/** 失敗時の記録用に、どこまで進んだかを持つ。 */
const progress: { releaseGeneratedAt?: string; committedInserted?: number } = {};
/** 引けの板寄せの足(06:00 / 15:45)。現行の取引時間では場外で、毎日 release に入っていて捨てるのが正常。 */
const EXPECTED_OFF_SESSION_HHMM = new Set(['06:00', '15:45']);
const hhmm = (t: number) => jst(t).slice(11, 16);

async function main() {
  const meta = JSON.parse((await get('basedata-1min.meta.json')).toString('utf8'));
  progress.releaseGeneratedAt = String(meta.generatedAt);
  log(`release: generatedAt=${meta.generatedAt} bars=${meta.count} ${jst(meta.firstBar)}..${jst(meta.lastBar)} JST`);

  const bars = gunzipSync(await get('basedata-1min.ndjson.gz')).toString('utf8')
    .split('\n').map(parseNdjsonLine).filter((b): b is NonNullable<typeof b> => b !== null)
    .sort((a, b) => a.t - b.t);
  if (bars.length === 0) throw new Error('release に足が0本');
  const future = bars.filter(b => b.t > Date.now() + 2 * 60_000);
  if (future.length) throw new Error(`未来日付の足 ${future.length} 本(例 ${jst(future[0]!.t)})= 日付マッピング異常。中止`);

  // ★黙って捨てる足を無くす(2026-11-23): 場外(classifySession=null)の足のうち、06:00/15:45(引けの板寄せ)
  //   以外は「日付がずれて休場日に置かれた足」の疑いが強い。実例: generatedAt 2026-11-19T23:04Z の release は
  //   2025-12-30(大納会)の夜間 780 本を 2026-01-02 17:00〜01-03 05:59(休場日)に置いており、追記でも補充でも
  //   黙って捨てられていた。件数と日付(JST 暦日)ごとの内訳を WARN にする(release 全体が対象)。
  const oddOff = new Map<string, number>();
  for (const b of bars) if (!classifySession(b.t) && !EXPECTED_OFF_SESSION_HHMM.has(hhmm(b.t))) {
    const d = jst(b.t).slice(0, 10); oddOff.set(d, (oddOff.get(d) ?? 0) + 1);
  }
  if (oddOff.size) {
    const n = [...oddOff.values()].reduce((a, x) => a + x, 0);
    warn(`release の場外の足のうち 06:00/15:45 以外が ${n} 本(捨てた・日付ずれの疑い): ${[...oddOff].map(([d, k]) => `${d}:${k}`).join(' ')}`);
  }

  if (!existsSync(DB_PATH)) throw new Error(`DB が無い: ${DB_PATH}`);   // openDb は無ければ新規作成してしまう
  db = openDb(DB_PATH);
  db.exec('PRAGMA busy_timeout = 30000');
  if (!DRY) ensureBacktestDbSchema(db);
  const before = db.prepare('SELECT COUNT(*) n, MIN(t) a, MAX(t) b FROM bars_1m WHERE symbol=?').get(SYMBOL) as any;
  log(`DB before: ${before.n} bars ${jst(before.a)}..${jst(before.b)} JST`);
  const spansBefore = loadSessionSpans(db);
  const nwdBefore = nightsWithoutDay(spansBefore, { excludeFirst: true }).length;

  // 重なり区間の突き合わせ(上書きしない)
  //   あわせて「release にあって DB に無い場内の足」(DB の期間内の欠け)を数える。
  const q = db.prepare('SELECT o,h,l,c,volume FROM bars_1m WHERE symbol=? AND t=?');
  let overlap = 0, mismatch = 0, volMismatch = 0;
  const missingIn = new Map<string, number>();
  for (const b of bars) {
    if (b.t > before.b) break;
    const r = q.get(SYMBOL, b.t) as any;
    if (!r) {
      const s = b.t >= before.a ? classifySession(b.t) : null;
      if (s) { const k = `${s.sessionDate}/${s.session}`; missingIn.set(k, (missingIn.get(k) ?? 0) + 1); }
      continue;
    }
    overlap++;
    if (r.o !== b.o || r.h !== b.h || r.l !== b.l || r.c !== b.c) mismatch++;
    if ((r.volume ?? null) !== (b.v ?? null)) volMismatch++;
  }
  log(`overlap check: ${overlap} bars compared, ${mismatch} OHLC mismatches, ${volMismatch} volume mismatches`);
  if (missingIn.size) {
    const n = [...missingIn.values()].reduce((a, x) => a + x, 0);
    warn(`release にあって DB に無い場内の足 ${n} 本(DB の期間内の欠け・追記では埋めない。fill-from-xlsx.mts で補う): ${[...missingIn].map(([k, c]) => `${k}:${c}`).join(' ')}`);
  }

  // ★祝日の日付ずれ対策(2026-11-21 追加): 旧 server/basedataDate.ts:rowToBar は祝日を考慮せず、
  //   取引の無い祝日の前夜(例: 11/20 金の夜間・ラベル 11/24)を祝日の夜(11/23 17:00〜)に置いて公開していた。
  //   上流は v0.9.116 で直った(rowsToBars = データ内の1つ前のラベルで夜間の日付を決める)ので、
  //   いまの release ではこのガードは発火しないはず。それでも残す: release が古い版で作り直された場合や
  //   別の日付ずれが起きた場合に、同じ夜間を二重に入れないための最後の網(発火したらログに残る)。
  //   既に正しい時刻で入っている夜間と値動きが同一のセッションは、新しい足として入れない。
  const fp = (xs: { o: number; h: number; l: number; c: number }[]) => xs.slice(0, 60).map(x => `${x.o},${x.h},${x.l},${x.c}`).join(';');
  const existing = new Set<string>();
  const recent = db.prepare(`SELECT session_date sd, session s, o, h, l, c FROM bars_1m WHERE symbol=? AND t>? ORDER BY t`)
    .all(SYMBOL, before.b - 14 * 86400e3) as any[];
  const byS = new Map<string, any[]>(); for (const r of recent) { const k = r.sd + r.s; (byS.get(k) ?? byS.set(k, []).get(k)!).push(r); }
  for (const xs of byS.values()) if (xs.length >= 60) existing.add(fp(xs));
  const freshAll = bars.filter(b => b.t > before.b);
  const groups = new Map<string, typeof freshAll>();
  for (const b of freshAll) { const s = classifySession(b.t); const k = s ? s.sessionDate + s.session : 'off'; (groups.get(k) ?? groups.set(k, []).get(k)!).push(b); }
  const dupKeys = new Set([...groups.entries()].filter(([k, xs]) => k !== 'off' && xs.length >= 60 && existing.has(fp(xs))).map(([k]) => k));
  if (dupKeys.size) warn(`★既存の夜間と値動きが同一のセッションを除外(日付ずれの疑い): ${[...dupKeys].join(', ')}`);
  const fresh = freshAll.filter(b => { const s = classifySession(b.t); return !(s && dupKeys.has(s.sessionDate + s.session)); });
  let inserted = 0, skipped = 0;
  if (!DRY && fresh.length) {
    db.exec('BEGIN');
    try {
      for (const b of fresh) {
        const s = classifySession(b.t);
        if (!s) { skipped++; continue; }
        upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
        inserted++;
      }
      db.exec('COMMIT');
      progress.committedInserted = inserted;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  const after = db.prepare('SELECT COUNT(*) n, MAX(t) b FROM bars_1m WHERE symbol=?').get(SYMBOL) as any;
  log(`new in release: ${fresh.length}${fresh.length ? ` (${jst(fresh[0]!.t)}..${jst(fresh[fresh.length - 1]!.t)} JST)` : ''}`
    + ` → inserted ${inserted}, skipped(off-session) ${skipped}${DRY ? ' [dry: 書き込みなし]' : ''}`);
  log(`DB after: ${after.n} bars, last ${jst(after.b)} JST`);

  // ── 整合チェック(書き込みの有無にかかわらず毎回) ──
  const spans = loadSessionSpans(db);
  const ov = overlappingSessions(spans);
  if (ov.length) warn(`セッションの時間が重なっている ${ov.length} 組(例 ${ov[0]![0].sessionDate}${ov[0]![0].session} / ${ov[0]![1].sessionDate}${ov[0]![1].session})`);
  const nwd = nightsWithoutDay(spans, { excludeFirst: true });
  if (nwd.length > nwdBefore) warn(`「平日で日中なし夜間あり」が ${nwdBefore}→${nwd.length} に増えた(日付ずれの疑い): ${nwd.slice(-5).map(s => s.sessionDate).join(', ')}`);
  else if (nwd.length) log(`note: 「平日で日中なし夜間あり」 ${nwd.length} 件(実行前から。scripts/backtest-db/repair-holiday-nights.mts で直せる)`);
  const fut = (db.prepare('SELECT COUNT(*) n FROM bars_1m WHERE symbol=? AND t > ?').get(SYMBOL, Date.now() + 2 * 60_000) as any).n;
  if (fut) warn(`未来の足 ${fut} 本`);
  log(`integrity: overlaps ${ov.length}, weekday-night-without-day ${nwd.length} (before ${nwdBefore}), future ${fut}`);

  copyReadme();   // status に README コピー失敗の WARN も数えるため、status を書く前に行う
  if (!DRY) {
    const st = refreshDatasetStats(db);
    setDatasetInfo(db, {
      last_append_at_jst: jstSecond(Date.now()),
      last_append_status: warnCount ? `ok(WARN ${warnCount} 件・ログ参照)` : 'ok',
      last_append_inserted: inserted,
      last_append_release_generated_at: String(meta.generatedAt),
      last_append_log: join(LOG_DIR, 'append-ohlc.log'),
    });
    log(`dataset_info: bar_count=${st.bars} sessions=${st.sessions} last=${jst(st.last)} JST`);
  }
  db.close(); db = undefined;
}

/** 説明書を DB の隣へコピー(失敗しても本処理の結果は変えない)。 */
function copyReadme() {
  if (DRY) { log(`[dry] README コピーせず(${README_OUT})`); return; }
  try { copyFileSync(README_SRC, README_OUT); log(`README: ${README_OUT}`); }
  catch (e) { warn(`README コピー失敗: ${(e as Error)?.message ?? e}`); }
}

/** 失敗を dataset_info に書く(DB を開けない・ロック中などで書けなければ諦める)。 */
function recordFailure(msg: string) {
  if (DRY) return;
  try {
    try { db?.exec('ROLLBACK'); } catch { /* トランザクション外 */ }
    try { db?.close(); } catch { /* 既に閉じている */ }
    if (!existsSync(DB_PATH)) return;
    const d = new DatabaseSync(DB_PATH);
    d.exec('PRAGMA busy_timeout = 30000');
    ensureBacktestDbSchema(d);
    const committed = progress.committedInserted;
    const entries: Record<string, string | number> = {
      last_append_at_jst: jstSecond(Date.now()),
      last_append_status: (`error${committed !== undefined ? `(追記 ${committed} 本は COMMIT 済み)` : ''}`
        + `${warnCount ? `(WARN ${warnCount} 件)` : ''}: ${msg}`).slice(0, 500),
      // COMMIT 前の失敗なら今回は 0 本。COMMIT 後の失敗なら入った本数(0 と書くと「入っていない」と読める)
      last_append_inserted: committed ?? 0,
      last_append_log: join(LOG_DIR, 'append-ohlc.log'),
    };
    if (progress.releaseGeneratedAt) entries.last_append_release_generated_at = progress.releaseGeneratedAt;
    setDatasetInfo(d, entries);
    d.close();
  } catch (e) { log(`(dataset_info への失敗記録もできなかった: ${(e as Error)?.message ?? e})`); }
}

main().then(
  () => { flushLog(); },
  e => { const m = String(e?.message ?? e); log(`ERROR: ${m}`); copyReadme(); recordFailure(m); flushLog(); process.exit(1); },
);
