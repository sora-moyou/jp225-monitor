// 収集デーモン(collector)の **死活監視**(表示・書き出し専用・RECORD-ONLY)。
//
// ■ 実運用で起きたこと(実測で確定)
//     collector_heartbeat  10:13:44 で凍結   ← collector のプロセスが停止
//     ticks の最新         10:13:44          ← ティック保管が止まった
//     台帳の毎時書き出し   10:20:33 の回が一度も走っていない
//   そして **誰も気づかなかった**。monitor 本体は正常に動き続け、画面にも書き出しにも何も出なかった。
//   collector は Rust がデタッチ起動するので、アプリを次に起動するまで誰も再起動しない。
//   いま1年がかりで決済パラメータ検証用のティックを溜めている最中で、
//   「黙って死ぬ」= データが虫食いになり、それに **1年後に気づく**。
//
// ■ ★循環を断つ = 「生きている側」が書く
//   従来の状態記録(tick_archive / ledger_export)は **collector 自身が書いていた**。
//   collector が死ぬと状態も死に、「最後に生きていた時の状態」が現在の状態として残り続ける。
//   今回の誤診断の直接原因がこれ。だからこの判定は **monitor プロセスが書く**。
//   ・meta キー(collector_watch / collector_watch_status)は collector が **一度も書かない** キー。
//     = 単一書き手の前提を壊さない(新しい書き手が既存のキーを奪わない)。
//   ・書き出しフォルダの状態ファイルも monitor が書く(collector 経由に依存しない)。
//
// ■ ★「取引時間外だから止まっている」と「死んでいる」を取り違えない
//   collector の while ループは `writeHeartbeat(db, start)` を **inPollWindow の判定より前** で
//   毎周回まわす(collector/index.ts)。つまり心拍は取引時間外でも打たれ続け、周期が
//   2秒(場中)→30秒(場外)に変わるだけ。
//   → **心拍の凍結は時間帯では説明できない = プロセス停止の確実な証拠**。
//   セッションは「死んでいるか」の判定には一切使わず、**生きている場合の言い方**
//   (収集中 ok / 待機中 idle)を分けるためだけに使う。
//   ★逆に「ティックが増えていない」「書き出しが走っていない」は時間外でも正常に起こるので、
//     **死亡(dead)** 判定の材料には **しない**。
//
// ■ ★「生きているが仕事をしていない」(stuck)を、時間外と取り違えずに検知する
//   心拍だけを見る設計には穴がある: 心拍は while ループの先頭で無条件に打たれるので、
//   **ポーリング本体が例外を出し続けていても心拍は正常に見える**
//   (collector/index.ts の poll は catch して周回を続ける = プロセスは生きたまま何も記録しない)。
//   これは現実に起こりやすい部分故障で、しかも3機構(心拍・pid・書き出し)全部の網を抜ける。
//   ★かといって「ティックが増えていない」を単独の根拠にはできない。時間外・週末・休場日には
//     正常に増えないからで、そこを取り違えると警告が信用を失う。
//   → **2つの独立した事実の食い違い** だけを根拠にする:
//       ① 収集デーモンのティック(共有DB `ticks`。**書き手は collector だけ**)が伸びていない
//       ② それなのに **monitor 自身の価格フィード**(別プロセス・同じ公開HTTP)は新鮮
//     ②が新鮮ということは市場が動いている(=時間外でも休場でもフィード障害でもない)。
//     それでも①が伸びないなら、原因は収集デーモン側にしか無い。
//   ★②が新鮮でないときは **判定しない**(ok のまま理由に書く)。休場日・フィード障害を
//     収集デーモンのせいにしない。取引時間の判定(inPollWindow)は休場日を既に除外しているが、
//     それでも「市場が動いている証拠」を別経路で1つ持つ = 時間帯の判定に頼り切らない。
//   ★窓が開いた直後は判定しない: 直前のセッションの最後のティックは当然古いので、
//     `inPollWindow(now - 猶予)` も真であること(= 窓が猶予ぶん開き続けている)を条件にする。
//
// ■ 閾値
//   場外の心拍間隔が 30 秒。1周回の中には毎時の台帳スナップショット(VACUUM INTO)など
//   数秒かかる仕事が混ざるので、余裕を **6周期(180秒)** 取る。死は永続的な状態なので
//   検出が3分遅れても失うものは無いが、誤検知は「警告が読まれなくなる」形で必ず害になる。
//   ★アラートの単一書き手調停に使う `isCollectorAlive`(45秒)とは **別の閾値**。
//     あちらを表示の都合で動かすと記録の挙動が変わるので、絶対に共有しない。

