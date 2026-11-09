import type { DatabaseSync } from 'node:sqlite';
import { upsertBar, upsertDailyClose } from './db/store.js';
import { classifySession } from '../core/session.js';
import type { BaseBar } from './basedataDate.js';

// xlsx の日付マッピング(rowToBar / 日付規約)は server/basedataDate.ts が唯一の正準実装(SSOT)。
// publish スクリプトと共有する。ここでは再エクスポートのみ(取り込みは publish 済み NDJSON の t を直接使う)。
export { rowToBar } from './basedataDate.js';
export type { BaseBar } from './basedataDate.js';

const SYMBOL = 'NIY=F';

export function parseNdjsonLine(line: string): BaseBar | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const o = JSON.parse(s);
    if ([o?.t, o?.o, o?.h, o?.l, o?.c].some(x => typeof x !== 'number')) return null;
    return { t: o.t, o: o.o, h: o.h, l: o.l, c: o.c, v: typeof o.v === 'number' ? o.v : null };
  } catch { return null; }
}

export interface ImportResult { inserted: number; updated: number; skipped: number; from: number; to: number; total: number; }

// ─── 書き込みの分割(1回のロック保持を短くする) ─────────────────────────────────────
//
// ■ なぜ分けるか(2026-10-27/28 の実事故)
//   以前は全バー(運用PCで約25.7万本)を **1つの BEGIN..COMMIT** で書いていた。SQLite の書き込みロックは
//   DB 全体に1本しか無いので、その間 collector(別プロセス)の書き込みは busy_timeout=5000ms
//   (server/db/store.ts の openDb)だけ待って `database is locked` で失敗する。実際に collector が
//   08:05 の自動公開の取り込み中に writeHeartbeat で落ち、13日間止まった。
//   実測(運用DBのコピー・base 265,200本): 1トランザクションの保持 ≈ 5.6〜6.0秒(> 5秒)。
//   別プロセスの setMeta は最長 5,457ms 待たされた(=タイムアウトぎりぎり)。
//
// ■ ★分けるだけでは足りない: 次の BEGIN の前に **イベントループへ譲る**
//   同期ループで COMMIT→BEGIN を続けると、ロックが空く隙間はほぼ無い。待っている側の busy handler は
//   眠ってから再試行する(SQLite 既定の再試行間隔は最大 100ms。★これは SQLite の実装上の値で、ここでは未測定)
//   ので、その隙間にはまず当たらない(=分けても結局 5秒待たされうる)。
//   → チャンクの間に IMPORT_YIELD_MS だけ setTimeout で譲る。再試行間隔より長く空けるので、
//     待っている書き手はどこかの隙間でロックを取れる。
//   ★テストは「取り込みの途中で別の接続が書ける」を件数で確かめている(server/basedata.test.ts)。
//
// ■ 大きさの決め方(実測・運用DBのコピー・base 265,200本・この開発機)
//   1行あたり ≈ 22µs(6,027ms / 265,200)。チャンク別の1回の最長保持: 1000本=99ms / 2000本=99ms /
//   5000本=170〜225ms / 10000本=321ms / 20000本=488ms。全体の所要は 5000本で約13秒(譲り時間込み)。
//   5000本を採った: 最長保持を busy_timeout(5秒)の 1/20 以下・collector の poll 周期(2秒)の 1/8 程度に抑えつつ、
//   全体の所要(1000本だと 42秒)を伸ばしすぎない。別プロセスの setMeta(100ms ごと)の最長待ちは
//   変更前 5,457ms → 変更後 150ms(同じ DB・同じ本数での実測)。★運用PCのディスク速度では未測定。
//
// ■ ★挙動の差(意図して受け入れたもの)
//   途中のチャンクで例外が出たとき、**それより前のチャンクは確定したまま** になる(以前は全件 ROLLBACK)。
//   書き込みは upsert(冪等・非破壊)なので、取り込みをやり直せば同じ結果に収束する。
//   反映件数・未来バーのドロップ・daily_closes の更新は従来と同じ。

/** 1トランザクションで書くバーの本数(入力の本数で数える=スキップ/ドロップ分も含む)。 */
export const IMPORT_CHUNK_ROWS = 5000;
/** チャンクの間にイベントループへ譲る時間[ms]。待ち手の busy handler の最大睡眠(100ms)より長くする。 */
export const IMPORT_YIELD_MS = 120;

