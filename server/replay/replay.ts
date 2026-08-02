// オフライン再生の中核。**取引しない・ライブ経路に一切関わらない分析用の処理**。
//
//   generator_proposals.db(提案・全数)  ┐
//                                        ├→ 再生 → shadow_exits.db(影30通り)
//   ticks_archive.db(NIY=F ティック)   ┘
//
// ■ ★再実装しない(本番の関数をそのまま呼ぶ)
//   武装 = planToArmed / 約定判定 = detectFill / 遷移 = advance(決済関数だけ差し替え)。
//   これらは ShadowSim(server/signalTrade/shadow/sim.ts)が既に内側で呼んでいるので、
//   ここでは **ShadowSim に価格を供給するだけ**。約定・決済・打ち切りの規約を書き写す場所は1行も無い。
//   門も同様に本番の純関数を呼ぶ(server/replay/gates.ts)。
//   ★過去の解析スクリプト群が本番コードを import せず再実装したために9年分の検証結果に留保が付いた。
//     同じ轍は踏まない。非公開ファイルをテキスト走査することも **しない**(import して関数として呼ぶ)。
//
// ■ ★右側打ち切りを固定時間で作らない
//   地平は ShadowSim の既定(SHADOW_HORIZON_MS)。固定の短い地平で切ると **床が緩い設定ほど保有が長い**
//   ため、測ろうとしている軸に沿って選択的に不利になる。ここでは地平を縮めず、ティックの窓の方を
//   「最後の提案の武装時刻 + 地平」まで伸ばして、打ち切りが窓の都合で増えないようにする。
//
// ■ ★再生の単位は取引日(session_date)
//   影は提案をまたいで重なる(提案は2分ごと・地平は480分)。途中の任意の tick で中断すると
//   同時生存本数が通しと食い違うので、日ごとに ShadowSim を作り直して独立に計算する。
//   → 「通しで走らせた結果」と「途中で止めて再開した結果」が一致する(=再開可能)。
//   同時生存本数(concurrent)は **その日の再生窓の中で** 数えた本数になる(日をまたいで生き残った
//   前日の影は数えない)。日の境界は 06:00〜08:45 のティックが無い帯なので、跨いで生きる影は
//   夜間終盤に武装したものだけ。この限界は記録の意味として受け入れる(窓は replay_days に残す)。
//
// ■ ★覆えなかった範囲を無音にしない
//   ティックが無い期間の提案・途中でティックが切れた提案・門で落ちた提案は、**全部「何件・なぜ」** を
//   replay_coverage に残し、標準出力にも出す。「1年後に件数が少ない理由が分からない」が最悪の失敗形。

import { DatabaseSync } from 'node:sqlite';
import { classifySession } from '../../core/session.js';
import { getArchiveTicks, sessionDateRange, EXPORT_SETTLE_MS } from '../db/tickArchive.js';
import type { Tick } from '../db/store.js';
import { insertShadowRows, recordShadowLadderMeta } from '../db/shadowStore.js';
import { ShadowSim, SHADOW_HORIZON_MS, type ShadowRow, type ShadowPlan } from '../signalTrade/shadow/sim.js';
import { getShadowExitLadder, type ShadowExitLadder } from '../signalTrade/exit/index.js';
import { applyArmGates } from './gates.js';
import { readProposals, readCandidateDays, countProposalsWithoutSessionDate, type ReplayProposal } from './source.js';
import {
  initReplaySchema, isDayReplayed, recordReplayDay, recordCoverage,
  type CoverageReason, type CoverageRow,
} from './store.js';

/** ARM 時点の価格として認めるティックの最大の古さ[ms]。
 *  ★A の livePrice() は「新鮮値(stale でない)」だけを門に渡す。オフラインでこれに対応するのが
 *    「武装時刻の直前に実際にティックが在ったか」。3分は monitor の他所の鮮度上限
 *    (server/llm/scalpContext.ts / server/signalTrade/regime.ts の MAX_STALE_MS)と同じ考え方。
 *    実測の NIY=F は 35,860件/日 ≒ 0.8件/秒 なので、3分空くのは **フィードが切れていた** ということ。 */
