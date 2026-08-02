// 影(決済パラメータを振った模擬)の記録先。**専用 DB ファイル**。
//
// ■ なぜ共有 DB(jp225.db)に入れないか
//   trade2 の priceSnapshotWorker が 30分ごとに **DB 全体を `VACUUM INTO`** して prices_<host>.db を作る。
//   実測 102MB で約1.3秒の同期ブロック。ここを太らせるほど実弾トレードのフィード/発注/約定検知を
//   止めるリスクが増える。→ ティック保管(db/tickArchive.ts)と同じ判断で **別ファイル** に置く。
//   (trade2 は %APPDATA%/jp225-monitor を列挙せず jp225.db と server.log しか見ないので、
//    別ファイルを置くだけで自動的に VACUUM INTO の対象外になる。相手側の変更は不要。)
//
// ■ 書き込みは必ず「まとめて・取引経路の外で」
//   SQLite の書き込みは WAL チェックポイントやディスクの詰まりでブロックしうる。例外の隔離だけでは足りない。
//   → 模擬(ShadowSim)は行をメモリに積むだけで、この store には触らない。フラッシュは別の呼び出し元が行う。
//
// ■ 列は最初から全部持たせる(後から足すと期の境界が曖昧になる)
//   epoch / param_class / censored / source / concurrent は、後続作業ではなく **今** 作る。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ShadowRow } from '../signalTrade/shadow/sim.js';
import { isAnalysisEnabled } from '../analysisGate.js';
import type { ShadowExitLadder } from '../signalTrade/exit/index.js';

/** 影の記録 DB のパス(%APPDATA%/jp225-monitor/shadow_exits.db)。
 *  JP225_SHADOW_DB で上書きできる(隔離テスト/オフライン再生の検証用)。 */
export function resolveShadowDbPath(): string {
  const env = process.env.JP225_SHADOW_DB;
  if (env && env.trim()) return env.trim();
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  const dir = join(base, 'jp225-monitor');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'shadow_exits.db');
}

/** 影の記録スキーマ。
 *  ★UNIQUE(epoch, source, proposal_id, spec): 同じ提案 × 同じ決済仕様の影は1行だけ。
 *    再生を2回流しても二重計上しない(INSERT OR IGNORE と対で効く)。 */
export function initShadowSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shadow_exits (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch        TEXT    NOT NULL,
      source       TEXT    NOT NULL,
      proposal_id  TEXT    NOT NULL,
      spec         TEXT    NOT NULL,
      param_class  TEXT    NOT NULL,
      dir          TEXT    NOT NULL,
      armed_t      INTEGER NOT NULL,
      armed_price  REAL,
      entry_t      INTEGER,
      entry_price  REAL,
      entry_leg    TEXT,
      initial_stop REAL,
      exit_t       INTEGER,
      exit_price   REAL,
      exit_reason  TEXT,
      pnl          REAL,
      outcome      TEXT    NOT NULL,
      censored     INTEGER NOT NULL,
      censor_reason TEXT,
      unrealized   REAL,
      mfe          REAL,
      mae          REAL,
      peak_profit  REAL,
      hold_ms      INTEGER,
      elapsed_ms   INTEGER NOT NULL,
      horizon_ms   INTEGER NOT NULL,
      concurrent   INTEGER NOT NULL,
      ticks        INTEGER NOT NULL,
      created_at   INTEGER NOT NULL,
      UNIQUE (epoch, source, proposal_id, spec)
    );
    CREATE INDEX IF NOT EXISTS idx_shadow_proposal ON shadow_exits (proposal_id);
    CREATE INDEX IF NOT EXISTS idx_shadow_spec ON shadow_exits (epoch, spec);
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
}

/** 影の記録 DB を開く。
 *  ★公開版(lite)では **入口を閉じる**。影の決済模擬は決済パラメータの分析専用で、公開版には要らない。
 *    現時点でこの関数は取引経路から配線されていないので lite が今日壊れることは無い。将来 **うっかり
 *    配線されたとき**に、公開版で黙って専用 DB が増え続けるより、開発中に大きな音で落ちる方が良い
 *    (このプロジェクトの「無音の失敗は欠陥」に従う)。full では従来と完全に同一。 */
