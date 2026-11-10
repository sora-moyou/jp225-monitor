// ★見送り後の再武装の判定(engine.ts maybeRequestPlan / currentWaitReason)で、**古い重要価格を使わない**。
//
// ■ 実例(2026-10-28〜11-10): collector が止まり、重要価格は 10/28 05:59 のティック(64,395)基準のまま。
//   ライブ現値 61,0xx に対して「上の節目」も「下の節目」も 64,xxx 帯 = 再武装の境界が古い価格で決まっていた。
// ■ 古いときは「重要価格が無い」と同じ既存の扱い(rearmBounds の ±50円フォールバック)に倒す。新しい挙動は作らない。
// ★旧実装(getLevelsSnapshot() をそのまま渡す)に戻すと、「古い」2件が赤になる。
//   新しいときは従来どおり節目で判定することも同じファイルで固定する(直しすぎていない)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';
import type { LevelsResult } from '../levels.js';

let canned: ScalpPlanResult = { ok: false, error: 'unset' };
vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));
vi.mock('../sse/broker.js', () => ({ broadcast: () => { /* noop */ } }));
let snapshot: LevelsResult;
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: (): LevelsResult => snapshot }));

import { SignalEngine } from './engine.js';
import { setPrices } from '../cache.js';

const DAY = Date.UTC(2026, 7, 3, 1, 0, 0);   // 2026-08-03(月) JST 10:00 = 立会中
const REF = 38_250;
const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
const NONE: ScalpPlanResult = {
  ok: true,
  plan: { direction: 'none', rationale: '見送り', refPrice: REF, regime: 'unclear', confidence: 25 },
  vetoFired: true, noneReason: 'trend',
};
/** 現値の上 +20 / 下 −30 に節目。新しければ再武装の境界はこの2本になる。 */
function levels(latestTickAt: number): LevelsResult {
  return {
    current: REF,
    up: [{ price: REF + 20, dist: 20, labels: ['上'], strong: false, score: 1, tier: 0, confluence: false }],
    down: [{ price: REF - 30, dist: -30, labels: ['下'], strong: false, score: 1, tier: 0, confluence: false }],
    swing: null, reversalSatisfied: false, asOf: latestTickAt, latestTickAt,
  };
}

describe('SignalEngine: 古い重要価格で再武装を判定しない', () => {
  let dir: string;
  let origAppData: string | undefined;
  let logs: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-stalerearm-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
    setPrices([{ symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: DAY, stale: false }]);
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    setPrices([]);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  async function suppressed(): Promise<SignalEngine> {
    canned = NONE;
    const eng = new SignalEngine(A_CFG);
    await eng.start();
    eng.feed(REF, DAY);
    await vi.waitFor(() => expect(eng.getState(DAY).waitReason?.kind).toBe('level'), { timeout: 3000 });
    return eng;
  }

  it('新しい重要価格: 境界は節目(+20 / −30)のまま(従来どおり)', async () => {
    snapshot = levels(DAY - 2_000);
    const eng = await suppressed();
    expect(eng.getState(DAY).waitReason).toEqual({ kind: 'level', upperTrigger: REF + 20, lowerTrigger: REF - 30 });
    eng.stop();
  });

  it('★古い重要価格(最終ティックが2時間前): 境界は「重要価格が無い」ときと同じ ±50円', async () => {
    snapshot = levels(DAY - 2 * 3600_000);
    const eng = await suppressed();
    expect(eng.getState(DAY).waitReason).toEqual({ kind: 'level', upperTrigger: REF + 50, lowerTrigger: REF - 50 });
    eng.stop();
  });

  it('★古い重要価格: 古い節目(+20)を越えても再武装しない / ±50 を越えたら再武装し、古さをログに残す', async () => {
    snapshot = levels(DAY - 2 * 3600_000);
    const eng = await suppressed();
    eng.feed(REF + 25, DAY + 1_000);   // 古い節目 +20 を越える(新しければここで再武装する)
    expect(eng.getState(DAY + 1_000).waitReason?.kind).toBe('level');
    expect(logs.some(l => l.includes('plan-rearm 節目クロス'))).toBe(false);
    eng.feed(REF + 60, DAY + 2_000);   // ±50 を越える
    expect(logs.some(l => l.includes('plan-rearm 節目クロス') && l.includes('(±50fallback)')
      && l.includes('重要価格が古いため無しとして判定'))).toBe(true);
    eng.stop();
  });

  it('新しい重要価格: 節目(+20)を越えたら再武装する(ログに古さの注記は付かない)', async () => {
    snapshot = levels(DAY - 2_000);
    const eng = await suppressed();
    snapshot = levels(DAY + 1_000 - 2_000);
    eng.feed(REF + 25, DAY + 1_000);
    const line = logs.find(l => l.includes('plan-rearm 節目クロス'));
    expect(line).toBeDefined();
    expect(line).not.toContain('重要価格が古い');
    expect(line).not.toContain('±50fallback');
    eng.stop();
  });
});