import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { classifySession, inPollWindow } from '../core/session.js';
import { getMeta, setMeta, openDb, resolveDbPath, getLatestTick } from './db/store.js';
import { getPrices } from './cache.js';
import { jstStamp, fmtDur } from './db/tickArchiveHeartbeat.js';
import { hostLabel } from './db/ledgerExport.js';
import { resolveTickExportDir } from './db/tickArchive.js';
import { readHeartbeatAt, HEARTBEAT_IDLE_MS, HEARTBEAT_POLL_MS } from './collectorHeartbeat.js';
import { pidLockPath, readPidFile, isAlive } from './pidLock.js';
import { readSpawnLogTail, resolveSpawnLogPath, appendSpawnLog } from './spawnLog.js';
import { resolveVariant } from './variant.js';
import { resolveAppDataDir } from './appDataDir.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本(既存の状態記録と同じ作法)。
 *  ★どちらも **monitor だけ** が書く(collector は触らない)。 */
export const COLLECTOR_WATCH_KEY = 'collector_watch';
export const COLLECTOR_WATCH_STATUS_KEY = 'collector_watch_status';

/** collector の pid ファイル名。
 *  ★collector/lock.ts と同じ文字列。server → collector の import は依存の向きが逆なので張らず、
 *    代わりに **テストで2つが一致していることを固定** する(server/collectorWatch.test.ts)。 */
export const COLLECTOR_PID_FILE = 'collector.pid';

/** 心拍が途絶えたと判定するまでの猶予。場外周期(30秒)の6倍。 */
export const COLLECTOR_DEAD_MS = 6 * HEARTBEAT_IDLE_MS;
/** 監視の周期(monitor 側)。 */
export const COLLECTOR_WATCH_MS = 30_000;
/** 読み手が「監視そのものが止まった(monitor 停止)」と判定する猶予(= 3周期)。 */
export const COLLECTOR_WATCH_FRESH_MS = 3 * COLLECTOR_WATCH_MS;
/** 状態ファイルを最低でもこの間隔では書き直す(状態が変わらなくても「いつ時点の判定か」を新しくする)。 */
export const COLLECTOR_STATUS_FILE_MS = 5 * 60_000;

/** ★「生きているが仕事をしていない」と判定するまでの、ティックが伸びない時間。
 *  場中のティックは2秒間隔で入る。フィードの一時的な取得失敗(バックオフ)や AJAX の間引きで
 *  数十秒空くことはあるので、桁で余裕を取る。誤検知は「警告が読まれなくなる」形で必ず害になる。 */
export const COLLECTOR_STUCK_MS = 5 * 60_000;

/** ★monitor 自身のフィードを「新鮮=市場が動いている証拠」と認めるまでの猶予。
 *  monitor の priceLoop は場中 2 秒間隔、全滅時はバックオフする。これを越えて古ければ
 *  「市場が動いている」とは言えない = 収集デーモンの異常だと **言い切らない**。 */
export const MONITOR_FEED_FRESH_MS = 3 * 60_000;

/** ★仕事の有無を測る銘柄。収集デーモンが必ず記録する主銘柄(長期保管もこれ)。 */
export const COLLECTOR_WORK_SYMBOL = 'NIY=F';

export type CollectorWatchState =
  /** 心拍が新しく、取引時間内(= 収集しているはず)。 */
  | 'ok'
  /** 心拍が新しく、取引時間外(= 収集しないのが正常)。★生きている。 */
  | 'idle'
  /** ★心拍は新しい(プロセスは生きている)のに、ティックが伸びていない。
   *  かつ monitor 自身のフィードは新鮮 = 市場は動いている。→ 収集デーモン側の部分故障。 */
  | 'stuck'
  /** ★心拍が途絶えた = プロセスが停止している。 */
  | 'dead'
  /** 心拍が一度も無い(この PC でまだ collector が動いたことがない/DB が新しい)。 */
  | 'missing';

/** pid ファイルから読める事実。「心拍が無い」だけでなく「プロセスが居ない」も併せて見る。 */
export interface CollectorPidInfo {
  file: string;
  /** pid ファイルの中身(無ければ null)。 */
  pid: number | null;
  /** その pid が実在するか(kill(pid,0))。pid が無ければ false。 */
  alive: boolean;
}

