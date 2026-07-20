import { describe, it, expect } from 'vitest';
import { computeDailyBands, computeDailyMAs, dailyCloseSeries } from './dailyBand.js';

describe('computeDailyBands', () => {
  it('returns [] when fewer than 25 closes', () => {
    expect(computeDailyBands([])).toEqual([]);
    expect(computeDailyBands(Array.from({ length: 24 }, (_, i) => 38000 + i))).toEqual([]);
  });

  it('returns exactly 5 bands when 25 closes', () => {
    const closes = Array.from({ length: 25 }, () => 38000);
    const bands = computeDailyBands(closes);
    expect(bands).toHaveLength(5);
  });

  it('uses only the last 25 closes', () => {
    // 10 garbage values + 25 identical -> sd should be 0, all bands = 38000
    const closes = [...Array.from({ length: 10 }, () => 1), ...Array.from({ length: 25 }, () => 38000)];
    const bands = computeDailyBands(closes);
    expect(bands.every(b => b.price === 38000)).toBe(true);
  });

  it('computes MA25 as the mean of the last 25 closes', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 38000 + i); // mean = 38012
    const bands = computeDailyBands(closes);
    const ma = bands.find(b => b.refKind === 'ma25');
    expect(ma?.price).toBe(38012);
    expect(ma?.label).toBe('MA25');
  });

  it('+1sigma and -1sigma are symmetric around MA25', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 38000 + i * 10);
    const bands = computeDailyBands(closes);
    const ma = bands.find(b => b.refKind === 'ma25')!.price;
    const plus1 = bands.find(b => b.label === '+1sigma')!.price;
    const minus1 = bands.find(b => b.label === '-1sigma')!.price;
    expect(plus1 - ma).toBe(ma - minus1);
    expect(plus1).toBeGreaterThan(ma);
    expect(minus1).toBeLessThan(ma);
  });

  it('+2sigma distance from MA25 is 2x the +1sigma distance', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 38000 + i * 10);
    const bands = computeDailyBands(closes);
    const ma = bands.find(b => b.refKind === 'ma25')!.price;
    const plus1 = bands.find(b => b.label === '+1sigma')!.price;
    const plus2 = bands.find(b => b.label === '+2sigma')!.price;
    // distances may differ by 1 due to independent rounding; compare unrounded via raw sigma
    const d1 = plus1 - ma;
    const d2 = plus2 - ma;
    expect(Math.abs(d2 - 2 * d1)).toBeLessThanOrEqual(1);
  });

  it('uses population std (divide by N=25)', () => {
    // closes alternating so we can compute population sd by hand
    const closes = [...Array.from({ length: 13 }, () => 38100), ...Array.from({ length: 12 }, () => 37900)];
    const mean = (13 * 38100 + 12 * 37900) / 25; // 38004
    const variance = (13 * (38100 - mean) ** 2 + 12 * (37900 - mean) ** 2) / 25;
    const sd = Math.sqrt(variance);
    const bands = computeDailyBands(closes);
    const ma = bands.find(b => b.refKind === 'ma25')!.price;
    const plus1 = bands.find(b => b.label === '+1sigma')!.price;
    expect(ma).toBe(Math.round(mean));
    expect(plus1).toBe(Math.round(mean + sd));
  });

  it('labels and refKinds are as specified', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 38000 + i * 5);
    const bands = computeDailyBands(closes);
    const byLabel = Object.fromEntries(bands.map(b => [b.label, b.refKind]));
    expect(byLabel).toEqual({
      'MA25': 'ma25',
      '+1sigma': 'sigma1',
      '-1sigma': 'sigma1',
      '+2sigma': 'sigma2',
      '-2sigma': 'sigma2',
    });
  });

  it('all band prices are integers', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 38000 + i * 7.3);
    const bands = computeDailyBands(closes);
    expect(bands.every(b => Number.isInteger(b.price))).toBe(true);
  });
});

