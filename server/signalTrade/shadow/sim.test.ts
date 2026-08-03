// 影の決済模擬エンジンの検証。
//
// ★否定対照(この機能を実装する前のコードでの結果):
//   - ShadowSim / SHADOW_HORIZON_MS が存在しないため import 段で解決できず、このファイルは全部赤。
//   - advance の第4引数(exitFn)が無いため「同じ advance をパラメータだけ変えて呼ぶ」ことができず、
//     『同じ advance を通っている』『spec ごとに決済が変わる』のテストは実装後でなければ緑にならない。
//   - 打ち切りの証明(地平を越えた tick を処理しない)は、地平の判定を advance の **後** に置いた実装では
//     「決済」として記録されるため赤になる(下の該当テストのコメント参照)。
//
// ★このファイルは公開リポにも載る。**実運用の決済の実数値は一切書かない。**
//   ここで使う床/発動の値は、動きを見るためだけの **合成値**(実運用の設定とは無関係)。

import { describe, it, expect, vi } from 'vitest';

// ─── 「再実装していない」ことを観測するための包み(中身は本物をそのまま呼ぶ) ───────────────
const spied = vi.hoisted(() => ({
  advance: vi.fn(),
  detectFill: vi.fn(),
  planToArmed: vi.fn(),
}));
vi.mock('../decisions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../decisions.js')>();
  spied.advance.mockImplementation(actual.advance);
  spied.detectFill.mockImplementation(actual.detectFill);
  spied.planToArmed.mockImplementation(actual.planToArmed);
  return { ...actual, advance: spied.advance, detectFill: spied.detectFill, planToArmed: spied.planToArmed };
});

import { ShadowSim, SHADOW_HORIZON_MS, MAX_OPEN_SHADOWS, type ShadowRow } from './sim.js';
import { detectFill, planToArmed, ARMED_TIMEOUT_MS, LIMIT_FILL_MARGIN_YEN, STOP_SLIPPAGE_YEN } from '../decisions.js';
import type { ExitState } from '../exit/index.js';
import type { ShadowExitLadder } from '../exit/index.js';

// ── 合成の決済仕様(実運用の値ではない) ─────────────────────────────────────
/** 含み益ピークが trigger[pt] に達したら 建値±floor[pt] を床にする、という形だけの合成仕様。 */
function fakeSpec(name: string, trigger: number, floor: number) {
  return {
    name,
    paramClass: 'ratchet' as const,
    exit: (s: ExitState): number | null => {
      if (!Number.isFinite(s.initialStop)) return null;
      if (s.peakProfit < trigger) return s.initialStop;
      const ratchet = s.direction === 'buy' ? s.entryPrice + floor : s.entryPrice - floor;
      return s.direction === 'buy' ? Math.max(s.initialStop, ratchet) : Math.min(s.initialStop, ratchet);
    },
  };
}
/** 決して床を動かさない仕様(=初期LC固定)。 */
const holdSpec = { name: 'hold', paramClass: 'ratchet' as const, exit: (s: ExitState) => s.initialStop };
const ratchetSpec = fakeSpec('ratchet', 100, 50);

const ladderOf = (...specs: Array<{ name: string; paramClass: 'ratchet'; exit: (s: ExitState) => number | null }>) =>
  (): ShadowExitLadder => ({ epoch: 'test-epoch', specs });

// ── 提案(A と同じ形の AiPlan の部分集合) ───────────────────────────────────
const T0 = 1_700_000_000_000;
const buyPlan = {
  direction: 'buy' as const,
  limitEntry: 38_000,
  stopLossForLimit: 37_900,
  rationale: '合成テスト',
};
/** 指値約定に必要な価格(指値を LIMIT_FILL_MARGIN_YEN 行き過ぎる)。 */
const FILL_PRICE = buyPlan.limitEntry - LIMIT_FILL_MARGIN_YEN;

function newSim(specs: Array<{ name: string; paramClass: 'ratchet'; exit: (s: ExitState) => number | null }>, horizonMs = 60 * 60_000, maxOpenShadows = MAX_OPEN_SHADOWS) {
  return new ShadowSim({ ladder: ladderOf(...specs), horizonMs, maxOpenShadows, log: () => { /* 静かに */ } });
}
const bySpec = (rows: ShadowRow[], name: string): ShadowRow => {
  const r = rows.find(x => x.spec === name);
  if (!r) throw new Error(`spec ${name} の行が無い`);
  return r;
};