export const LIVE_MAX_AGE_MS = 3 * 60_000;

/** 影の同時生存上限(再生用)。
 *  ★ShadowSim の既定(512本)はライブの CPU/メモリを守るための値。オフライン再生には実時間の締切が無く、
 *    上限に当たると **提案ごと拒否** されるので、忙しい時間帯(=提案が密な時間帯)だけが系統的に落ちる
 *    =測ろうとしている軸に沿ったバイアスになる。だから再生では十分大きく取り、当たったら記録に残す。 */
export const REPLAY_MAX_OPEN_SHADOWS = 100_000;

export interface ReplayDeps {
  /** 提案の台帳(**readOnly**)。 */
  gen: DatabaseSync;
  /** 保管ティック(**readOnly**)。 */
  ticks: DatabaseSync;
  /** 影の記録先(書き込み)。 */
  shadow: DatabaseSync;
  symbol: string;
  now: () => number;
  log: (msg: string) => void;
  /** 影の決済仕様(既定=非公開ラダー)。テストでは合成の仕様を注入する。 */
  ladder?: () => ShadowExitLadder;
  horizonMs?: number;
  maxOpenShadows?: number;
  liveMaxAgeMs?: number;
}

export interface DayResult {
  sessionDate: string;
  ladderEpoch: string;
  proposals: number;
  opened: number;
  /** 影の行(生成された数)と、実際に DB へ入った数(既にあれば入らない=冪等)。 */
  rows: number;
  inserted: number;
  /** ★force のときだけ: 既存行を **上書きした** 数。通常再生では undefined。 */
  replaced?: number;
  /** ★force のときだけ: 上書きの結果 **結末が実際に変わった** 数。
   *  「inserted:0 なので何も起きなかった」という誤読を作らないための数字。 */
  changed?: number;
  /** ★force のときだけ: 覆域の件数のうち実際に変わった行数。 */
  coverageChanged?: number;
  ticks: number;
  windowFrom: number;
  windowTo: number;
  coverage: CoverageRow[];
  /** ★打ち切り(censoring)の件数。**0 件でも必ず出す**(「今日は0件だった」と「数えていない」を区別する)。
   *  母集団を「打ち切りでないもの」で切ると spec 依存の選択バイアスが入るので、切る前の数を毎日残す。 */
  censored: { horizon: number; ticksExhausted: number };
  /** 既に再生済みで飛ばした(=再開)。 */
  skipped: boolean;
}

/** 影の行から打ち切りを数える純関数(理由別)。 */
export function countCensored(rows: readonly ShadowRow[]): { horizon: number; ticksExhausted: number } {
  let horizon = 0, ticksExhausted = 0;
  for (const r of rows) {
    if (!r.censored) continue;
    if (r.censorReason === 'horizon') horizon += 1;
    else if (r.censorReason === 'ticks_exhausted') ticksExhausted += 1;
  }
  return { horizon, ticksExhausted };
}

/** 覆域の集計器(提案1件を必ずどれか1つの理由に落とす=取りこぼしを作らない)。 */
class Coverage {
  private readonly map = new Map<string, CoverageRow>();
  constructor(private readonly sessionDate: string, private readonly ladderEpoch: string) {}
  add(epoch: string, reason: CoverageReason, detail?: string | null): void {
    // ★区切りは「長さ接頭辞」で入れる(生の NUL を使わない)。
    //   以前は epoch と reason を **生の NUL 文字** で連結していたが、NUL が1バイトでもあると
    //   git はそのファイルを **バイナリ扱い** にし、`git diff` / `git show` が `Bin 0 -> N bytes` しか
    //   出さなくなる。=差分が永久に読めず、このプロジェクトの否定対照の手法
    //   (`git show HEAD:<path>` で修正前に戻して赤くなることを見る)もこのファイルに使えなくなる。
    //   長さを先頭に置けば epoch の切れ目が一意に決まるので、epoch や reason に
    //   区切り文字が含まれても衝突しない(NUL を使っていた目的をそのまま満たす)。
    const key = `${epoch.length}:${epoch}:${reason}`;
    const cur = this.map.get(key);
    if (cur) { cur.n += 1; return; }
    this.map.set(key, {
      sessionDate: this.sessionDate, ladderEpoch: this.ladderEpoch, epoch,
      reason, n: 1, detail: detail ?? null,
    });
  }
  rows(): CoverageRow[] {
    return [...this.map.values()].sort((a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : a.reason < b.reason ? -1 : 1));
  }
}

