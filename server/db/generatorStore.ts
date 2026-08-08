// 提案生成器の台帳(**専用 DB ファイル**・追記のみ)。
//
// ■ なぜ共有 DB(jp225.db)に入れないか
//   trade2 の priceSnapshotWorker が 30分ごとに **DB 全体を `VACUUM INTO`** して prices_<host>.db を作る。
//   実測 102MB で約1.3秒の同期ブロック。ここを太らせるほど実弾トレードのフィード/発注/約定検知を
//   止めるリスクが増える。→ ティック保管(db/tickArchive.ts)・影の記録(db/shadowStore.ts)と同じ判断で
//   **別ファイル** に置く。(trade2 は %APPDATA%/jp225-monitor を列挙せず jp225.db と server.log しか
//   見ないので、別ファイルを置くだけで自動的に VACUUM INTO の対象外になる。相手側の変更は不要。)
//
// ■ ★ここに書いてよいもの / 絶対に書かないもの
//   書いてよい: 提案(AiPlan)そのもの・見送り理由・腕(変種名)・サイクルID・epoch・撮影の識別子・
//               決済設定の **版番号と一方向ハッシュ**(既に jp225.db / 書き出し CSV に載っているのと同じ粒度)。
//   絶対に書かない: 決済ラダーの実数値、API キー。どちらもこのモジュールの入力に現れない
//               (変種は名前、決済設定は hash、キーは「出どころ」だけが monitor から返る)。
//
// ■ 列は最初から全部持たせる(後から足すと期の境界が曖昧になる)
//   1年かけて溜める台帳なので、途中で列が生えると「NULL は未記録か、そういう値だったのか」が
//   区別できなくなる。再試行・撮影の同一性・見送り理由・HTTP 由来の欠測理由は **今** 作る。

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { isAnalysisEnabled } from '../analysisGate.js';
import { resolveAppDataDir } from '../appDataDir.js';
import { DEFAULT_EXIT_VARIANT, type ExitVariant } from '../signalTrade/exit/index.js';

/** ★腕(arm)= 既存の語彙 ExitVariant に、**同じ入力へ2回問う対照** を足しただけのもの。
 *  新しい列挙を作らない(ExitVariant を並行して手書きし直すと、変種が増えたとき片方だけ古くなる)。
 *  - 'current'     … ①現行の決済仕様を教えた生成器
 *  - 'candidate-a' … ②候補の決済仕様を教えた生成器
 *  - 'control'     … ①' ①と **同じ入力** でもう1回問う対照(LLM のばらつきの基準線)。
 *                    送る exitVariant は 'current' と同一で、腕名だけが違う。 */
export type GeneratorArm = ExitVariant | 'control';

/** 対照の腕。①と同じ exitVariant を送るので、区別は腕名だけが担う。 */
export const CONTROL_ARM: GeneratorArm = 'control';

/** 対照が実際に送る変種(=①と同じ)。 */
export const CONTROL_EXIT_VARIANT: ExitVariant = DEFAULT_EXIT_VARIANT;

/** 1要求の結末。**欠測をランダムでなくする理由まで含めて** 区別する。
 *  - 'plan'          … 200 + ok:true。提案(見送り direction:'none' を含む)が返った
 *  - 'plan-error'    … 200 + ok:false。chart-not-generated / LLM 失敗 / キー無し等
 *  - 'skipped'       … 429。生成器ゲートが弾いた(busy / budget / default-quota / disabled / closed)
 *  - 'http-error'    … それ以外の HTTP エラー(400=変種や caller が拒否された等)
 *  - 'timeout'       … 応答が来なかった
 *  - 'network-error' … monitor に届かなかった */
export type ProposalStatus = 'plan' | 'plan-error' | 'skipped' | 'http-error' | 'timeout' | 'network-error';

