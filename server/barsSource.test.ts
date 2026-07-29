import { describe, it, expect, beforeEach } from 'vitest';
import { mergeBars, collectRecentBars } from './barsSource.js';
import { feedRealtimePrice, _reset } from './feedBars.js';

// mergeBars は「DBの1分足 ∪ メモリ内のライブ足」を作る純関数。
// 指標/AI文脈が DB(collector 依存・常時ライブとは限らない)だけに繋がっていたため
// 「蓄積中…」から永久に抜けなかった事故の修正点。ここでは合成規則を固定する。

const T0 = Date.UTC(2026, 6, 29, 0, 0, 0);
const MIN = 60_000;

function db(t: number, o: number, h: number, l: number, c: number): { t: number; o: number; h: number; l: number; c: number } {
  return { t, o, h, l, c };
}

describe('mergeBars', () => {
  it('DBが空でもメモリ足だけで1分足が得られる(メモリ側も実 O/H/L/C を持つ)', () => {
    const mem = [db(T0, 38000, 38050, 37990, 38010), db(T0 + MIN, 38010, 38020, 38000, 38015)];
    const out = mergeBars([], mem);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ t: T0, o: 38000, h: 38050, l: 37990, c: 38010 });
    expect(out[1]!.c).toBe(38015);
  });

  it('メモリが空でもDB足だけで返る(実OHLCはそのまま)', () => {
    const out = mergeBars([db(T0, 1, 5, 0, 3)], []);
    expect(out).toEqual([{ t: T0, o: 1, h: 5, l: 0, c: 3 }]);
  });

  it('同一 t の重複は c を常にメモリ(ライブ)側で上書きする', () => {
    const out = mergeBars([db(T0, 100, 105, 95, 101)], [db(T0, 101, 104, 99, 103)]);
    expect(out.length).toBe(1);
    expect(out[0]!.c).toBe(103);          // 時刻比較はせず常にメモリ側
  });

  it('同一 t の h/l は両者の和集合(h=max・l=min)、o は DB 優先', () => {
    const out = mergeBars([db(T0, 100, 105, 95, 101)], [db(T0, 102, 110, 99, 108)]);
    expect(out[0]!.o).toBe(100);          // DB の実始値を優先(ライブは分の途中から始まりうる)
    expect(out[0]!.h).toBe(110);          // max(105, 110)
    expect(out[0]!.l).toBe(95);           // min(95, 99)
  });

  it('t 昇順でユニーク化する(入力順は問わない)', () => {
    const out = mergeBars(
      [db(T0 + 2 * MIN, 3, 3, 3, 3), db(T0, 1, 1, 1, 1)],
      [db(T0 + MIN, 2, 2, 2, 2), db(T0, 1.5, 1.5, 1.5, 1.5)],
    );
    expect(out.map(b => b.t)).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
  });

  it('不正なライブ値(NaN/0以下)は無視する', () => {
    const out = mergeBars([], [
      db(T0, Number.NaN, Number.NaN, Number.NaN, Number.NaN),
      db(T0 + MIN, 0, 0, 0, 0),
      db(T0 + 2 * MIN, 38000, 38000, 38000, 38000),
    ]);
    expect(out.length).toBe(1);
    expect(out[0]!.t).toBe(T0 + 2 * MIN);
  });

  it('両方空なら空配列', () => {
    expect(mergeBars([], [])).toEqual([]);
  });
});

describe('collectRecentBars', () => {
  beforeEach(() => { _reset(); });

  it('DB ハンドルが無くてもメモリ内ライブ足から窓内の1分足を集める(collector 未稼働でも指標が出る)', () => {
    const now = T0 + 10 * MIN;
    feedRealtimePrice('NIY=F', 38000, T0 + 8 * MIN);
    feedRealtimePrice('NIY=F', 38020, T0 + 9 * MIN);
    const bars = collectRecentBars(null, 'NIY=F', now - 60 * MIN);
    expect(bars.length).toBe(2);
    expect(bars[bars.length - 1]!.c).toBe(38020);
  });

  it('メモリ足の分内高安が保たれる(レンジ0のローソクにならない=ATRが潰れない)', () => {
    feedRealtimePrice('NIY=F', 38000, T0 + 8 * MIN);
    feedRealtimePrice('NIY=F', 38060, T0 + 8 * MIN + 20_000);
    feedRealtimePrice('NIY=F', 37980, T0 + 8 * MIN + 40_000);
    const bars = collectRecentBars(null, 'NIY=F', T0);
    expect(bars[0]).toEqual({ t: T0 + 8 * MIN, o: 38000, h: 38060, l: 37980, c: 37980 });
  });

  it('窓より古いライブ足は落とす', () => {
    feedRealtimePrice('NIY=F', 37000, T0);
    feedRealtimePrice('NIY=F', 38000, T0 + 30 * MIN);
    const bars = collectRecentBars(null, 'NIY=F', T0 + 10 * MIN);
    expect(bars.length).toBe(1);
    expect(bars[0]!.t).toBe(T0 + 30 * MIN);
  });
});
