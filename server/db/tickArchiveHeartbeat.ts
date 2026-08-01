// ティック長期保管の**健全性ハートビート**(RECORD-ONLY・取引挙動には一切関与しない)。
//
// ■ 何のためか
//   ティック保管(server/db/tickArchive.ts)は「1年後に効いてくる」機構で、最悪の失敗形は
//   **書けていないことに気づくのが1年後**。したがって「書けている/止まっている」は
//   *常時見える* 指標でなければならない。単発の確認手段では同じ失敗をもう一度やる。
//
// ■ ★どこに載せるか = 共有DB(jp225.db)の meta テーブル
//   保管の実体(ticks_archive.db)は **意図的に** 共有DBと別ファイルにしてある(trade2 の 30分ごとの
//   `VACUUM INTO` を太らせないため)。その結果、専用DBの状態は既存の書き出し
//   (prices_<host>.db = jp225.db 全体の VACUUM INTO)からは **一切見えない**。
//   → 保管の *中身* は別ファイルのままにし、**状態(メタ情報)だけ** を共有DBの meta に書く。
//     meta は VACUUM INTO でそのまま複製されるので、**既存の30分ごとの書き出しに自動的に乗る**。
//     (この「meta が複製に含まれる」ことは tickArchiveHeartbeat.test.ts が実 VACUUM INTO で検査する。)
//   既存の `collector_heartbeat`(server/collectorHeartbeat.ts)と同じ置き場・同じ発想で、
//   新しい配管・新しい同期経路をひとつも増やさない。
//
// ■ ★「止まっている」が一目で分かること
//   ①`state` … ok / idle(場外=正常に止まっている) / stalled(場中なのに増えていない) / error。
//     **場外の 0 件は正常**なので、場中(classifySession が非 null)かどうかで必ず場合分けする。
//     これを分けないと、週末は毎回「異常」に見えて誰も見なくなる = 指標が死ぬ。
//   ②`tick_archive_status` … 同じ内容の**人が読む1行**。JSON を開かなくても状態が読める。
//   ③ ハートビート自体が止まったら(= collector 停止)、読み手側の describeTickArchive() が
//     `at` の古さから検出する。**「値が更新されない」を「正常」と誤読させない**。
//
// ■ ★「増加数」の定義 = 前回ハートビート時刻(prev.at)以降のティック件数
//   当日累計ではなく **前回ハートビートからの差分** を主指標に採る。理由:
//     ・当日累計はセッション開始直後に必ず 0 になるので「0=異常」と読めない(場合分けが増える)。
//     ・差分なら **スナップショット1枚だけ** で「この60秒で増えたか」が判定できる。
//       前後2枚を突き合わせる必要がない = 1年後に1枚拾っただけでも真偽が分かる。
//   実装は「in-memory のカウンタの差」ではなく `COUNT(*) WHERE t >= prev.at` の**実測**にする。
//     ・archiveTicks() の戻り値(=試行件数)ではなく **DB に実際に入った件数** を数える
//       (INSERT OR IGNORE で弾かれたものは増加ではない)。
//     ・プロセス再起動を跨いでも壊れない(状態は meta にしか無い)。
//     ・後から誰でも同じ SQL で再計算して検算できる。
//   当日累計(`sessionRows`)も併記する: 日次書き出しの件数と突き合わせる用。
//
// ■ 累計件数(`total`)は「実測値 + 実測時刻」で持つ
//   `COUNT(*)` は 900万行で実測 350ms(索引全走査)。毎分やるとティック増加に比例して重くなる。
//   → **1時間に1回だけ実測**し、その間は値を据え置いて `totalAt`(実測時刻)を添える。
//     推定値で埋めて“それらしい数字”を出すことはしない(嘘をつくくらいなら古い事実を出す)。

import type { DatabaseSync } from 'node:sqlite';
import { classifySession } from '../../core/session.js';
import { getMeta, setMeta } from './store.js';
import { ARCHIVED_SYMBOLS, sessionDateRange, pendingExportDates } from './tickArchive.js';

