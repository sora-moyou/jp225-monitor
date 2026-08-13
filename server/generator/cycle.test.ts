import { describe, it, expect, vi } from 'vitest';

// ─── 1サイクル(①→①'→②)────────────────────────────────────────────────────
//
// 何を守っているか:
//   ・①②を **直列** に、この順で回す(別スケジュールにすると提案の差に市場変動が混ざる)
//   ・①'(対照)は3本目の分析用ではなく、**同じサイクルの中で同じ入力にもう1回問う**
//   ・429-busy は 15〜20秒後に1回だけ再試行し、再試行の有無と1回目の理由を残す
//     (busy は「A が入るかもしれない瞬間」に立つので、無策だと欠測がランダムでなくなる)
//   ・提案(見送りも)・見送り理由・撮影の同一性を漏れなく行に写す
//
// ★否定対照:
//   ・planCycleArms の対照分岐を消す → 「5サイクルに1回 ①' が入る」が赤
//   ・runArm の busy 再試行を消す     → 「busy で1回だけ再試行」「再試行を記録」が赤
//   ・classifyAttempt を「全部 skipped」に潰す → 200/400/timeout の区別4件が赤

import {
  planCycleArms, classifyAttempt, runArm, toProposalRow, makeCycleId, runCycle, type CycleDeps,
} from './cycle.js';
import type { GeneratorConfig } from './config.js';

const cfg: GeneratorConfig = {
  monitorUrl: 'http://mon', intervalMs: 120_000, controlEvery: 5,
  retryMinMs: 15_000, retryMaxMs: 20_000, requestTimeoutMs: 180_000, tallyIntervalMs: 1_800_000,
};

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    fetcher: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as unknown as Response,
    now: () => 1_700_000_000_000,
    sleep: async () => { /* 即返す */ },
    random: () => 0,
    ...over,
  };
}

const res = (status: number, body: unknown): Response =>
  ({ ok: status === 200, status, json: async () => body }) as unknown as Response;

describe('planCycleArms — 直列の構成', () => {
  // ★v0.9.75: 候補の腕を **決済仕様('candidate-a')から 質問文('prompt-v2')へ載せ替えた**。
  //   決済仕様の A/B は実測3セッション(08-10〜08-12)でどの指標も動かなかったので畳んでいる。
  it('通常のサイクルは ① current → ② prompt-v2 の2本(この順)', () => {
    expect(planCycleArms(1, 5)).toEqual([
      { arm: 'current', exitVariant: 'current', promptVariant: 'v1', seq: 0 },
      { arm: 'prompt-v2', exitVariant: 'current', promptVariant: 'v2', seq: 1 },
    ]);
  });

  it('★5サイクルに1回だけ ①\' 対照が ① と ② の **あいだ** に入る', () => {
    expect(planCycleArms(0, 5)).toEqual([
      { arm: 'current', exitVariant: 'current', promptVariant: 'v1', seq: 0 },
      { arm: 'control', exitVariant: 'current', promptVariant: 'v1', seq: 1 },
      { arm: 'prompt-v2', exitVariant: 'current', promptVariant: 'v2', seq: 2 },
    ]);
    expect(planCycleArms(5, 5).map(a => a.arm)).toEqual(['current', 'control', 'prompt-v2']);
    for (const i of [1, 2, 3, 4, 6]) expect(planCycleArms(i, 5).map(a => a.arm)).toEqual(['current', 'prompt-v2']);
  });

  it('★①と②の違いは質問文の1点だけ(決済仕様は3本とも同じ)', () => {
    const arms = planCycleArms(0, 5);
    expect(new Set(arms.map(a => a.exitVariant))).toEqual(new Set(['current']));
    expect(arms.map(a => a.promptVariant)).toEqual(['v1', 'v1', 'v2']);
  });

  it('★対照は ① と **同じ exitVariant** を送る(同じ入力に2回問うのが定義)', () => {
    const arms = planCycleArms(0, 5);
    expect(arms[1]!.exitVariant).toBe(arms[0]!.exitVariant);
    expect(arms[1]!.arm).not.toBe(arms[0]!.arm);
  });

  it('controlEvery=0 で対照なし', () => {
    expect(planCycleArms(0, 0).map(a => a.arm)).toEqual(['current', 'prompt-v2']);
  });
});

