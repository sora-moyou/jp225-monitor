// 影(決済パラメータを振った模擬)の記録先。**専用 DB ファイル**。
//
// ■ なぜ共有 DB(jp225.db)に入れないか
//   trade2 の priceSnapshotWorker が 30分ごとに **DB 全体を `VACUUM INTO`** して prices_<host>.db を作る。
//   実測 102MB で約1.3秒の同期ブロック。ここを太らせるほど実取引トレードのフィード/発注/約定検知を
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
import { resolveAppDataDir } from '../appDataDir.js';
import type { ShadowExitLadder } from '../signalTrade/exit/index.js';

/** 影の記録 DB のパス(%APPDATA%/jp225-monitor/shadow_exits.db)。
 *  JP225_SHADOW_DB で上書きできる(隔離テスト/オフライン再生の検証用)。 */
export function resolveShadowDbPath(): string {
  const env = process.env.JP225_SHADOW_DB;
  if (env && env.trim()) return env.trim();
  const dir = resolveAppDataDir();
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

// ─── ★「強制再計算」が本当に置き換わること ──────────────────────────────────
//
// UNIQUE(epoch, source, proposal_id, spec) の鍵には **結果の値が1つも入っていない**。
// つまり INSERT OR IGNORE だけを持っていると、実装を直して再生し直しても
//   「鍵が同じ → 無視 → 報告は inserted:0 → DB の中身は古い結果のまま」
// になる。しかも報告の 0 は「変わらなかった」と読めるので、**バグを直してもデータが直らず、
// しかも成功に見える**。これが一番危ない形なので、置き換える経路を明示的に持つ。
//
// ★通常の再生(force なし)は従来どおり INSERT OR IGNORE(冪等・二重計上しない)。
// ★force のときだけ INSERT OR REPLACE にして、**結果が変わった行数(changed)を数えて返す**。
//   行数そのものは増減しない(鍵が同じなら1行のまま)ので、「増えなかった=何もしていない」ではない。

/** 置き換え前に「その行の結末が今と同じか」を見るための問い合わせ。
 *  ★結末を決める列だけを見る(NULL 安全な IS で比較する)。ここが全部一致していれば
 *    再計算しても答えは変わらなかった、と言ってよい。 */
const SAME_OUTCOME_SQL = `
  SELECT 1 AS x FROM shadow_exits
   WHERE epoch = ? AND source = ? AND proposal_id = ? AND spec = ?
     AND outcome IS ? AND censored IS ? AND censor_reason IS ?
     AND exit_t IS ? AND exit_price IS ? AND exit_reason IS ? AND pnl IS ?
`;

/** 行を書く SQL。衝突時の振る舞いだけが違う(列と順序は1か所に置く=食い違いを作らない)。 */
function insertSql(conflict: 'IGNORE' | 'REPLACE'): string {
  return `
  INSERT OR ${conflict} INTO shadow_exits (
    epoch, source, proposal_id, spec, param_class, dir,
    armed_t, armed_price, entry_t, entry_price, entry_leg, initial_stop,
    exit_t, exit_price, exit_reason, pnl,
    outcome, censored, censor_reason, unrealized, mfe, mae, peak_profit,
    hold_ms, elapsed_ms, horizon_ms, concurrent, ticks, created_at
  ) VALUES (?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?,?,?)
`;
}

/** 数値は非有限なら NULL(NaN/Infinity を DB に置かない)。 */
function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

export interface ShadowInsertResult {
  /** 新しく増えた行数。 */
  inserted: number;
  /** 既にあったので入らなかった行数(replace のときは 0 にならず replaced に出る)。 */
  skipped: number;
  /** ★replace のときだけ: 既存行を **上書きした** 行数。 */
  replaced?: number;
  /** ★replace のときだけ: 上書きした結果、**結末が実際に変わった** 行数。
   *  0 なら「再計算したが答えは同じ」、>0 なら「古い結果が残っていた」。
   *  どちらも「何もしていない」ではないことが読み手に分かる。 */
  changed?: number;
}

/** 影の行をまとめて追記する(1トランザクション)。挿入できた件数を返す。
 *  ★重複(同 epoch/source/proposal/spec)は静かに無視ではなく、戻り値の差で分かるようにする。
 *  ★opts.replace=true(=強制再計算)のときは **上書きする**。一意鍵に結果の値が入っていない以上、
 *    IGNORE のままでは「実装を直して再生し直しても DB は古い結果のまま・報告は inserted:0」になる。
 *  ★フラッシュ経路を作る人へ: **行を書く前に recordShadowLadderMeta(db, ladder) を1回呼ぶこと**。
 *    行には spec(不透明名)と epoch しか載らないので、対応表が無いと1年後に「候補はどれか」が読めない。 */
export function insertShadowRows(
  db: DatabaseSync, rows: readonly ShadowRow[], opts: { replace?: boolean } = {},
): ShadowInsertResult {
  if (rows.length === 0) return opts.replace ? { inserted: 0, skipped: 0, replaced: 0, changed: 0 } : { inserted: 0, skipped: 0 };
  const stmt = db.prepare(insertSql(opts.replace ? 'REPLACE' : 'IGNORE'));
  const same = opts.replace ? db.prepare(SAME_OUTCOME_SQL) : null;
  const before = countShadowRows(db);
  /** 既存行と結末まで完全に一致していた件数(=再計算しても答えが同じだった行)。 */
  let identical = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (same) {
        // ★上書きする **前** に「結末が今と同じか」を見る(上書き後では差が読めない)。
        const hit = same.get(
          r.epoch, r.source, r.proposalId, r.spec,
          r.outcome, r.censored ? 1 : 0, r.censorReason,
          num(r.exitT), num(r.exitPrice), r.exitReason, num(r.pnl),
        );
        if (hit) identical += 1;
      }
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
  if (!opts.replace) return { inserted, skipped: rows.length - inserted };
  // ★force のときは「入らなかった」ではなく「上書きした」と数える。
  //   行数は増えない(鍵が同じなら1行のまま)ので、inserted:0 だけを見せると
  //   「何もしていない/変わらなかった」と読めてしまう。置換件数と、そのうち **結末が変わった** 件数を返す。
  const replaced = rows.length - inserted;
  return { inserted, skipped: 0, replaced, changed: replaced - identical };
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

// ─── ★打ち切り(censoring)を後から必ず検定できるようにする ───────────────────────────
//
// ■ なぜ集計の入口をここに置くか
//   事前登録は「観測地平以内に決済へ到達したもの(=打ち切りでない)」で母集団を切る。ところが
//   **打ち切り率は spec に依存する**(床が緩いほど長く生きる)。地平480分を選んだ理由がまさにそれなのに、
//   結末で母集団を条件付けると、そこに選択バイアスが戻ってくる。
//   さらに 'ticks_exhausted'(価格の供給が尽きた)は時間帯に依存する: 再生は取引日単位なので、
//   夜間終盤に武装した提案の地平は 06:00〜08:45 の空白帯を跨ぐ。長く生きる spec ほど当たりやすく、
//   **spec × 時間帯** の交絡になる。時間帯は過去の検証で判明した最大の効果軸なので、無音にできない。
//   → 「打ち切りを **除いた** 集計」と「**含めた** 集計」の両方を、いつでも同じ DB から出せるようにする。
//     (行そのものは既に必要な値を全部持っている: censored / censor_reason / unrealized / mfe / mae /
//      elapsed_ms / hold_ms。ここに置くのは **数え方の入口** だけで、新しい記録は増やさない。)
//
// ■ 時間帯の表し方
//   armed_t の **JST 時(0-23)** で返す。セッションの区切り(Day 08:45 / 夕方 17:00 / NY 前後)は
//   時から作れるので、ここでセッション判定を書き写さない(core/session.ts を再実装しない)。

/** JST の「時」を armed_t から出す SQL 断片(+9時間して 1時間で割った余り)。 */
const JST_HOUR_SQL = "CAST(((armed_t + 32400000) / 3600000) AS INTEGER) % 24";

/** spec × 時間帯(JST 時)× 打ち切り理由 の件数。**打ち切っていない行も含む**(censorReason=null)。
 *  ★これ1つで「spec 別 × 時間帯別の打ち切り率」も「ticks_exhausted だけの分布」も出せる。 */
export interface ShadowCensorCell {
  spec: string;
  /** 武装時刻の JST 時(0-23)。 */
  jstHour: number;
  /** 'horizon' / 'ticks_exhausted' / null(=打ち切っていない)。 */
  censorReason: string | null;
  n: number;
}

export function shadowCensorByHour(db: DatabaseSync, epoch?: string): ShadowCensorCell[] {
  const sql = `SELECT spec, ${JST_HOUR_SQL} AS jstHour, censor_reason AS censorReason, COUNT(*) AS n
                 FROM shadow_exits ${epoch ? 'WHERE epoch = ?' : ''}
                GROUP BY spec, jstHour, censorReason
                ORDER BY spec, jstHour, censorReason`;
  const stmt = db.prepare(sql);
  return (epoch ? stmt.all(epoch) : stmt.all()) as unknown as ShadowCensorCell[];
}

/** spec × 打ち切りの有無 の集計。**打ち切りを除いた集計と含めた集計の両方** をこの1表から作る。
 *  - 除いた集計 … censored=0 の行だけを使う(pnl は必ずある)。
 *  - 含めた集計 … censored=1 の行を、決済していない事実(pnl は無く unrealized がある)ごと足す。
 *  ★両者の差そのものを見るために、母数(n)と各合計の **個数** を必ず一緒に返す
 *    (平均を返してしまうと、いくつの行から作った平均かが消える)。 */
export interface ShadowSpecTotals {
  spec: string;
  /** 1=打ち切り(観測を打ち切った) / 0=終わった(決済 or 未約定失効)。 */
  censored: number;
  n: number;
  /** 決済した行の数と損益合計(打ち切り行の pnl は NULL なので入らない)。 */
  nPnl: number;
  sumPnl: number;
  /** 打ち切り時点の含み損益(打ち切り行だけが持つ)。 */
  nUnrealized: number;
  sumUnrealized: number;
  /** 約定した行だけが持つ MFE / MAE / 保有時間。 */
  nMfe: number; sumMfe: number;
  nMae: number; sumMae: number;
  nHold: number; sumHoldMs: number;
  /** 武装からの経過(全行が持つ)。 */
  sumElapsedMs: number;
}

export function shadowSpecTotals(db: DatabaseSync, epoch?: string): ShadowSpecTotals[] {
  const sql = `SELECT spec, censored,
                      COUNT(*) AS n,
                      COUNT(pnl) AS nPnl, COALESCE(SUM(pnl), 0) AS sumPnl,
                      COUNT(unrealized) AS nUnrealized, COALESCE(SUM(unrealized), 0) AS sumUnrealized,
                      COUNT(mfe) AS nMfe, COALESCE(SUM(mfe), 0) AS sumMfe,
                      COUNT(mae) AS nMae, COALESCE(SUM(mae), 0) AS sumMae,
                      COUNT(hold_ms) AS nHold, COALESCE(SUM(hold_ms), 0) AS sumHoldMs,
                      COALESCE(SUM(elapsed_ms), 0) AS sumElapsedMs
                 FROM shadow_exits ${epoch ? 'WHERE epoch = ?' : ''}
                GROUP BY spec, censored
                ORDER BY spec, censored`;
  const stmt = db.prepare(sql);
  return (epoch ? stmt.all(epoch) : stmt.all()) as unknown as ShadowSpecTotals[];
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
