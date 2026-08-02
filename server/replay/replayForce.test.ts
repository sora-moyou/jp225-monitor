import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { openTickArchiveDb, sessionDateRange } from '../db/tickArchive.js';
import { openShadowDb, countShadowRows } from '../db/shadowStore.js';
import { SHADOW_HORIZON_MS } from '../signalTrade/shadow/sim.js';
import { LIMIT_FILL_MARGIN_YEN } from '../signalTrade/decisions.js';
import type { ExitState, ShadowExitLadder } from '../signalTrade/exit/index.js';
import type { AiPlan } from '../llm/scalpPlan.js';
import { runReplay, type ReplayDeps } from './replay.js';
import { countCoverage, countReplayDays } from './store.js';

// ─── ★B3: 「強制再計算」が本当に再計算して置き換わること ─────────────────────────
//
// 何が壊れていたか:
//   影の行の一意鍵は UNIQUE(epoch, source, proposal_id, spec)、覆域の一意鍵は
//   UNIQUE(session_date, ladder_epoch, epoch, reason) で、**どちらも結果の値が入っていない**。
//   そこへ INSERT OR IGNORE だけを持っていたので、決済の実装を直して force で再生し直しても
//     「鍵が同じ → 無視 → 報告は inserted:0 → DB の中身は古い結果のまま」
//   になっていた。報告の 0 は「変わらなかった」と読めるので、**バグを直してもデータが直らず、
//   しかも成功に見える**。一番危ない形。
//
// ★このテストはサブリーダーと同じ実験をする:
//   ① ある決済仕様で再生 → ② **決済の計算を変える** → ③ force で再生 → ④ DB の中身を読む。
//   中身が新しい計算結果に置き換わっていること・置き換えた件数が報告に出ることを固定する。
//
// ★否定対照(修正前 = git show HEAD:server/db/shadowStore.ts + HEAD:server/replay/store.ts +
//   HEAD:server/replay/replay.ts): force でも IGNORE のままなので、
//   「中身が新しい結果になっている」「replaced/changed が報告される」が全部 **赤**。
//
// ★このファイルは公開リポにも載る。**実運用の決済の実数値は一切書かない**(下の spec は合成)。

const SYMBOL = 'NIY=F';
const GEN_EPOCH = 'g1:forceepoch';
const DAY = '2026-06-01';
const NOW = sessionDateRange(DAY).end + SHADOW_HORIZON_MS + 10 * 24 * 3_600_000;
const LADDER_EPOCH = 'test-force-ladder';

/** 合成の決済仕様。「床をどこに置くか」だけを差し替えて **結末が変わる** ようにする。 */
function ladderWith(floorPt: number): () => ShadowExitLadder {
  const spec = {
    name: 'shForce', paramClass: 'ratchet' as const,
    exit: (s: ExitState): number | null => {
      if (!Number.isFinite(s.initialStop)) return null;
      if (s.peakProfit < 50) return s.initialStop;
      const floor = s.direction === 'buy' ? s.entryPrice + floorPt : s.entryPrice - floorPt;
      return s.direction === 'buy' ? Math.max(s.initialStop, floor) : Math.min(s.initialStop, floor);
    },
  };
  return () => ({ epoch: LADDER_EPOCH, specs: [spec], variantSpecs: { 'current': spec.name, 'candidate-a': spec.name } });
}

function buyPlan(): AiPlan {
  return {
    direction: 'buy', rationale: '合成', refPrice: 38_050,
    limitEntry: 38_000, stopLossForLimit: 37_900,
    stopEntry: 38_100, stopLossForStop: 38_000,
  };
}
const FILL_PRICE = 38_000 - LIMIT_FILL_MARGIN_YEN;   // 指値が約定する価格(本番の規約)
/** 1秒刻みの合成ティック(t0-2秒 から)。指値で約定 → +150 まで伸びる → じわ下げ。 */
const PRICES = [38_040, 38_050, 38_050, FILL_PRICE, 38_150, 38_120, 38_060, 38_010, 37_900];

let seq = 0;
function addProposal(gen: DatabaseSync, at: number, plan: AiPlan): void {
  seq += 1;
  const row: ProposalRow = {
    epoch: GEN_EPOCH, cycleId: `f${seq}`, arm: 'current', exitVariant: 'current', seq: 0,
    sessionDate: DAY, requestedAt: at - 5_000, respondedAt: at, latencyMs: 5_000,
    status: 'plan', skipReason: null, httpStatus: 200, error: null,
    retried: 0, retryCount: 0, preRetryReason: null,
    direction: plan.direction, planJson: JSON.stringify(plan),
    refPrice: plan.refPrice, regime: null, confidence: null,
    noneReason: null, noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
    shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: at,
  };
  insertProposal(gen, row);
}

function addTicks(db: DatabaseSync, startT: number, prices: readonly number[], stepMs = 1_000): void {
  const st = db.prepare('INSERT OR IGNORE INTO ticks (symbol, t, price) VALUES (?,?,?)');
  prices.forEach((p, i) => st.run(SYMBOL, startT + i * stepMs, p));
}