describe('computeDailyMAs (日足MA5/20/50/75・線のみ)', () => {
  it('十分な本数があれば MA5/20/50/75 の4水準を返す', () => {
    const closes = Array.from({ length: 100 }, () => 38000);
    const mas = computeDailyMAs(closes);
    expect(mas.map(m => m.period)).toEqual([5, 20, 50, 75]);
    expect(mas.map(m => m.label)).toEqual(['MA5', 'MA20', 'MA50', 'MA75']);
    expect(mas.every(m => m.price === 38000)).toBe(true);
  });

  it('期間に満たない終値はスキップする(不足MAは出さない)', () => {
    expect(computeDailyMAs([]).map(m => m.period)).toEqual([]);
    expect(computeDailyMAs(Array.from({ length: 4 }, () => 1)).map(m => m.period)).toEqual([]);   // <5
    expect(computeDailyMAs(Array.from({ length: 5 }, () => 1)).map(m => m.period)).toEqual([5]);   // 5だけ
    expect(computeDailyMAs(Array.from({ length: 20 }, () => 1)).map(m => m.period)).toEqual([5, 20]);
    expect(computeDailyMAs(Array.from({ length: 74 }, () => 1)).map(m => m.period)).toEqual([5, 20, 50]);   // 75未満
    expect(computeDailyMAs(Array.from({ length: 75 }, () => 1)).map(m => m.period)).toEqual([5, 20, 50, 75]);
  });

  it('各MAは直近period本の単純平均・整数に丸める', () => {
    // 末尾5本 = 38010..38014 平均=38012、末尾20本 = 37995..38014 平均=38004.5→38005(round)
    const closes = Array.from({ length: 20 }, (_, i) => 37995 + i);
    const mas = computeDailyMAs(closes);
    expect(mas.find(m => m.period === 5)!.price).toBe(38012);
    expect(mas.find(m => m.period === 20)!.price).toBe(38005);
    expect(mas.every(m => Number.isInteger(m.price))).toBe(true);
  });

  it('直近period本のみ使う(それ以前は無視)', () => {
    // 先頭にゴミ、末尾5本だけ 40000 → MA5=40000
    const closes = [...Array.from({ length: 10 }, () => 1), ...Array.from({ length: 5 }, () => 40000)];
    const mas = computeDailyMAs(closes);
    expect(mas.find(m => m.period === 5)!.price).toBe(40000);
  });
});

describe('dailyCloseSeries (realtime MA25, v0.6.22)', () => {
  it('24 confirmed + current price -> 25 values ending in the price', () => {
    const confirmed = Array.from({ length: 24 }, (_, i) => 38000 + i);
    const series = dailyCloseSeries(confirmed, 39999);
    expect(series).toHaveLength(25);
    expect(series[series.length - 1]).toBe(39999);
    expect(series.slice(0, 24)).toEqual(confirmed);
  });

  it('keep を大きくすると MA50/75 用に長い系列を返す(バンドは既定24で不変)', () => {
    const confirmed = Array.from({ length: 90 }, (_, i) => 38000 + i);
    expect(dailyCloseSeries(confirmed, 40000)).toHaveLength(25);          // 既定 keep=24 → 25値(バンド用・不変)
    const long = dailyCloseSeries(confirmed, 40000, 75);
    expect(long).toHaveLength(76);                                        // 75確定 + 現在値
    expect(long[long.length - 1]).toBe(40000);
    expect(long.slice(0, 75)).toEqual(confirmed.slice(-75));
  });

  it('30 confirmed -> keeps only the last 24 then appends the current price', () => {
    const confirmed = Array.from({ length: 30 }, (_, i) => 38000 + i);
    const series = dailyCloseSeries(confirmed, 40000);
    expect(series).toHaveLength(25);
    // last 24 of confirmed = indices 6..29 -> 38006..38029
    expect(series.slice(0, 24)).toEqual(confirmed.slice(-24));
    expect(series[24]).toBe(40000);
  });

  it('appends the price even when fewer than 24 confirmed closes', () => {
    const confirmed = [38000, 38010, 38020];
    const series = dailyCloseSeries(confirmed, 38100);
    expect(series).toEqual([38000, 38010, 38020, 38100]);
  });

  it('changing currentPrice changes the computed MA25', () => {
    const confirmed = Array.from({ length: 24 }, () => 38000);
    const maOf = (price: number): number =>
      computeDailyBands(dailyCloseSeries(confirmed, price)).find(b => b.refKind === 'ma25')!.price;
    const maLow = maOf(38000);   // all 25 == 38000 -> MA25 = 38000
    const maHigh = maOf(40500);  // (24*38000 + 40500)/25 = 38100
    expect(maLow).toBe(38000);
    expect(maHigh).toBe(38100);
    expect(maHigh).toBeGreaterThan(maLow);
  });
});
