import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// indicatorsLoop の **スクイーズ用の足の窓(7日)と、その再計算の節約** の回帰テスト。
//
// 何を守るか:
//   ①スクイーズ用の足は **既存の6時間窓とは別に取り直す**(7日)。
//     6時間窓では5分足が最大72本しか作れず SQUEEZE_BW_LOOKBACK(125)に永久に届かない
//     = ready は常に false = スクイーズ/バルジ判定が **構造的に死ぬ**。
//   ②それでも **既存の RSI/SMA/BB/live/progress は6時間窓のまま**(1ミリも動かない)。
//     computeIndicators の RSI は prefix 全体を Wilder 平滑化するため、既存窓を伸ばすと
//     既存値そのものが変わる(バンドウォーク判定と AI プロンプトが共有している系列)。
//   ③15秒 tick のたびに7日ぶんの1分足を読み直さない。確定足が増えていなければ
//     **DB を読まずに前回の結果を返す**(実質5分に1回)。
//
// 足は DB(bars_1m)側だけから供給する: メモリ内ライブ足(feedBars)は最大520本 ≒ 8.7時間しか
// 保持しないため、125本の確定5分足(=実時間で最大6.2日)は原理的にメモリだけでは張れない。

const broadcastMock = vi.fn<[{ type: string; payload: unknown }], void>();
vi.mock('../sse/broker.js', () => ({ broadcast: (e: { type: string; payload: unknown }) => broadcastMock(e) }));

/** DB が返す1分足(テスト内で差し替える)。 */
let dbBars: { t: number; o: number; h: number; l: number; c: number }[] = [];
/** getRecentBars がどの窓で呼ばれたか(sinceT の記録)。DB 読みの実回数の観測点でもある。 */
const readWindows: number[] = [];

vi.mock('../db/store.js', () => ({
  openDb: () => ({ close: () => {} }),
  resolveDbPath: () => ':memory:',
  getRecentBars: (_db: unknown, _symbol: string, sinceT: number) => {
    readWindows.push(sinceT);
    return dbBars.filter(b => b.t >= sinceT);
  },
}));

const indicatorsEnabledMock = vi.fn<[], boolean>(() => true);
vi.mock('../configStore.js', () => ({ resolveIndicatorsEnabled: () => indicatorsEnabledMock() }));

const inPollWindowMock = vi.fn<[], boolean>(() => true);
vi.mock('../../core/session.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inPollWindow: () => inPollWindowMock(),
}));

import { startIndicatorsLoop, stopIndicatorsLoop, _reset as resetLoop } from './indicatorsLoop.js';
import { _reset as resetFeedBars } from '../feedBars.js';
import {
  aggregate5m, buildSqueezeSnapshot, computeIndicators, indicatorProgress, valuesOf,
  type IndicatorSnapshot, type OHLCBar,
} from '../indicators.js';
import { SQUEEZE_BW_LOOKBACK, SQUEEZE_BB_PERIOD } from '../../core/indicatorSpec.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const POLL_MS = 15_000;
/** 5分ちょうどに揃った固定時刻(バケット境界のゆらぎで結果が変わらないように)。 */
const NOW = Date.UTC(2026, 7, 13, 5, 0, 0);
/** 1分足の本数(20時間ぶん)。6時間窓には360本しか入らない=2つの窓が確実に別物になる。 */
const BAR_COUNT = 1200;

/** 徐々に静かになる系列(振れ幅が単調に縮む)= 最後の足で Bandwidth が窓内最小になり、スクイーズが出る。 */
function makeBars(count: number, endT: number): OHLCBar[] {
  const bars: OHLCBar[] = [];
  for (let i = 0; i < count; i++) {
    const t = endT - (count - i) * MIN;
    const amp = 60 * (1 - i / count) + 0.2;
    const p = 41000 + Math.sin(i / 2.5) * amp;
    bars.push({ t, o: p, h: p, l: p, c: p });
  }
  return bars;
}

/** broadcast された最新の indicators ペイロード。 */
function lastIndicators(): IndicatorSnapshot | null {
  const calls = broadcastMock.mock.calls.filter(c => c[0]?.type === 'indicators');
  return calls.length > 0 ? (calls[calls.length - 1]![0].payload as IndicatorSnapshot) : null;
}

/** 7日窓での DB 読み(=スクイーズ用)の回数。6時間窓の読みと区別する。 */
function squeezeReads(now: number): number {
  return readWindows.filter(s => s <= now - 24 * HOUR).length;
}