/** 影の行の結末(=これが置き換わったかどうかを見る)。 */
function outcomes(db: DatabaseSync): Array<{ spec: string; exit_price: number | null; pnl: number | null }> {
  return db.prepare('SELECT spec, exit_price, pnl FROM shadow_exits ORDER BY proposal_id, spec')
    .all() as unknown as Array<{ spec: string; exit_price: number | null; pnl: number | null }>;
}

function newEnv(floorPt: number): { gen: DatabaseSync; ticks: DatabaseSync; shadow: DatabaseSync; dep: ReplayDeps } {
  const gen = openGeneratorDb(':memory:');
  const ticks = openTickArchiveDb(':memory:');
  const shadow = openShadowDb(':memory:');
  const dep: ReplayDeps = {
    gen, ticks, shadow, symbol: SYMBOL, now: () => NOW, log: () => { /* 静かに */ },
    ladder: ladderWith(floorPt),
  };
  return { gen, ticks, shadow, dep };
}

describe('★REPLAY_FORCE は本当に再計算して置き換える', () => {
  it('実装(床の位置)を変えて force で再生すると、DB の結末が新しい計算結果に置き換わる', () => {
    const { gen, ticks, shadow, dep } = newEnv(20);
    const t0 = sessionDateRange(DAY).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    // 指値レッグで約定 → 含み益ピーク(+150) → じわ下げ。床 20 なら 38_010 で、床 60 なら 38_060 で当たる。
    addTicks(ticks, t0 - 2_000, PRICES);

    const first = runReplay(dep);
    expect(first.days.filter(d => !d.skipped)).toHaveLength(1);
    const before = outcomes(shadow);
    expect(before).toHaveLength(1);
    expect(before[0]!.exit_price).not.toBeNull();
    const snapshot = { rows: countShadowRows(shadow), cov: countCoverage(shadow), days: countReplayDays(shadow) };

    // ── ② 決済の計算を変える(=バグを直したのと同じ状況)
    const dep2: ReplayDeps = { ...dep, ladder: ladderWith(60) };

    // ── ③ force で再生
    const forced = runReplay(dep2, { force: true });
    const day = forced.days.find(d => !d.skipped)!;

    // ── ④ ★中身が本当に置き換わっている
    const after = outcomes(shadow);
    expect(after[0]!.exit_price).not.toBe(before[0]!.exit_price);
    expect(after[0]!.pnl).not.toBe(before[0]!.pnl);

    // ★報告が「0件でした」に見えない: 上書きした件数と、結末が変わった件数が出る。
    expect(day.inserted).toBe(0);          // 行数は増えない(鍵が同じ)
    expect(day.replaced).toBe(1);
    expect(day.changed).toBe(1);

    // 冪等性は壊さない(行数・覆域・完了印は増えない)。
    expect(countShadowRows(shadow)).toBe(snapshot.rows);
    expect(countCoverage(shadow)).toBe(snapshot.cov);
    expect(countReplayDays(shadow)).toBe(snapshot.days);
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('実装を変えずに force しても結末は変わらない(changed=0)= 「変わらなかった」と「やっていない」を区別できる', () => {
    const { gen, ticks, shadow, dep } = newEnv(20);
    const t0 = sessionDateRange(DAY).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, PRICES);
    runReplay(dep);
    const day = runReplay(dep, { force: true }).days.find(d => !d.skipped)!;
    expect(day.replaced).toBe(1);
    expect(day.changed).toBe(0);           // ★上書きはした / 答えは同じだった
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('★覆域の件数も置き換わる(n は一意鍵に入っていないので、放置すると初回のまま固定される)', () => {
    const { gen, ticks, shadow, dep } = newEnv(20);
    const t0 = sessionDateRange(DAY).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, PRICES);
    runReplay(dep);
    const cov1 = shadow.prepare("SELECT n FROM replay_coverage WHERE reason = 'replayed'").get() as { n: number };
    expect(cov1.n).toBe(1);

    // 提案を増やす = 同じ (session_date, ladder_epoch, epoch, reason) の件数が変わる状況。
    addProposal(gen, t0 + 2_000, buyPlan());
    const day = runReplay(dep, { force: true }).days.find(d => !d.skipped)!;
    const cov2 = shadow.prepare("SELECT n FROM replay_coverage WHERE reason = 'replayed'").get() as { n: number };
    expect(cov2.n).toBe(2);                // ★初回の 1 のまま固定されない
    expect(day.coverageChanged).toBe(1);
    for (const db of [gen, ticks, shadow]) db.close();
  });

  it('★通常の再生(force なし)は従来どおり冪等 = 上書きしない', () => {
    const { gen, ticks, shadow, dep } = newEnv(20);
    const t0 = sessionDateRange(DAY).start + 10 * 60_000;
    addProposal(gen, t0, buyPlan());
    addTicks(ticks, t0 - 2_000, PRICES);
    runReplay(dep);
    const before = outcomes(shadow);
    // 実装を変えても、force を付けなければ完了印で飛ばして触らない(=従来の契約)。
    const dep2: ReplayDeps = { ...dep, ladder: ladderWith(60) };
    const res = runReplay(dep2);
    expect(res.days.filter(d => !d.skipped)).toHaveLength(0);
    expect(outcomes(shadow)).toEqual(before);
    for (const db of [gen, ticks, shadow]) db.close();
  });
});
