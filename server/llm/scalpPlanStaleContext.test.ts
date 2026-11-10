// ★仮想取引の計画(runScalpPlanWithChart)に、**古い重要価格・古い本日高安を入れない**。
//
// ■ 実例(2026-10-28〜11-10): collector が止まり、ticks は 10/28 05:59、bars_1m の最新セッションは 11/6 Night のまま。
//   重要価格(64,395 基準)と「本日高安」(11/6 Night の高安)が、ライブ現値 61,0xx と並んで計画の文脈に入っていた。
//   さらに AI の建値が古いピボットに一致すると、5円ずらしがその古い節目を根拠に建値を動かしえた。
// ■ ここで守ること(古いとき)
//   1. 主要節目ブロック: 数値を一切出さず、止まっている事実を1行
//   2. buildNikkeiTechnical に guardStaleLevels を渡す(上値/下値メド・フィボを出さない)
//   3. 本日高安: 出さない(足からの近似にも落とさない)。当日始値比も古い始値で計算しない
//   4. 5円ずらし: 行わない(buildScalpPlan に levels を渡さない=取れない回と同じ)
//   6. 落としたことを context_presence_json(contextPresence.stale)に残す
//   ★新しいときは従来どおり(節目が入る・levels を渡す・stale を付けない)ことも固定する。
// ★旧実装に戻すと「古い」ケースが赤になる(変異確認は報告書に記載)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LevelsResult } from '../levels.js';

const buildScalpPlanMock = vi.fn();
vi.mock('./openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,
  resolveEffectiveRangeEnabled: () => false,
}));
const LIVE = 61_050;
vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: LIVE }],
  getNews: () => [],
}));
const techMock = vi.fn((_g: unknown, _p: unknown, _o?: { guardStaleLevels?: boolean; now?: number }) => '■ テクニカル');
vi.mock('../chatContext.js', () => ({
  buildNikkeiTechnical: (g: unknown, p: unknown, o?: { guardStaleLevels?: boolean; now?: number }) => techMock(g, p, o),
}));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 100,
  resolveScalpChartFallbackText: () => true,
  resolveScalpChartVisionMode: () => 'off',
  resolveIndicatorsEnabled: () => true,
  resolveBandwalkEnabled: () => false,
  resolveEffectiveScalpBias: () => 'none',
  resolveShockParams: () => ({ move1: 45, move2: 55, shock1: 50, shock2: 70, accelTh: 10, avgLen: 30, avgMult: 2.0, breakLen: 10, sameDirLen: 3, sameDirNeed: 2, scoreNeed: 5 }),
}));
vi.mock('../chart/chartShot.js', () => ({ captureChartPngCached: vi.fn() }));

const J = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 9, mi);
const NOW = J(2026, 11, 10, 11, 0);   // 2026-11-10(火) 11:00 JST = 立会中

let lastBarT: number | null = null;
let session: unknown = null;
let heartbeat: number | null = null;
vi.mock('../db/store.js', () => ({
  openDb: () => ({ close: () => {}, prepare: () => ({ get: () => ({ m: lastBarT }) }) }),
  resolveDbPath: () => ':memory:',
  getRecentBars: () => [],
  getRecentAlerts: () => [],
  getSessionOHLC: () => (session ? [session] : []),
  // ★collector の心拍(meta collector_heartbeat)。寄りの猶予の判定にだけ使われる。null=meta に無い。
  getMeta: (_db: unknown, key: string) => (key === 'collector_heartbeat' && heartbeat !== null ? String(heartbeat) : null),
  getSignalTrades: () => [],
  getDailyCloses: () => [],
}));
// 足: 直近60分ぶん、ライブ現値付近(古いのは重要価格とセッション OHLC だけ=実例と同じ形)。
vi.mock('../barsSource.js', () => ({
  collectRecentBars: () => Array.from({ length: 60 }, (_, i) => {
    const c = LIVE - 30 + i;
    return { t: NOW - (60 - i) * 60_000, o: c, h: c + 5, l: c - 5, c };
  }),
}));
let snapshot: LevelsResult;
vi.mock('../loops/levelsLoop.js', () => ({ getLevelsSnapshot: (): LevelsResult => snapshot }));