export interface ImportBarsOptions {
  /** 1トランザクションの本数(テスト/実測用。既定 IMPORT_CHUNK_ROWS)。 */
  chunkRows?: number;
  /** チャンク間の譲り時間[ms](既定 IMPORT_YIELD_MS)。 */
  yieldMs?: number;
  /** 各トランザクションの保持時間[ms](BEGIN〜COMMIT)と本数を知らせる(実測用)。 */
  onTxn?: (holdMs: number, rows: number) => void;
}

/** bars を session 付与して upsert。session=null(休場/場外)はスキップ。削除はしない。
 *  ★IMPORT_CHUNK_ROWS 本ごとに COMMIT し、間で IMPORT_YIELD_MS 譲る(上の「書き込みの分割」参照)。
 *  行ごとの autocommit にはしない(WAL の fsync で激遅になる)。 */
export async function importBars(db: DatabaseSync, bars: BaseBar[], opts: ImportBarsOptions = {}): Promise<ImportResult> {
  const chunkRows = Math.max(1, Math.floor(opts.chunkRows ?? IMPORT_CHUNK_ROWS));
  const yieldMs = Math.max(0, opts.yieldMs ?? IMPORT_YIELD_MS);
  let applied = 0, skipped = 0, futureDropped = 0, latestFuture = 0, from = Infinity, to = -Infinity;
  const futureCutoff = Date.now() + 2 * 60_000;
  // 取引日15:45終値の永続化用: 各 Day セッションの「最後に存在する bar」= その日の終値(15:45 が
  // 無ければ Day セッション最終 bar が代替終値)。session_date ごとに最大 t の bar を追う。
  const dayLast = new Map<string, { t: number; close: number }>();
  for (let start = 0; start < bars.length; start += chunkRows) {
    if (start > 0) await new Promise(r => setTimeout(r, yieldMs));
    const end = Math.min(bars.length, start + chunkRows);
    const t0 = performance.now();
    db.exec('BEGIN');
    try {
      for (let i = start; i < end; i++) {
        const b = bars[i]!;
        // 【未来=バグ方針 / 取り込み方法の基準実装】未来日時のバーは日付マッピングのバグなので DB に
        // 入れない。黙って捨てると原因が隠れるためドロップ件数をためて下でエラーログに残す(正しく
        // マッピングできていれば未来バーは存在しないはず)。publish 側(basedata-publish.mts)はこの方針に
        // 合わせて publish 自体を中止する。
        if (b.t > futureCutoff) { futureDropped++; if (b.t > latestFuture) latestFuture = b.t; continue; }
        const s = classifySession(b.t);
        if (!s) { skipped++; continue; }
        upsertBar(db, SYMBOL, b.t, b.o, b.h, b.l, b.c, b.v, s.sessionDate, s.session);
        if (s.session === 'Day') {
          const cur = dayLast.get(s.sessionDate);
          if (!cur || b.t > cur.t) dayLast.set(s.sessionDate, { t: b.t, close: b.c });
        }
        applied++; if (b.t < from) from = b.t; if (b.t > to) to = b.t;
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    opts.onTxn?.(performance.now() - t0, end - start);
  }
  // 取り込んだ範囲の各取引日終値を daily_closes に upsert(歴史分を埋める)。件数は日数ぶん(≪バー数)。
  //   ★これも1回のロック保持になるので測る(日数ぶん=数百行・数ms)。
  if (dayLast.size > 0) {
    if (bars.length > 0) await new Promise(r => setTimeout(r, yieldMs));
    const t0 = performance.now();
    db.exec('BEGIN');
    try {
      for (const [sessionDate, v] of dayLast) upsertDailyClose(db, SYMBOL, sessionDate, v.close, v.t);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    opts.onTxn?.(performance.now() - t0, dayLast.size);
  }
  if (futureDropped > 0) {
    console.error(`[basedata] ERROR: dropped ${futureDropped} future-dated bars on import `
      + `(latest ${new Date(latestFuture).toISOString()}, now ${new Date().toISOString()}). `
      + `日付バグ or ソースデータ異常の可能性。server/basedataDate.ts の日付マッピングを確認すること。`);
  }
  return { inserted: applied, updated: 0, skipped, from: from === Infinity ? 0 : from, to: to === -Infinity ? 0 : to, total: bars.length };
}