/** 昇順のティック列で t 以下の最後の要素の添字(無ければ -1)。二分探索(純関数)。 */
export function lastIndexAtOrBefore(ticks: readonly Tick[], t: number): number {
  let lo = 0, hi = ticks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** 昇順のティック列で t 以上の最初の要素の添字(無ければ -1)。二分探索(純関数)。 */
export function firstIndexAtOrAfter(ticks: readonly Tick[], t: number): number {
  let lo = 0, hi = ticks.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid]!.t >= t) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return ans;
}

/** その取引日を再生してよいか(=これ以上ティックも提案も増えない)。
 *  ★取引日の終わり(D+1 06:00)+ 地平 + 猶予。地平のぶん先まで待つのは、最後の提案の影が
 *    使いうるティックが全部出揃ってからでないと **同じ日を2回再生した結果が食い違う** ため。 */
export function isDayReplayable(sessionDate: string, now: number, horizonMs: number): boolean {
  return now >= sessionDateRange(sessionDate).end + horizonMs + EXPORT_SETTLE_MS;
}

/** 取引日1日ぶんを再生する。★同じ入力なら常に同じ行を作る(決定論)。 */
export function replayDay(dep: ReplayDeps, sessionDate: string, opts: { force?: boolean } = {}): DayResult {
  const force = opts.force === true;
  const ladderFn = dep.ladder ?? getShadowExitLadder;
  const ladder = ladderFn();
  const horizonMs = dep.horizonMs ?? SHADOW_HORIZON_MS;
  const liveMaxAgeMs = dep.liveMaxAgeMs ?? LIVE_MAX_AGE_MS;
  const empty = (skipped: boolean): DayResult => ({
    sessionDate, ladderEpoch: ladder.epoch, proposals: 0, opened: 0, rows: 0, inserted: 0,
    ticks: 0, windowFrom: 0, windowTo: 0, coverage: [],
    censored: { horizon: 0, ticksExhausted: 0 }, skipped,
  });
  if (ladder.specs.length === 0) {
    // 影が1本も作れない = 非公開ラダーが読み込まれていない。黙って0件を積まない。
    throw new Error('影の決済仕様が0件です(非公開ラダー未読込)。再生しても記録は作れません');
  }
  initReplaySchema(dep.shadow);   // CREATE IF NOT EXISTS(単独で呼ばれても表が在ることを保証する)
  if (!force && isDayReplayed(dep.shadow, sessionDate, ladder.epoch)) return empty(true);

  const cov = new Coverage(sessionDate, ladder.epoch);
  const range = sessionDateRange(sessionDate);
  const all = readProposals(dep.gen, range.start, range.end);
  // 武装時刻がその取引日に属するものだけを対象にする(境界の 15:45〜17:00 等は取引日を持たない)。
  const targets: ReplayProposal[] = [];
  for (const p of all) {
    if (classifySession(p.armedT)?.sessionDate === sessionDate) targets.push(p);
    else cov.add(p.epoch, 'armed-outside-session', `armedT=${p.armedT}`);
  }
  if (targets.length === 0) {
    const rows = cov.rows();
    const c = recordCoverage(dep.shadow, rows, dep.now(), { replace: force });
    recordReplayDay(dep.shadow, {
      sessionDate, ladderEpoch: ladder.epoch, windowFrom: range.start, windowTo: range.start,
      ticks: 0, proposals: 0, opened: 0, rowsWritten: 0, doneAt: dep.now(),
    }, { replace: force });
    return { ...empty(false), coverage: rows, ...(force ? { replaced: 0, changed: 0, coverageChanged: c.changed } : {}) };
  }

  // ★ティックの窓: 最初の武装の「価格復元ぶん」手前から、最後の武装 + 地平 まで(+1ms は
  //   ちょうど地平に当たるティックを含めるため=打ち切り理由が窓の都合で 'horizon' から
  //   'ticks_exhausted' にすり替わらないようにする)。
  const windowFrom = targets[0]!.armedT - liveMaxAgeMs;
  const windowTo = targets[targets.length - 1]!.armedT + horizonMs + 1;
  const ticks = getArchiveTicks(dep.ticks, dep.symbol, windowFrom, windowTo);

  const sim = new ShadowSim({
    ladder: ladderFn, horizonMs,
    maxOpenShadows: dep.maxOpenShadows ?? REPLAY_MAX_OPEN_SHADOWS,
    log: dep.log,
  });

  // 提案ごとに「開く位置(最初の t>=armedT のティック)」と「ARM 時点の価格」を先に決める(決定論)。
  interface Pending { p: ReplayProposal; openAt: number; live: number; plan: ShadowPlan }
  const pending: Pending[] = [];
  for (const p of targets) {
    if (!p.plan) { cov.add(p.epoch, 'bad-plan', p.planError); continue; }
    const before = lastIndexAtOrBefore(ticks, p.armedT);
    const live = before >= 0 && p.armedT - ticks[before]!.t <= liveMaxAgeMs ? ticks[before]!.price : null;
    if (live == null) {
      // ★門は「その瞬間のライブ価格」を要求する。復元できない提案を素通しで影にすると、
      //   A と別の母集団になったことが記録から見えなくなる。数えて落とす。
      cov.add(p.epoch, 'no-live-price', before >= 0 ? `直近tickが${Math.round((p.armedT - ticks[before]!.t) / 1000)}秒前` : 'ARM 以前のtickが無い');
      continue;
    }
    const gate = applyArmGates(p.plan, live, p.armedT, p.vetoFired);
    if (!gate.ok) { cov.add(p.epoch, gate.gate, gate.reason.slice(0, 200)); continue; }
    const openAt = firstIndexAtOrAfter(ticks, p.armedT);
    if (openAt < 0) { cov.add(p.epoch, 'no-ticks', `armedT=${p.armedT} 以後のtickが無い`); continue; }
    pending.push({ p, openAt, live, plan: gate.plan });
  }
  // 開く順は「開く位置 → 武装時刻 → id」で完全に決まる(targets は既に整列済み)。
  pending.sort((a, b) => (a.openAt - b.openAt) || (a.p.armedT - b.p.armedT) || (a.p.id < b.p.id ? -1 : 1));

  const rows: ShadowRow[] = [];
  const openedIds = new Set<string>();
  let cursor = 0;
  for (let i = 0; i < ticks.length; i++) {
    while (cursor < pending.length && pending[cursor]!.openAt === i) {
      const { p, live, plan } = pending[cursor]!;
      cursor += 1;
      const r = sim.open({
        proposalId: p.id, source: 'generator', plan, now: p.armedT,
        armedPrice: live, extra: { vetoFired: p.vetoFired },
      });
      if (r.ok) { openedIds.add(p.id); cov.add(p.epoch, 'replayed'); }
      else cov.add(p.epoch, 'sim-rejected', `${r.reason}: ${r.detail}`);
    }
    const t = ticks[i]!;
    sim.feed(t.price, t.t);
    const drained = sim.drainRows();
    if (drained.length > 0) rows.push(...drained);
  }
  // ティックが尽きた = 観測の終わり。生きている影は **打ち切り**(決済にしない)。
  sim.closeAll('ticks_exhausted');
  rows.push(...sim.drainRows());

  // ★途中でティックが切れた提案を数える(打ち切りで終わった影を1本でも持つ提案)。
  const truncated = new Map<string, string>();
  for (const r of rows) {
    if (r.censored && r.censorReason === 'ticks_exhausted') truncated.set(r.proposalId, r.epoch);
  }
  const epochOf = new Map(targets.map(p => [p.id, p.epoch]));
  for (const id of truncated.keys()) cov.add(epochOf.get(id) ?? '(unknown)', 'ticks_exhausted', 'ティックが尽きて打ち切り');

  // ★行を書く **前** に「変種 ↔ spec」の対応を記録する(shadowStore.ts の doc の契約)。
  recordShadowLadderMeta(dep.shadow, ladder);
  // ★force = 強制再計算。一意鍵に結果の値が入っていない以上、IGNORE のままでは
  //   「実装を直して再生し直しても DB は古い結果のまま」になる(db/shadowStore.ts の節を参照)。
  const ins = insertShadowRows(dep.shadow, rows, { replace: force });
  const covRows = cov.rows();
  const covRes = recordCoverage(dep.shadow, covRows, dep.now(), { replace: force });
  recordReplayDay(dep.shadow, {
    sessionDate, ladderEpoch: ladder.epoch, windowFrom, windowTo,
    ticks: ticks.length, proposals: targets.length, opened: openedIds.size,
    rowsWritten: ins.inserted + (ins.replaced ?? 0), doneAt: dep.now(),
  }, { replace: force });
  const stats = sim.stats();
  if (stats.errors > 0) dep.log(`★${sessionDate}: 影の内部エラー ${stats.errors} 件(記録が欠けている可能性)`);
  // ★打ち切りは **毎日必ず** 出す(0 件でも)。事前登録は打ち切りでないもので母集団を切るが、
  //   打ち切り率は spec に依存するので、切る前の数が無いと選択バイアスの大きさを後から測れない。
  //   spec 別 × 時間帯別の内訳は shadow_exits の行から出せる(db/shadowStore.ts の shadowCensorByHour)。
  const censored = countCensored(rows);
  dep.log(`${sessionDate} 打ち切り: horizon=${censored.horizon} ticks_exhausted=${censored.ticksExhausted}`
    + `(影の行 ${rows.length} 件中 / 地平 ${Math.round(horizonMs / 60_000)}分)`);
  return {
    sessionDate, ladderEpoch: ladder.epoch,
    proposals: targets.length, opened: openedIds.size,
    rows: rows.length, inserted: ins.inserted,
    ...(force ? { replaced: ins.replaced, changed: ins.changed, coverageChanged: covRes.changed } : {}),
    ticks: ticks.length, windowFrom, windowTo, coverage: covRows, censored, skipped: false,
  };
}