/** ★「仕事をしているか」を測る材料。**どちらも monitor(生きている側)が測る**。 */
export interface CollectorWorkInfo {
  /** 測った銘柄。 */
  symbol: string;
  /** 収集デーモンが最後に書いたティックの時刻。共有DB `ticks` の書き手は collector だけなので、
   *  これは **収集デーモンの出力そのもの**(monitor は ticks を1行も書かない)。 */
  lastTickAt: number | null;
  /** ★monitor 自身の価格フィードが最後に新鮮だった時刻(= 市場が動いている独立した証拠)。 */
  feedAt: number | null;
}

export const NO_WORK_INFO: CollectorWorkInfo = {
  symbol: COLLECTOR_WORK_SYMBOL, lastTickAt: null, feedAt: null,
};

export interface CollectorWatch {
  v: 1;
  /** この判定を書いた時刻。★読み手はこれの古さで **監視側(monitor)の停止** を検出する。 */
  at: number;
  atJst: string;
  /** ★出どころ。collector 自身ではなく monitor が書いた判定であることを明示する
   *  (「最後に生きていた時の自己申告」と取り違えさせない)。 */
  writtenBy: 'monitor';
  state: CollectorWatchState;
  reason: string;
  /** 最後の心拍[epoch ms]。無ければ null。 */
  heartbeatAt: number | null;
  /** 心拍からの経過[ms]。無ければ null。 */
  ageMs: number | null;
  /** 判定に使った閾値[ms](後から「なぜそう判定したか」を再現できるように残す)。 */
  deadMs: number;
  /** 判定時点が取引時間内か。★死亡判定には使っていない(生きている時の言い方を分けるだけ)。 */
  inPollWindow: boolean;
  sessionDate: string | null;
  pid: CollectorPidInfo;
  /** ★**判定した monitor 側の** variant(収集デーモンのものではない)。
   *  収集デーモンは lite でも走るので、この値は「どのアプリが判定したか」を示すだけ。 */
  variant: string;
  /** Rust が書く spawn 記録の末尾(起動できたのか/いつ起動したのか)。 */
  spawn: { path: string; lines: string[] };
  /** collector 自身のファイルログの場所(「どこを見ればよいか」を遠隔に伝える)。 */
  logHint: string;
  /** ★仕事の有無(ティックの伸び / monitor 自身のフィード)。判定の根拠を後から再現できるように残す。 */
  work: CollectorWorkInfo;
  /** 仕事が止まったと見なす閾値[ms]。 */
  stuckMs: number;
  /** ティックからの経過[ms]。ティックが1件も無ければ null。 */
  tickAgeMs: number | null;
  /** monitor 自身のフィードからの経過[ms]。測れなければ null。 */
  feedAgeMs: number | null;
}

export interface BuildCollectorWatchInput {
  now: number;
  heartbeatAt: number | null;
  pid: CollectorPidInfo;
  deadMs?: number;
  variant?: string;
  spawn?: { path: string; lines: string[] };
  logHint?: string;
  /** ★省略時は「測っていない」= stuck 判定を **一切しない**(材料が無いのに異常と言わない)。 */
  work?: CollectorWorkInfo;
  stuckMs?: number;
  feedFreshMs?: number;
}

