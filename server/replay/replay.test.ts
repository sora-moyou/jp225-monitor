// オフライン再生(提案 + 保管ティック → 影30通り)の検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   - server/replay/*.ts が無いため import 段で解決できず、このファイルは全部赤。
//   - 影の行を INSERT OR IGNORE でなく素の INSERT で書く実装 / 取引日の完了印を持たない実装では
//     『2回走らせても1行も増えない』が赤になる(冪等性の否定対照)。
//   - 取引日ごとに ShadowSim を作り直さず、途中の tick で中断・再開する実装では
//     『中断して再開した結果が通しと一致する』が赤になる(再開可能性の否定対照)。
//   - 地平を「固定時間で切る」実装(打ち切りを決済として記録する / 地平の判定を advance の後に置く)では
//     『打ち切りは決済として記録しない』が赤になる。
//   - 門(sanity/refstale/stale/recheck)を通さない実装では『門で落ちた件数が記録される』が赤になる。
//
// ★このファイルは公開リポにも載る。**実運用の決済の実数値は一切書かない**(下の spec は合成)。

import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { openTickArchiveDb } from '../db/tickArchive.js';
import { openShadowDb, countShadowRows, readShadowLadderMeta } from '../db/shadowStore.js';
import { sessionDateRange } from '../db/tickArchive.js';
import { SHADOW_HORIZON_MS } from '../signalTrade/shadow/sim.js';
import { LIMIT_FILL_MARGIN_YEN, STOP_SLIPPAGE_YEN } from '../signalTrade/decisions.js';
import type { ExitState, ShadowExitLadder } from '../signalTrade/exit/index.js';
import type { AiPlan } from '../llm/scalpPlan.js';
import { replayDay, runReplay, isDayReplayable, lastIndexAtOrBefore, firstIndexAtOrAfter, type ReplayDeps } from './replay.js';
import { countCoverage, countReplayDays, coverageTotals } from './store.js';

// ── 合成の決済仕様(実運用の値ではない) ─────────────────────────────────────
const holdSpec = { name: 'shHold', paramClass: 'ratchet' as const, exit: (s: ExitState) => s.initialStop };
const ratchetSpec = {
  name: 'shRatchet', paramClass: 'ratchet' as const,
  exit: (s: ExitState): number | null => {
    if (!Number.isFinite(s.initialStop)) return null;
    if (s.peakProfit < 100) return s.initialStop;
    const floor = s.direction === 'buy' ? s.entryPrice + 50 : s.entryPrice - 50;
    return s.direction === 'buy' ? Math.max(s.initialStop, floor) : Math.min(s.initialStop, floor);
  },
};
const LADDER_EPOCH = 'test-ladder-1';
const ladder = (): ShadowExitLadder => ({
  epoch: LADDER_EPOCH, specs: [holdSpec, ratchetSpec],
  variantSpecs: { 'current': holdSpec.name, 'candidate-a': ratchetSpec.name },
});

const SYMBOL = 'NIY=F';
const GEN_EPOCH = 'g1:testepoch';
const DAYS = ['2026-06-01', '2026-06-02', '2026-06-03'];
/** どの日も「もう増えない」時刻(=再生してよい)。 */
const NOW = sessionDateRange(DAYS[2]!).end + SHADOW_HORIZON_MS + 10 * 24 * 3_600_000;

/** 合成の買い計画(2レッグ・現値 38_050 を挟む)。 */
function buyPlan(over: Partial<AiPlan> = {}): AiPlan {
  return {
    direction: 'buy', rationale: '合成', refPrice: 38_050,
    limitEntry: 38_000, stopLossForLimit: 37_900,
    stopEntry: 38_100, stopLossForStop: 38_000,
    ...over,
  };
}
const FILL_PRICE = 38_000 - LIMIT_FILL_MARGIN_YEN;   // 指値が約定する価格(本番の規約)

