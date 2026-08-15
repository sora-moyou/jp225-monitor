import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// indicatorsLoop が **スクイーズ用バンド(20本/2σ)のスナップショット** を配信に載せる配線の回帰テスト。
//
// 何を守るか:
//   ①snap.squeeze が実際に SSE ペイロードへ載る(載らなければパネルは何も出せない)。
//   ②squeeze は **確定足の close 列**(usedCloses / usedTimes = 形成中の最後の1本を除いたもの)から
//     作られる。形成中足を混ぜると 5分ごとに値が飛び、色(増加/減少)が嘘になる。
//   ③**既存の値/系列/live/progress は1ミリも変わらない**(= squeeze を外した残りが、
//     従来どおりの computeIndicators + live + progress と完全一致する)。
//     既存の 14本/0.7σ 系列はバンドウォーク判定と AI プロンプトが共有しており、
//     ここが動くと実走中の質問文 A/B の標本が割れる。
//
// モックの流儀は indicatorsLoop.test.ts と同じ(DB/SSE/設定/セッション判定を差し替え、足は本物の feedBars)。

const broadcastMock = vi.fn<[{ type: string; payload: unknown }], void>();
vi.mock('../sse/broker.js', () => ({ broadcast: (e: { type: string; payload: unknown }) => broadcastMock(e) }));

// DB は「開けるが bars_1m が空」= collector 未稼働の環境と同じ(足はメモリ内ライブ足だけ)。
vi.mock('../db/store.js', () => ({
  openDb: () => ({ close: () => {} }),
  resolveDbPath: () => ':memory:',
  getRecentBars: () => [],
}));

const indicatorsEnabledMock = vi.fn<[], boolean>(() => true);
vi.mock('../configStore.js', () => ({ resolveIndicatorsEnabled: () => indicatorsEnabledMock() }));

const inPollWindowMock = vi.fn<[], boolean>(() => true);
vi.mock('../../core/session.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inPollWindow: () => inPollWindowMock(),
}));

import { startIndicatorsLoop, stopIndicatorsLoop, _reset as resetLoop } from './indicatorsLoop.js';
import { feedRealtimePrice, _reset } from '../feedBars.js';
import {
  aggregate5m, buildSqueezeSnapshot, computeIndicators, indicatorProgress, valuesOf,
  type IndicatorSnapshot, type OHLCBar,
} from '../indicators.js';
import { SQUEEZE_BW_LOOKBACK } from '../../core/indicatorSpec.js';

const MIN = 60_000;
const SYMBOL = 'NIY=F';

/** broadcast された最新の indicators ペイロード。 */
function lastIndicators(): IndicatorSnapshot | null {
  const calls = broadcastMock.mock.calls.filter(c => c[0]?.type === 'indicators');
  return calls.length > 0 ? (calls[calls.length - 1]![0].payload as IndicatorSnapshot) : null;
}

/** 1分1ティック(o=h=l=c)で n 本投入し、**同じ入力から独立に組み直した** 1分足を返す。
 *  loop の内部を覗かずに「loop が何を計算すべきだったか」を再現するための対照。 */
function feedSeries(n: number, priceAt: (i: number) => number): OHLCBar[] {
  const start = Math.floor((Date.now() - n * MIN) / MIN) * MIN;
  const bars: OHLCBar[] = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * MIN;
    const p = priceAt(i);
    feedRealtimePrice(SYMBOL, p, t);
    bars.push({ t, o: p, h: p, l: p, c: p });
  }
  return bars;
}

/** loop と同じ「確定足 / 形成中足込み」の分け方(最後の5分足を落とす)。 */
function splitCloses(bars1: OHLCBar[]) {
  const bars5 = aggregate5m(bars1);
  const closesLive = bars5.map(b => b.c);
  const timesLive = bars5.map(b => b.t);
  return { closesLive, timesLive, usedCloses: closesLive.slice(0, -1), usedTimes: timesLive.slice(0, -1) };
}