/** 判定を組み立てる純関数(DB にもファイルにも触らない = テストで全経路を通せる)。 */
export function buildCollectorWatch(input: BuildCollectorWatchInput): CollectorWatch {
  const { now, heartbeatAt, pid } = input;
  const deadMs = input.deadMs ?? COLLECTOR_DEAD_MS;
  const poll = inPollWindow(now);
  const session = classifySession(now);
  const work = input.work ?? NO_WORK_INFO;
  const stuckMs = input.stuckMs ?? COLLECTOR_STUCK_MS;
  const stuck = judgeCollectorWork({
    now, poll, work, stuckMs, feedFreshMs: input.feedFreshMs ?? MONITOR_FEED_FRESH_MS,
  });
  // 時計のずれ(未来の心拍)は「新しい」側に倒す。異常判定を時計の事故で出さない。
  const ageMs = heartbeatAt === null ? null : now - heartbeatAt;

  let state: CollectorWatchState;
  let reason: string;
  if (heartbeatAt === null || ageMs === null) {
    state = 'missing';
    reason = '心拍(collector_heartbeat)が1件も無い'
      + '(この PC で収集デーモンがまだ一度も動いていない/DB が作り直された)';
  } else if (ageMs > deadMs) {
    state = 'dead';
    // ★「時間外だから」で片付けられないことを、判定文そのものに書く。
    reason = `★収集デーモンが停止しています(心拍が ${jstStamp(heartbeatAt)} JST = ${fmtDur(ageMs)}前で凍結`
      + ` / 判定閾値 ${fmtDur(deadMs)})`
      + ` — 心拍は取引時間外でも ${Math.round(HEARTBEAT_IDLE_MS / 1000)}秒ごとに打たれる設計なので、`
      + '凍結は時間帯では説明できません(=プロセス停止)'
      + ` / pid ファイル=${pid.pid === null ? '無し' : `${pid.pid}(${pid.alive ? '★プロセスは生存' : 'プロセス不在'})`}`;
  } else if (stuck.verdict === 'stuck') {
    state = 'stuck';
    reason = stuck.reason;
  } else {
    state = poll ? 'ok' : 'idle';
    reason = poll
      ? `収集中(心拍 ${fmtDur(ageMs)}前 / 場中は約${Math.round(HEARTBEAT_POLL_MS / 1000)}秒間隔)`
      : `生存・待機中(心拍 ${fmtDur(ageMs)}前 / 取引時間外は約${Math.round(HEARTBEAT_IDLE_MS / 1000)}秒間隔`
        + ' — ティックが増えないのは正常)';
    // ★「増えていないが、収集デーモンのせいだとは言い切れない」ときは、その事実と **判定しなかった理由** を残す。
    //   ここを黙ると「観測できない」を「異常なし」と読み替える、いつもの失敗形になる。
    if (stuck.reason) reason += ` | ${stuck.reason}`;
  }

  return {
    v: 1, at: now, atJst: jstStamp(now), writtenBy: 'monitor',
    state, reason, heartbeatAt, ageMs, deadMs,
    inPollWindow: poll, sessionDate: session?.sessionDate ?? null,
    pid, variant: input.variant ?? 'unknown',
    spawn: input.spawn ?? { path: '', lines: [] },
    logHint: input.logHint ?? '',
    work, stuckMs, tickAgeMs: stuck.tickAgeMs, feedAgeMs: stuck.feedAgeMs,
  };
}

/** ★「生きているが仕事をしていない」の判定(純関数)。**心拍が新しいときだけ** 呼ぶ。
 *
 *  返り値は3通り:
 *    ・'stuck'      … ティックが伸びていない **かつ** monitor 自身のフィードは新鮮(=市場は動いている)
 *    ・'not-judged' … 判定しない(材料が無い/窓が開いた直後/フィードも古い)。理由は reason に残す
 *    ・'working'    … ティックが伸びている(正常)
 *  ★時間外・週末・休場日は 'not-judged' にすらならない(そもそも呼ばれない側で ok/idle が付く)。 */
export function judgeCollectorWork(input: {
  now: number;
  poll: boolean;
  work: CollectorWorkInfo;
  stuckMs: number;
  feedFreshMs: number;
}): { verdict: 'stuck' | 'working' | 'not-judged'; reason: string; tickAgeMs: number | null; feedAgeMs: number | null } {
  const { now, poll, work, stuckMs, feedFreshMs } = input;
  // 時計のずれ(未来の値)は「新しい」側に倒す。異常判定を時計の事故で出さない。
  const tickAgeMs = work.lastTickAt === null ? null : Math.max(0, now - work.lastTickAt);
  const feedAgeMs = work.feedAt === null ? null : Math.max(0, now - work.feedAt);
  const none = { verdict: 'not-judged' as const, reason: '', tickAgeMs, feedAgeMs };

  if (!poll) return none;                              // 時間外は「増えないのが正常」= 何も言わない
  if (work.lastTickAt === null && work.feedAt === null) return none;   // 測っていない
  // ★セッションが開いた直後は判定しない: 直前セッション最後のティックは当然古い。
  //   基準は **ポーリング窓ではなくセッション本体**: 収集デーモンがティックを書くのは
  //   classifySession()!==null の間だけ(collector/record.ts が場外ティックを捨てる)なので、
  //   窓の前後マージン(寄り5分前/引け10分後)を含めると寄り直後に必ず誤検知する。
  if (classifySession(now - stuckMs) === null) {
    return { ...none, reason: `(セッションが始まって${Math.round(stuckMs / 60_000)}分未満のため、ティックの伸びは判定しません)` };
  }
  const behind = tickAgeMs === null || tickAgeMs > stuckMs;
  if (!behind) return { verdict: 'working', reason: '', tickAgeMs, feedAgeMs };

  const feedFresh = feedAgeMs !== null && feedAgeMs <= feedFreshMs;
  const tickText = tickAgeMs === null
    ? `${work.symbol} のティックが1件も無い`
    : `${work.symbol} のティックが ${fmtDur(tickAgeMs)}前で止まっている`;
  if (!feedFresh) {
    // ★収集デーモンのせいにしない。monitor 自身も取れていない = 市場側/回線側の可能性。
    return {
      verdict: 'not-judged', tickAgeMs, feedAgeMs,
      reason: `${tickText}が、monitor 自身の価格フィードも`
        + `${feedAgeMs === null ? '観測できていない' : `${fmtDur(feedAgeMs)}前で古い`}`
        + '(市場が動いていない/フィード障害の可能性)ため、収集デーモンの異常とは判定しません',
    };
  }
  return {
    verdict: 'stuck', tickAgeMs, feedAgeMs,
    reason: `★収集デーモンは生きていますが記録が止まっています(${tickText}`
      + ` / 判定閾値 ${fmtDur(stuckMs)})`
      + ` — 同じ時刻に monitor 自身の価格フィードは ${fmtDur(feedAgeMs ?? 0)}前と新鮮なので、`
      + '取引時間外・休場日・フィード障害では説明できません(=収集デーモン側の部分故障。'
      + '心拍はポーリングの成否と無関係に打たれるので、心拍だけでは見えません)',
  };
}