let seq = 0;
function addProposal(gen: DatabaseSync, at: number, plan: AiPlan | null, over: Partial<ProposalRow> = {}): string {
  seq += 1;
  const cycleId = `c${seq}`;
  const row: ProposalRow = {
    epoch: GEN_EPOCH, cycleId, arm: 'current', exitVariant: 'current', seq: 0,
    sessionDate: '2026-06-01',
    requestedAt: at - 5_000, respondedAt: at, latencyMs: 5_000,
    status: 'plan', skipReason: null, httpStatus: 200, error: null,
    retried: 0, retryCount: 0, preRetryReason: null,
    direction: plan?.direction ?? 'buy',
    planJson: plan ? JSON.stringify(plan) : null,
    refPrice: plan?.refPrice ?? null, regime: null, confidence: null,
    noneReason: null, noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
    shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: at,
    ...over,
  };
  insertProposal(gen, row);
  return `${row.epoch}/${row.cycleId}/${row.arm}`;
}

function addTicks(db: DatabaseSync, startT: number, prices: readonly number[], stepMs = 1_000): void {
  const st = db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?,?,?)');
  prices.forEach((p, i) => st.run(SYMBOL, startT + i * stepMs, p));
}

interface Env { gen: DatabaseSync; ticks: DatabaseSync; shadow: DatabaseSync; dep: ReplayDeps }
function newEnv(over: Partial<ReplayDeps> = {}): Env {
  const gen = openGeneratorDb(':memory:');
  const ticks = openTickArchiveDb(':memory:');
  const shadow = openShadowDb(':memory:');
  const dep: ReplayDeps = {
    gen, ticks, shadow, symbol: SYMBOL, now: () => NOW, log: () => { /* 静かに */ },
    ladder, ...over,
  };
  return { gen, ticks, shadow, dep };
}
function allRows(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT epoch, source, proposal_id, spec, dir, armed_t, entry_t, entry_price, exit_t, exit_price, exit_reason, pnl, outcome, censored, censor_reason, unrealized, mfe, mae, hold_ms, elapsed_ms, horizon_ms, concurrent, ticks FROM shadow_exits ORDER BY proposal_id, spec').all() as unknown[];
}

describe('二分探索(価格の復元位置)', () => {
  const ts = [{ symbol: SYMBOL, t: 10, price: 1 }, { symbol: SYMBOL, t: 20, price: 2 }, { symbol: SYMBOL, t: 30, price: 3 }];
  it('t 以下の最後 / t 以上の最初', () => {
    expect(lastIndexAtOrBefore(ts, 9)).toBe(-1);
    expect(lastIndexAtOrBefore(ts, 20)).toBe(1);
    expect(lastIndexAtOrBefore(ts, 25)).toBe(1);
    expect(lastIndexAtOrBefore(ts, 99)).toBe(2);
    expect(firstIndexAtOrAfter(ts, 9)).toBe(0);
    expect(firstIndexAtOrAfter(ts, 20)).toBe(1);
    expect(firstIndexAtOrAfter(ts, 21)).toBe(2);
    expect(firstIndexAtOrAfter(ts, 31)).toBe(-1);
  });
});