/** 共有DB(jp225.db)meta のキー。JSON 本体と、人が読む1行の2本。 */
export const TICK_ARCHIVE_HEARTBEAT_KEY = 'tick_archive_heartbeat';
export const TICK_ARCHIVE_STATUS_KEY = 'tick_archive_status';

/** ハートビートを書く間隔。増加数(delta)の測定窓でもある。 */
export const TICK_ARCHIVE_HEARTBEAT_MS = 60_000;
/** 場中に「最終保管がこれより古い」=止まっているとみなす。フィードは ~4秒周期なので2分は十分に余裕。 */
export const TICK_ARCHIVE_STALE_LAG_MS = 120_000;
/** 累計件数(COUNT(*))を実測し直す間隔。 */
export const TICK_ARCHIVE_TOTAL_RECOUNT_MS = 60 * 60_000;
/** 読み手が「ハートビート自体が止まった(collector 停止)」と判定する猶予(= 3周期)。 */
export const TICK_ARCHIVE_HEARTBEAT_FRESH_MS = 3 * TICK_ARCHIVE_HEARTBEAT_MS;
/** 未書き出しの確定日がこの数以上たまっていたら日次書き出しが滞っている。
 *  1 は「確定直後〜次の毎時実行までの正常な待ち」で出るので、2 以上を異常とする。 */
export const TICK_ARCHIVE_EXPORT_BEHIND = 2;

export type TickArchiveState = 'ok' | 'idle' | 'stalled' | 'error';

const STATE_RANK: Record<TickArchiveState, number> = { ok: 0, idle: 1, stalled: 2, error: 3 };

/** 最後に成功した日次書き出し(いつ・どの日・どのファイル・何件)。 */
export interface TickArchiveExportInfo {
  at: number; sessionDate: string; file: string; rows: number;
}
/** 最後に起きた失敗。**消さない**(消すと無音に戻る)。 */
export interface TickArchiveErrorInfo {
  at: number; where: string; message: string;
}

/** 保管DBから実測した銘柄ごとの生データ(判定前)。 */
export interface TickArchiveSymbolStat {
  symbol: string;
  /** archive に入っている最新ティックの t。1件も無ければ null。 */
  lastTickT: number | null;
  /** 累計件数(実測)と、その実測時刻。 */
  total: number;
  totalAt: number;
  /** 前回ハートビート時刻以降に入った件数。前回が無い(初回)なら null。 */
  delta: number | null;
  /** 当日(セッション日)の件数。場外は null。 */
  sessionRows: number | null;
  /** 未書き出しの確定済みセッション日の数(0 が正常)。 */
  pendingExports: number;
}

export interface TickArchiveSymbolHealth extends TickArchiveSymbolStat {
  lagMs: number | null;
  state: TickArchiveState;
  reason: string;
}

export interface TickArchiveHeartbeat {
  v: 1;
  /** このハートビートを書いた時刻。**読み手はこれの古さで collector 停止を検出する**。 */
  at: number;
  atJst: string;
  state: TickArchiveState;
  reason: string;
  /** 書いた時刻が場中か。**archiveTicks が書き込む条件(classifySession)と同一の判定**を使う
   *  (ここを inPollWindow 等の別条件にすると、前後マージン帯で必ず誤検知する)。 */
  sessionOpen: boolean;
  sessionDate: string | null;
  /** 前回ハートビートからの経過(= delta の測定窓)。初回は null。 */
  sinceMs: number | null;
  exportDir: string;
  exportEnabled: boolean;
  exportBehind: boolean;
  symbols: TickArchiveSymbolHealth[];
  lastExport: TickArchiveExportInfo | null;
  lastError: TickArchiveErrorInfo | null;
}

// ─── 表示ヘルパ(JST・純関数) ───────────────────────────────
const JST_OFFSET = 9 * 60 * 60_000;
const p2 = (n: number): string => String(n).padStart(2, '0');