/** 台帳の1行。**1サイクル×1腕で1行**(再試行しても行は増えない=再試行は列で表す)。 */
export interface ProposalRow {
  epoch: string;
  /** ①①'②を結ぶキー(対応比較の結合キー)。 */
  cycleId: string;
  arm: GeneratorArm;
  /** 実際に送った exitVariant。'control' は 'current' を送るので、腕名とは別に残す。 */
  exitVariant: ExitVariant;
  /** サイクル内の直列順(0=①, 1=①' か ②, 2=②)。①②の順序効果を後から検定できるように残す。 */
  seq: number;
  /** 取引日(セッション外は null)。 */
  sessionDate: string | null;
  requestedAt: number;
  respondedAt: number | null;
  latencyMs: number | null;
  status: ProposalStatus;
  /** 429 の理由(busy/budget/default-quota/disabled/closed)や HTTP エラーの短い分類。 */
  skipReason: string | null;
  httpStatus: number | null;
  error: string | null;
  /** 再試行したか(0/1)と回数。★429-busy は「A が入るかもしれない瞬間」に立つので、
   *  無策だと台帳は **A が行動する瞬間を系統的に取りこぼす**(欠測がランダムでなくなる)。 */
  retried: 0 | 1;
  retryCount: number;
  /** 再試行前の1回目の理由(busy 等)。欠測の性質を後から検定するために残す。 */
  preRetryReason: string | null;
  // ── 提案そのもの(見送りもエラーも全部) ──
  direction: string | null;
  /** AiPlan 全体の JSON(見送り direction:'none' も含めて全数)。 */
  planJson: string | null;
  refPrice: number | null;
  regime: string | null;
  confidence: number | null;
  // ── 見送り理由(応答に additive で載っているもの) ──
  noneReason: string | null;
  noneLegsJson: string | null;
  /** ★レッグ1本ごとの脱落理由の JSON 配列(monitor の応答 legDrops をそのまま)。
   *  例: `[{"name":"stop","reason":"missing"},{"name":"limit","reason":"lc","entry":38200,"stopLoss":38120}]`。
   *  none_legs_json が **両レッグ落ちて見送りになった回** しか持たないのに対し、こちらは
   *  **片レッグだけ落ちた回**(最終プランは成立しているが逆指値だけ消えた 等)も持つ。
   *  ★NULL は2つの意味を持つ: ①この列を持たない版で記録された(観測不能) ②1本も落ちなかった。
   *    どちらかは **同じ epoch の他の行に値が入っているか**(=その期の monitor がこの列を返す版か)で
   *    判別する。epoch ごとの起動時刻は runs テーブルにある。
   *  ★型上は optional(省略= NULL)。既存の呼び出し/テストが作る行をそのまま受け付けるため。 */
  legDropsJson?: string | null;
  vetoFired: 0 | 1 | null;
  rangeAnomalyJson: string | null;
  // ── ★画像の同一性(①と②が同じ1枚を見たか) ──
  shotId: string | null;
  shotAgeMs: number | null;
  shotOrigin: string | null;
  /** ★プロンプトから **外した** 文脈ブロックの JSON 配列(monitor の応答 contextOmitted をそのまま)。
   *  現在は両腕とも ["paper-trade-history"](=A の紙成績を見せていない=母集団の独立性)。
   *  ★NULL の意味: 「まだこの列を持たない版の monitor/生成器で記録された」= **紙成績を見せていた** 標本。
   *    値が無いことと「外していない」を混同しないよう、ここに明記しておく。
   *  ★型上は optional(省略= NULL)。既存の呼び出し/テストが作る行をそのまま受け付けるため。
   *    実際の生成器(cycle.ts)は **常に** 明示的に値(または null)を入れる。 */
  contextOmittedJson?: string | null;
  /** ★monitor が文脈を組み立てた時刻(epoch ms・**monitor の時計**)。
   *  requested_at/responded_at は生成器プロセスの時計で、撮影と LLM の待ちを含んだ両端でしかない
   *  (実測でその差は秒オーダー)。凍結した断面から提案を再生して突き合わせるには、
   *  「どの時刻の断面を読んだか」そのものが要る。応答に無ければ NULL(= この列を返さない版と話した)。
   *  ★型上は optional(省略= NULL)。既存の呼び出し/テストが作る行をそのまま受け付けるため。 */
  contextAt?: number | null;
  /** ★送った system+user プロンプトの一方向指紋(`sp1:<16桁hex>`)。**本文は入らない**
   *  (プロンプトには非公開の決済仕様が入るため、指紋だけを持つ)。
   *  ★型上は optional(省略= NULL)。 */
  promptFp?: string | null;
  createdAt: number;
}

