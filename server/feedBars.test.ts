import { describe, it, expect, beforeEach } from 'vitest';
import { feedRealtimePrice, getRealtimeBars, isRealtimeBarsReady, _reset } from './feedBars.js';

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

  it('MAX_BARS(520) を超えると古いバーを捨てる', () => {
    for (let i = 0; i < 540; i++) feedRealtimePrice('NIY=F', 66000 + i, i * M);
    const bars = getRealtimeBars('NIY=F');
    expect(bars.length).toBeLessThanOrEqual(521);   // 確定520 + 進行中1
    expect(bars[bars.length - 1]!.close).toBe(66539);  // 直近は残る
    expect(bars[0]!.close).toBeGreaterThan(66000);     // 最古は捨てられた
  });
});