import { runScalpPlanWithChart } from './scalpPlanRunner.js';

/** 古い帯(64,xxx)の重要価格。latestTickAt で新旧を切り替える。 */
function levels(latestTickAt: number): LevelsResult {
  return {
    current: 64_395,
    up: [{ price: 64_600, kinds: ['sessHL'], labels: ['10/27夜高'], dist: 205, strong: true, score: 3, tier: 2, confluence: false }],
    down: [{ price: 64_100, kinds: ['pivotLow'], labels: ['スイング安'], dist: -295, strong: false, score: 2, tier: 1, confluence: false }],
    swing: null, reversalSatisfied: false, asOf: latestTickAt, latestTickAt,
  } as LevelsResult;
}
const NIGHT_1106 = {
  sessionDate: '2026-11-06', session: 'Night', open: 64_000, high: 64_500, low: 63_900, close: 64_395,
  highT: J(2026, 11, 6, 22, 10), lowT: J(2026, 11, 6, 18, 0), openT: J(2026, 11, 6, 17, 0),
};
const DAY_1110 = {
  sessionDate: '2026-11-10', session: 'Day', open: 61_000, high: 61_300, low: 60_900, close: LIVE,
  highT: J(2026, 11, 10, 9, 30), lowT: J(2026, 11, 10, 10, 0), openT: J(2026, 11, 10, 8, 45),
};

function call(): { technical: string; levels?: unknown } {
  expect(buildScalpPlanMock).toHaveBeenCalledTimes(1);
  return buildScalpPlanMock.mock.calls[0]![0] as { technical: string; levels?: unknown };
}