describe('indicatorsLoop — スクイーズ用の足は7日窓で取り直す', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    broadcastMock.mockReset();
    readWindows.length = 0;
    dbBars = makeBars(BAR_COUNT, NOW);
    resetFeedBars();
    stopIndicatorsLoop();
    resetLoop();
    inPollWindowMock.mockReturnValue(true);
    indicatorsEnabledMock.mockReturnValue(true);
  });
  afterEach(() => { stopIndicatorsLoop(); vi.useRealTimers(); });

  it('★7日窓の足で ready:true になり state が出る(6時間窓では構造的に発火しなかった)', () => {
    startIndicatorsLoop();
    const snap = lastIndicators()!;

    // 6時間窓では確定5分足が 必要本数に届かない(=元の実装が死んでいた理由)。
    const closed6h = aggregate5m(dbBars.filter(b => b.t >= NOW - 6 * HOUR)).slice(0, -1);
    // ★必要な確定足 = 参照本数 + (BB本数−1)。BW の先頭 19本は必ず null なので、
    //   参照本数そのものと比べると「72本あれば足りる」と誤読する。
    expect(closed6h.length).toBeLessThan(SQUEEZE_BW_LOOKBACK + SQUEEZE_BB_PERIOD - 1);

    // 7日窓なら届く。
    const closed7d = aggregate5m(dbBars.filter(b => b.t >= NOW - 7 * DAY)).slice(0, -1);
    expect(closed7d.length).toBeGreaterThanOrEqual(SQUEEZE_BW_LOOKBACK + SQUEEZE_BB_PERIOD - 1);

    expect(snap.squeeze!.ready).toBe(true);
    expect(snap.squeeze!.state).toBe('squeeze');   // 振れ幅が単調に縮む系列 = 最後の足が窓内最小
    expect(snap.squeeze).toEqual(buildSqueezeSnapshot(closed7d.map(b => b.c), closed7d.map(b => b.t)));
    // 主指標と同じ足で終わっている(2つの数字が別の時刻を指さない)。
    expect(snap.squeeze!.t).toBe(snap.t);
  });

  it('★DB は「6時間窓」と「7日窓」の両方で読まれる(既存窓を広げていない)', () => {
    startIndicatorsLoop();
    expect(readWindows).toContain(NOW - 6 * HOUR);
    expect(readWindows).toContain(NOW - 7 * DAY);
  });

  it('★既存の RSI/SMA/BB/live/progress は6時間窓のまま(7日窓の足で計算されていない)', () => {
    startIndicatorsLoop();
    const snap = lastIndicators()!;

    const bars6h = dbBars.filter(b => b.t >= NOW - 6 * HOUR);
    const bars5 = aggregate5m(bars6h);
    const closesLive = bars5.map(b => b.c);
    const timesLive = bars5.map(b => b.t);
    const usedCloses = closesLive.slice(0, -1);
    const usedTimes = timesLive.slice(0, -1);

    const expected = computeIndicators(usedCloses, usedTimes);
    expected.live = valuesOf(computeIndicators(closesLive, timesLive));
    expected.progress = indicatorProgress(bars6h.length, usedCloses.length);

    const { squeeze: _drop, ...rest } = snap;
    expect(rest).toEqual(expected);

    // 否定対照: 7日窓の足で計算した値とは一致しない(=窓を取り違えていたら赤くなる)。
    const bars5_7d = aggregate5m(dbBars);
    const wide = computeIndicators(bars5_7d.map(b => b.c).slice(0, -1), bars5_7d.map(b => b.t).slice(0, -1));
    expect(snap.rsi).not.toBeCloseTo(wide.rsi!, 6);
  });

  it('★確定足が増えていなければ再計算しない(15秒 tick で7日ぶんを読み直さない)', () => {
    startIndicatorsLoop();
    expect(squeezeReads(NOW)).toBe(1);            // 起動時の1回

    // 5分ぶん(=20 tick)進めても、足が1本も増えていないので7日窓の読みは増えない。
    vi.advanceTimersByTime(20 * POLL_MS);
    expect(readWindows.filter(s => s === NOW - 6 * HOUR || s > NOW - 24 * HOUR).length)
      .toBeGreaterThanOrEqual(20);                // 6時間窓(軽い)は毎 tick 読んでいる
    expect(squeezeReads(NOW)).toBe(1);            // ★7日窓(重い)は1回のまま
  });

  it('★新しい確定足が出たら計算し直す(節約が「更新されない」に化けていない)', () => {
    startIndicatorsLoop();
    const before = lastIndicators()!.squeeze!;
    vi.advanceTimersByTime(20 * POLL_MS);         // 5分経過(足は増えていない)
    expect(squeezeReads(NOW)).toBe(1);

    // 次の5分ぶんの足が届く = 確定足が1本増える。
    dbBars = [...dbBars, ...makeBars(5, NOW + 5 * MIN)];
    vi.advanceTimersByTime(POLL_MS);

    expect(squeezeReads(NOW)).toBe(2);
    const after = lastIndicators()!.squeeze!;
    expect(after.t).toBe(before.t! + 5 * MIN);    // 参照した確定足が1本進んだ
  });

  it('確定5分足が1本も無ければ7日窓を読まずに全 null を返す(古い足を現在値として出さない)', () => {
    dbBars = [];
    startIndicatorsLoop();
    const snap = lastIndicators()!;
    expect(snap.progress?.state).toBe('no-bars');
    expect(snap.squeeze).toEqual({
      pctB: null, prevPctB: null, bw: null, prevBw: null,
      bwHigh: null, bwLow: null, ready: false, state: null,
    });
    expect(squeezeReads(NOW)).toBe(0);
  });
});
