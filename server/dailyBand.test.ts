import { describe, it, expect } from 'vitest';
import { computeDailyBands } from './dailyBand.js';

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