/** 台帳 DB のパス(%APPDATA%/jp225-monitor/generator_proposals.db)。
 *  JP225_GENERATOR_DB で上書きできる(隔離テスト/検証用)。 */
export function resolveGeneratorDbPath(): string {
  const env = process.env.JP225_GENERATOR_DB;
  if (env && env.trim()) return env.trim();
  const dir = resolveAppDataDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'generator_proposals.db');
}

/** 台帳スキーマ。
 *  ★UNIQUE(epoch, cycle_id, arm): 同じ epoch × 同じサイクル × 同じ腕は1行だけ(再送しても二重計上しない)。 */
export function initGeneratorSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS proposals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      epoch         TEXT    NOT NULL,
      cycle_id      TEXT    NOT NULL,
      arm           TEXT    NOT NULL,
      exit_variant  TEXT    NOT NULL,
      seq           INTEGER NOT NULL,
      session_date  TEXT,
      requested_at  INTEGER NOT NULL,
      responded_at  INTEGER,
      latency_ms    INTEGER,
      status        TEXT    NOT NULL,
      skip_reason   TEXT,
      http_status   INTEGER,
      error         TEXT,
      retried       INTEGER NOT NULL,
      retry_count   INTEGER NOT NULL,
      pre_retry_reason TEXT,
      direction     TEXT,
      plan_json     TEXT,
      ref_price     REAL,
      regime        TEXT,
      confidence    REAL,
      none_reason   TEXT,
      none_legs_json TEXT,
      -- ★レッグ1本ごとの脱落理由(JSON 配列)。none_legs_json が両レッグ落ち(=見送り)しか持たないのに対し、
      --   **片レッグだけ落ちた回**(逆指値だけ消えた 等)も持つ。NULL = この列を持たない版で記録された
      --   or 1本も落ちなかった(区別は同じ epoch の他行に値が在るかで読む)。
      leg_drops_json TEXT,
      veto_fired    INTEGER,
      range_anomaly_json TEXT,
      shot_id       TEXT,
      shot_age_ms   INTEGER,
      shot_origin   TEXT,
      -- ★プロンプトから外した文脈ブロック(JSON 配列)。NULL = この列を持たない版で記録された
      --   = **紙成績(A の履歴)を見せていた** 標本(値が無いことと「外していない」を混同しない)。
      context_omitted TEXT,
      -- ★凍結再生の突合(下の ALTER と同じ2列)。context_at=monitor が文脈を組み立てた時刻(monitor の時計)。
      --   prompt_fp=送ったプロンプトの一方向指紋。★本文は決して入れない。
      context_at    INTEGER,
      prompt_fp     TEXT,
      created_at    INTEGER NOT NULL,
      UNIQUE (epoch, cycle_id, arm)
    );
    CREATE INDEX IF NOT EXISTS idx_gen_cycle ON proposals (cycle_id);
    CREATE INDEX IF NOT EXISTS idx_gen_day ON proposals (session_date, arm);
    CREATE INDEX IF NOT EXISTS idx_gen_requested ON proposals (requested_at);

    -- ★プロセスの起動ごとに1行 **追記** する(更新も削除もしない)。
    --   「1年後に、実は3か月動いていなかった」を後から必ず特定できるようにするための土台。
    --   凍結設定は **/api/settings の生スナップショット** をそのまま持つ(取引記録から推測しない)。
    CREATE TABLE IF NOT EXISTS runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at    INTEGER NOT NULL,
      epoch         TEXT    NOT NULL,
      monitor_url   TEXT    NOT NULL,
      exit_impl     TEXT,
      exit_variant_impl TEXT,
      exit_config_version INTEGER,
      exit_config_hash TEXT,
      settings_json TEXT    NOT NULL,
      epoch_input_json TEXT NOT NULL,
      generator_config_json TEXT NOT NULL
    );

    -- ★取引日ごとの件数(腕別・見送り理由別)の **追記のみ** の台帳。
    --   行を更新しない: 同じ取引日について時刻つきのスナップショットを積み増すので、
    --   「いつまで記録があって、いつ止まったか」が必ず読める(件数は各 (day,arm,...) の最大値)。
    CREATE TABLE IF NOT EXISTS daily_tally (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      session_date TEXT    NOT NULL,
      epoch        TEXT    NOT NULL,
      arm          TEXT    NOT NULL,
      status       TEXT    NOT NULL,
      none_reason  TEXT    NOT NULL,
      n            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gen_tally ON daily_tally (session_date, at);

    -- ★「止まった理由」の **追記のみ** の台帳。
    --   起動時検証(preflight)や稼働中の再検証で前提が崩れたとき、生成器は意図的に停止する。
    --   運用PCではコンソールを見られないので、理由がログにしか出ないと「動いていない」ことは
    --   分かっても「なぜ止まったか」は永遠に分からない(= 別物である)。だから台帳に残し、
    --   monitor の /api/status → 死活ドットまで届ける。
    --   ★決済の実数値は入らない(reason は preflight/recheck の文言=種別・版・指紋のみ)。
    CREATE TABLE IF NOT EXISTS halts (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     INTEGER NOT NULL,
      phase  TEXT    NOT NULL,
      reason TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gen_halt ON halts (at);

    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
  `);
  // ★既に走っている台帳(実売買PCには数日ぶんの行がある)へ列を足す。冪等に足すのは
  //   server/db/store.ts と同じ作法。既存行は NULL のまま = 「紙成績を見せていた版で記録された」。
  //   ここで足さないと、旧DBに対する INSERT が列不一致で毎回失敗して記録が丸ごと止まる。
  const cols = (db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map(r => r.name);
  if (!cols.includes('context_omitted')) db.exec('ALTER TABLE proposals ADD COLUMN context_omitted TEXT');
  // ★v0.9.57: 片レッグ脱落の理由。既存行は NULL のまま =「この列を持たない版で記録された」。
  if (!cols.includes('leg_drops_json')) db.exec('ALTER TABLE proposals ADD COLUMN leg_drops_json TEXT');
  // ★凍結再生の突合。既存行は NULL のまま =「この列を持たない版で記録された」。
  //   monitor 側の signal_plans と **同じ2列・同じ意味** にして、両台帳を同じ道具で読めるようにする。
  if (!cols.includes('context_at')) db.exec('ALTER TABLE proposals ADD COLUMN context_at INTEGER');
  if (!cols.includes('prompt_fp')) db.exec('ALTER TABLE proposals ADD COLUMN prompt_fp TEXT');
}

/** 台帳 DB を開く(書き込み用)。
 *  ★公開版(lite)では **入口を閉じる**。提案生成器は決済パラメータの分析専用で、公開版には要らない。
 *    黙って専用 DB が増え続けるより、開発中に大きな音で落ちる方が良い(「無音の失敗は欠陥」)。 */
export function openGeneratorDb(path: string): DatabaseSync {
  if (!isAnalysisEnabled()) {
    throw new Error('提案生成器の台帳は分析専用です(公開版では開けません) — server/analysisGate.ts');
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initGeneratorSchema(db);
  return db;
}

/** 台帳 DB を **読み取り専用** で開く(/api/status の死活表示用)。
 *  ファイルが無ければ null(表示のために台帳を新規作成しない=「まだ1度も動いていない」を捏造しない)。 */
export function openGeneratorDbReadOnly(path: string): DatabaseSync | null {
  if (!existsSync(path)) return null;
  try {
    // readOnly は node 24 ランタイムにあるが @types/node@20 の型に無いためキャストで通す(db/mergeDb.ts と同じ作法)。
    const opts = { readOnly: true } as unknown as ConstructorParameters<typeof DatabaseSync>[1];
    return new DatabaseSync(path, opts);
  } catch {
    return null;   // 別プロセスが WAL で書いている最中など。表示のために例外を投げない。
  }
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO proposals (
    epoch, cycle_id, arm, exit_variant, seq, session_date,
    requested_at, responded_at, latency_ms,
    status, skip_reason, http_status, error,
    retried, retry_count, pre_retry_reason,
    direction, plan_json, ref_price, regime, confidence,
    none_reason, none_legs_json, leg_drops_json, veto_fired, range_anomaly_json,
    shot_id, shot_age_ms, shot_origin, context_omitted,
    context_at, prompt_fp, created_at
  ) VALUES (?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?)
`;

/** 数値は非有限なら NULL(NaN/Infinity を DB に置かない)。 */
function num(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** 台帳へ1行 **追記** する。既に同じ (epoch, cycle_id, arm) があれば false(二重計上しない)。 */
export function insertProposal(db: DatabaseSync, r: ProposalRow): boolean {
  const before = countProposals(db);
  db.prepare(INSERT_SQL).run(
    r.epoch, r.cycleId, r.arm, r.exitVariant, r.seq, r.sessionDate,
    r.requestedAt, num(r.respondedAt), num(r.latencyMs),
    r.status, r.skipReason, num(r.httpStatus), r.error,
    r.retried, r.retryCount, r.preRetryReason,
    r.direction, r.planJson, num(r.refPrice), r.regime, num(r.confidence),
    r.noneReason, r.noneLegsJson, r.legDropsJson ?? null, r.vetoFired, r.rangeAnomalyJson,
    r.shotId, num(r.shotAgeMs), r.shotOrigin, r.contextOmittedJson ?? null,
    num(r.contextAt), r.promptFp ?? null, r.createdAt,
  );
  return countProposals(db) > before;
}

export function countProposals(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
}

/** 起動を1行 **追記** する(戻り値=run id)。凍結設定・決済版・epoch の入力をそのまま残す。 */
export function insertRun(db: DatabaseSync, r: {
  startedAt: number; epoch: string; monitorUrl: string;
  exitImpl: string | null; exitVariantImpl: string | null;
  exitConfigVersion: number | null; exitConfigHash: string | null;
  settingsJson: string; epochInputJson: string; generatorConfigJson: string;
}): void {
  db.prepare(`INSERT INTO runs (
    started_at, epoch, monitor_url, exit_impl, exit_variant_impl,
    exit_config_version, exit_config_hash, settings_json, epoch_input_json, generator_config_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    r.startedAt, r.epoch, r.monitorUrl, r.exitImpl, r.exitVariantImpl,
    num(r.exitConfigVersion), r.exitConfigHash, r.settingsJson, r.epochInputJson, r.generatorConfigJson,
  );
}

/** 取引日ごとの件数(腕別・見送り理由別)を **今の台帳から数え直して追記** する。
 *  ★更新でなく追記なので、過去のスナップショットは残る=「いつ止まったか」が必ず読める。
 *  ★件数は proposals から毎回 GROUP BY で導出する(別勘定を持たない=drift しない)。
 *  戻り値=追記した行数。 */
export function appendDailyTally(db: DatabaseSync, at: number, sessionDate?: string | null): number {
  const where = sessionDate === undefined
    ? ''
    : sessionDate === null ? 'WHERE session_date IS NULL' : 'WHERE session_date = ?';
  const sql = `SELECT COALESCE(session_date, '(closed)') AS d, epoch, arm, status,
                      COALESCE(none_reason, '') AS nr, COUNT(*) AS n
               FROM proposals ${where}
               GROUP BY d, epoch, arm, status, nr
               ORDER BY d, epoch, arm, status, nr`;
  const stmt = db.prepare(sql);
  const rows = (sessionDate !== undefined && sessionDate !== null ? stmt.all(sessionDate) : stmt.all()) as unknown as
    Array<{ d: string; epoch: string; arm: string; status: string; nr: string; n: number }>;
  if (rows.length === 0) return 0;
  const ins = db.prepare('INSERT INTO daily_tally (at, session_date, epoch, arm, status, none_reason, n) VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const r of rows) ins.run(at, r.d, r.epoch, r.arm, r.status, r.nr, r.n);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

// ─── ★止まった理由(halts)────────────────────────────────────────────────────
//
// 「動いていない」と「止まった理由」は別物。前者は台帳の件数(planLastHour)で分かるが、
// 後者はプロセスのログにしか無かった。運用PCではコンソールを見られないので、
// **理由を残す場所** を台帳に1つ作り、/api/status → 死活ドットまで届ける。

/** 止まった理由の1行(追記のみ・更新も削除もしない)。 */
export interface GeneratorHaltRow {
  at: number;
  /** どの局面で止まったか('起動しません' / '停止します')。生成器 die() の第2引数と同じ語彙。 */
  phase: string;
  /** 理由の文言(preflight/recheck が返すもの)。★決済の実数値は含まれない。 */
  reason: string;
}

/** 止まった理由を **追記** する。台帳が無ければ作る(=停止しか起きなかった PC でも理由が残る)。
 *  ★呼ぶのは「有効化されていて、実際に止まったとき」だけ。無効(待機)中は1行も書かない。 */
export function insertGeneratorHalt(db: DatabaseSync, row: GeneratorHaltRow): void {
  db.prepare('INSERT INTO halts (at, phase, reason) VALUES (?,?,?)')
    .run(row.at, row.phase, row.reason);
}

/** 直近の停止理由を読む(readOnly 接続で使う)。halts 表が無い旧台帳では null。 */
function readLatestHalt(db: DatabaseSync): GeneratorHaltRow | null {
  try {
    const r = db.prepare('SELECT at, phase, reason FROM halts ORDER BY at DESC, id DESC LIMIT 1')
      .get() as { at: number; phase: string; reason: string } | undefined;
    return r ? { at: r.at, phase: r.phase, reason: r.reason } : null;
  } catch {
    return null;   // 旧台帳(halts 表が無い)。停止理由が無いことと観測不能を区別する必要はここでは無い。
  }
}

/** 死活を判定する窓[ms]。1サイクル=2分なので、1時間 ≒ 30サイクル ≒ 標本60〜90件。 */
export const LIVENESS_WINDOW_MS = 60 * 60_000;

/** /api/status に出す死活情報。**読むだけ**(採番も作成もしない)。 */
export interface GeneratorLedgerStatus {
  /** 台帳ファイルが在るか。false=生成器はこの PC で一度も動いていない。 */
  available: boolean;
  /** 最後に1行記録した時刻(epoch ms)。 */
  lastRecordAt: number | null;
  /** 「最終記録 N 分前」。★これは **プロセスが生きているか** しか言わない(下の planLastHour を見ること)。 */
  ageMin: number | null;
  /** ★死活の本体: 直近1時間に **標本が取れた**(status='plan')件数。
   *
   *  なぜ ageMin では足りないか: 生成器はゲートに弾かれている間も2分ごとに status='skipped' を
   *  書き続ける。だから「最後の記録が何分前か」は **止まっている間も新しいまま** で、画面は緑のままになる。
   *  実売買PCの実ログでは従属停止でセッションの 91〜100% が止まっていたのに、この指標は一度も
   *  警告に変わらなかった(=無音の失敗)。溜めたいのは提案であって行数ではないので、
   *  **溜まっているか** を直接数える。
   *  ★台帳が読めない環境では **フィールドごと無い**(「0件」と「観測できない」を混同しない)。 */
  planLastHour?: number;
  /** 直近1時間に **取引時間内に**(session_date が付いた状態で)投げた要求の件数。
   *  0 なら「そもそも標本を取る時間帯ではない」= planLastHour が 0 でも異常ではない。
   *  取引時間外の常態を警告色にすると、警告そのものが読まれなくなる。 */
  inSessionLastHour?: number;
  /** 直近の取引日(セッション外は '(closed)')の腕別件数。 */
  today: Array<{ sessionDate: string; arm: string; n: number }>;
  total: number;
  /** ★**まだ効いている** 停止理由(最後の記録より後に止まっているときだけ入る)。
   *  最後の提案より前の停止は、その後に走り出しているので「今の状態」ではない=出さない
   *  (古い理由を出し続けると、ドットが直らなくなって読まれなくなる)。 */
  halt?: GeneratorHaltRow;
}

const UNAVAILABLE_LEDGER: GeneratorLedgerStatus = {
  available: false, lastRecordAt: null, ageMin: null, today: [], total: 0,
};

/** ★最後に「前提検証を通って起動した」記録(runs の最新行)。**読むだけ**・例外を投げない。
 *  停止理由(halts)と対で読むためのもの: halts だけでは「一度も起動できていない」と
 *  「起動していたが後で崩れた」が区別できない。台帳が無ければ null。 */
export function readGeneratorLastRun(path: string): { startedAt: number; epoch: string; monitorUrl: string } | null {
  const db = openGeneratorDbReadOnly(path);
  if (!db) return null;
  try {
    const r = db.prepare('SELECT started_at, epoch, monitor_url FROM runs ORDER BY started_at DESC, id DESC LIMIT 1')
      .get() as { started_at: number; epoch: string; monitor_url: string } | undefined;
    return r ? { startedAt: r.started_at, epoch: r.epoch, monitorUrl: r.monitor_url } : null;
  } catch {
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 台帳の死活情報を読む。**例外を投げない**(状態を見に来た画面が「サーバが死んでいる」ように見えない)。 */
export function readGeneratorLedgerStatus(path: string, now: number): GeneratorLedgerStatus {
  const db = openGeneratorDbReadOnly(path);
  if (!db) return UNAVAILABLE_LEDGER;
  try {
    const last = (db.prepare('SELECT MAX(requested_at) AS t FROM proposals').get() as { t: number | null }).t;
    const total = (db.prepare('SELECT COUNT(*) AS n FROM proposals').get() as { n: number }).n;
    // ★死活は「標本が溜まっているか」で測る(行が増えているか、ではない)。
    const since = now - LIVENESS_WINDOW_MS;
    const planLastHour = (db.prepare(
      "SELECT COUNT(*) AS n FROM proposals WHERE status = 'plan' AND requested_at >= ?",
    ).get(since) as { n: number }).n;
    const inSessionLastHour = (db.prepare(
      'SELECT COUNT(*) AS n FROM proposals WHERE session_date IS NOT NULL AND requested_at >= ?',
    ).get(since) as { n: number }).n;
    const day = (db.prepare(`SELECT COALESCE(session_date, '(closed)') AS d FROM proposals
                             ORDER BY requested_at DESC LIMIT 1`).get() as { d: string } | undefined)?.d ?? null;
    const today = day === null ? [] : (db.prepare(
      `SELECT COALESCE(session_date, '(closed)') AS d, arm, COUNT(*) AS n FROM proposals
       WHERE COALESCE(session_date, '(closed)') = ? GROUP BY d, arm ORDER BY arm`,
    ).all(day) as unknown as Array<{ d: string; arm: string; n: number }>)
      .map(r => ({ sessionDate: r.d, arm: r.arm, n: r.n }));
    // ★停止理由は「最後の記録より後」のものだけ効いていると見なす。
    const latestHalt = readLatestHalt(db);
    const halt = latestHalt && latestHalt.at >= (last ?? 0) ? latestHalt : null;
    return {
      available: true,
      lastRecordAt: last,
      ageMin: last == null ? null : Math.max(0, Math.round((now - last) / 60_000)),
      planLastHour,
      inSessionLastHour,
      today,
      total,
      ...(halt ? { halt } : {}),
    };
  } catch {
    // 表がまだ無い(=開いただけで一度も書いていない)等。「観測できなかった」を available:false で表す。
    return UNAVAILABLE_LEDGER;
  } finally {
    try { db.close(); } catch { /* close 失敗は無視 */ }
  }
}