/** 人が読む1行(meta の collector_watch_status)。JSON と同じ構造体から **この関数だけ** で作るので、
 *  2つの表現が食い違うことはない(既存の状態記録と同じ作法)。 */
export function formatCollectorWatchStatus(w: CollectorWatch): string {
  const parts: string[] = [
    `${w.state.toUpperCase()} ${w.atJst} JST`,
    w.reason,
    // ★これを書いたのは誰か。collector が死ぬと collector の自己申告は凍るので、出どころを必ず書く。
    '判定者=monitor(収集デーモン本人ではない)',
    `心拍=${w.heartbeatAt === null ? '無し' : `${jstStamp(w.heartbeatAt)}(${fmtDur(w.ageMs ?? 0)}前)`}`
      + ` 閾値=${fmtDur(w.deadMs)}`,
    `取引時間=${w.inPollWindow ? '内' : '外'}${w.sessionDate ? `(${w.sessionDate})` : ''}`,
    `pid=${w.pid.pid === null ? '無し' : w.pid.pid}(${w.pid.alive ? '生存' : '不在'}) ${w.pid.file}`,
    // ★「仕事をしているか」の材料。出どころが違う2つを **畳まずに** 並べる
    //   (畳むと後から「どちらが正か」= 収集デーモンの故障か市場側かが読めなくなる)。
    `仕事=${w.work.symbol} 最終ティック${w.tickAgeMs === null ? '無し' : `${fmtDur(w.tickAgeMs)}前`}`
      + ` / monitor自身のフィード${w.feedAgeMs === null ? '未観測' : `${fmtDur(w.feedAgeMs)}前`}`
      + ` 閾値=${fmtDur(w.stuckMs)}`,
    `判定した monitor の variant=${w.variant}`,
    `収集デーモンのログ=${w.logHint || '(未解決)'}`,
    w.spawn.lines.length > 0
      ? `spawn記録=${w.spawn.lines.slice(-3).join(' / ')}`
      : `spawn記録=無し(${w.spawn.path})`,
  ];
  return parts.join(' | ');
}

// ─── 測る ────────────────────────────────────────────────────────────

/** pid ファイルの事実を読む。**例外を投げない**。 */
export function measureCollectorPid(): CollectorPidInfo {
  let file = COLLECTOR_PID_FILE;
  try { file = pidLockPath(COLLECTOR_PID_FILE); } catch { /* 解決できなければ名前だけ残す */ }
  const pid = readPidFile(file);
  return { file, pid, alive: pid === null ? false : isAlive(pid) };
}

/** ★「仕事をしているか」の材料を測る。**例外を投げない**。
 *  ・ティック … 共有DBの `ticks`(書き手は collector だけ = 収集デーモンの出力そのもの)
 *  ・フィード … monitor 自身の価格キャッシュ(別プロセス・同じ公開HTTP = 市場が動いている独立証拠)
 *  ★ここは **読むだけ**。取引の経路(価格キャッシュ)には一切書き込まない。 */