export function openShadowDb(path: string): DatabaseSync {
  if (!isAnalysisEnabled()) {
    throw new Error('影の決済模擬は分析専用です(公開版では開けません) — server/analysisGate.ts');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initShadowSchema(db);
  return db;
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO shadow_exits (
    epoch, source, proposal_id, spec, param_class, dir,
    armed_t, armed_price, entry_t, entry_price, entry_leg, initial_stop,
    exit_t, exit_price, exit_reason, pnl,
    outcome, censored, censor_reason, unrealized, mfe, mae, peak_profit,
    hold_ms, elapsed_ms, horizon_ms, concurrent, ticks, created_at
  ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?)
`;

/** 数値は非有限なら NULL(NaN/Infinity を DB に置かない)。 */
function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** 影の行をまとめて追記する(1トランザクション)。挿入できた件数を返す。
 *  ★重複(同 epoch/source/proposal/spec)は静かに無視ではなく、戻り値の差で分かるようにする。
 *  ★フラッシュ経路を作る人へ: **行を書く前に recordShadowLadderMeta(db, ladder) を1回呼ぶこと**。
 *    行には spec(不透明名)と epoch しか載らないので、対応表が無いと1年後に「候補はどれか」が読めない。 */
export function insertShadowRows(db: DatabaseSync, rows: readonly ShadowRow[]): { inserted: number; skipped: number } {
  if (rows.length === 0) return { inserted: 0, skipped: 0 };
  const stmt = db.prepare(INSERT_SQL);
  const before = countShadowRows(db);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.epoch, r.source, r.proposalId, r.spec, r.paramClass, r.dir,
        r.armedT, num(r.armedPrice), num(r.entryT), num(r.entryPrice), r.entryLeg, num(r.initialStop),
        num(r.exitT), num(r.exitPrice), r.exitReason, num(r.pnl),
        r.outcome, r.censored ? 1 : 0, r.censorReason, num(r.unrealized), num(r.mfe), num(r.mae), num(r.peakProfit),
        num(r.holdMs), r.elapsedMs, r.horizonMs, r.concurrent, r.ticks, r.createdAt,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const inserted = countShadowRows(db) - before;
  return { inserted, skipped: rows.length - inserted };
}

// ─── 版(epoch)と「変種 ↔ spec」の対応をメタに残す ──────────────────────────────
//
// ■ なぜ記録するか
//   影の行には spec(不透明名)と epoch しか載らない。1年後に「候補の決済仕様を教えて作った提案」と
//   「候補の決済仕様で測った影」を突き合わせるには、**その epoch では候補がどの spec だったか** が要る。
//   人間が覚える運用(「候補は sh** だ」)は、格子や候補が動いた瞬間に黙って嘘になる。
//   → 影を書き出すのと同じ場所・同じ版で、引き当て結果そのものを残す。
//
// ■ 何を書かないか
//   載るのは **epoch と不透明な spec 名だけ**。決済の実数値・その指紋は一切書かない。

/** meta の キー(epoch ごとに1行)。 */
function variantSpecsKey(epoch: string): string {
  return `variant_specs:${epoch}`;
}

export interface ShadowLadderMetaResult {
  /** 今回この呼び出しで新しく書いたか(既に同じ内容なら false=冪等)。 */
  written: boolean;
  /** 書かなかった理由(対応表を持たないラダー=公開フォールバックなど)。 */
  skipped?: 'no-variant-specs';
}

/** 影ラダーの「変種 ↔ spec」対応を meta に記録する(epoch ごとに1行・冪等)。
 *  ★同じ epoch で **違う対応** を書こうとしたら throw する: それは「格子/変種を変えたのに epoch を
 *    上げなかった」ということで、同じ epoch の下に別物の記録が混ざる=集計が静かに壊れる。 */
export function recordShadowLadderMeta(db: DatabaseSync, ladder: ShadowExitLadder): ShadowLadderMetaResult {
  const map = ladder.variantSpecs;
  if (!map || Object.keys(map).length === 0) return { written: false, skipped: 'no-variant-specs' };
  const key = variantSpecsKey(ladder.epoch);
  // キーの順序で値が揺れないように整列してから直列化する(冪等性のため)。
  const value = JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
  const found = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  if (found) {
    if (found.value === value) return { written: false };
    throw new Error(
      `影ラダーの版 "${ladder.epoch}" に、既存と異なる「変種↔spec」対応を記録しようとしました。` +
      '格子か変種を変えたのに epoch を上げていない可能性があります(同じ版に別物が混ざると集計が壊れます)。',
    );
  }
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  return { written: true };
}

/** ある epoch の「変種 ↔ spec」対応を読み出す(分析の入口)。未記録は null。 */
export function readShadowLadderMeta(db: DatabaseSync, epoch: string): Record<string, string> | null {
  const found = db.prepare('SELECT value FROM meta WHERE key = ?').get(variantSpecsKey(epoch)) as { value: string } | undefined;
  if (!found) return null;
  try {
    const parsed = JSON.parse(found.value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : null;
  } catch {
    return null;
  }
}

export function countShadowRows(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM shadow_exits').get() as { n: number }).n;
}

/** 集計の入口(分析用)。**打ち切りは決済と混ぜない** ので outcome 別に数える。 */
export function shadowOutcomeCounts(db: DatabaseSync, epoch?: string): Array<{ spec: string; outcome: string; n: number }> {
  const sql = epoch
    ? 'SELECT spec, outcome, COUNT(*) AS n FROM shadow_exits WHERE epoch = ? GROUP BY spec, outcome ORDER BY spec, outcome'
    : 'SELECT spec, outcome, COUNT(*) AS n FROM shadow_exits GROUP BY spec, outcome ORDER BY spec, outcome';
  const stmt = db.prepare(sql);
  const rows = (epoch ? stmt.all(epoch) : stmt.all()) as unknown as Array<{ spec: string; outcome: string; n: number }>;
  return rows;
}
