// バックテスト用DB の「取引の無い祝日の前夜の夜間が、1営業日あと(祝日の夜)に置かれている」不備を直す。
// 判定と移動先の決定は server/backtestDb/holidayNights.ts(純関数・テスト付き)。ここは DB の読み書きだけ。
//
// ★--db は必須(既定パスを持たない = 本番を誤って触らない)。既定は dry(計画と件数を出すだけ)。
//   --apply で 1 トランザクションで実行。安全条件が1つでも崩れたら何も書かずに終了コード 1。
//   冪等: 直した後に再実行すると「移動 0 件」。
// 動かすのは t と session_date だけ(o/h/l/c/volume/src は不変)。t は日数 × 86400000 ms ずらす。
//
// Run: npx tsx scripts/backtest-db/repair-holiday-nights.mts --db <path> [--apply]
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { classifySession } from '../../core/session.js';
import { findMisplacedNights, nightsWithoutDay, overlappingSessions, type NightMove } from '../../server/backtestDb/holidayNights.js';
import {
  BACKTEST_SYMBOL as SYMBOL, dbOpenOptions, ensureBacktestDbSchema, jstMinute, jstSecond, loadSessionSpans, refreshDatasetStats, setDatasetInfo,
} from '../../server/backtestDb/schema.js';

// ★先頭の夜間(session_date 2018-01-03 Night)の特例。直前の Day がデータに無いので規則では決まらない。
//   この夜間は xlsx 先頭ラベル 2018-01-04(大発会)の夜間で、旧 rowToBar が「土日だけ飛ばす前営業日」で
//   01-03 に置いたもの。01-03 は年始休業(1/1〜1/3 は取引なし)なので 01-03 の夜間は存在しえない。
//   ラベル 01-04 の「1つ前の取引日」は 2017-12-29(金・大納会)。根拠と実測は報告/説明書に記載:
//   (1) 同じ規約の実例 = 2026 版 xlsx でラベル 2026-01-05 の夜間は 2025-12-30(大納会)の夜(basedataDate.ts 冒頭)。
//   (2) この DB の他の年明けの夜間(2019-01-03→2018-12-28 等)も全て「大納会の夜」に戻る。
//   (3) この夜間の終値 22780 → 翌 01-04 日中始値 23100 の窓は +320 で、全 2,219 組の「夜間終値→次の日中始値」
//       の |窓| 中央値 40・90%点 180 より大きい(大きい方から 90 番目)。他の年の「大納会の夜→大発会」の窓も
//       ±85〜480 と大きい。= この夜間と 01-04 の間に休場が挟まっている形(1/3 の夕方なら窓は小さいはず)。
//       ※補強材料であって証明ではない。外部の値(2017-12-29 の実際の夜間の値)とは未照合。
const HEAD_TARGETS: Record<string, string> = { '2018-01-03': '2017-12-29' };

const argv = process.argv.slice(2);
const dbIdx = argv.indexOf('--db');
const DB_PATH = dbIdx >= 0 ? argv[dbIdx + 1] : undefined;
const APPLY = argv.includes('--apply');
if (!DB_PATH) { console.error('usage: repair-holiday-nights.mts --db <path> [--apply]   (--db は必須)'); process.exit(2); }
if (!existsSync(DB_PATH)) { console.error(`DB が無い: ${DB_PATH}`); process.exit(2); }

const fail = (msg: string): never => { console.error(`中止: ${msg}`); process.exit(1); };

const db = new DatabaseSync(DB_PATH, dbOpenOptions(!APPLY));
db.exec('PRAGMA busy_timeout = 30000');
const head = db.prepare('SELECT COUNT(*) n, MIN(t) a, MAX(t) b, COUNT(DISTINCT session_date||session) s FROM bars_1m WHERE symbol=?').get(SYMBOL) as any;
console.log(`DB ${DB_PATH}: ${head.n} bars / ${head.s} sessions / ${jstMinute(head.a)}..${jstMinute(head.b)} JST ${APPLY ? '[apply]' : '[dry]'}`);

const spans = loadSessionSpans(db);
const { moves, problems } = findMisplacedNights(spans, HEAD_TARGETS);
if (problems.length) { for (const p of problems) console.error('  問題: ' + p); fail(`安全条件を満たさない夜間 ${problems.length} 件`); }