/** epoch ms → 'YYYY-MM-DD HH:mm:ss'(JST)。 */
export function jstStamp(t: number): string {
  const j = new Date(t + JST_OFFSET);
  return `${j.getUTCFullYear()}-${p2(j.getUTCMonth() + 1)}-${p2(j.getUTCDate())} `
    + `${p2(j.getUTCHours())}:${p2(j.getUTCMinutes())}:${p2(j.getUTCSeconds())}`;
}

/** 経過時間を人が読む短い形に('42s' / '3m20s' / '5h04m' / '12d3h')。 */
export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${p2(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${p2(m % 60)}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

const num = (n: number): string => n.toLocaleString('en-US');

// ─── 保管DBの実測 ─────────────────────────────────────────

/** 保管DBを読んで銘柄ごとの生データを実測する。
 *  すべて索引で決まる軽い問い合わせ(MAX は O(log n)・範囲 COUNT は範囲内の件数のみ)。
 *  唯一重い COUNT(*) だけ TICK_ARCHIVE_TOTAL_RECOUNT_MS ごとに間引く。 */
export function readTickArchiveSymbolStats(
  archiveDb: DatabaseSync,
  now: number,
  prev: TickArchiveHeartbeat | null,
  symbols: readonly string[] = ARCHIVED_SYMBOLS,
): TickArchiveSymbolStat[] {
  const s = classifySession(now);
  const range = s ? sessionDateRange(s.sessionDate) : null;
  const maxStmt = archiveDb.prepare('SELECT MAX(t) AS m FROM ticks WHERE symbol = ?');
  const cntAll = archiveDb.prepare('SELECT COUNT(*) AS n FROM ticks WHERE symbol = ?');
  const cntFrom = archiveDb.prepare('SELECT COUNT(*) AS n FROM ticks WHERE symbol = ? AND t >= ?');
  const cntRange = archiveDb.prepare('SELECT COUNT(*) AS n FROM ticks WHERE symbol = ? AND t >= ? AND t < ?');

  return symbols.map((symbol) => {
    const p = prev?.symbols?.find(x => x.symbol === symbol) ?? null;
    const lastTickT = (maxStmt.get(symbol) as { m: number | null }).m ?? null;

    // 累計は1時間に1回だけ実測。据え置き中は「いつ実測した値か」を必ず一緒に持つ。
    const stale = !p || !Number.isFinite(p.totalAt) || now - p.totalAt >= TICK_ARCHIVE_TOTAL_RECOUNT_MS;
    const total = stale ? (cntAll.get(symbol) as { n: number }).n : p.total;
    const totalAt = stale ? now : p!.totalAt;

    // ★増加数 = 前回ハートビート時刻以降に入った件数の**実測**(カウンタの差ではない)。
    //   フィードの timestamp は取得時刻(Date.now)なのでハートビートの時計と同一(ajaxCmePrice)。
    const delta = prev && prev.at <= now
      ? (cntFrom.get(symbol, prev.at) as { n: number }).n
      : null;

    const sessionRows = range
      ? (cntRange.get(symbol, range.start, range.end) as { n: number }).n
      : null;

    return { symbol, lastTickT, total, totalAt, delta, sessionRows, pendingExports: pendingExportDates(archiveDb, symbol, now).length };
  });
}

// ─── 判定(純関数) ────────────────────────────────────────

function judgeSymbol(
  st: TickArchiveSymbolStat, now: number, sessionOpen: boolean, sinceMs: number | null,
): TickArchiveSymbolHealth {
  const lagMs = st.lastTickT == null ? null : now - st.lastTickT;
  let state: TickArchiveState;
  let reason: string;
  if (!sessionOpen) {
    // ★場外の 0 件は「止まっている」ではなく「止めてある」。ここを異常にすると指標が信用を失う。
    state = 'idle';
    reason = '場外(取引時間外)=書き込みが無いのが正常';
  } else if (st.lastTickT == null) {
    state = 'stalled';
    reason = '保管が空(1件も入っていない)';
  } else if (st.delta === 0) {
    state = 'stalled';
    reason = `場中なのに直近${sinceMs == null ? '?' : fmtDur(sinceMs)}で0件`;
  } else if (lagMs != null && lagMs > TICK_ARCHIVE_STALE_LAG_MS) {
    state = 'stalled';
    reason = `場中なのに最終保管が${fmtDur(lagMs)}前`;
  } else if (st.delta == null) {
    state = 'ok';
    reason = '起動直後(増加数は次回ハートビートから)';
  } else {
    state = 'ok';
    reason = `+${num(st.delta)}件/${sinceMs == null ? '?' : fmtDur(sinceMs)}`;
  }
  return { ...st, lagMs, state, reason };
}

/** ハートビートを組み立てる純関数(DB に触らない=テストしやすい)。
 *  lastExport / lastError は **前回から引き継ぐ**(新しいものが渡された時だけ更新)。
 *  → 失敗の記録は上書きされるまで残り続ける = 無音にならない。 */
export function buildTickArchiveHeartbeat(input: {
  now: number;
  prev: TickArchiveHeartbeat | null;
  stats: readonly TickArchiveSymbolStat[];
  exportDir: string;
  lastExport?: TickArchiveExportInfo | null;
  lastError?: TickArchiveErrorInfo | null;
}): TickArchiveHeartbeat {
  const { now, prev, stats, exportDir } = input;
  const s = classifySession(now);
  const sessionOpen = s !== null;
  const sinceMs = prev && prev.at <= now ? now - prev.at : null;

  const lastExport = input.lastExport ?? prev?.lastExport ?? null;
  const lastError = input.lastError ?? prev?.lastError ?? null;
  // 「今回の窓で起きた失敗」だけを state に反映する(古い失敗で永久に赤くしない)。
  // 記録(lastError)自体は残り続けるので、過去に失敗した事実は消えない。
  const errorFresh = lastError != null && lastError.at >= (prev?.at ?? 0) && lastError.at <= now;

  const symbols = stats.map(st => judgeSymbol(st, now, sessionOpen, sinceMs));
  const exportEnabled = exportDir !== '';
  const exportBehind = exportEnabled && symbols.some(x => x.pendingExports >= TICK_ARCHIVE_EXPORT_BEHIND);

  let state: TickArchiveState = 'ok';
  let reason = '';
  if (errorFresh) {
    state = 'error';
    reason = `${lastError!.where}: ${lastError!.message}`;
  } else if (symbols.length === 0) {
    state = 'stalled';
    reason = '保管対象の銘柄が1つも無い';
  } else {
    const worst = symbols.reduce((a, b) => (STATE_RANK[b.state] > STATE_RANK[a.state] ? b : a));
    state = worst.state;
    reason = symbols.length === 1 ? worst.reason : `${worst.symbol}: ${worst.reason}`;
  }

  return {
    v: 1, at: now, atJst: jstStamp(now), state, reason,
    sessionOpen, sessionDate: s?.sessionDate ?? null, sinceMs,
    exportDir, exportEnabled, exportBehind,
    symbols, lastExport, lastError,
  };
}

/** 人が読む1行(meta の tick_archive_status に入る値)。
 *  JSON と同じ構造体から**この関数だけ**で作るので、2つの表現が食い違うことはない。 */
export function formatTickArchiveStatus(hb: TickArchiveHeartbeat): string {
  const parts: string[] = [`${hb.state.toUpperCase()} ${hb.atJst} JST`, hb.reason];
  for (const x of hb.symbols) {
    const last = x.lastTickT == null ? '無し' : `${jstStamp(x.lastTickT)}(${fmtDur(x.lagMs ?? 0)}前)`;
    const d = x.delta == null ? '?' : `+${num(x.delta)}`;
    parts.push(
      `${x.symbol} 最終保管=${last} 増加=${d}件/${hb.sinceMs == null ? '?' : fmtDur(hb.sinceMs)}`
      + ` 当日=${x.sessionRows == null ? '-' : num(x.sessionRows)}件`
      + ` 累計=${num(x.total)}件(${jstStamp(x.totalAt)}実測)`
      + ` 未書出=${x.pendingExports}日`,
    );
  }
  parts.push(hb.exportEnabled
    ? (hb.lastExport
      ? `最終書出=${hb.lastExport.sessionDate} ${num(hb.lastExport.rows)}件 ${hb.lastExport.file}(${jstStamp(hb.lastExport.at)})`
      : '最終書出=まだ無し')
    : '書出先=未設定(保管は継続)');
  if (hb.exportBehind) parts.push('★書き出しが滞留');
  parts.push(hb.lastError
    ? `最終エラー=${jstStamp(hb.lastError.at)} ${hb.lastError.where}: ${hb.lastError.message}`
    : 'エラー無し');
  return parts.join(' | ');
}

// ─── 共有DB(jp225.db)meta への読み書き ────────────────────

export function readTickArchiveHeartbeat(db: DatabaseSync): TickArchiveHeartbeat | null {
  const raw = getMeta(db, TICK_ARCHIVE_HEARTBEAT_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as TickArchiveHeartbeat;
    return (v && typeof v.at === 'number' && Array.isArray(v.symbols)) ? v : null;
  } catch {
    return null;   // 壊れた値は「無い」扱い(次のハートビートで上書きされる)
  }
}

/** 保管の状態を1回測って共有DBの meta に書く。書いたハートビートを返す。
 *
 *  ★保管DBの読み取りに失敗しても **共有DBには必ず書く**。読めなかったという事実こそが
 *    伝えるべき情報で、ここで例外にして何も書かないと「更新が止まった」だけになり無音に戻る。
 *  共有DBへの書き込み自体が失敗した場合だけ例外を投げる(呼び出し側が必ずログに出す)。 */
export function writeTickArchiveHeartbeat(
  sharedDb: DatabaseSync,
  archiveDb: DatabaseSync,
  opts: {
    now?: number;
    exportDir: string;
    lastExport?: TickArchiveExportInfo | null;
    lastError?: TickArchiveErrorInfo | null;
    symbols?: readonly string[];
  },
): TickArchiveHeartbeat {
  const now = opts.now ?? Date.now();
  const prev = readTickArchiveHeartbeat(sharedDb);
  let stats: TickArchiveSymbolStat[] = [];
  let lastError = opts.lastError ?? null;
  try {
    stats = readTickArchiveSymbolStats(archiveDb, now, prev, opts.symbols);
  } catch (e) {
    stats = [];
    lastError = { at: now, where: 'archive-read', message: e instanceof Error ? e.message : String(e) };
  }
  const hb = buildTickArchiveHeartbeat({
    now, prev, stats, exportDir: opts.exportDir, lastExport: opts.lastExport ?? null, lastError,
  });
  setMeta(sharedDb, TICK_ARCHIVE_HEARTBEAT_KEY, JSON.stringify(hb));
  setMeta(sharedDb, TICK_ARCHIVE_STATUS_KEY, formatTickArchiveStatus(hb));
  return hb;
}

// ─── 読み手側(スナップショットを開いた人 / 将来の UI) ──────

export interface TickArchiveVerdict {
  state: TickArchiveState | 'missing';
  /** ハートビートが書かれてからの経過。missing は null。 */
  ageMs: number | null;
  text: string;
}

/** ハートビートを **読む時刻から見て** 評価する。
 *  ★これが要点: 値が更新されなくなった(collector 停止・保管モジュール不在)ときは
 *    最後の値が 'ok' のまま凍る。`at` の古さを見ないと「OK のまま止まっている」を見逃す。 */
export function describeTickArchive(
  hb: TickArchiveHeartbeat | null, now: number,
  freshMs: number = TICK_ARCHIVE_HEARTBEAT_FRESH_MS,
): TickArchiveVerdict {
  if (!hb) {
    return { state: 'missing', ageMs: null, text: 'MISSING ティック保管のハートビートが無い(記録が始まっていない/古い版で動いている)' };
  }
  const ageMs = now - hb.at;
  const line = formatTickArchiveStatus(hb);
  if (ageMs > freshMs) {
    return {
      state: 'stalled', ageMs,
      text: `STALLED ハートビートが${fmtDur(ageMs)}前で停止(collector が動いていない疑い) | ${line}`,
    };
  }
  return { state: hb.state, ageMs, text: line };
}