export function measureCollectorWork(
  db: DatabaseSync, symbol: string = COLLECTOR_WORK_SYMBOL,
): CollectorWorkInfo {
  let lastTickAt: number | null = null;
  try { lastTickAt = getLatestTick(db, symbol)?.t ?? null; } catch { /* 読めなければ「無い」 */ }
  let feedAt: number | null = null;
  try {
    // stale(取得できず前回値を持ち越している)は「新鮮な証拠」にはならないので採らない。
    const p = getPrices().find(x => x.symbol === symbol);
    feedAt = p && !p.stale ? p.timestamp : null;
  } catch { /* 価格キャッシュが無い環境(テスト等)では未観測のまま */ }
  return { symbol, lastTickAt, feedAt };
}

/** いまの collector の状態を1回測る(共有DBの心拍 + pid ファイル + spawn 記録 + 仕事の伸び)。
 *  ★共有DBは **渡されたハンドルを読むだけ**。例外は投げない。 */
export function measureCollectorWatch(db: DatabaseSync, now: number = Date.now()): CollectorWatch {
  let heartbeatAt: number | null = null;
  try { heartbeatAt = readHeartbeatAt(db); } catch { /* 読めなければ「無い」= missing で出る */ }
  const spawnPath = resolveSpawnLogPath();
  let variant = 'unknown';
  try { variant = resolveVariant(); } catch { /* ignore */ }
  return buildCollectorWatch({
    now, heartbeatAt, pid: measureCollectorPid(), variant,
    spawn: { path: spawnPath, lines: readSpawnLogTail(spawnPath) },
    logHint: collectorLogHint(),
    work: measureCollectorWork(db),
  });
}

/** collector のファイルログが置かれるはずの場所(server/processLog.ts と同じ規則)。
 *  ★ここは「どこを見ればよいか」を伝えるためだけの文字列(存在は保証しない)。 */
export function collectorLogHint(): string {
  try {
    const dir = resolveTickExportDir();
    if (dir) return join(dir, `collector_${hostLabel()}.log`);
  } catch { /* ignore */ }
  return join(resolveAppDataDir(), 'collector.log');
}

/** 判定を共有DBの meta に書く(**monitor が書く**)。 */
export function writeCollectorWatch(db: DatabaseSync, now: number = Date.now()): CollectorWatch {
  const w = measureCollectorWatch(db, now);
  setMeta(db, COLLECTOR_WATCH_KEY, JSON.stringify(w));
  setMeta(db, COLLECTOR_WATCH_STATUS_KEY, formatCollectorWatchStatus(w));
  return w;
}

/** 読み手側(スナップショットを開いた人)。壊れた値は「無い」扱い。 */
export function readCollectorWatch(db: DatabaseSync): CollectorWatch | null {
  const raw = getMeta(db, COLLECTOR_WATCH_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as CollectorWatch;
    return (v && typeof v.at === 'number' && typeof v.state === 'string') ? v : null;
  } catch {
    return null;
  }
}

/** ★判定そのものが古くなっていないかを **読む時刻から** 評価する。
 *  monitor が止まれば判定も止まり、最後の 'ok' が固まる。`at` を見ないと同じ罠を作り直す。 */
export function describeCollectorWatch(
  w: CollectorWatch | null, now: number, freshMs: number = COLLECTOR_WATCH_FRESH_MS,
): { state: CollectorWatchState | 'missing' | 'unwatched'; ageMs: number | null; text: string } {
  if (!w) {
    return {
      state: 'missing', ageMs: null,
      text: 'MISSING 収集デーモンの死活判定が無い(monitor が古い版/一度も動いていない)',
    };
  }
  const ageMs = now - w.at;
  const line = formatCollectorWatchStatus(w);
  if (ageMs > freshMs) {
    return {
      state: 'unwatched', ageMs,
      text: `UNWATCHED 死活判定が${fmtDur(ageMs)}前で止まっている(monitor が動いていない`
        + ` = この判定は「その時点の事実」であって現在の状態ではない) | ${line}`,
    };
  }
  return { state: w.state, ageMs, text: line };
}

// ─── 書き出しフォルダへ(別PCから読めるように) ───────────────────────

/** 状態ファイル名 `collector_status_<host>.txt`(prices_<host>.db と同じ理由でホスト名入り)。 */
export function collectorStatusFileName(host: string = hostLabel()): string {
  return `collector_status_${host}.txt`;
}