export interface ReplayRunResult {
  ladderEpoch: string;
  days: DayResult[];
  /** まだ再生してよい時刻に達していない取引日(=次回以降に回る)。 */
  pendingDays: string[];
  /** 取引日が付いていない提案の件数(場外に記録された=どの日にも入らない)。 */
  withoutSessionDate: number;
}

export interface ReplayRunOptions {
  /** 1回の実行で再生する取引日の上限(0/未指定=無制限)。 */
  maxDays?: number;
  /** この取引日だけを再生する(検証用)。 */
  onlyDay?: string;
  /** ★完了印を無視して **本当に再計算して置き換える**(検証用)。
   *  行数は増えない(一意鍵が同じなら1行のまま)が、中身は新しい計算結果で上書きされる。
   *  何行を上書きし、そのうち何行の結末が変わったかは DayResult.replaced / .changed に出る。 */
  force?: boolean;
}

/** 未再生の取引日を古い順に再生する。★何度走らせても記録は増えない(冪等)。 */
export function runReplay(dep: ReplayDeps, opts: ReplayRunOptions = {}): ReplayRunResult {
  initReplaySchema(dep.shadow);
  const ladder = (dep.ladder ?? getShadowExitLadder)();
  const horizonMs = dep.horizonMs ?? SHADOW_HORIZON_MS;
  const now = dep.now();
  const all = opts.onlyDay ? [opts.onlyDay] : readCandidateDays(dep.gen);
  const days: DayResult[] = [];
  const pendingDays: string[] = [];
  for (const d of all) {
    if (!opts.onlyDay && !isDayReplayable(d, now, horizonMs)) { pendingDays.push(d); continue; }
    if (!opts.force && isDayReplayed(dep.shadow, d, ladder.epoch)) continue;
    days.push(replayDay(dep, d, { force: opts.force }));
    if (opts.maxDays && days.length >= opts.maxDays) break;
  }
  return {
    ladderEpoch: ladder.epoch, days, pendingDays,
    withoutSessionDate: countProposalsWithoutSessionDate(dep.gen),
  };
}