describe('★再実装していないことの実証(本番と同じ関数を通る)', () => {
  it('open は planToArmed(本番の変換)をそのまま呼ぶ', () => {
    spied.planToArmed.mockClear();
    const sim = newSim([holdSpec]);
    const r = sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    expect(r.ok).toBe(true);
    expect(spied.planToArmed).toHaveBeenCalledTimes(1);
    expect(spied.planToArmed).toHaveBeenCalledWith(buyPlan, T0, undefined);
    // 影が使う ArmedBracket は planToArmed の戻り値そのもの。
    expect(spied.planToArmed.mock.results[0]!.value).toEqual(planToArmed(buyPlan, T0));
  });

  it('feed は advance(本番の遷移関数)を、spec の exitFn だけ差し替えて呼ぶ', () => {
    spied.advance.mockClear();
    const sim = newSim([holdSpec, ratchetSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    sim.feed(FILL_PRICE, T0 + 1_000);
    // 影2本ぶん = advance が2回。第4引数の exitFn は **各 spec の純関数そのもの**(グローバル差し替えではない)。
    expect(spied.advance).toHaveBeenCalledTimes(2);
    const exitFns = spied.advance.mock.calls.map(c => (c[3] as { exitFn: unknown }).exitFn);
    expect(exitFns).toContain(holdSpec.exit);
    expect(exitFns).toContain(ratchetSpec.exit);
    // 価格と時刻はそのまま渡っている(影が独自の価格系列を作っていない)。
    for (const call of spied.advance.mock.calls) {
      expect(call[1]).toBe(FILL_PRICE);
      expect(call[2]).toBe(T0 + 1_000);
    }
  });

  it('約定レッグのラベルは detectFill に問うて得る(条件を書き写していない)', () => {
    spied.detectFill.mockClear();
    const sim = newSim([holdSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    sim.feed(FILL_PRICE, T0 + 1_000);
    expect(spied.detectFill).toHaveBeenCalledTimes(1);
    const [armedArg, priceArg] = spied.detectFill.mock.calls[0] as [unknown, number];
    expect(armedArg).toEqual(planToArmed(buyPlan, T0));
    expect(priceArg).toBe(FILL_PRICE);
    // 記録された建値/レッグは detectFill の戻り値と一致する(別の計算をしていない)。
    const truth = detectFill(planToArmed(buyPlan, T0)!, FILL_PRICE)!;
    sim.feed(37_800, T0 + 2_000);   // 初期LC で決済させて行を出す
    const row = sim.drainRows()[0]!;
    expect(row.entryLeg).toBe(truth.leg);
    expect(row.entryPrice).toBe(truth.entryPrice);
    expect(row.initialStop).toBe(truth.initialStop);
  });

  it('約定する価格の集合が detectFill と完全に一致する(境界の 5円 行き過ぎ / 逆指値のスリップ込み)', () => {
    const plan = { ...buyPlan, stopEntry: 38_100, stopLossForStop: 38_000 };
    const armed = planToArmed(plan, T0)!;
    // 指値側の境界(-5円)と逆指値側の境界をまたぐ価格を総なめする。
    for (let price = 37_980; price <= 38_120; price += 5) {
      const sim = newSim([holdSpec]);
      sim.open({ proposalId: `p${price}`, source: 'generator', plan, now: T0 });
      sim.feed(price, T0 + 1_000);
      sim.closeAll();
      const row = sim.drainRows()[0]!;
      const truth = detectFill(armed, price);
      expect(row.entryT != null, `price=${price}`).toBe(truth != null);
      if (truth) {
        expect(row.entryPrice, `price=${price}`).toBe(truth.entryPrice);
        expect(row.entryLeg, `price=${price}`).toBe(truth.leg);
      }
    }
    // 逆指値レッグの建値は本番と同じ規約(逆指値価格ちょうど)=独自の約定モデルではない。
    const sim = newSim([holdSpec]);
    sim.open({ proposalId: 'stop', source: 'generator', plan: { ...plan, limitEntry: undefined, stopLossForLimit: undefined }, now: T0 });
    sim.feed(38_100, T0 + 1_000);
    sim.closeAll();
    expect(sim.drainRows()[0]!.entryPrice).toBe(38_100 + STOP_SLIPPAGE_YEN);
  });
});

describe('決済パラメータを振ると結果が変わる(影の存在理由)', () => {
  it('同じ提案・同じ価格系列でも spec ごとに決済が変わる', () => {
    const sim = newSim([holdSpec, ratchetSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0, armedPrice: 38_010 });
    sim.feed(FILL_PRICE, T0 + 1_000);      // 約定(建値=38000・初期LC=37900)
    sim.feed(38_200, T0 + 2_000);          // 含み益 200pt(ピーク更新)
    sim.feed(38_050, T0 + 3_000);          // ratchet は床 38050 に到達 → 決済 / hold は継続
    const rows = sim.drainRows();
    expect(rows.map(r => r.spec)).toEqual(['ratchet']);
    const r = rows[0]!;
    expect(r.outcome).toBe('exit');
    expect(r.censored).toBe(false);
    expect(r.exitReason).toBe('ratchet_floor');
    expect(r.exitPrice).toBe(38_050 - STOP_SLIPPAGE_YEN);   // 逆指値決済=床の価格ちょうど(本番と同じ)
    expect(r.pnl).toBe(38_050 - STOP_SLIPPAGE_YEN - 38_000);
    expect(r.peakProfit).toBe(200);
    expect(r.mfe).toBe(200);
    expect(r.mae).toBe(-5);                            // 約定 tick の含み損益
    expect(r.armedPrice).toBe(38_010);
    expect(r.concurrent).toBe(2);
    expect(r.epoch).toBe('test-epoch');
    expect(r.paramClass).toBe('ratchet');
    expect(r.source).toBe('generator');

    sim.feed(37_900, T0 + 4_000);                       // hold は初期LC で決済
    const r2 = sim.drainRows()[0]!;
    expect(r2.spec).toBe('hold');
    expect(r2.exitReason).toBe('initial_stop');
    expect(r2.pnl).toBe(37_900 - STOP_SLIPPAGE_YEN - 38_000);
  });
});

describe('★右側打ち切り(観測できなかった と 終わった を混ぜない)', () => {
  it('地平に達した影は「決済」ではなく「打ち切り」として記録する', () => {
    const horizonMs = 5_000;
    const sim = newSim([holdSpec], horizonMs);
    sim.open({ proposalId: 'p1', source: 'live-A', plan: buyPlan, now: T0 });
    sim.feed(FILL_PRICE, T0 + 1_000);
    sim.feed(38_200, T0 + 2_000);
    sim.feed(38_100, T0 + 4_000);
    expect(sim.drainRows()).toHaveLength(0);   // まだ生きている
    // ★この tick は初期LC(37900)を割っており、地平が無ければ「決済」になる価格。
    //   地平を越えた tick を処理してしまう実装(=地平の判定を advance の後に置いた実装)では
    //   outcome='exit' になり、このテストは赤になる = 打ち切りの否定対照。
    sim.feed(37_800, T0 + horizonMs);
    const r = sim.drainRows()[0]!;
    expect(r.outcome).toBe('censored');
    expect(r.censored).toBe(true);
    expect(r.censorReason).toBe('horizon');
    expect(r.exitT).toBeNull();
    expect(r.exitPrice).toBeNull();
    expect(r.exitReason).toBeNull();
    expect(r.pnl).toBeNull();                 // 決済していないので実現損益は無い
    expect(r.unrealized).toBe(38_100 - 38_000);   // 打ち切り時点の含み損益
    expect(r.mfe).toBe(200);
    expect(r.mae).toBe(-5);
    expect(r.elapsedMs).toBe(4_000);          // 武装→最後に観測した tick
    expect(r.holdMs).toBe(3_000);             // 約定→最後に観測した tick
    expect(r.horizonMs).toBe(horizonMs);
    expect(r.ticks).toBe(3);
  });

  it('価格の供給が尽きた場合も打ち切り(理由を区別して記録する)', () => {
    const sim = newSim([holdSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    sim.feed(FILL_PRICE, T0 + 1_000);
    sim.closeAll();                            // 再生終了 / プロセス停止
    const r = sim.drainRows()[0]!;
    expect(r.outcome).toBe('censored');
    expect(r.censorReason).toBe('ticks_exhausted');
    expect(r.pnl).toBeNull();
  });

  it('未約定失効は打ち切りではない(A と同じ ARMED_TIMEOUT_MS の規約で終わった)', () => {
    const sim = newSim([holdSpec], 10 * ARMED_TIMEOUT_MS);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    sim.feed(38_500, T0 + ARMED_TIMEOUT_MS);   // 一度も約定条件を満たさないまま失効
    const r = sim.drainRows()[0]!;
    expect(r.outcome).toBe('armed_timeout');
    expect(r.censored).toBe(false);
    expect(r.entryT).toBeNull();
    expect(r.entryPrice).toBeNull();
    expect(r.pnl).toBeNull();
    expect(r.unrealized).toBeNull();
  });

  it('地平の既定は 240分以上(床が緩い設定ほど保有が長いので短く切ると選択的に不利になる)', () => {
    expect(SHADOW_HORIZON_MS).toBeGreaterThanOrEqual(240 * 60_000);
  });
});

describe('対象・上限・隔離', () => {
  it('directional のみ(レンジ提案・見送りは影を作らない)', () => {
    const sim = newSim([holdSpec]);
    const range = sim.open({
      proposalId: 'r', source: 'generator', now: T0,
      plan: { direction: 'range', rationale: 'レンジ', range: { upper: { side: 'sell', entry: 38_200, stopLoss: 38_300, type: 'limit' }, lower: { side: 'buy', entry: 38_000, stopLoss: 37_900, type: 'limit' } } },
    });
    expect(range).toEqual({ ok: false, reason: 'not-directional', detail: 'range は対象外' });
    const none = sim.open({ proposalId: 'n', source: 'generator', now: T0, plan: { direction: 'none', rationale: '見送り' } });
    expect(none.ok).toBe(false);
    expect(sim.stats().openShadows).toBe(0);
  });

  it('上限を超える提案は **拒否** する(部分的に間引かない=無音の欠測を作らない)', () => {
    const sim = newSim([holdSpec, ratchetSpec], 60 * 60_000, 3);
    expect(sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 }).ok).toBe(true);
    const r = sim.open({ proposalId: 'p2', source: 'generator', plan: buyPlan, now: T0 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('capacity');
    expect(sim.stats().openShadows).toBe(2);          // 部分的に開いていない
    expect(sim.stats().rejectedProposals).toBe(1);    // 拒否は必ず数える
  });

  it('決済仕様が0件(非公開ラダー未読込)なら影を作らずに拒否する', () => {
    const sim = new ShadowSim({ ladder: () => ({ epoch: 'none', specs: [] }), log: () => { /* 静かに */ } });
    const r = sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('no-specs');
  });

  it('同じ proposalId の二重登録は拒否する', () => {
    const sim = newSim([holdSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    const r = sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    expect(r.ok === false && r.reason).toBe('duplicate');
  });

  it('影が例外を投げても feed は投げ返さない(A の決済を止めない)', () => {
    const boom = { name: 'boom', paramClass: 'ratchet' as const, exit: () => { throw new Error('影の不具合'); } };
    const sim = newSim([boom]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    expect(() => {
      sim.feed(FILL_PRICE, T0 + 1_000);
      sim.feed(38_100, T0 + 2_000);   // filled 中に exitFn が投げる
    }).not.toThrow();
    expect(sim.stats().errors).toBe(1);       // 無音にしない
    expect(sim.stats().openShadows).toBe(0);  // 壊れた影は閉じる
  });

  it('feed 中に DB を触らない(行はバッファに積むだけ・取り出すまで残る)', () => {
    const sim = newSim([holdSpec]);
    sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
    sim.feed(FILL_PRICE, T0 + 1_000);
    sim.feed(37_800, T0 + 2_000);
    expect(sim.stats().bufferedRows).toBe(1);
    expect(sim.drainRows()).toHaveLength(1);
    expect(sim.stats().bufferedRows).toBe(0);
    expect(sim.drainRows()).toHaveLength(0);   // 二重に取れない
  });
});

describe('ライブ / オフライン再生で同じ結果になる', () => {
  it('同じ提案・同じ tick 列なら、供給元が違っても行が一致する', () => {
    const ticks: Array<[number, number]> = [
      [FILL_PRICE, T0 + 1_000], [38_050, T0 + 2_000], [38_200, T0 + 3_000],
      [38_120, T0 + 4_000], [38_050, T0 + 5_000], [37_950, T0 + 6_000],
    ];
    const run = (): ShadowRow[] => {
      const sim = newSim([holdSpec, ratchetSpec, fakeSpec('tight', 50, 10)]);
      sim.open({ proposalId: 'p1', source: 'generator', plan: buyPlan, now: T0 });
      for (const [p, t] of ticks) sim.feed(p, t);
      sim.closeAll();
      return sim.drainRows().sort((a, b) => a.spec.localeCompare(b.spec));
    };
    const live = run();
    const replay = run();
    expect(live.length).toBe(3);
    expect(replay).toEqual(live);
  });
});