/** 状態ファイルの中身。★1枚で「誰が・いつ・何を根拠に」判定したかが読めること。 */
export function formatCollectorStatusFile(w: CollectorWatch, host: string = hostLabel()): string {
  return [
    `# 収集デーモン(collector)の死活 — host=${host}`,
    '#',
    '# ★この判定は **monitor(生きている側)** が書いています。収集デーモン自身の自己申告ではありません。',
    '#   従来の状態(tick_archive / ledger_export)は収集デーモン自身が書くため、',
    '#   デーモンが死ぬと「最後に生きていた時の状態」が現在の状態として残り続けました(誤診断の原因)。',
    '# ★心拍は取引時間外でも打たれます(場中2秒 / 場外30秒)。',
    '#   したがって「心拍の凍結」は時間帯では説明できず、プロセス停止の証拠になります。',
    '# ★STUCK =「生きているが仕事をしていない」。心拍はポーリングの成否と無関係に打たれるので、',
    '#   ポーリングが例外を出し続けても心拍は正常に見えます(collector 側は catch して周回を続ける)。',
    '#   判定は **2つの独立した事実の食い違い** だけを根拠にします:',
    '#     ① 収集デーモンのティック(共有DB ticks・書き手は collector だけ)が伸びていない',
    '#     ② それなのに monitor 自身の価格フィード(別プロセス)は新鮮 = 市場は動いている',
    '#   ②が古いときは判定しません(休場日・フィード障害を収集デーモンのせいにしない)。',
    '#',
    `状態: ${w.state.toUpperCase()}`,
    `判定時刻: ${w.atJst} JST`,
    `理由: ${w.reason}`,
    `心拍: ${w.heartbeatAt === null ? '無し' : `${jstStamp(w.heartbeatAt)} JST(${fmtDur(w.ageMs ?? 0)}前)`}`,
    `判定閾値: ${fmtDur(w.deadMs)}`,
    `最終ティック(${w.work.symbol}): ${w.work.lastTickAt === null ? '無し' : `${jstStamp(w.work.lastTickAt)} JST(${fmtDur(w.tickAgeMs ?? 0)}前)`}`,
    `monitor 自身のフィード: ${w.work.feedAt === null ? '未観測(新鮮な取得なし)' : `${jstStamp(w.work.feedAt)} JST(${fmtDur(w.feedAgeMs ?? 0)}前)`}`,
    `仕事の判定閾値: ${fmtDur(w.stuckMs)}`,
    `取引時間: ${w.inPollWindow ? '内' : '外'}${w.sessionDate ? `(${w.sessionDate})` : ''}`,
    `pid ファイル: ${w.pid.file} = ${w.pid.pid === null ? '無し' : w.pid.pid}(${w.pid.alive ? '生存' : '不在'})`,
    `判定した monitor の variant: ${w.variant}`,
    `収集デーモンのログ: ${w.logHint || '(未解決)'}`,
    `spawn 記録(${w.spawn.path}):`,
    ...(w.spawn.lines.length > 0 ? w.spawn.lines.map(l => `  ${l}`) : ['  (無し)']),
    '',
  ].join('\n');
}

