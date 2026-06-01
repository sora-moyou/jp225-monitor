import { describe, it, expect, beforeEach } from 'vitest';
import { feedRealtimePrice, getRealtimeBars, isRealtimeBarsReady, getRollingReturn, _reset, seedBars, seedSamples } from './feedBars.js';

const M = 60_000;

describe('feedBars (マルチ銘柄リアルタイム1分足ビルダー)', () => {
  beforeEach(() => _reset());

  it('同一分内は close を最新値で更新し、バーは1本(進行中)', () => {
    feedRealtimePrice('NIY=F', 66600, 10 * M + 1000);
    feedRealtimePrice('NIY=F', 66650, 10 * M + 30_000);
    feedRealtimePrice('NIY=F', 66620, 10 * M + 59_000);
    const bars = getRealtimeBars('NIY=F');
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: 10 * M, close: 66620 });
  });

  it('分が変わると前の足が確定し、新しい進行中足ができる', () => {
    feedRealtimePrice('NIY=F', 66600, 10 * M + 1000);
    feedRealtimePrice('NIY=F', 66700, 11 * M + 1000);
    const bars = getRealtimeBars('NIY=F');
    expect(bars).toEqual([{ t: 10 * M, close: 66600 }, { t: 11 * M, close: 66700 }]);
  });

  it('銘柄ごとに独立した系列を保つ', () => {
    feedRealtimePrice('NIY=F', 66600, 10 * M);
    feedRealtimePrice('NQ=F', 30450, 10 * M);
    feedRealtimePrice('NQ=F', 30460, 11 * M);
    expect(getRealtimeBars('NIY=F')).toEqual([{ t: 10 * M, close: 66600 }]);
    expect(getRealtimeBars('NQ=F')).toEqual([{ t: 10 * M, close: 30450 }, { t: 11 * M, close: 30460 }]);
  });

  it('未投入銘柄は空配列・未 ready', () => {
    expect(getRealtimeBars('YM=F')).toEqual([]);
    expect(isRealtimeBarsReady('YM=F')).toBe(false);
  });

  it('時刻逆行・不正価格は無視する', () => {
    feedRealtimePrice('NIY=F', 66600, 11 * M);
    feedRealtimePrice('NIY=F', 66500, 10 * M);   // 過去 → 無視
    feedRealtimePrice('NIY=F', 0, 12 * M);        // 不正 → 無視
    feedRealtimePrice('NIY=F', NaN, 12 * M);
    expect(getRealtimeBars('NIY=F')).toEqual([{ t: 11 * M, close: 66600 }]);
  });

  it('isRealtimeBarsReady は 65本でしきい値に達する (銘柄ごと)', () => {
    for (let i = 0; i < 64; i++) feedRealtimePrice('NIY=F', 66000 + i, i * M);
    expect(isRealtimeBarsReady('NIY=F')).toBe(false);
    feedRealtimePrice('NIY=F', 66064, 64 * M);
    expect(isRealtimeBarsReady('NIY=F')).toBe(true);
    expect(isRealtimeBarsReady('NQ=F')).toBe(false);   // 別銘柄は独立
  });

  it('getRollingReturn: 指定窓のローリング変化率(比)を生サンプルから返す', () => {
    // 生サンプルは秒単位 (分足ではない)。10秒間隔で投入。
    feedRealtimePrice('NIY=F', 67000, 0);
    feedRealtimePrice('NIY=F', 67020, 10_000);
    feedRealtimePrice('NIY=F', 67134, 60_000);   // 60秒後
    // 60秒窓: 60000-60000=0 以下の最大 → t=0(67000)。(67134-67000)/67000
    expect(getRollingReturn(60_000, 'NIY=F')).toBeCloseTo((67134 - 67000) / 67000, 6);
    // 5秒窓: 60000-5000=55000 以下の最大 → t=10000(67020)
    expect(getRollingReturn(5_000, 'NIY=F')).toBeCloseTo((67134 - 67020) / 67020, 6);
  });

  it('getRollingReturn: サンプル不足/未投入は null', () => {
    expect(getRollingReturn(60_000, 'NIY=F')).toBeNull();
    feedRealtimePrice('NIY=F', 67000, 0);
    expect(getRollingReturn(60_000, 'NIY=F')).toBeNull();   // 1本のみ
    expect(getRollingReturn(60_000, 'NQ=F')).toBeNull();    // 未投入
  });

  it('MAX_BARS(520) を超えると古いバーを捨てる', () => {
    for (let i = 0; i < 540; i++) feedRealtimePrice('NIY=F', 66000 + i, i * M);
    const bars = getRealtimeBars('NIY=F');
    expect(bars.length).toBeLessThanOrEqual(521);   // 確定520 + 進行中1
    expect(bars[bars.length - 1]!.close).toBe(66539);  // 直近は残る
    expect(bars[0]!.close).toBeGreaterThan(66000);     // 最古は捨てられた
  });
});

describe('seedBars / seedSamples (DB warmup)', () => {
  beforeEach(() => _reset());

  it('seedBars fills closed bars + an in-progress bar from the last, and reports ready', () => {
    const bars = Array.from({ length: 70 }, (_, i) => ({ t: i * M, close: 67000 + i }));
    seedBars('NIY=F', bars);
    const out = getRealtimeBars('NIY=F');
    expect(out).toHaveLength(70);
    expect(out[0]).toEqual({ t: 0, close: 67000 });
    expect(out[69]).toEqual({ t: 69 * M, close: 67069 });
    expect(isRealtimeBarsReady('NIY=F')).toBe(true);
  });

  it('seedBars does nothing on empty input or if the series already has data', () => {
    seedBars('NIY=F', []);
    expect(getRealtimeBars('NIY=F')).toEqual([]);
    feedRealtimePrice('NIY=F', 67000, 10 * M);            // now has live data
    seedBars('NIY=F', [{ t: 0, close: 99999 }]);          // must NOT overwrite
    expect(getRealtimeBars('NIY=F').some(b => b.close === 99999)).toBe(false);
  });

  it('after seedBars, a live tick in a new minute appends (no duplicate of the last seeded minute)', () => {
    seedBars('NIY=F', [{ t: 10 * M, close: 67000 }, { t: 11 * M, close: 67010 }]);
    feedRealtimePrice('NIY=F', 67050, 12 * M);
    const out = getRealtimeBars('NIY=F');
    expect(out.map(b => b.t)).toEqual([10 * M, 11 * M, 12 * M]);
  });

  it('seedSamples enables getRollingReturn; does nothing if samples already exist', () => {
    seedSamples('NIY=F', [{ t: 0, price: 67000 }, { t: 61_000, price: 67067 }]);
    expect(getRollingReturn(60_000, 'NIY=F')).toBeCloseTo((67067 - 67000) / 67000, 6);
  });
});