// 計画の表示(直前セッション終了 → 夜間開始 の間隔: いま → 直した後)
const prevEndOf = (startT: number, excludeFrom?: string) => {
  let best: number | undefined;
  for (const s of spans) if (s.endT < startT && !(excludeFrom && s.sessionDate === excludeFrom && s.session === 'Night')) best = Math.max(best ?? -Infinity, s.endT);
  return best;
};
const byYear = new Map<string, number>();
for (const m of moves) {
  byYear.set(m.fromDate.slice(0, 4), (byYear.get(m.fromDate.slice(0, 4)) ?? 0) + 1);
  const pe = prevEndOf(m.startT);
  const peNew = prevEndOf(m.startT - m.shiftMs, m.fromDate);
  const h = (x: number | undefined, s: number) => x === undefined ? '  -  ' : ((s - x) / 3600e3).toFixed(1) + 'h';
  console.log(`  ${m.fromDate} Night → ${m.toDate} Night (-${m.shiftDays}d, ${m.bars} bars, ${m.basis}, 次Day ${m.nextDayDate})`
    + ` 間隔 ${h(pe, m.startT)} → ${h(peNew, m.startT - m.shiftMs)}`);
}
console.log(`移動する夜間: ${moves.length} 件 / 足 ${moves.reduce((a, m) => a + m.bars, 0)} 本  年別: ${[...byYear].map(([y, n]) => `${y}:${n}`).join(' ')}`);

// ★全件の事前検証: 移動先が空・全ての足が移動後に (toDate, Night) と判定される・本数一致
const qRange = db.prepare('SELECT COUNT(*) n FROM bars_1m WHERE symbol=? AND t BETWEEN ? AND ?');
const qBars = db.prepare("SELECT t FROM bars_1m WHERE symbol=? AND t BETWEEN ? AND ? AND session_date=? AND session='Night' ORDER BY t");
for (const m of moves) {
  const occ = (qRange.get(SYMBOL, m.startT - m.shiftMs, m.endT - m.shiftMs) as any).n;
  if (occ !== 0) fail(`${m.fromDate}→${m.toDate}: 移動先の時間帯に既存の足が ${occ} 本ある`);
  const ts = (qBars.all(SYMBOL, m.startT, m.endT, m.fromDate) as { t: number }[]).map(r => r.t);
  if (ts.length !== m.bars) fail(`${m.fromDate}: 本数が計画と違う ${ts.length} != ${m.bars}`);
  for (const t of ts) {
    const s = classifySession(t - m.shiftMs);
    if (!s || s.sessionDate !== m.toDate || s.session !== 'Night') fail(`${m.fromDate}: 足 ${jstMinute(t)} の移動先 ${jstMinute(t - m.shiftMs)} が ${m.toDate} Night と判定されない(${JSON.stringify(s)})`);
  }
}
console.log('事前検証: 移動先は全て空・移動後の全ての足が移動先の夜間と判定される');

if (!APPLY) { console.log('[dry] 書き込みなし。実行するには --apply'); db.close(); process.exit(0); }

// 主キー(symbol, t)の範囲で絞る(session_date に索引は無いので、それだけで絞ると全表走査になる)
const upd = db.prepare("UPDATE bars_1m SET t = t - ?, session_date = ? WHERE symbol=? AND t BETWEEN ? AND ? AND session_date=? AND session='Night'");
db.exec('BEGIN IMMEDIATE');
try {
  ensureBacktestDbSchema(db);
  for (const m of moves) {
    const r = upd.run(m.shiftMs, m.toDate, SYMBOL, m.startT, m.endT, m.fromDate);
    if (Number(r.changes) !== m.bars) throw new Error(`${m.fromDate}: 更新 ${r.changes} 行 != ${m.bars}`);
  }
  const after = loadSessionSpans(db);
  const left = nightsWithoutDay(after, { excludeFirst: true });
  const again = findMisplacedNights(after, HEAD_TARGETS);
  const ov = overlappingSessions(after);
  if (left.length) throw new Error(`修復後も検出条件に該当: ${left.map(s => s.sessionDate).join(',')}`);
  if (again.moves.length || again.problems.length) throw new Error(`修復後の再判定が 0 件にならない(移動 ${again.moves.length}・問題 ${again.problems.length})`);
  if (ov.length) throw new Error(`修復後にセッション重なり ${ov.length} 件`);
  if (moves.length) {
    setDatasetInfo(db, {
      repaired_holiday_nights: moves.length,
      repaired_holiday_nights_bars: moves.reduce((a, m) => a + m.bars, 0),
      repaired_holiday_nights_at_jst: jstSecond(Date.now()),
      repaired_holiday_nights_detail: JSON.stringify(moves.map((m: NightMove) => [m.fromDate, m.toDate])),
      repaired_holiday_nights_note: '2018-2025 の取引の無い祝日の前夜の夜間が祝日の夜に置かれていたのを、直前の日中の日付の夜へ移した(t と session_date のみ変更・OHLCV不変)。先頭 2018-01-03 夜間は 2017-12-29(大納会)の夜へ。scripts/backtest-db/repair-holiday-nights.mts',
    });
  }
  const st = refreshDatasetStats(db);
  db.exec('COMMIT');
  console.log(`COMMIT: 移動 ${moves.length} 件。DB ${st.bars} bars / ${st.sessions} sessions / ${jstMinute(st.first)}..${jstMinute(st.last)} JST`);
} catch (e) {
  db.exec('ROLLBACK');
  fail(`ROLLBACK(${(e as Error).message})`);
}
db.close();