describe('classifyAttempt — 結末を理由別に分ける', () => {
  it('200 + ok:true = plan', () => {
    const a = classifyAttempt(200, { ok: true, plan: { direction: 'none' } });
    expect(a.status).toBe('plan');
    expect(a.body).not.toBeNull();
  });
  it('200 + ok:false = plan-error(理由を残す)', () => {
    const a = classifyAttempt(200, { ok: false, error: 'chart-not-generated' });
    expect(a.status).toBe('plan-error');
    expect(a.error).toBe('chart-not-generated');
  });
  it('429 = skipped(busy/budget/default-quota/disabled/closed を区別)', () => {
    for (const reason of ['busy', 'budget', 'default-quota', 'disabled', 'closed']) {
      const a = classifyAttempt(429, { ok: false, error: reason, detail: 'd' });
      expect(a.status).toBe('skipped');
      expect(a.skipReason).toBe(reason);
    }
  });
  it('400 = http-error / bad-request(黙って skipped にまとめない)', () => {
    const a = classifyAttempt(400, { ok: false, error: 'exitVariant ...' });
    expect(a.status).toBe('http-error');
    expect(a.skipReason).toBe('bad-request');
  });
  it('500 = http-error / http-500', () => {
    expect(classifyAttempt(500, {}).skipReason).toBe('http-500');
  });
});

describe('runArm — ★429-busy だけ 15〜20秒後に1回だけ再試行', () => {
  const req = { arm: 'current' as const, exitVariant: 'current' as const, promptVariant: 'v1' as const, seq: 0 };

  it('busy → 待って再試行し、成功したら plan として記録・再試行の跡を残す', async () => {
    const calls: number[] = [];
    let n = 0;
    const slept: number[] = [];
    const out = await runArm(cfg, deps({
      fetcher: async () => { n += 1; calls.push(n); return n === 1 ? res(429, { error: 'busy' }) : res(200, { ok: true, plan: { direction: 'buy' } }); },
      sleep: async (ms) => { slept.push(ms); },
      random: () => 0.5,
    }), req);
    expect(n).toBe(2);
    expect(out.attempt.status).toBe('plan');
    expect(out.retryCount).toBe(1);
    expect(out.preRetryReason).toBe('busy');
    expect(slept[0]).toBeGreaterThanOrEqual(15_000);
    expect(slept[0]).toBeLessThanOrEqual(20_000);
  });

  it('busy が2回続いても **再試行は1回だけ**(記録は2回目の結末)', async () => {
    let n = 0;
    const out = await runArm(cfg, deps({ fetcher: async () => { n += 1; return res(429, { error: 'busy' }); } }), req);
    expect(n).toBe(2);
    expect(out.attempt.skipReason).toBe('busy');
    expect(out.retryCount).toBe(1);
  });

  it('★busy 以外(budget/closed/400)は再試行しない', async () => {
    for (const [status, body] of [[429, { error: 'budget' }], [429, { error: 'closed' }], [400, { error: 'x' }]] as const) {
      let n = 0;
      const out = await runArm(cfg, deps({ fetcher: async () => { n += 1; return res(status, body); } }), req);
      expect(n).toBe(1);
      expect(out.retryCount).toBe(0);
      expect(out.preRetryReason).toBeNull();
    }
  });

  it('タイムアウト/ネットワーク断も値で返す(例外を外へ出さない)', async () => {
    const to = await runArm(cfg, deps({
      fetcher: async () => { const e = new Error('The operation was aborted'); e.name = 'TimeoutError'; throw e; },
    }), req);
    expect(to.attempt.status).toBe('timeout');
    const net = await runArm(cfg, deps({ fetcher: async () => { throw new Error('ECONNREFUSED'); } }), req);
    expect(net.attempt.status).toBe('network-error');
  });

  it('★取引経路を叩かない: 送るのは /api/scalp-plan に caller=generator と変種名だけ(決済の数値を載せない)', async () => {
    let seenUrl = ''; let seenBody = '';
    await runArm(cfg, deps({
      fetcher: async (url, init) => { seenUrl = String(url); seenBody = String(init?.body ?? ''); return res(200, { ok: true, plan: {} }); },
    }), { arm: 'prompt-v2', exitVariant: 'current', promptVariant: 'v2', seq: 1 });
    expect(seenUrl).toBe('http://mon/api/scalp-plan');
    // ★送るのは名前だけ(決済の実数値も質問文の本文も載せない)。
    expect(JSON.parse(seenBody)).toEqual({ caller: 'generator', exitVariant: 'current', promptVariant: 'v2' });
  });
});