describe('runScalpPlanWithChart — 古い重要価格・古い本日高安を計画の文脈に入れない', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    buildScalpPlanMock.mockReset().mockResolvedValue({ ok: true, plan: { direction: 'none', rationale: 'x', refPrice: LIVE } });
    techMock.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('★実例(重要価格は 10/28 05:59・セッションは 11/6 Night): 数値を出さず、事実を1行・ずらさない・記録に残す', async () => {
    snapshot = levels(J(2026, 10, 28, 5, 59));
    session = NIGHT_1106;
    lastBarT = J(2026, 11, 7, 5, 59);
    const r = await runScalpPlanWithChart();
    const { technical, ...rest } = call();
    // 1. 主要節目: 数値なし・事実1行
    expect(technical).toContain('主要節目: 収集停止中のため算出できません(最終ティック 10/28 05:59 JST)');
    expect(technical).not.toContain('主要節目(');
    for (const n of ['64,600', '64600', '64,100', '64100']) expect(technical).not.toContain(n);
    // 3. 本日高安: 古いセッションの高安も、足からの近似も出さない。当日始値比も古い始値(64,000)で計算しない
    expect(technical).toContain('本日高安=収集停止中のため算出できません(最終足 11/07 05:59 JST)');
    expect(technical).not.toContain('本日高安 ');
    for (const n of ['64,500', '64500', '63,900', '63900']) expect(technical).not.toContain(n);
    expect(technical).toContain('当日始値比—');
    // 2. buildNikkeiTechnical に guardStaleLevels を渡している
    expect(techMock.mock.calls[0]![2]).toMatchObject({ guardStaleLevels: true });
    // 4. 5円ずらし: levels を渡さない(=ずらさない)
    expect('levels' in rest).toBe(false);
    // 6. 記録(context_presence_json に乗る contextPresence.stale)
    const cp = (r as { contextPresence?: { levels: boolean; sessionHighLow: boolean; stale?: { dropped: string[]; levelsTickAt?: number; sessionLastBarAt?: number | null } } }).contextPresence!;
    expect(cp.levels).toBe(false);
    expect(cp.sessionHighLow).toBe(false);
    expect(cp.stale).toEqual({
      dropped: ['levels', 'sessionHighLow', 'baseTechLevels', 'pivotNudge'],
      levelsTickAt: J(2026, 10, 28, 5, 59),
      sessionLastBarAt: J(2026, 11, 7, 5, 59),
    });
  });

  it('新しいとき(ティック2秒前・セッション 11/10 Day・最終足30秒前): 節目が入り・ずらしの節目を渡し・stale は付かない', async () => {
    snapshot = levels(NOW - 2_000);
    session = DAY_1110;
    lastBarT = NOW - 30_000;
    const r = await runScalpPlanWithChart();
    const { technical, levels: lv } = call();
    expect(technical).toContain('主要節目(');
    expect(technical).toContain('64600 レジ');
    expect(technical).toContain('本日高安 61300〜60900');
    expect(technical).not.toContain('収集停止中');
    expect(lv).toEqual([{ price: 64_600, kinds: ['sessHL'] }, { price: 64_100, kinds: ['pivotLow'] }]);
    const cp = (r as { contextPresence?: Record<string, unknown> }).contextPresence!;
    expect(cp.levels).toBe(true);
    expect('stale' in cp).toBe(false);
  });

  it('重要価格だけ古い(セッションは新しい)→ 落とすのは節目系だけ・本日高安は従来どおり', async () => {
    snapshot = levels(NOW - 5 * 60_000);
    session = DAY_1110;
    lastBarT = NOW - 30_000;
    const r = await runScalpPlanWithChart();
    const { technical, ...rest } = call();
    expect(technical).toContain('主要節目: 収集停止中');
    expect(technical).toContain('本日高安 61300〜60900');
    expect('levels' in rest).toBe(false);
    const cp = (r as { contextPresence?: { stale?: { dropped: string[] } } }).contextPresence!;
    expect(cp.stale!.dropped).toEqual(['levels', 'baseTechLevels', 'pivotNudge']);
  });

  // ★エバリュエーター指摘(v0.9.114 後の実装の欠陥): 寄り直後(17:00:00〜数秒)は latestTickAt も最新のセッションも
  //   前のセッション(15:44:59 の Day)のまま。これを「収集停止」と取り違えて重要価格と本日高安を落としていた
  //   (実例: 10/26 17:00 の計画 763A/764B=寄り+3.5/+4.0秒)。寄りの猶予内は従来と同じ文脈にする。
  it('★寄り+3.5秒(17:00:03.482・最終ティック 15:44:59・最新セッションは当日 Day): 何も落とさない', async () => {
    const T = J(2026, 10, 26, 17, 0) + 3_482;
    vi.setSystemTime(T);
    heartbeat = T - 2_000;   // collector は生きている
    snapshot = { ...levels(J(2026, 10, 26, 15, 44) + 59_491), collectorHeartbeatAt: heartbeat };
    session = { ...DAY_1110, sessionDate: '2026-10-26' };
    lastBarT = J(2026, 10, 26, 15, 44);
    const r = await runScalpPlanWithChart();
    const { technical, levels: lv } = call();
    expect(technical).toContain('主要節目(');
    expect(technical).toContain('本日高安 61300〜60900');
    expect(technical).not.toContain('収集停止中');
    expect(lv).toEqual([{ price: 64_600, kinds: ['sessHL'] }, { price: 64_100, kinds: ['pivotLow'] }]);
    expect(techMock.mock.calls[0]![2]).toMatchObject({ guardStaleLevels: true, now: T });
    const cp = (r as { contextPresence?: Record<string, unknown> }).contextPresence!;
    expect('stale' in cp).toBe(false);
  });

  it('★猶予を過ぎてもティックも足も来ない(17:03:01)→ 落とす(本当に止まっている)', async () => {
    vi.setSystemTime(J(2026, 10, 26, 17, 3) + 1_000);
    snapshot = levels(J(2026, 10, 26, 15, 44) + 59_491);
    session = { ...DAY_1110, sessionDate: '2026-10-26' };
    lastBarT = J(2026, 10, 26, 15, 44);
    const r = await runScalpPlanWithChart();
    const { technical } = call();
    expect(technical).toContain('主要節目: 収集停止中');
    expect(technical).toContain('本日高安=収集停止中');
    const cp = (r as { contextPresence?: { stale?: { dropped: string[] } } }).contextPresence!;
    expect(cp.stale!.dropped).toEqual(['levels', 'sessionHighLow', 'baseTechLevels', 'pivotNudge']);
  });

  it('立会外(引け後 15:50・寄り前 16:57)は本日高安を落とさない(従来どおり)', async () => {
    for (const T of [J(2026, 11, 10, 15, 50), J(2026, 11, 10, 16, 57)]) {
      buildScalpPlanMock.mockClear();
      vi.setSystemTime(T);
      snapshot = levels(J(2026, 11, 10, 15, 44) + 59_000);
      session = DAY_1110;
      lastBarT = J(2026, 11, 10, 15, 44);
      await runScalpPlanWithChart();
      const { technical } = call();
      expect(technical).toContain('本日高安 61300〜60900');
      expect(technical).not.toContain('収集停止中');
    }
  });

  // ★エバリュエーター指摘(寄りの猶予の穴): 878A/879B の再現。10/27 は collector が 08:01 に死亡、
  //   17:00 の寄りの時点で最終ティック・最新セッションは朝の Night(10/26 Night・末尾 10/27 05:59)のまま。
  //   直前の Day(10/27)の末尾に届いていないので、寄り+3秒でも落とす。
  it('★停止中の寄り(10/27 17:00:03・最終ティック 05:59:58・最新は 10/26 Night): 寄りの猶予を与えず落とす', async () => {
    vi.setSystemTime(J(2026, 10, 27, 17, 0) + 3_000);
    snapshot = levels(J(2026, 10, 27, 5, 59) + 58_000);
    session = { ...NIGHT_1106, sessionDate: '2026-10-26' };
    lastBarT = J(2026, 10, 27, 5, 59);
    const r = await runScalpPlanWithChart();
    const { technical, ...rest } = call();
    expect(technical).toContain('主要節目: 収集停止中');
    expect(technical).toContain('本日高安=収集停止中');
    expect('levels' in rest).toBe(false);
    const cp = (r as { contextPresence?: { stale?: { dropped: string[] } } }).contextPresence!;
    expect(cp.stale!.dropped).toEqual(['levels', 'sessionHighLow', 'baseTechLevels', 'pivotNudge']);
  });

  // ★818A/819B の再現(10/27 08:45:01.4・最終ティック 05:59:58=直前の夜間の末尾・collector は 08:01:08 に死亡)。
  it('★818A/819B: 直前のセッション末尾までティックがあっても、心拍が止まっていれば寄りの猶予を与えず落とす', async () => {
    const T = J(2026, 10, 27, 8, 45) + 1_400;
    vi.setSystemTime(T);
    heartbeat = J(2026, 10, 27, 8, 1) + 8_000;
    snapshot = { ...levels(J(2026, 10, 27, 5, 59) + 58_000), collectorHeartbeatAt: heartbeat };
    session = { ...NIGHT_1106, sessionDate: '2026-10-26' };
    lastBarT = J(2026, 10, 27, 5, 59);
    const r = await runScalpPlanWithChart();
    const { technical, ...rest } = call();
    expect(technical).toContain('主要節目: 収集停止中');
    expect(technical).toContain('本日高安=収集停止中');
    expect('levels' in rest).toBe(false);
    const cp = (r as { contextPresence?: { stale?: { dropped: string[] } } }).contextPresence!;
    expect(cp.stale!.dropped).toEqual(['levels', 'sessionHighLow', 'baseTechLevels', 'pivotNudge']);
  });

  it('★同じ状況で心拍が新しければ(健全な寄り待ち)何も落とさない', async () => {
    const T = J(2026, 10, 27, 8, 45) + 1_400;
    vi.setSystemTime(T);
    heartbeat = T - 2_000;
    snapshot = { ...levels(J(2026, 10, 27, 5, 59) + 58_000), collectorHeartbeatAt: heartbeat };
    session = { ...NIGHT_1106, sessionDate: '2026-10-26' };
    lastBarT = J(2026, 10, 27, 5, 59);
    const r = await runScalpPlanWithChart();
    const { technical } = call();
    expect(technical).not.toContain('収集停止中');
    expect(technical).toContain('主要節目(');
    expect('stale' in (r as { contextPresence: object }).contextPresence).toBe(false);
  });
});