/** 状態ファイルを書き出しフォルダへ置く。一時ファイル → rename(部分書き込みを同期に流さない)。 */
export function writeCollectorStatusFile(
  destDir: string, w: CollectorWatch, host: string = hostLabel(),
): { ok: boolean; file: string | null; error: string | null } {
  if (!destDir) return { ok: false, file: null, error: '書出先が未設定' };
  const file = join(destDir, collectorStatusFileName(host));
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(tmp, formatCollectorStatusFile(w, host), 'utf-8');
    try { if (existsSync(file)) rmSync(file); } catch { /* 上書き rename が使える環境では不要 */ }
    renameSync(tmp, file);
    return { ok: true, file, error: null };
  } catch (e) {
    try { if (existsSync(tmp)) rmSync(tmp); } catch { /* ignore */ }
    return { ok: false, file: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── 定期監視(monitor プロセス) ─────────────────────────────────────

let timer: NodeJS.Timeout | null = null;
let db: DatabaseSync | null = null;
let last: CollectorWatch | null = null;
let lastState: CollectorWatchState | null = null;
let lastFileAt = 0;

/** 直近の判定(/api/status が読む)。まだ測っていなければ null。 */
export function currentCollectorWatch(): CollectorWatch | null { return last; }

/** 状態が変わった/一定時間たったら書き出しフォルダの状態ファイルを更新する(純関数)。
 *  同期フォルダを毎30秒たたかないための判断を、テストできる形で切り出す。 */
export function shouldWriteStatusFile(
  prev: CollectorWatchState | null, next: CollectorWatchState, lastWriteAt: number, now: number,
  minIntervalMs: number = COLLECTOR_STATUS_FILE_MS,
): boolean {
  if (prev !== next) return true;
  return now - lastWriteAt >= minIntervalMs;
}

/** 共用の1行ログ(sidecar-spawn.log)に書くべき遷移か(純関数)。
 *  ★monitor を起動しただけ(前の状態が無く、収集も正常)は書かない = 共用ログを雑音で埋めない。
 *    異常(dead / stuck / missing)と、そこからの復帰は **必ず** 書く。 */
export function shouldLogTransition(
  prev: CollectorWatchState | null, next: CollectorWatchState,
): boolean {
  if (prev === next) return false;
  if (prev === null) return next === 'dead' || next === 'stuck' || next === 'missing';
  return true;
}

/** 1回測って記録する。**失敗しても絶対に throw しない**(表示のための機構でサーバを落とさない)。 */
export function collectorWatchTick(now: number = Date.now()): CollectorWatch | null {
  try {
    if (!db) db = openDb(resolveDbPath());
    const w = writeCollectorWatch(db, now);
    last = w;
    // ★状態が変わった瞬間を、Rust の spawn 記録と **同じ1行ログ** に残す。
    //   「起動された → いつ静かになった → いつ戻った」が1ファイルで時系列に並ぶ。
    //   ★共用のログなので雑音を足さない: monitor を起動しただけ(前の状態が無く、かつ正常)は書かない。
    if (lastState !== w.state) {
      if (shouldLogTransition(lastState, w.state)) appendSpawnLog(`[collector-watch] ${w.state}: ${w.reason}`, now);
      if (w.state === 'dead' || w.state === 'stuck') console.error(`[collector-watch] ${w.reason}`);
      else console.log(`[collector-watch] ${w.state}: ${w.reason}`);
    }
    if (shouldWriteStatusFile(lastState, w.state, lastFileAt, now)) {
      let dir = '';
      try { dir = resolveTickExportDir(); } catch { /* 未設定と同じ扱い */ }
      if (dir) {
        const r = writeCollectorStatusFile(dir, w);
        if (!r.ok && lastState !== w.state) {
          console.warn(`[collector-watch] 状態ファイルを書けません: ${r.error ?? '?'}`);
        }
      }
      lastFileAt = now;
    }
    lastState = w.state;
    return w;
  } catch (e) {
    console.warn('[collector-watch] 記録に失敗:', e instanceof Error ? e.message : String(e));
    try { db?.close(); } catch { /* ignore */ }
    db = null;   // 次回に開き直す(WAL の一時的な失敗から自力で復帰する)
    return null;
  }
}

/** 収集デーモンの死活を定期監視する。
 *  ★取引時間でゲートしない: 「時間外で静かなのか」「止まっているのか」を区別するために、
 *    場外でも判定を更新し続ける必要がある(場外で生きていれば state='idle' = 正常と読める)。
 *  ★lite でも動かす: 収集デーモンは lite でも走る(止まれば同じ被害が出る)。 */
export function startCollectorWatch(): void {
  if (timer) return;
  collectorWatchTick();   // 起動直後に1回(30秒待たずに状態が届く)
  timer = setInterval(() => { collectorWatchTick(); }, COLLECTOR_WATCH_MS);
  timer.unref?.();
}

export function stopCollectorWatch(): void {
  if (timer) { clearInterval(timer); timer = null; }
  try { db?.close(); } catch { /* ignore */ }
  db = null;
}

/** テスト専用: 監視の内部状態を捨てる。 */
export function _resetCollectorWatchForTest(): void {
  stopCollectorWatch();
  last = null; lastState = null; lastFileAt = 0;
}

// ─── /api/status に出す形(画面のドットが読む) ───────────────────────

export interface CollectorStatusForApi {
  state: CollectorWatchState;
  reason: string;
  heartbeatAt: number | null;
  ageMs: number | null;
  inPollWindow: boolean;
  pidAlive: boolean;
  /** この判定を測った時刻(画面側が「判定自体の古さ」を見られるように)。 */
  at: number;
}

/** 直近の判定を /api/status 向けに縮める。★まだ一度も測っていなければ **その場で1回測る**
 *  (監視ループが動いていない状況でも画面が無言にならない)。失敗したら null(=表示しない)。 */
export function collectorStatusForApi(now: number = Date.now()): CollectorStatusForApi | null {
  let w = last;
  if (!w || now - w.at > COLLECTOR_WATCH_MS) w = collectorWatchTick(now) ?? last;
  if (!w) return null;
  return {
    state: w.state, reason: w.reason, heartbeatAt: w.heartbeatAt, ageMs: w.ageMs,
    inPollWindow: w.inPollWindow, pidAlive: w.pid.alive, at: w.at,
  };
}