describe('indicatorsLoop — スクイーズ用スナップショットの配信', () => {
  beforeEach(() => {
    broadcastMock.mockReset(); _reset(); stopIndicatorsLoop(); resetLoop();
    inPollWindowMock.mockReturnValue(true);
    indicatorsEnabledMock.mockReturnValue(true);
  });
  afterEach(() => { stopIndicatorsLoop(); });

  it('★squeeze が配信に載り、確定足の close 列から作られている(形成中足を混ぜない)', () => {
    const bars = feedSeries(180, i => 41000 + Math.sin(i / 7) * 80);
    startIndicatorsLoop();
    const snap = lastIndicators()!;
    const { closesLive, timesLive, usedCloses, usedTimes } = splitCloses(bars);

    expect(snap.squeeze).toBeDefined();
    expect(snap.squeeze!.bw).not.toBeNull();
    expect(snap.squeeze!.pctB).not.toBeNull();
    // 確定足の列と完全一致する(= usedCloses/usedTimes を渡している)。
    expect(snap.squeeze).toEqual(buildSqueezeSnapshot(usedCloses, usedTimes));
    // 形成中足込みの列とは一致しない(混ぜたら赤になる)。
    expect(snap.squeeze).not.toEqual(buildSqueezeSnapshot(closesLive, timesLive));
    // t は主指標の参照時刻と同じ足を指す(別の足を見ていない)。
    expect(snap.squeeze!.t).toBe(snap.t);
  });

  it('★既存の値/系列/live/progress は1ミリも変わらない(squeeze を外した残りが従来と完全一致)', () => {
    const bars = feedSeries(180, i => 41000 + Math.sin(i / 7) * 80);
    startIndicatorsLoop();
    const snap = lastIndicators()!;
    const { closesLive, timesLive, usedCloses, usedTimes } = splitCloses(bars);

    const expected = computeIndicators(usedCloses, usedTimes);
    expected.live = valuesOf(computeIndicators(closesLive, timesLive));
    expected.progress = indicatorProgress(bars.length, usedCloses.length);

    const { squeeze: _drop, ...rest } = snap;
    expect(rest).toEqual(expected);
  });

  it('足が1本も無くても squeeze は全 null で付く(未定義参照でパネルを壊さない)', () => {
    startIndicatorsLoop();
    const snap = lastIndicators()!;
    expect(snap.progress?.state).toBe('no-bars');
    expect(snap.squeeze).toEqual({
      pctB: null, prevPctB: null, bw: null, prevBw: null,
      bwHigh: null, bwLow: null, ready: false, state: null,
    });
  });

  it('取引時間外に入っても直前の squeeze を保持する(値は消さない=引け後に読める)', () => {
    feedSeries(180, i => 41000 + Math.sin(i / 7) * 80);
    startIndicatorsLoop();
    const ready = lastIndicators()!;
    expect(ready.squeeze!.bw).not.toBeNull();

    inPollWindowMock.mockReturnValue(false);
    stopIndicatorsLoop();
    startIndicatorsLoop();
    const closed = lastIndicators()!;
    expect(closed.progress?.state).toBe('closed');
    expect(closed.squeeze).toEqual(ready.squeeze);
  });

  // 足が足りない間の振る舞い(ここでは供給が3時間ぶんしか無い)。
  //   → ready:false = state(スクイーズ/バルジ)は null。ただし表示に使う値は出す。
  //   ★足が十分にある場合に ready:true / state が出ることは indicatorsLoopSqueezeWindow.test.ts が固定する
  //     (この loop は7日窓で足を取り直すので、メモリ内ライブ足(最大520本)だけでは 125本に届かない)。
  it('★確定5分足が 125本に届かない間は ready:false / state:null のまま', () => {
    const bars = feedSeries(360, i => 41000 + Math.sin(i / 11) * 120);   // まるまる6時間ぶん
    startIndicatorsLoop();
    const snap = lastIndicators()!;
    const { usedCloses } = splitCloses(bars);

    expect(usedCloses.length).toBeLessThan(SQUEEZE_BW_LOOKBACK);
    expect(snap.squeeze!.ready).toBe(false);
    expect(snap.squeeze!.state).toBeNull();
    // ただし表示に使う値は出る(パネルは「蓄積中…」にならない)。
    expect(snap.squeeze!.bw).not.toBeNull();
    expect(snap.squeeze!.bwHigh).not.toBeNull();
    expect(snap.squeeze!.bwLow).not.toBeNull();
  });
});
