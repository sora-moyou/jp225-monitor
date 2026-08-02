// ─── ★打ち切りを無音にしない(D4 の記録側) ──────────────────────────────────────
//
// 何を守っているか:
//   母集団を「打ち切りでないもの」で切ると、**打ち切り率が spec に依存する** ぶんだけ選択バイアスが入る。
//   だから再生は毎日、**0件でも** 打ち切りの件数を出す(「今日は0件だった」と「数えていない」を区別する)。
//   実データ3日では打ち切り0件だったが、それは3日の話でしかない。
//
// ★否定対照: git show HEAD:server/replay/replay.ts に戻すと、DayResult.censored が無く
//   打ち切りの行も出ないので、このファイルの2件が赤になる。
//
// ★このファイルは公開リポにも載る。実運用の決済の実数値は一切書かない(下の spec は合成)。

import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { openTickArchiveDb, sessionDateRange } from '../db/tickArchive.js';
import { openShadowDb } from '../db/shadowStore.js';
import { SHADOW_HORIZON_MS } from '../signalTrade/shadow/sim.js';
import { LIMIT_FILL_MARGIN_YEN } from '../signalTrade/decisions.js';
import type { ExitState, ShadowExitLadder } from '../signalTrade/exit/index.js';
import type { AiPlan } from '../llm/scalpPlan.js';
import { replayDay, countCensored, type ReplayDeps } from './replay.js';

// 合成の決済仕様(実運用の値ではない): 損切りは初期LCのまま動かさない。
const holdSpec = { name: 'shHold', paramClass: 'ratchet' as const, exit: (s: ExitState) => s.initialStop };
const ladder = (): ShadowExitLadder => ({
  epoch: 'test-censor-1', specs: [holdSpec],
  variantSpecs: { 'current': holdSpec.name, 'candidate-a': holdSpec.name },
});

const SYMBOL = 'NIY=F';
const DAY = '2026-06-01';
const NOW = sessionDateRange(DAY).end + SHADOW_HORIZON_MS + 10 * 24 * 3_600_000;

const plan: AiPlan = {
  direction: 'buy', rationale: '合成', refPrice: 38_050,
  limitEntry: 38_000, stopLossForLimit: 37_900,
  stopEntry: 38_100, stopLossForStop: 38_000,
};

function env(): { gen: DatabaseSync; ticks: DatabaseSync; shadow: DatabaseSync; logs: string[]; dep: ReplayDeps } {
  const gen = openGeneratorDb(':memory:');
  const ticks = openTickArchiveDb(':memory:');
  const shadow = openShadowDb(':memory:');
  const logs: string[] = [];
  const dep: ReplayDeps = {
    gen, ticks, shadow, symbol: SYMBOL, now: () => NOW, log: (m) => { logs.push(m); }, ladder,
  };
  return { gen, ticks, shadow, logs, dep };
}

function addProposal(gen: DatabaseSync, at: number, withPlan: AiPlan | null): void {
  const row: ProposalRow = {
    epoch: 'g1:test', cycleId: `c${at}`, arm: 'current', exitVariant: 'current', seq: 0,
    sessionDate: DAY, requestedAt: at - 5_000, respondedAt: at, latencyMs: 5_000,
    status: 'plan', skipReason: null, httpStatus: 200, error: null,
    retried: 0, retryCount: 0, preRetryReason: null,
    direction: withPlan?.direction ?? null, planJson: withPlan ? JSON.stringify(withPlan) : null,
    refPrice: withPlan?.refPrice ?? null, regime: null, confidence: null,
    noneReason: null, noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
    shotId: null, shotAgeMs: null, shotOrigin: null, contextOmittedJson: null, createdAt: at,
  };
  insertProposal(gen, row);
}

function addTicks(db: DatabaseSync, startT: number, prices: readonly number[], stepMs = 1_000): void {
  const st = db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?,?,?)');
  prices.forEach((p, i) => st.run(SYMBOL, startT + i * stepMs, p));
}

describe('★再生は打ち切りを毎日必ず出す(0件でも)', () => {
  it('ティックが尽きて打ち切りになった件数が結果とログに出る', () => {
    const { gen, ticks, shadow, logs, dep } = env();
    const t0 = sessionDateRange(DAY).start + 3_600_000;
    addProposal(gen, t0, plan);
    // 指値で約定したあと、損切りにも届かないままティックが尽きる → ticks_exhausted。
    addTicks(ticks, t0 - 2_000, [38_040, 38_050, 38_050, 38_000 - LIMIT_FILL_MARGIN_YEN, 38_010]);

    const r = replayDay(dep, DAY);

    expect(r.censored.ticksExhausted).toBe(1);
    expect(r.censored.horizon).toBe(0);
    expect(logs.some(l => l.includes('打ち切り: horizon=0 ticks_exhausted=1'))).toBe(true);
    // 打ち切りは決済として記録しない(pnl は無く、含み損益が残る)。
    const row = shadow.prepare('SELECT censored, censor_reason AS r, pnl, unrealized FROM shadow_exits').get() as
      { censored: number; r: string; pnl: number | null; unrealized: number | null };
    expect(row).toEqual({ censored: 1, r: 'ticks_exhausted', pnl: null, unrealized: expect.any(Number) });
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('★打ち切りが1件も無い日でも「0件」と出す(無音にしない)', () => {
    const { gen, ticks, shadow, logs, dep } = env();
    const t0 = sessionDateRange(DAY).start + 3_600_000;
    addProposal(gen, t0, plan);
    // 約定 → 初期LCに当たって決済(打ち切りは起きない)。
    addTicks(ticks, t0 - 2_000, [38_040, 38_050, 38_050, 38_000 - LIMIT_FILL_MARGIN_YEN, 37_890]);

    const r = replayDay(dep, DAY);

    expect(r.censored).toEqual({ horizon: 0, ticksExhausted: 0 });
    expect(logs.some(l => l.includes('打ち切り: horizon=0 ticks_exhausted=0'))).toBe(true);
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('countCensored は理由ごとに数える(純関数)', () => {
    const mk = (censored: boolean, reason: 'horizon' | 'ticks_exhausted' | null): { censored: boolean; censorReason: string | null } =>
      ({ censored, censorReason: reason });
    const rows = [mk(true, 'horizon'), mk(true, 'ticks_exhausted'), mk(true, 'horizon'), mk(false, null)];
    expect(countCensored(rows as never)).toEqual({ horizon: 2, ticksExhausted: 1 });
  });
});
