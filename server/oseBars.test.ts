import { describe, it, expect, beforeEach } from 'vitest';
import { feedOsePrice, getOseBars, isOseBarsReady, _reset } from './oseBars.js';

const M = 60_000;

describe('oseBars (リアルタイム OSE 1分足ビルダー)', () => {
  beforeEach(() => _reset());

  it('同一分内は close を最新値で更新し、バーは1本(進行中)', () => {
    feedOsePrice(66600, 10 * M + 1000);
    feedOsePrice(66650, 10 * M + 30_000);
    feedOsePrice(66620, 10 * M + 59_000);
    const bars = getOseBars();
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ t: 10 * M, close: 66620 });
  });

  it('分が変わると前の足が確定し、新しい進行中足ができる', () => {
    feedOsePrice(66600, 10 * M + 1000);
    feedOsePrice(66700, 11 * M + 1000);
    const bars = getOseBars();
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({ t: 10 * M, close: 66600 });   // 確定
    expect(bars[1]).toEqual({ t: 11 * M, close: 66700 });   // 進行中
  });

  it('時刻逆行は無視する', () => {
    feedOsePrice(66600, 11 * M + 1000);
    feedOsePrice(66500, 10 * M + 1000);   // 過去 → 無視
    const bars = getOseBars();
    expect(bars).toHaveLength(1);
    expect(bars[0]!.close).toBe(66600);
  });

  it('不正な価格(0/NaN)は無視する', () => {
    feedOsePrice(0, 10 * M);
    feedOsePrice(NaN, 10 * M);
    expect(getOseBars()).toHaveLength(0);
  });

  it('isOseBarsReady は 65本でしきい値に達する', () => {
    for (let i = 0; i < 64; i++) feedOsePrice(66000 + i, i * M);
    expect(isOseBarsReady()).toBe(false);   // 64本
    feedOsePrice(66064, 64 * M);
    expect(isOseBarsReady()).toBe(true);    // 65本
  });

  it('MAX_BARS を超えると古いバーを捨てる(直近130確定 + 進行中)', () => {
    for (let i = 0; i < 140; i++) feedOsePrice(66000 + i, i * M);
    const bars = getOseBars();
    expect(bars.length).toBeLessThanOrEqual(131);
    // 最古は捨てられ、直近が残る
    expect(bars[bars.length - 1]!.close).toBe(66139);
  });
});