describe('toProposalRow — 提案・見送り理由・撮影の同一性を漏れなく写す', () => {
  const req = { arm: 'candidate-a' as const, exitVariant: 'candidate-a' as const, promptVariant: 'v1' as const, seq: 2 };
  const outcome = (body: unknown) => ({
    attempt: classifyAttempt(200, body),
    requestedAt: 1_700_000_000_000, respondedAt: 1_700_000_012_000,
    retryCount: 0, preRetryReason: null,
  });

  it('★見送り(direction:none)も全部記録する', () => {
    const r = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true,
      plan: { direction: 'none', rationale: '見送り', refPrice: 38250, regime: 'range', confidence: 40 },
      noneReason: 'trend', noneLegs: { dir: 'buy', legs: [{ name: 'limit', entry: 38200, ok: false }] },
      vetoFired: true, rangeAnomaly: { tag: 'mixed', legs: 'x' },
      chartShot: { shotId: 'aa-1', ageMs: 12_000, origin: 'cache' },
      exitVariant: 'candidate-a',
    }));
    expect(r.status).toBe('plan');
    expect(r.direction).toBe('none');
    expect(r.noneReason).toBe('trend');
    expect(JSON.parse(r.noneLegsJson!).dir).toBe('buy');
    expect(r.vetoFired).toBe(1);
    expect(JSON.parse(r.rangeAnomalyJson!).tag).toBe('mixed');
    expect(r.refPrice).toBe(38250);
    expect(r.regime).toBe('range');
    expect(r.confidence).toBe(40);
    expect(JSON.parse(r.planJson!).rationale).toBe('見送り');
    expect(r.latencyMs).toBe(12_000);
    expect(r.arm).toBe('candidate-a');
    expect(r.seq).toBe(2);
  });

  it('★撮影の同一性(識別子・齢・由来)を列に落とす', () => {
    const r = toProposalRow('g1:x', 'c1', req, outcome({
      ok: true, plan: { direction: 'buy', refPrice: 1 },
      chartShot: { shotId: 'aa-7', ageMs: 31_000, origin: 'cache' },
    }));
    expect(r.shotId).toBe('aa-7');
    expect(r.shotAgeMs).toBe(31_000);
    expect(r.shotOrigin).toBe('cache');
  });

  it('画像を見ていない(chartShot 無し)は NULL(値が無いことを捏造しない)', () => {
    const r = toProposalRow('g1:x', 'c1', req, outcome({ ok: true, plan: { direction: 'buy', refPrice: 1 } }));
    expect(r.shotId).toBeNull();
    expect(r.shotAgeMs).toBeNull();
  });

  it('★変種のエコーが送った名前と違えば error に残す(無音にしない)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => { /* noop */ });
    const r = toProposalRow('g1:x', 'c1', req, outcome({ ok: true, plan: { direction: 'buy' }, exitVariant: 'current' }));
    expect(r.error).toContain('variant-mismatch');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skipped(429)は提案の列が全部 NULL・理由だけが残る', () => {
    const r = toProposalRow('g1:x', 'c1', req, {
      attempt: classifyAttempt(429, { error: 'busy', detail: 'inFlight=1' }),
      requestedAt: 1, respondedAt: 2, retryCount: 1, preRetryReason: 'busy',
    });
    expect(r.status).toBe('skipped');
    expect(r.skipReason).toBe('busy');
    expect(r.planJson).toBeNull();
    expect(r.direction).toBeNull();
    expect(r.retried).toBe(1);
    expect(r.preRetryReason).toBe('busy');
  });
});

describe('runCycle — 直列に回して腕ごとの行を返す', () => {
  it('★1サイクル分の行が ①(①\')② の順で揃い、同じ cycleId で結ばれる', async () => {
    const order: string[] = [];
    const rows = await runCycle(cfg, deps({
      fetcher: async (_u, init) => {
        const b = JSON.parse(String(init?.body ?? '{}')) as { exitVariant: string };
        order.push(b.exitVariant);
        return res(200, { ok: true, plan: { direction: 'none', refPrice: 1 }, exitVariant: b.exitVariant, chartShot: { shotId: 'same-1', ageMs: 0, origin: 'fresh' } });
      },
    }), { epoch: 'g1:x', cycleId: 'c-0', cycleIndex: 0 });
    // ★3本とも決済仕様は 'current'(動かす変数は質問文だけ)。
    expect(order).toEqual(['current', 'current', 'current']);
    expect(rows.map(r => r.arm)).toEqual(['current', 'control', 'prompt-v2']);
    expect(rows.map(r => r.promptVariant)).toEqual(['v1', 'v1', 'v2']);
    expect(new Set(rows.map(r => r.cycleId))).toEqual(new Set(['c-0']));
    // ★同じ1枚を見たことが記録から言える
    expect(new Set(rows.map(r => r.shotId))).toEqual(new Set(['same-1']));
  });

  it('makeCycleId は再起動をまたいでも衝突しない形(接頭辞+時刻+連番)', () => {
    expect(makeCycleId('ab12cd34', 1_700_000_000_000, 7)).toBe(`ab12cd34-${(1_700_000_000_000).toString(36)}-7`);
    expect(makeCycleId('ab12cd34', 1_700_000_000_000, 7)).not.toBe(makeCycleId('ff00ff00', 1_700_000_000_000, 7));
  });
});