describe('再生の基本(提案 + ティック → 影)', () => {
  it('提案1件から spec ぶんの影を作り、両方の epoch を後から結合できる形で残す', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    const id = addProposal(gen, t0, buyPlan());
    // ARM 時点の価格(門に渡る live=38_050)→ 約定 → 初期LC で決済。
    addTicks(ticks, t0 - 2_000, [38_040, 38_045, 38_050, FILL_PRICE, 37_950, 37_900]);
    const r = replayDay(dep, day);
    expect(r.opened).toBe(1);
    expect(r.rows).toBe(2);
    expect(r.inserted).toBe(2);
    const rows = shadow.prepare('SELECT * FROM shadow_exits ORDER BY spec').all() as unknown as Array<Record<string, unknown>>;
    expect(rows.map(x => x.spec)).toEqual([holdSpec.name, ratchetSpec.name]);
    // ★影の epoch = 決済ラダーの版 / 提案の epoch は proposal_id に載る(別物を両方残す)。
    expect(rows[0]!.epoch).toBe(LADDER_EPOCH);
    expect(rows[0]!.proposal_id).toBe(id);
    expect(String(rows[0]!.proposal_id).startsWith(`${GEN_EPOCH}/`)).toBe(true);
    expect(rows[0]!.source).toBe('generator');
    // 本番の約定/決済の規約がそのまま出る(建値=指値・逆指値決済は逆指値価格ちょうど)。
    expect(rows[0]!.entry_price).toBe(38_000);
    expect(rows[0]!.outcome).toBe('exit');
    expect(rows[0]!.exit_price).toBe(37_900 - STOP_SLIPPAGE_YEN);
    expect(rows[0]!.armed_price).toBe(38_050);   // ARM 時刻の価格(直前/同時刻のティック)
    // ★対応表(変種 ↔ spec)は行を書く前に記録されている。
    expect(readShadowLadderMeta(shadow, LADDER_EPOCH)).toEqual({ 'candidate-a': ratchetSpec.name, 'current': holdSpec.name });
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('地平は ShadowSim の既定(固定の短い時間で切らない)', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, [38_040, 38_045, FILL_PRICE, 37_900]);
    const r = replayDay(dep, day);
    // ティックの窓は「最後の武装 + 地平」まで伸ばす(窓の都合で打ち切りを増やさない)。
    expect(r.windowTo).toBe(t0 + SHADOW_HORIZON_MS + 1);
    const horizons = shadow.prepare('SELECT DISTINCT horizon_ms AS h FROM shadow_exits').all() as unknown as Array<{ h: number }>;
    expect(horizons).toEqual([{ h: SHADOW_HORIZON_MS }]);
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('重なる影(前の影が生きているうちに次が始まる)を同時生存本数で残す', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    const a = addProposal(gen, t0, buyPlan());
    const b = addProposal(gen, t0 + 60_000, buyPlan());
    // 60秒間 約定しない価格 → 2件目が開くとき1件目の2本がまだ生きている。
    const prices = Array.from({ length: 200 }, () => 38_050);
    addTicks(ticks, t0 - 2_000, [...prices, 37_800]);
    const r = replayDay(dep, day);
    expect(r.opened).toBe(2);
    const conc = shadow.prepare('SELECT proposal_id, MAX(concurrent) AS c FROM shadow_exits GROUP BY proposal_id ORDER BY proposal_id').all() as unknown as Array<{ proposal_id: string; c: number }>;
    expect(conc.find(x => x.proposal_id === a)!.c).toBe(2);
    expect(conc.find(x => x.proposal_id === b)!.c).toBe(4);   // 自分2本 + 生存中の2本
    for (const db of [gen, ticks, shadow]) db.close();
  });
});

