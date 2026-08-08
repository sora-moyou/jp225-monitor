import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { classifySession } from '../../core/session.js';
import { resolveAppDataDir } from '../appDataDir.js';

/** 共有 DB ファイルのパス (%APPDATA%/jp225-monitor/jp225.db、無ければ HOME/cwd)。
 *  ★テスト実行中は resolveAppDataDir が実パスを隔離先へ差し替える(server/appDataDir.ts 参照)。
 *    本番では従来と同一の文字列を返す。 */
export function resolveDbPath(): string {
  const dir = resolveAppDataDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, 'jp225.db');
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  initSchema(db);
  return db;
}

export interface Tick { symbol: string; t: number; price: number; }
export interface Bar1m { symbol: string; session_date: string | null; session: string | null; t: number; o: number; h: number; l: number; c: number; }

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS bars_1m (
      symbol TEXT NOT NULL, session_date TEXT, session TEXT, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL,
      PRIMARY KEY (symbol, t)
    );
    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT );
    CREATE TABLE IF NOT EXISTS daily_closes (
      symbol TEXT NOT NULL, session_date TEXT NOT NULL, close REAL NOT NULL, t INTEGER NOT NULL,
      PRIMARY KEY (symbol, session_date)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL, triggered_at INTEGER NOT NULL,
      direction TEXT, detection_kind TEXT, window_seconds INTEGER,
      change_percent REAL, price REAL,
      session_date TEXT, session TEXT,
      ret5 REAL, ret15 REAL, ret30 REAL,
      reference_kind TEXT, reference_price REAL
    );
    CREATE TABLE IF NOT EXISTS signal_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, dir TEXT NOT NULL,
      exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
      qty INTEGER NOT NULL, rationale TEXT, meta TEXT, mode TEXT
    );
    CREATE TABLE IF NOT EXISTS signal_exit_stops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL, signal_id INTEGER, opened_at INTEGER NOT NULL,
      direction TEXT NOT NULL, exit_stop REAL NOT NULL, phase TEXT
    );
    CREATE TABLE IF NOT EXISTS signal_meta (
      system TEXT PRIMARY KEY,
      last_signal_id INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_trades_clears (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL,
      system_requested TEXT,
      system_effective TEXT NOT NULL,
      deleted_trades INTEGER NOT NULL,
      max_signal_id_before INTEGER,
      orphan_exit_stops INTEGER NOT NULL
    );
    -- ★計画サイクルの台帳(RECORD-ONLY)。**約定したか見送ったかに関わらず、1サイクル=1行**。
    --   signal_trades は「約定して決済された」ときにしか行が出ないため、A/B 実験の主要指標である
    --   「見送り率」と「レッグが落ちた理由の内訳」が DB に一切残っていなかった(実測: サーバログには
    --   plan-suppress 415件 / plan-legdrop 46件 あるのに signal_trades には0件)。ログはローテートする。
    --   ★対象は flat からの計画サイクル(maybeRequestPlan)のみ。保有中の反転評価(held-eval)と
    --     レンジ再評価(range-reeval)は A だけの別種のサイクルなので、この表には入れない(A/B 対称を保つ)。
    CREATE TABLE IF NOT EXISTS signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL,           -- 計画が解決した時刻(epoch ms)
      -- ★系統。signal_trades と違い A も明示的に 'A' を入れる(NULL=A の後方互換規約を新表に持ち込まない)。
      system TEXT NOT NULL,
      signal_id INTEGER,            -- ARM した回のみ采番値。見送り/不成立は NULL。
      direction TEXT,               -- 'buy'|'sell'|'none'|'range'。計画が得られなかった回(error)は NULL。
      none_reason TEXT,             -- NoneReason の語彙(ai/geometry/stopSide/lc/lcFloor/bias/trend/rangeDisabled/missing/stale)
      veto_fired INTEGER,           -- トレンド veto が発火したか(0/1)。不明は NULL。
      ref_price REAL,               -- 計画が見た現在値(NIY=F)
      regime TEXT,                  -- AI 自己レジーム(trend_up/trend_down/range/unclear)
      confidence REAL,              -- AI 自己確信度 0-100
      limit_entry REAL,             -- 最終プランの価格。無い/none/range では NULL。
      stop_entry REAL,
      stop_loss_for_limit REAL,
      stop_loss_for_stop REAL,
      leg_drops_json TEXT,          -- レッグ1本ごとの脱落理由(LegDrop[] の JSON)。1本も落ちなければ NULL。
      settings_json TEXT,           -- そのサイクルの実効設定(signal_trades.meta の settings と同じ組み立て)
      rationale TEXT,               -- AI の判断理由(上限 PLAN_RATIONALE_MAX_CHARS 文字で切る)
      error TEXT,                   -- 計画が得られなかった回の理由(chart-not-generated 等)。取れた回は NULL。
      -- ★凍結再生の突合(RECORD-ONLY): 下の ALTER と同じ2列。新規DBはここで、既存DBは ALTER で入る。
      context_at INTEGER,           -- 文脈を組み立てた時刻(epoch ms)。t(記録時刻)とは別物。
      prompt_fp TEXT                -- 送った system+user プロンプトの一方向指紋。★本文は決して入れない。
    );
    CREATE INDEX IF NOT EXISTS idx_signal_plans_sys_t ON signal_plans (system, t);
  `);
  // ★v0.9.59(RECORD-ONLY): ARM した回の「待ち時間(armed-timeout までの猶予)がどう決まったか」の全材料。
  //   待ち時間を距離×ボラで可変にしたので、**なぜこの時間になったか** が後から読めないと検証できない。
  //   arm_wait_ms=採用した待ち / arm_wait_distance=ARM 時価格から最寄エントリーまでの距離[円] /
  //   arm_wait_sigma=直近1分足終値変化の標準偏差[円/分] / arm_wait_reason=どの枝で決まったか。
  //   既存DBへ後付けマイグレーション(NULL 可=旧行 / ARM しなかった回)。
  const spCols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
  if (!spCols.includes('arm_wait_ms')) db.exec('ALTER TABLE signal_plans ADD COLUMN arm_wait_ms INTEGER');
  if (!spCols.includes('arm_wait_distance')) db.exec('ALTER TABLE signal_plans ADD COLUMN arm_wait_distance REAL');
  if (!spCols.includes('arm_wait_sigma')) db.exec('ALTER TABLE signal_plans ADD COLUMN arm_wait_sigma REAL');
  if (!spCols.includes('arm_wait_reason')) db.exec('ALTER TABLE signal_plans ADD COLUMN arm_wait_reason TEXT');
  // ★凍結再生の突合(RECORD-ONLY)。この2列が無いと、凍結した入力から組み直した文脈が
  //   「その時刻に実際に AI へ渡ったもの」と同じかを **原理的に** 確かめられない
  //   (実測: サーバログの行を時刻の真値の代用にして秒オーダーの誤差が残り、1件は1分足が隣にずれた。
  //    さらに計画サイクルの一部は ref_price が collector の tick 列に一度も現れず、時刻すら決められない)。
  //   context_at … buildRichScalpContextResult に渡した now(epoch ms)。t(記録時刻)とは別物。
  //   prompt_fp  … system+user プロンプトの一方向指紋(`sp1:<16桁hex>`)。★本文は決して入れない
  //                (非公開の決済仕様が本文に入り、記録は同期フォルダ経由で機外へ出るため)。
  //   既存DBへ後付けマイグレーション(NULL 可=この列を持たない版で記録された旧行)。
  if (!spCols.includes('context_at')) db.exec('ALTER TABLE signal_plans ADD COLUMN context_at INTEGER');
  if (!spCols.includes('prompt_fp')) db.exec('ALTER TABLE signal_plans ADD COLUMN prompt_fp TEXT');
  // ★RECORD-ONLY: 根拠文で AI が **申告した LC幅** と、AI が実際に出力した |entry − stopLoss| の突き合わせ。
  //   LcDeclarationCheck[](server/llm/rationaleLc.ts)をそのまま JSON 化する。leg_drops_json に相乗りせず
  //   **別列** にする理由: (a)故障の分母には「落ちたレッグ」だけでなく「採用されたレッグ」も要る
  //   (実測で落ちたレッグ 41.7% / 採用レッグ 2.0% = 対照が無いと『AI が壊れている』と言えない)。
  //   (b)leg_drops_json の形と意味を変えないため(既存の集計/テストが読む形は不変)。
  //   既存DBへ後付けマイグレーション(NULL 可=この列を持たない版で記録された旧行はそのまま)。
  if (!spCols.includes('lc_audit_json')) db.exec('ALTER TABLE signal_plans ADD COLUMN lc_audit_json TEXT');
  // ★RECORD-ONLY(v0.9.66): 根拠文の「そのレッグは出さない」という **表明** と、実際に発注されるレッグの
  //   突き合わせ。OmissionClaimCheck[](server/llm/rationaleOmission.ts)をそのまま JSON 化する。
  //   lc_audit_json に相乗りしない理由: あちらは「AI が出したレッグ1本ごとの申告幅 vs 実出力」で、
  //   行が在る条件(entry と stopLoss が両方揃っている)も意味も違う。相乗りすると既存の集計が読む形が変わる。
  //   ★判定には使わない(落としも直しもしない)。まず頻度を測るためだけの列。
  //   既存DBへ後付けマイグレーション(NULL 可=この列を持たない版で記録された旧行 or 表明ゼロ)。
  if (!spCols.includes('omission_audit_json')) db.exec('ALTER TABLE signal_plans ADD COLUMN omission_audit_json TEXT');
  // v0.7.51: レンジ両面ストラドルを別枠集計するための mode タグ('range' / 'directional')。
  //   既存DBへ後付けマイグレーション(NULL は directional 扱い=後方互換)。
  const stCols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
  if (!stCols.includes('mode')) db.exec('ALTER TABLE signal_trades ADD COLUMN mode TEXT');
  // ★v0.8.2: A/B 2系統タグ。'A'(実売買・現行) / 'B'(紙専用の並走エンジン)。
  //   既存DBへ後付けマイグレーション(NULL は 'A' 扱い=後方互換・既存行は全て A)。
  if (!stCols.includes('system')) db.exec('ALTER TABLE signal_trades ADD COLUMN system TEXT');
  // ★検証(monitor2⇔trade2 突合)用: signal_id を1級列にして signals_<host>.db⇔forward_<host>.db を equijoin できるようにする。
  //   既存DBへ後付けマイグレーション(NULL 可=旧行/signalId 未采番の B 行)。RECORD-ONLY(決済ロジック不変)。
  if (!stCols.includes('signal_id')) db.exec('ALTER TABLE signal_trades ADD COLUMN signal_id INTEGER');
  // ★遡り解析用(RECORD-ONLY): ARM(武装)時刻と「ARM 時点で monitor が見ていた価格」。
  //   armed_t だけでは「武装時点でエントリー価格を通過済みだったか」を事後判定できない: 判定には武装時点の価格が
  //   必要だが、prices_*.db の ticks は collector が別プロセス・別位相(+AJAXキャッシュ)で記録しており monitor が
  //   実際に feed した価格列と一致しない(実測で誤検出多数)。よって ARM 時点の live 価格(新鮮値・stale/欠落は NULL)を
  //   同じ行に残す。既存DBへ後付けマイグレーション(NULL 可=旧行/価格が取れなかった行)。
  if (!stCols.includes('armed_t')) db.exec('ALTER TABLE signal_trades ADD COLUMN armed_t INTEGER');
  if (!stCols.includes('armed_price')) db.exec('ALTER TABLE signal_trades ADD COLUMN armed_price REAL');
  // ★決済パラメータ分析用(RECORD-ONLY): 実際の決済を後から再現するための3点。
  //   exit_reason       … どの経路で閉じたか(core/exitReasons.ts の表のキー)。従来は決済理由が一切残らず、
  //                       rationale はエントリー時の文言の使い回しだったため「初期LCで切られたのか床で利確したのか」
  //                       すら事後に判別できなかった。
  //   exit_initial_stop … **約定したレッグ** の初期LC(絶対価格)。meta.settings の LC は代表レッグ(指値優先)の
  //                       幅であり、2レッグのブラケットでは実際に約定したレッグと食い違う(監査で確認済み)。
  //   peak_profit       … 決済時点の含み益ピーク[pt](ラチェット床の決定に使っている値そのもの)。床の何段目が
  //                       効いたかが設定値から逆算でき、各エントリーの MFE も価格再生なしで分かる。
  //   既存DBへ後付けマイグレーション(NULL 可=旧行)。決済ロジックには一切関与しない。
  if (!stCols.includes('exit_reason')) db.exec('ALTER TABLE signal_trades ADD COLUMN exit_reason TEXT');
  if (!stCols.includes('exit_initial_stop')) db.exec('ALTER TABLE signal_trades ADD COLUMN exit_initial_stop REAL');
  if (!stCols.includes('peak_profit')) db.exec('ALTER TABLE signal_trades ADD COLUMN peak_profit REAL');
  // ★決済設定の「版」(RECORD-ONLY): この取引がどの決済設定で閉じられたかを後から特定するための2列。
  //   exit_cfg_version … 単調増加の整数版番号(初出順に 1,2,3…)。ハッシュだけでは順序が読めないため別に持つ。
  //   exit_cfg_hash    … 決済関数の振る舞い指紋(16桁hex)。**値そのものは記録しない**(記録は同期フォルダ
  //                      経由で機外に出るため。決済ラダーの実数値は非公開)。
  //   値が固定の今から記録を始める(今日から version=1)。後から始めると、それ以前の行が「版が不明」なのか
  //   「版1」なのか区別できなくなる。既存DBへ後付けマイグレーション(NULL 可=記録開始前の旧行)。
  if (!stCols.includes('exit_cfg_version')) db.exec('ALTER TABLE signal_trades ADD COLUMN exit_cfg_version INTEGER');
  if (!stCols.includes('exit_cfg_hash')) db.exec('ALTER TABLE signal_trades ADD COLUMN exit_cfg_hash TEXT');
  // ★武装したのに一度も約定せず armed-timeout で失効した回数(系統別・永続)。
  //   これが無いと「monitor は武装 → trade2 が拒否し続ける → 15分後に黙って失効」が完全に無音になる
  //   (実測 sid=361 は trade2 が147回拒否したが monitor 側にカウンタも警告も無かった)。
  const smCols = (db.prepare('PRAGMA table_info(signal_meta)').all() as Array<{ name: string }>).map(c => c.name);
  if (!smCols.includes('armed_timeouts')) db.exec('ALTER TABLE signal_meta ADD COLUMN armed_timeouts INTEGER NOT NULL DEFAULT 0');
  if (!smCols.includes('last_armed_timeout_at')) db.exec('ALTER TABLE signal_meta ADD COLUMN last_armed_timeout_at INTEGER');
  // ★連続未約定失効(streak): 約定のたびに 0 へ戻る。累計(armed_timeouts)とは **別列** に持つ:
  //   累計は「無音の失敗が何件あったか」という機体の生涯の健全性指標で、リセットしてはいけない。
  //   一方で待機表示に出したいのは「いま何回続けて空振りしているか」なので、混ぜずに両方を残す。
  if (!smCols.includes('armed_timeout_streak')) db.exec('ALTER TABLE signal_meta ADD COLUMN armed_timeout_streak INTEGER NOT NULL DEFAULT 0');
  // ★履歴消去(POST /api/signal-trades/clear)の監査行。ゲートも認証も無い削除口で、実データでは 5 回発火した
  //   痕跡が「signal_id が飛んでいる」という間接証拠でしか残っていなかった(誰が/いつ/何件は判定不能)。
  //   削除のたびに1行残し、後からエポック境界と孤児化件数を機械的に復元できるようにする。
  //   既存DB(この表が無い/列が欠けている)へは以下の冪等 ALTER で後付けする。
  const scCols = (db.prepare('PRAGMA table_info(signal_trades_clears)').all() as Array<{ name: string }>).map(c => c.name);
  if (scCols.length > 0) {
    if (!scCols.includes('system_requested')) db.exec('ALTER TABLE signal_trades_clears ADD COLUMN system_requested TEXT');
    if (!scCols.includes('system_effective')) db.exec('ALTER TABLE signal_trades_clears ADD COLUMN system_effective TEXT');
    if (!scCols.includes('deleted_trades')) db.exec('ALTER TABLE signal_trades_clears ADD COLUMN deleted_trades INTEGER');
    if (!scCols.includes('max_signal_id_before')) db.exec('ALTER TABLE signal_trades_clears ADD COLUMN max_signal_id_before INTEGER');
    if (!scCols.includes('orphan_exit_stops')) db.exec('ALTER TABLE signal_trades_clears ADD COLUMN orphan_exit_stops INTEGER');
  }
  const cols = (db.prepare('PRAGMA table_info(bars_1m)').all() as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('session_date')) db.exec('ALTER TABLE bars_1m ADD COLUMN session_date TEXT');
  if (!cols.includes('session')) db.exec('ALTER TABLE bars_1m ADD COLUMN session TEXT');
  if (!cols.includes('volume')) db.exec('ALTER TABLE bars_1m ADD COLUMN volume INTEGER');
  // v0.6.0: アラートに基準(reference)を記録。既存DBへ後付けマイグレーション。
  const aCols = (db.prepare('PRAGMA table_info(alerts)').all() as Array<{ name: string }>).map(c => c.name);
  if (!aCols.includes('reference_kind')) db.exec('ALTER TABLE alerts ADD COLUMN reference_kind TEXT');
  if (!aCols.includes('reference_price')) db.exec('ALTER TABLE alerts ADD COLUMN reference_price REAL');
  // v0.6.17: アラートの同一性に UNIQUE インデックスを張り、二重書き込み(collector×monitor の
  // ハートビート陳腐化窓・monitor 二重起動など)による完全一致重複を DB レベルで物理的に禁止する。
  // NULL-safe: SQLite は UNIQUE 索引で NULL を相異と見なす(NULL同士は衝突しない)ため、COALESCE で
  // 既定値に正規化して NULL の reference_price 等も正しく重複判定する。reference_* を含めるので
  // 「同時刻・同種別・別水準」の正当に異なるアラートは衝突せず保持される。
  // 既存DBに重複があると UNIQUE 索引を張れないため、先に id 最小を残して重複を除去(自己修復)。
  const ALERT_IDENTITY = `symbol, triggered_at, COALESCE(detection_kind,''), COALESCE(direction,''), `
    + `COALESCE(window_seconds,-1), COALESCE(reference_kind,''), COALESCE(reference_price,-1)`;
  // 索引が未作成のときだけ重複除去(初回マイグレーションのみ)。以後は UNIQUE 索引が重複を防ぐため、
  // 起動毎の全表スキャン DELETE は不要。
  const hasIdentityIdx = (db.prepare('PRAGMA index_list(alerts)').all() as Array<{ name: string }>)
    .some(i => i.name === 'idx_alerts_identity');
  if (!hasIdentityIdx) {
    db.exec(`DELETE FROM alerts WHERE id NOT IN (SELECT MIN(id) FROM alerts GROUP BY ${ALERT_IDENTITY})`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_identity ON alerts(${ALERT_IDENTITY})`);
  }
  // bars_1m の読み取りはすべて PRIMARY KEY(symbol, t) のレンジで賄える(getSessionOHLC は t 範囲を
  // 読んで JS 側でセッション集計、getRecentBars/getBarClose* も symbol+t)。session_date/session で
  // 絞る索引はもう不要なため作らない(旧 idx_bars_session は書き込み増だけで読みに使われていなかった)。
}

// 生 tick を保存しつつ、その分の 1分足 OHLC を upsert する。
export function recordTick(db: DatabaseSync, symbol: string, t: number, price: number, sessionDate: string, session: string): void {
  if (!Number.isFinite(price) || price <= 0) return;
  db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?, ?, ?)').run(symbol, t, price);
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      h = max(h, excluded.h), l = min(l, excluded.l), c = excluded.c
  `).run(symbol, sessionDate, session, minute, price, price, price, price);
}

export function getRecentBars(db: DatabaseSync, symbol: string, sinceT: number): Bar1m[] {
  return db.prepare(
    'SELECT symbol, session_date, session, t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Bar1m[];
}

/** 出来高(volume>0)のあるバーの h/l/volume。価格帯別出来高(ボリュームプロファイル)用。
 *  出来高はリアルタイムフィードに無く基礎データ(週次)由来のため、過去ぶんのみ返る。 */
export function getVolumeBars(db: DatabaseSync, symbol: string, sinceT: number): { h: number; l: number; volume: number }[] {
  return db.prepare(
    'SELECT h, l, volume FROM bars_1m WHERE symbol = ? AND t >= ? AND volume > 0 ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as { h: number; l: number; volume: number }[];
}

export function getRecentTicks(db: DatabaseSync, symbol: string, sinceT: number): Tick[] {
  return db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, sinceT) as unknown as Tick[];
}

export function getLatestTick(db: DatabaseSync, symbol: string): Tick | null {
  const row = db.prepare(
    'SELECT symbol, t, price FROM ticks WHERE symbol = ? ORDER BY t DESC LIMIT 1',
  ).get(symbol) as Tick | undefined;
  return row ?? null;
}

/** 基礎データ取り込み用。(symbol,t) で OHLCV を全上書き upsert（基礎=正）。削除はしない。 */
export function upsertBar(
  db: DatabaseSync, symbol: string, t: number,
  o: number, h: number, l: number, c: number, volume: number | null,
  sessionDate: string, session: string,
): void {
  const minute = Math.floor(t / 60_000) * 60_000;
  db.prepare(`
    INSERT INTO bars_1m (symbol, session_date, session, t, o, h, l, c, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(symbol, t) DO UPDATE SET
      o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c,
      volume = excluded.volume, session_date = excluded.session_date, session = excluded.session
  `).run(symbol, sessionDate, session, minute, o, h, l, c, volume);
}

// ─── 取引日15:45終値の永続化(daily_closes・v0.8.6) ───
// 取引日=日中(Day)セッション。その終値(=15:45クローズ・無ければ当該Dayセッションの最後に存在する bar)を
// session_date 単位で durable に保存する。基礎データ import で歴史分を埋め、ライブで確定日を追記する。
// 日足MA(MA5/20/50/75)/MA25バンドの終値系列はこの完全な系列を優先して使い、欠損日(15:45が無い日)も残さない。

export interface DailyCloseRow { symbol: string; session_date: string; close: number; t: number; }

/** 取引日終値を upsert(symbol+session_date で全上書き)。close=Dayセッション終値、t=その終値の時刻。 */
export function upsertDailyClose(db: DatabaseSync, symbol: string, sessionDate: string, close: number, t: number): void {
  if (!Number.isFinite(close) || close <= 0) return;
  db.prepare(`
    INSERT INTO daily_closes (symbol, session_date, close, t) VALUES (?, ?, ?, ?)
    ON CONFLICT(symbol, session_date) DO UPDATE SET close = excluded.close, t = excluded.t
  `).run(symbol, sessionDate, close, t);
}

/** 直近 limit 件の取引日終値を古い→新しい順で返す(MA/バンドの終値系列用)。 */
export function getDailyCloses(db: DatabaseSync, symbol: string, limit: number): DailyCloseRow[] {
  const rows = db.prepare(
    'SELECT symbol, session_date, close, t FROM daily_closes WHERE symbol = ? ORDER BY session_date DESC LIMIT ?',
  ).all(symbol, Math.max(1, Math.min(2000, limit))) as unknown as DailyCloseRow[];
  return rows.reverse();   // session_date DESC で直近 limit 件 → 反転して古い→新しい
}

/** cutoff(epoch ms) より古い ticks を削除 (bars_1m は残す)。 */
export function pruneTicks(db: DatabaseSync, cutoff: number): void {
  db.prepare('DELETE FROM ticks WHERE t < ?').run(cutoff);
}

/** meta(key/value) テーブルの読み書き。基礎データの取り込み版管理などに使う。 */
export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number; openT: number;   // openT = セッション最初のバー時刻(寄り欠け判定用)
}

export interface AlertRow {
  id: number; symbol: string; triggered_at: number; direction: string | null;
  detection_kind: string | null; window_seconds: number | null;
  change_percent: number | null; price: number | null;
  session_date: string | null; session: string | null;
  ret5: number | null; ret15: number | null; ret30: number | null;
  reference_kind: string | null; reference_price: number | null;
}
export interface AlertInsert {
  symbol: string; triggeredAt: number; direction: string; detectionKind: string;
  windowSeconds: number; changePercent: number; price: number;
  sessionDate: string | null; session: string | null;
  referenceKind?: string | null; referencePrice?: number | null;
}

export function insertAlert(db: DatabaseSync, a: AlertInsert): void {
  // INSERT OR IGNORE: alerts の同一性 UNIQUE インデックス(idx_alerts_identity)違反は黙って無視。
  // collector と monitor(あるいは monitor の二重起動)が同じ確定足アラートを書いても、DBレベルで
  // 完全一致重複が物理的に作られない(プロセス間レース・ハートビート陳腐化窓の最終防壁)。
  db.prepare(`
    INSERT OR IGNORE INTO alerts (symbol, triggered_at, direction, detection_kind, window_seconds,
      change_percent, price, session_date, session, reference_kind, reference_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(a.symbol, a.triggeredAt, a.direction, a.detectionKind, a.windowSeconds,
    a.changePercent, a.price, a.sessionDate, a.session,
    a.referenceKind ?? null, a.referencePrice ?? null);
}

/** 近接重複とみなす基準価格(reference_price)の許容差(円)。
 *
 *  ★この値は検知器側の「同じ水準」の定義(server/detect/registry.ts の LEVEL_MERGE_YEN)と同一でなければ
 *    ならない。理由:
 *    ①検知器は hlLevels を作るとき互いに ±LEVEL_MERGE_YEN 以内の水準を1本に畳む。したがって
 *      **1つの writer が同時に出す基準価格は必ず 40円より離れている**(= 40円以内の2件は同じ水準)。
 *    ②emit のクールダウンキーも `${direction}@${round(price/40)*40}`(zone/dailyband/dailyMa 共通)で、
 *      同一 writer は同じ 40円ゾーンを 20〜30分は再発火しない。よって ±40円で潰しても
 *      「検知器が別物として出した水準」を消すことは原理的に無い。
 *    ③一方 dailyband/dailyMa の基準価格は現値を終値系列に足して毎ティック再計算する(MA5 なら
 *      現値変動の 1/5 が直接乗る)ため、monitor と collector の数秒差でも数円〜十数円ずれる。
 *      完全一致にすると、この種別の「双子」だけ重複排除をすり抜ける。
 *  → 完全一致でもゾーン無しでもなく、検知器と同じ 40円ゾーンで判定する。
 *    server/db/insertAlertIfNew.test.ts が registry の LEVEL_MERGE_YEN との一致を検査する。 */
export const ALERT_DEDUP_PRICE_YEN = 40;

/** Insert an alert only if no row with the same symbol+direction+detection_kind+window_seconds
 *  **and the same reference level** exists within [triggeredAt - dedupWindowMs, triggeredAt +
 *  dedupWindowMs]. Cross-process near-duplicate guard (monitor + collector overlap).
 *
 *  ★reference_price を含めるのが要点。含めないと「60秒以内の別水準の同種同方向」(例: 64,200 の
 *    上抜けと 64,500 の上抜け)が重複扱いで消える = 重複排除ではなくデータ損失だった。
 *    collector の level 検知が 8秒周期になり本関数の呼び出しが 7.5倍になるため、キーの正しさが
 *    そのまま記録の正しさになる。
 *  ★NULL の扱い: 「両方 NULL」だけを同一とみなす(片方だけ NULL は別物)。基準価格を持つ種別と
 *    持たない種別は別経路なので、双子は必ず同じ NULL 性で来る。 */
export function insertAlertIfNew(db: DatabaseSync, a: AlertInsert, dedupWindowMs: number): boolean {
  const ref = a.referencePrice ?? null;
  const dup = db.prepare(`
    SELECT 1 FROM alerts
    WHERE symbol = ? AND direction = ? AND detection_kind = ?
      AND (window_seconds IS ? OR window_seconds = ?)
      AND triggered_at >= ? AND triggered_at <= ?
      AND ( (reference_price IS NULL AND ? IS NULL)
         OR (reference_price IS NOT NULL AND ? IS NOT NULL AND ABS(reference_price - ?) <= ?) )
    LIMIT 1
  `).get(
    a.symbol, a.direction, a.detectionKind,
    a.windowSeconds, a.windowSeconds,
    a.triggeredAt - dedupWindowMs, a.triggeredAt + dedupWindowMs,
    ref, ref, ref, ALERT_DEDUP_PRICE_YEN,
  );
  if (dup) return false;
  insertAlert(db, a);
  return true;
}

/** t 以下で最も新しい bar の close。無ければ null。 */
export function getBarCloseAt(db: DatabaseSync, symbol: string, t: number): number | null {
  const row = db.prepare('SELECT c FROM bars_1m WHERE symbol = ? AND t <= ? ORDER BY t DESC LIMIT 1')
    .get(symbol, t) as { c: number } | undefined;
  return row ? row.c : null;
}

/** target 付近([target - tolBeforeMs, target])で最も新しい bar の close。範囲内に無ければ null。
 *  followup の +N分リターン用。セッション切れ目/収集欠損で +N分の足が無い時、遠い古い足(最悪は発火足)へ
 *  フォールバックして見かけ上 0% になるのを防ぐ(=データ未確定として null=集計除外にする)。 */
export function getBarCloseNear(db: DatabaseSync, symbol: string, t: number, tolBeforeMs: number): number | null {
  const row = db.prepare('SELECT c FROM bars_1m WHERE symbol = ? AND t <= ? AND t >= ? ORDER BY t DESC LIMIT 1')
    .get(symbol, t, t - tolBeforeMs) as { c: number } | undefined;
  return row ? row.c : null;
}

/** ret30 が未確定で、発火から30分以上経過したアラート(事後値動きを埋める対象)。 */
export function getAlertsNeedingFollowup(db: DatabaseSync, now: number): AlertRow[] {
  return db.prepare('SELECT * FROM alerts WHERE ret30 IS NULL AND triggered_at + ? <= ? ORDER BY triggered_at ASC')
    .all(30 * 60_000, now) as unknown as AlertRow[];
}

export function updateAlertReturns(db: DatabaseSync, id: number,
  ret5: number | null, ret15: number | null, ret30: number | null): void {
  db.prepare('UPDATE alerts SET ret5 = ?, ret15 = ?, ret30 = ? WHERE id = ?').run(ret5, ret15, ret30, id);
}

export function getRecentAlerts(db: DatabaseSync, limit: number): AlertRow[] {
  return db.prepare('SELECT * FROM alerts ORDER BY triggered_at DESC LIMIT ?')
    .all(limit) as unknown as AlertRow[];
}

/** セッション(session_date+session)別の OHLC と H/L 発生時刻。新しい順(直近が先)、最大 limit 件。 */
export function getSessionOHLC(db: DatabaseSync, symbol: string, limit: number): SessionOHLC[] {
  // セッションは t の純関数(classifySession)。保存列 session_date は collector のバージョン差で
  // null/stale になり得るため信頼せず、読み取り時に t から都度分類して集計する(=自己修復)。
  // 読み取り範囲は「本数」でなくカレンダー日数で決める: 平日は1日2セッション(Day+Night)なので
  // limit セッションは概ね limit/2 平日 ≒ limit*0.7 日に収まる。余裕を持って (limit+α) 日ぶん読めば
  // 取りこぼし無くカバーでき、巨大 lookback でも読み込み行数が際限なく膨らまない(上限 200 日)。
  const DAY_MS = 86_400_000;
  const latest = (db.prepare('SELECT MAX(t) AS m FROM bars_1m WHERE symbol = ?').get(symbol) as { m: number | null }).m;
  if (latest == null) return [];
  const spanDays = Math.min(Math.ceil(limit * 0.8) + 5, 200);
  const rows = db.prepare(
    'SELECT t, o, h, l, c FROM bars_1m WHERE symbol = ? AND t >= ? ORDER BY t ASC',
  ).all(symbol, latest - spanDays * DAY_MS) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
  // rows は古→新: open/openT は最初、close は最後、high/low は最初の極値で確定
  const map = new Map<string, SessionOHLC>();
  for (const b of rows) {
    const s = classifySession(b.t);
    if (!s) continue;   // 場外/休場は集計しない
    const key = `${s.sessionDate}|${s.session}`;
    const cur = map.get(key);
    if (!cur) {
      map.set(key, {
        sessionDate: s.sessionDate, session: s.session,
        open: b.o, high: b.h, low: b.l, close: b.c, highT: b.t, lowT: b.t, openT: b.t,
      });
    } else {
      if (b.h > cur.high) { cur.high = b.h; cur.highT = b.t; }   // 最初に最高値を付けた足
      if (b.l < cur.low) { cur.low = b.l; cur.lowT = b.t; }      // 最初に最安値を付けた足
      cur.close = b.c;                                            // 最後の足の close
    }
  }
  return [...map.values()].sort((a, b) => b.openT - a.openT).slice(0, limit);
}

// ─── トレードシグナル(表示専用・紙トラッキング)の決済履歴 ───
// エントリーは AI(scalp-plan)、決済は非公開 phase-exit。実発注はせず SSE 現在値で擬似約定した
// 1トレード(entry→exit)を決済確定ごとに1行記録する。既存テーブルとは独立(trade2 非干渉)。

export interface SignalTradeRow {
  id: number;
  entry_t: number; entry_price: number; dir: string;
  exit_t: number; exit_price: number; pnl: number; qty: number;
  rationale: string | null; meta: string | null;
  mode: string | null;   // 'range' / 'directional'(NULL は directional 扱い=後方互換)
  system: string | null; // ★v0.8.2: 'A'(実売買) / 'B'(紙専用)。NULL は 'A' 扱い(後方互換)。
  signal_id: number | null; // ★検証用: そのトレードの ARM 采番(trade2 の signal_id と join)。NULL=旧行/未采番。
  armed_t: number | null;     // ★ARM(武装)時刻。entry_t − armed_t = ARM→約定の経過[ms]。NULL=旧行。
  armed_price: number | null; // ★ARM 時点で monitor が見ていた価格(新鮮値)。NULL=旧行/取れない・stale。
  exit_reason: string | null;       // ★決済理由(core/exitReasons.ts のキー)。NULL=旧行。
  exit_initial_stop: number | null; // ★約定レッグの初期LC(絶対価格)。NULL=旧行。
  peak_profit: number | null;       // ★決済時点の含み益ピーク[pt]。NULL=旧行。
  exit_cfg_version: number | null;  // ★決済設定の版番号(単調増加)。NULL=記録開始前の旧行。
  exit_cfg_hash: string | null;     // ★決済設定の振る舞い指紋(16桁hex・値は含まない)。NULL=旧行。
}

export interface SignalTradeInsert {
  entryT: number; entryPrice: number; dir: 'buy' | 'sell';
  exitT: number; exitPrice: number; pnl: number; qty: number;
  rationale?: string | null; meta?: string | null;
  mode?: string | null;   // レンジ由来='range' / 単方向='directional'。未指定は NULL(=directional)。
  system?: 'A' | 'B' | null;   // ★v0.8.2: 系統タグ。A は NULL(=既存挙動と同一) / B は 'B'。
  signalId?: number | null;    // ★検証用: ARM 采番。trade2 側の signal_id と equijoin する結合キー。未指定は NULL。
  armedT?: number | null;      // ★ARM(武装)時刻。未指定は NULL(=旧行と同じ)。
  armedPrice?: number | null;  // ★ARM 時点で monitor が見ていた価格。取れない/stale は NULL。
  exitReason?: string | null;       // ★決済理由(core/exitReasons.ts のキー)。未指定は NULL。
  exitInitialStop?: number | null;  // ★約定レッグの初期LC(絶対価格)。未指定/非有限は NULL。
  peakProfit?: number | null;       // ★決済時点の含み益ピーク[pt]。未指定/非有限は NULL。
  exitCfgVersion?: number | null;   // ★決済設定の版番号。未指定は NULL(=既存挙動と byte 一致)。
  exitCfgHash?: string | null;      // ★決済設定の振る舞い指紋。未指定は NULL。
}

// ★v0.8.2: 系統フィルタ。'A' は NULL 行も含む(既存/A の行)。'B' は 'B' 行のみ。未指定は全件。
export type SignalSystemFilter = 'A' | 'B';
function systemWhere(system: SignalSystemFilter | undefined): { clause: string; params: string[] } {
  if (system === 'B') return { clause: ' WHERE system = ?', params: ['B'] };
  if (system === 'A') return { clause: " WHERE (system = ? OR system IS NULL)", params: ['A'] };
  return { clause: '', params: [] };
}

export function insertSignalTrade(db: DatabaseSync, t: SignalTradeInsert): void {
  db.prepare(`
    INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty, rationale, meta, mode, system, signal_id, armed_t, armed_price, exit_reason, exit_initial_stop, peak_profit, exit_cfg_version, exit_cfg_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.entryT, t.entryPrice, t.dir, t.exitT, t.exitPrice, t.pnl, t.qty,
    t.rationale ?? null, t.meta ?? null, t.mode ?? null, t.system ?? null, t.signalId ?? null,
    t.armedT ?? null, t.armedPrice ?? null,
    t.exitReason ?? null, t.exitInitialStop ?? null, t.peakProfit ?? null,
    t.exitCfgVersion ?? null, t.exitCfgHash ?? null);
}

/** 決済済みトレードを新しい順(直近が先)で最大 limit 件返す。
 *  ★v0.8.2: system で系統を絞れる('A'=NULL含む / 'B'=Bのみ / 未指定=全件)。 */
export function getSignalTrades(db: DatabaseSync, limit = 500, system?: SignalSystemFilter): SignalTradeRow[] {
  const w = systemWhere(system);
  return db.prepare(`SELECT * FROM signal_trades${w.clause} ORDER BY exit_t DESC LIMIT ?`)
    .all(...w.params, Math.max(1, Math.min(2000, limit))) as unknown as SignalTradeRow[];
}

/** 履歴消去の結果(監査行に書く値と同じ)。 */
export interface ClearSignalTradesResult {
  deleted: number;              // 実際に削除された signal_trades の行数(DELETE の changes)。
  orphanExitStops: number;      // この削除で signal_trades 側の裏付けを失った signal_exit_stops の行数。
  maxSignalIdBefore: number | null;  // 削除直前の、削除対象内の最大 signal_id(=このエポックの終端)。null=対象に採番済み行なし。
}

/** 「裏付けのある」exit-stop 行数 = signal_id が非 NULL で、同じ signal_id の signal_trades 行が存在するもの。
 *  DELETE は裏付けを増やせないため、前後の差がそのまま「この削除で孤児化した件数」になる。
 *  ★A に限定する: signal_exit_stops へ書くのは A(hold を露出する側)だけで、A と B の signalId は
 *    **別々のカウンタ**(signal_meta の system キー)なので数列が重なる。B にも采番するようになった今、
 *    系統を絞らないと「A の孤児が、たまたま同じ番号の B のトレードに裏付けられている」と誤判定する。 */
function backedExitStopCount(db: DatabaseSync): number {
  return (db.prepare(
    'SELECT COUNT(*) AS n FROM signal_exit_stops es WHERE es.signal_id IS NOT NULL '
    + 'AND EXISTS (SELECT 1 FROM signal_trades t WHERE t.signal_id = es.signal_id '
    + "AND (t.system IS NULL OR t.system = 'A'))",
  ).get() as { n: number }).n;
}

/** 指定系統(未指定=全件)のトレードを削除し、削除件数+孤児化件数+削除前の最大 signalId を返す。監査行を1行残す。
 *  ★signalId カウンタには一切触れない: 番号は機体の生涯で単調増加(下の resetArmedTimeoutCounter の注記を参照)。
 *  ★signal_exit_stops は消さない(従来どおり)。消えないまま裏付けを失うので、その件数を数えて返す/記録する。 */
export function clearSignalTradesAudited(
  db: DatabaseSync,
  opts: { system?: SignalSystemFilter; systemRequested?: string | null; t?: number } = {},
): ClearSignalTradesResult {
  const { system, systemRequested = null, t = Date.now() } = opts;
  const w = systemWhere(system);
  // 削除と監査行を1トランザクションに包む(=監査の残らない削除を物理的に起こさない)。
  // 既にトランザクション中(呼び出し側が張っている)なら BEGIN は失敗するので、その場合は包まずに続ける。
  let owns = false;
  try { db.exec('BEGIN IMMEDIATE'); owns = true; } catch { /* 既存トランザクションに相乗り */ }
  try {
    const maxBefore = (db.prepare(`SELECT MAX(signal_id) AS m FROM signal_trades${w.clause}`).get(...w.params) as { m: number | null }).m ?? null;
    // ★削除の前に、永続カウンタを「今の床」まで引き上げる(ラチェット)。床は永続値と既存記録の MAX の大きい方だが、
    //   その記録をこれから消すので、消す前に永続へ焼き付けないと床が一緒に消える。実データ(signals_kabu.db)は
    //   last_signal_id=0 で signal_id が 518 まで進んでおり、この一手が無いと全消去後の起動が 1 から採番し直した。
    for (const sys of (system ? [system] : ['A', 'B'] as const)) {
      setSignalIdCounter(db, sys, getSignalIdSeed(db, sys));
    }
    const backedBefore = backedExitStopCount(db);
    // 削除件数は DELETE の実 changes を使う(事前 COUNT の推定値を書かない)。
    const deleted = Number(db.prepare(`DELETE FROM signal_trades${w.clause}`).run(...w.params).changes);
    const orphanExitStops = backedBefore - backedExitStopCount(db);
    // ★未約定失効カウンタだけは従来どおり履歴に追随して 0 化(履歴と件数を食い違わせない)。signalId は据え置き。
    resetArmedTimeoutCounter(db, system);
    db.prepare(
      'INSERT INTO signal_trades_clears (t, system_requested, system_effective, deleted_trades, max_signal_id_before, orphan_exit_stops) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
    ).run(t, systemRequested, system ?? 'ALL', deleted, maxBefore, orphanExitStops);
    if (owns) db.exec('COMMIT');
    return { deleted, orphanExitStops, maxSignalIdBefore: maxBefore };
  } catch (e) {
    if (owns) { try { db.exec('ROLLBACK'); } catch { /* 既に巻き戻っている */ } }
    throw e;
  }
}

/** 指定系統(未指定=全件)のトレードを削除し、削除件数を返す(既存呼び出し互換の薄いラッパ)。
 *  監査行はこの経路でも必ず残る(消去の入口を1本に絞るため)。 */
export function clearSignalTrades(db: DatabaseSync, system?: SignalSystemFilter): number {
  return clearSignalTradesAudited(db, { system }).deleted;
}

/** 履歴消去の監査行を新しい順で返す(分析/自己診断用)。 */
export interface SignalTradesClearRow {
  id: number; t: number;
  system_requested: string | null; system_effective: string;
  deleted_trades: number; max_signal_id_before: number | null; orphan_exit_stops: number;
}
export function getSignalTradesClears(db: DatabaseSync, limit = 200): SignalTradesClearRow[] {
  return db.prepare('SELECT * FROM signal_trades_clears ORDER BY t DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(2000, limit))) as unknown as SignalTradesClearRow[];
}

// ─── トレードシグナルの signalId 永続カウンタ(検証の結合キーを再起動で安定化) ───
// signalId は ARM ごとに単調増加で採番する結合キー(monitor⇔trade2)。従来は in-memory のみで
// プロセス再起動ごとに 1 へ戻り、trade2 が追従する signalId と乖離していた。これを DB に永続し、
// 起動時にシード(=再起動を跨いで継続)する。★0 へ戻す経路は持たない(履歴消去でも戻さない)=機体の生涯で単調増加。
// last_signal_id は「最後に採番した signalId」= 次の採番は +1(未設定なら 0 → 次は 1)。

/** 指定系統の最後に採番した signalId を返す(未設定は 0)。起動時のシードに使う。 */
export function getSignalIdCounter(db: DatabaseSync, system: SignalSystemFilter): number {
  const row = db.prepare('SELECT last_signal_id FROM signal_meta WHERE system = ?').get(system) as { last_signal_id: number } | undefined;
  return row?.last_signal_id ?? 0;
}

/** 指定系統の最後に採番した signalId を永続する(ARM で採番するたびに更新)。 */
export function setSignalIdCounter(db: DatabaseSync, system: SignalSystemFilter, value: number): void {
  db.prepare('INSERT INTO signal_meta(system, last_signal_id) VALUES(?, ?) ON CONFLICT(system) DO UPDATE SET last_signal_id = excluded.last_signal_id')
    .run(system, value);
}

// ★系統ごとの「番号空間」の起点。B を 1,000,000 から始めて A(現在 536 付近)と **絶対に重ならない** ようにする。
//   理由: system を落とした join が **誤った行に当たり、しかも当たったように見える** から。空間を分けてあれば
//   同じ間違いは「1件も当たらない」で済み、その場で気づける(重なっていると静かに嘘の集計が出る)。
//   実際、このリポにも system を見ない突合が1つ在った(backedExitStopCount)。人間の約束ではなく番号で分ける。
export const SIGNAL_ID_SPACE_BASE: Readonly<Record<SignalSystemFilter, number>> = { A: 0, B: 1_000_000 };

/** 起動時に採番カウンタへ入れる値 = max(既存記録の床, その系統の番号空間の起点)。
 *  ★既に採番済みの番号があればそこから連続させる(下駄で巻き戻さない=単調増加の原則)。 */
export function getSignalIdStart(db: DatabaseSync, system: SignalSystemFilter): number {
  return Math.max(getSignalIdSeed(db, system), SIGNAL_ID_SPACE_BASE[system]);
}

/** 起動シードに使う「二度と下回ってはいけない signalId」= max(永続カウンタ, 既存記録の最大 signal_id)。
 *  永続値(signal_meta.last_signal_id)だけに頼ると、永続に失敗した/値が壊れた/古いDBを持ち込んだ場合に
 *  既存の記録より小さい番号を再発番してしまい、signal_id が結合キーとして使えなくなる(実データで発生済み)。
 *  ★signal_exit_stops は system 列を持たない。signalId を書くのは A(hold を露出する側)だけなので、
 *    A のときだけこの表の MAX も床に入れる(B に入れると B の採番が A の水準まで無意味に飛ぶ)。 */
export function getSignalIdSeed(db: DatabaseSync, system: SignalSystemFilter): number {
  const persisted = getSignalIdCounter(db, system);
  const w = systemWhere(system);
  const maxTrade = (db.prepare(`SELECT MAX(signal_id) AS m FROM signal_trades${w.clause}`).get(...w.params) as { m: number | null }).m ?? 0;
  const maxStop = system === 'A'
    ? ((db.prepare('SELECT MAX(signal_id) AS m FROM signal_exit_stops').get() as { m: number | null }).m ?? 0)
    : 0;
  return Math.max(persisted, maxTrade, maxStop);
}

/** 未約定失効(armed-timeout)カウンタを 0 へ戻す(履歴消去時のみ)。未指定=全系統。
 *  ★signalId カウンタ(last_signal_id)には触れない。番号は機体の生涯で単調増加とし、履歴消去でも巻き戻さない:
 *    巻き戻すと signal_id が再利用され、signal_exit_stops / trade2 側の記録と equijoin できなくなる
 *    (実データでは 5 回の巻き戻しで signal_id=1 が 5 建玉・両方向に存在する状態になった)。 */
export function resetArmedTimeoutCounter(db: DatabaseSync, system?: SignalSystemFilter): void {
  if (system) {
    db.prepare('UPDATE signal_meta SET armed_timeouts = 0, armed_timeout_streak = 0, last_armed_timeout_at = NULL WHERE system = ?').run(system);
  } else {
    db.exec('UPDATE signal_meta SET armed_timeouts = 0, armed_timeout_streak = 0, last_armed_timeout_at = NULL');
  }
}

// ─── 未約定失効(armed-timeout)カウンタ ───────────────────────────────
// 「武装したが一度も約定せず ARMED_TIMEOUT_MS で失効した」回数。monitor が正規シグナルを出したのに
// trade2 が受け取ってから拒否し続ける(=乖離)と、その終着点が必ずここになる。実測 sid=361(2026-07-30)は
// trade2 が6秒おきに147回拒否したのに monitor 側の記録は1行ログのみ・件数はどこにも残らなかった。
// 系統別(A=実売買 / B=紙専用)に永続し、履歴消去でのみ 0 に戻る。

/** count=累計(生涯・約定でも減らない) / streak=連続(約定のたびに 0 へ戻る)。両方を永続する。 */
export interface ArmedTimeoutStats { count: number; streak: number; lastAt: number | null }

/** 指定系統の未約定失効の累計/連続と最終発生時刻(未発生は {0, 0, null})。 */
export function getArmedTimeoutStats(db: DatabaseSync, system: SignalSystemFilter): ArmedTimeoutStats {
  const row = db.prepare('SELECT armed_timeouts, armed_timeout_streak, last_armed_timeout_at FROM signal_meta WHERE system = ?').get(system) as
    { armed_timeouts: number | null; armed_timeout_streak: number | null; last_armed_timeout_at: number | null } | undefined;
  return { count: row?.armed_timeouts ?? 0, streak: row?.armed_timeout_streak ?? 0, lastAt: row?.last_armed_timeout_at ?? null };
}

/** 未約定失効を1件加算し(累計+連続の両方)、発生時刻を記録する。加算後の値を返す。 */
export function bumpArmedTimeout(db: DatabaseSync, system: SignalSystemFilter, at: number): ArmedTimeoutStats {
  db.prepare(
    'INSERT INTO signal_meta(system, last_signal_id, armed_timeouts, armed_timeout_streak, last_armed_timeout_at) VALUES(?, 0, 1, 1, ?) '
    + 'ON CONFLICT(system) DO UPDATE SET armed_timeouts = signal_meta.armed_timeouts + 1, '
    + 'armed_timeout_streak = signal_meta.armed_timeout_streak + 1, last_armed_timeout_at = excluded.last_armed_timeout_at',
  ).run(system, at);
  return getArmedTimeoutStats(db, system);
}

/** ★約定したら連続失効(streak)だけを 0 へ戻す。累計(armed_timeouts)と最終発生時刻は触らない
 *  (累計は生涯の健全性指標・lastAt は「最後に空振りしたのはいつか」なので約定で消してはいけない)。 */
export function resetArmedTimeoutStreak(db: DatabaseSync, system: SignalSystemFilter): ArmedTimeoutStats {
  db.prepare(
    'INSERT INTO signal_meta(system, last_signal_id, armed_timeouts, armed_timeout_streak) VALUES(?, 0, 0, 0) '
    + 'ON CONFLICT(system) DO UPDATE SET armed_timeout_streak = 0',
  ).run(system);
  return getArmedTimeoutStats(db, system);
}

// ─── トレードシグナルの決済逆指値(exit-stop)遷移履歴(検証用・RECORD-ONLY) ───
// 紙建玉の hold.exitStop が「変化するたび」に1行記録する時系列(毎tickではなく変化時のみ=dedupe)。
// monitor2 のこの系列と trade2 の exit_stop_history を突き合わせ、決済逆指値ラダーの乖離・決済時刻ずれ・
// 片レッグ約定を検証できる。opened_at(建値時刻)+ direction は signalId 欠落時の二次結合キー。
// 決済ロジック/SSE/紙トレード結果には一切影響しない(追加の DB 書込のみ)。

export interface SignalExitStopRow {
  id: number;
  t: number; signal_id: number | null; opened_at: number;
  direction: string; exit_stop: number; phase: string | null;
}

export interface SignalExitStopInsert {
  t: number;               // 記録時刻(壁時計・= tick の now)。
  signalId?: number | null; // ARM 采番(trade2 の signal_id と join)。A のみ非 NULL。
  openedAt: number;        // 建値約定時刻(= hold.at)。二次結合キー。
  direction: 'buy' | 'sell';
  exitStop: number;        // その時点の決済逆指値(絶対価格)。
  phase?: string | null;   // どの決済ルールか(在れば・'range' 等)。無ければ NULL。
}

/** exit-stop 遷移を1行記録する。dedupe(変化時のみ)は呼び出し側(engine)が担う。 */
export function insertSignalExitStop(db: DatabaseSync, e: SignalExitStopInsert): void {
  db.prepare(`
    INSERT INTO signal_exit_stops (t, signal_id, opened_at, direction, exit_stop, phase)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(e.t, e.signalId ?? null, e.openedAt, e.direction, e.exitStop, e.phase ?? null);
}

// ─── 計画サイクルの台帳(signal_plans・RECORD-ONLY) ───────────────────────────
// 1計画サイクル=1行。ARM(約定に向けて武装)・見送り(none)・計画が得られなかった回 のすべてを残す。
// 取引の判断には一切使わない(書き込みに失敗しても engine は握りつぶして続行する)。

export interface SignalPlanRow {
  id: number;
  t: number; system: string; signal_id: number | null;
  direction: string | null; none_reason: string | null; veto_fired: number | null;
  ref_price: number | null; regime: string | null; confidence: number | null;
  limit_entry: number | null; stop_entry: number | null;
  stop_loss_for_limit: number | null; stop_loss_for_stop: number | null;
  leg_drops_json: string | null; settings_json: string | null;
  rationale: string | null; error: string | null;
  arm_wait_ms: number | null; arm_wait_distance: number | null;
  arm_wait_sigma: number | null; arm_wait_reason: string | null;
  /** 文脈を組み立てた時刻(epoch ms)。t(記録時刻)とは別物。旧行/文脈を組む前に見送った回は NULL。 */
  context_at: number | null;
  /** 送った system+user プロンプトの一方向指紋(`sp1:<16桁hex>`)。★本文は入らない。 */
  prompt_fp: string | null;
  /** 根拠文の申告 LC幅 と 実出力の突き合わせ(LcDeclarationCheck[] の JSON)。旧行/観測ゼロは NULL。 */
  lc_audit_json: string | null;
  /** 根拠文の「出さない」表明 と 実際に発注されるレッグの突き合わせ(OmissionClaimCheck[] の JSON)。
   *  旧行/表明ゼロは NULL。 */
  omission_audit_json: string | null;
}

export interface SignalPlanInsert {
  t: number;
  system: 'A' | 'B';
  signalId?: number | null;
  direction?: string | null;
  noneReason?: string | null;
  vetoFired?: boolean | null;
  refPrice?: number | null;
  regime?: string | null;
  confidence?: number | null;
  limitEntry?: number | null;
  stopEntry?: number | null;
  stopLossForLimit?: number | null;
  stopLossForStop?: number | null;
  legDropsJson?: string | null;
  settingsJson?: string | null;
  rationale?: string | null;
  error?: string | null;
  // ★ARM した回の待ち時間の決定内訳(RECORD-ONLY)。ARM しなかった回は全て null。
  armWaitMs?: number | null;
  armWaitDistance?: number | null;
  armWaitSigma?: number | null;
  armWaitReason?: string | null;
  // ★凍結再生の突合(RECORD-ONLY)。無ければ NULL(値が無いことを捏造しない)。
  /** 文脈を組み立てた時刻(epoch ms)= buildRichScalpContextResult に渡した now。 */
  contextAt?: number | null;
  /** 送った system+user プロンプトの一方向指紋。★本文は絶対に入れない。 */
  promptFp?: string | null;
  /** ★RECORD-ONLY: 申告 LC幅と実出力の突き合わせ(LcDeclarationCheck[] の JSON)。1件も無ければ未指定=NULL。 */
  lcAuditJson?: string | null;
  /** ★RECORD-ONLY: 「出さない」表明と実際に発注されるレッグの突き合わせ(OmissionClaimCheck[] の JSON)。
   *  1件も表明が読めなければ未指定=NULL。 */
  omissionAuditJson?: string | null;
}

/** 非有限(NaN/Infinity)は NULL にする(壊れた数値を列に入れて後の集計を汚さない)。 */
function finiteOrNull(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** 計画サイクルを1行記録する(追記のみ・更新も削除もしない)。 */
export function insertSignalPlan(db: DatabaseSync, p: SignalPlanInsert): void {
  db.prepare(`
    INSERT INTO signal_plans (
      t, system, signal_id, direction, none_reason, veto_fired, ref_price, regime, confidence,
      limit_entry, stop_entry, stop_loss_for_limit, stop_loss_for_stop,
      leg_drops_json, settings_json, rationale, error,
      arm_wait_ms, arm_wait_distance, arm_wait_sigma, arm_wait_reason,
      context_at, prompt_fp, lc_audit_json, omission_audit_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.t, p.system, p.signalId ?? null, p.direction ?? null, p.noneReason ?? null,
    p.vetoFired == null ? null : (p.vetoFired ? 1 : 0),
    finiteOrNull(p.refPrice), p.regime ?? null, finiteOrNull(p.confidence),
    finiteOrNull(p.limitEntry), finiteOrNull(p.stopEntry),
    finiteOrNull(p.stopLossForLimit), finiteOrNull(p.stopLossForStop),
    p.legDropsJson ?? null, p.settingsJson ?? null, p.rationale ?? null, p.error ?? null,
    finiteOrNull(p.armWaitMs), finiteOrNull(p.armWaitDistance), finiteOrNull(p.armWaitSigma),
    p.armWaitReason ?? null,
    finiteOrNull(p.contextAt), p.promptFp ?? null, p.lcAuditJson ?? null,
    p.omissionAuditJson ?? null,
  );
}

/** 計画サイクルを新しい順(直近が先)で最大 limit 件返す(分析/テスト用)。system で系統を絞れる。 */
export function getSignalPlans(db: DatabaseSync, limit = 500, system?: SignalSystemFilter): SignalPlanRow[] {
  const clause = system ? ' WHERE system = ?' : '';
  const params = system ? [system] : [];
  return db.prepare(`SELECT * FROM signal_plans${clause} ORDER BY t DESC, id DESC LIMIT ?`)
    .all(...params, Math.max(1, Math.min(5000, limit))) as unknown as SignalPlanRow[];
}

/** exit-stop 遷移を新しい順(直近が先)で最大 limit 件返す(分析/テスト用)。 */
export function getSignalExitStops(db: DatabaseSync, limit = 1000): SignalExitStopRow[] {
  return db.prepare('SELECT * FROM signal_exit_stops ORDER BY t DESC LIMIT ?')
    .all(Math.max(1, Math.min(5000, limit))) as unknown as SignalExitStopRow[];
}