describe('★打ち切りは「決済」として記録しない', () => {
  it('地平に達した影は censored(exit にしない)', () => {
    const horizonMs = 60_000;
    const { gen, ticks, shadow, dep } = newEnv({ horizonMs });
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    // 約定した後、地平のちょうどその tick で初期LC を割る価格を出す。
    // ★地平の判定を advance の後に置いた実装ではこの tick が「決済」になり、このテストは赤になる。
    addTicks(ticks, t0 - 2_000, [38_040, 38_045, 38_050, FILL_PRICE], 1_000);
    addTicks(ticks, t0 + horizonMs, [37_800], 1_000);
    const r = replayDay(dep, day);
    expect(r.rows).toBe(2);
    const rows = shadow.prepare('SELECT outcome, censor_reason, exit_t, pnl, unrealized FROM shadow_exits').all() as unknown as Array<Record<string, unknown>>;
    for (const x of rows) {
      expect(x.outcome).toBe('censored');
      expect(x.censor_reason).toBe('horizon');
      expect(x.exit_t).toBeNull();
      expect(x.pnl).toBeNull();
      expect(x.unrealized).not.toBeNull();
    }
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('ティックが途中で切れた提案は「打ち切り」+ 覆域に理由を残す', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, [38_040, 38_045, 38_050, FILL_PRICE]);   // 約定した直後にティックが尽きる
    const r = replayDay(dep, day);
    const rows = shadow.prepare('SELECT outcome, censor_reason FROM shadow_exits').all() as unknown as Array<Record<string, unknown>>;
    expect(rows.every(x => x.outcome === 'censored' && x.censor_reason === 'ticks_exhausted')).toBe(true);
    expect(r.coverage.find(c => c.reason === 'ticks_exhausted')?.n).toBe(1);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});

describe('★覆えなかった範囲を無音にしない', () => {
  it('門ごと・欠測ごとに件数と理由を記録する', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const base = sessionDateRange(day).start + 10 * 60_000;
    addTicks(ticks, base - 2_000, [38_040, 38_045], 1_000);      // 価格が在るのは base 近辺だけ
    addTicks(ticks, base + 1_000, Array.from({ length: 60 }, () => 38_050), 1_000);

    addProposal(gen, base, buyPlan());                                                  // replayed
    addProposal(gen, base + 1_000, buyPlan({ limitEntry: 38_100, stopEntry: undefined, stopLossForStop: undefined })); // sanity
    // 計画時価格に対しては健全だが、ARM 時価格(38_050)から 300円 離れている → refstale
    addProposal(gen, base + 2_000, buyPlan({
      refPrice: 38_350, limitEntry: 38_300, stopLossForLimit: 38_200, stopEntry: 38_400, stopLossForStop: 38_300,
    }));
    addProposal(gen, base + 3_000, buyPlan({ limitEntry: 38_500, stopLossForLimit: 38_400, stopEntry: undefined, stopLossForStop: undefined, refPrice: 38_600 })); // refstale(遠い計画)
    addProposal(gen, base + 4_000, null, { direction: 'buy' });                          // bad-plan
    addProposal(gen, base + 5_000, { direction: 'range', rationale: 'r', refPrice: 38_050, range: { upper: { side: 'sell', type: 'limit', entry: 38_200, stopLoss: 38_300 } } }, { direction: 'range' }); // not-directional
    // ★ティックがまったく無い時間帯(価格が復元できない)
    addProposal(gen, base + 30 * 60_000, buyPlan());                                     // no-live-price

    const r = replayDay(dep, day);
    const byReason = Object.fromEntries(r.coverage.map(c => [c.reason, c.n]));
    expect(byReason.replayed).toBe(1);
    expect(byReason.sanity).toBe(1);
    expect(byReason.refstale).toBe(2);
    expect(byReason['bad-plan']).toBe(1);
    expect(byReason['not-directional']).toBe(1);
    expect(byReason['no-live-price']).toBe(1);
    // 覆域は提案を1件も取りこぼさない(全部どれかの理由に入る)。
    const total = r.coverage.filter(c => c.reason !== 'ticks_exhausted').reduce((n, c) => n + c.n, 0);
    expect(total).toBe(r.proposals);
    // DB にも残る。
    expect(coverageTotals(shadow, LADDER_EPOCH).find(t => t.reason === 'sanity')!.n).toBe(1);
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('ARM 以後のティックが1本も無い提案は no-ticks として残す', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    const day = DAYS[0]!;
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, [38_040, 38_045], 1_000);   // t0 以後のティックが無い(最後は t0-1000)
    const r = replayDay(dep, day);
    expect(r.opened).toBe(0);
    expect(r.coverage.find(c => c.reason === 'no-ticks')?.n).toBe(1);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});

describe('★冪等(何度走らせても記録が増えない)', () => {
  it('同じ入力で2回走らせて、影の行も覆域も完了印も1行も増えない', () => {
    const { gen, ticks, shadow, dep } = newEnv();
    for (const day of DAYS) {
      const t0 = sessionDateRange(day).start + 10 * 60_000;
      addProposal(gen, t0, buyPlan(), { sessionDate: day });
      addTicks(ticks, t0 - 2_000, [38_040, 38_045, 38_050, FILL_PRICE, 38_150, 38_050, 37_900]);
    }
    const first = runReplay(dep);
    const snapshot = { rows: countShadowRows(shadow), cov: countCoverage(shadow), days: countReplayDays(shadow) };
    expect(snapshot.rows).toBeGreaterThan(0);
    expect(first.days.filter(d => !d.skipped)).toHaveLength(DAYS.length);

    const second = runReplay(dep);
    expect(second.days.filter(d => !d.skipped)).toHaveLength(0);   // 完了印で飛ばす
    expect(countShadowRows(shadow)).toBe(snapshot.rows);
    expect(countCoverage(shadow)).toBe(snapshot.cov);
    expect(countReplayDays(shadow)).toBe(snapshot.days);

    // ★完了印を無視して計算し直しても行は増えない(INSERT OR IGNORE の実証)。
    const forced = runReplay(dep, { force: true });
    expect(forced.days.filter(d => !d.skipped)).toHaveLength(DAYS.length);
    expect(forced.days.every(d => d.inserted === 0)).toBe(true);
    expect(countShadowRows(shadow)).toBe(snapshot.rows);
    expect(countCoverage(shadow)).toBe(snapshot.cov);
    expect(countReplayDays(shadow)).toBe(snapshot.days);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});

describe('★再開可能(途中で止めて再開しても通しと一致する)', () => {
  it('1日ずつ止めて再開した結果が、通しで走らせた結果と完全に一致する', () => {
    const gen = openGeneratorDb(':memory:');
    const ticks = openTickArchiveDb(':memory:');
    for (const day of DAYS) {
      const t0 = sessionDateRange(day).start + 10 * 60_000;
      addProposal(gen, t0, buyPlan(), { sessionDate: day });
      addProposal(gen, t0 + 30_000, buyPlan(), { sessionDate: day });
      addTicks(ticks, t0 - 20_000, [38_040, 38_045, 38_050, FILL_PRICE, 38_150, 38_120, 38_050, 37_900], 10_000);
    }
    const shadowFull = openShadowDb(':memory:');
    const shadowResume = openShadowDb(':memory:');
    const mk = (shadow: DatabaseSync): ReplayDeps => ({ gen, ticks, shadow, symbol: SYMBOL, now: () => NOW, log: () => { /* 静かに */ }, ladder });

    runReplay(mk(shadowFull));                       // 通し
    // 中断と再開: 1日ずつ(プロセスが落ちたつもりで毎回 runReplay を呼び直す)。
    for (let i = 0; i < DAYS.length; i++) runReplay(mk(shadowResume), { maxDays: 1 });

    expect(countShadowRows(shadowResume)).toBe(countShadowRows(shadowFull));
    expect(countShadowRows(shadowFull)).toBeGreaterThan(0);
    expect(allRows(shadowResume)).toEqual(allRows(shadowFull));
    expect(coverageTotals(shadowResume)).toEqual(coverageTotals(shadowFull));
    for (const db of [gen, ticks, shadowFull, shadowResume]) db.close();
  });
});

describe('まだ増えうる取引日は再生しない', () => {
  it('地平ぶんのティックが出揃うまでは再生を保留する(結果が2回目で変わるのを防ぐ)', () => {
    const day = DAYS[0]!;
    const end = sessionDateRange(day).end;
    expect(isDayReplayable(day, end + SHADOW_HORIZON_MS - 1, SHADOW_HORIZON_MS)).toBe(false);
    expect(isDayReplayable(day, end + SHADOW_HORIZON_MS + 3_600_000, SHADOW_HORIZON_MS)).toBe(true);

    const { gen, ticks, shadow, dep } = newEnv({ now: () => sessionDateRange(day).start });
    const t0 = sessionDateRange(day).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan(), { sessionDate: day });
    addTicks(ticks, t0 - 2_000, [38_040, 38_045, 38_050, FILL_PRICE, 37_900]);
    const r = runReplay(dep);
    expect(r.days).toHaveLength(0);
    expect(r.pendingDays).toEqual([day]);
    expect(countShadowRows(shadow)).toBe(0);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});

describe('非公開ラダーが無いときは黙って0件を積まない', () => {
  it('決済仕様が0件なら例外で止まる', () => {
    const { gen, ticks, shadow, dep } = newEnv({ ladder: () => ({ epoch: 'none', specs: [] }) });
    expect(() => replayDay(dep, DAYS[0]!)).toThrow(/決済仕様が0件/);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});
