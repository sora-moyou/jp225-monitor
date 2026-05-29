import { describe, it, expect } from 'vitest';
import { selectNewsPool } from './openai.js';
import type { NewsItem } from '../types.js';

const now = 1_700_000_000_000;
const min = (m: number): NewsItem => ({
  id: `n${m}`,
  title: `news ${m} min ago`,
  source: 's',
  lang: 'en',
  url: 'x',
  publishedAt: now - m * 60_000,
});

describe('selectNewsPool (v0.3.9 proximity fallback)', () => {
  it('returns ±15min pool when tight matches exist', () => {
    const pool = selectNewsPool([min(5), min(40), min(120)], now);
    expect(pool).toEqual([min(5)]);
  });

  it('falls back to ±60min pool when no tight matches', () => {
    const pool = selectNewsPool([min(40), min(120), min(200)], now);
    expect(pool).toEqual([min(40)]);
  });

  it('falls back to 4h pool when no tight or loose matches', () => {
    const pool = selectNewsPool([min(120), min(200), min(300)], now);
    // 4h = 240 min; 300 はカット, 120/200 残る
    expect(pool).toEqual([min(120), min(200)]);
  });

  it('returns empty array when nothing within 4h', () => {
    const pool = selectNewsPool([min(500), min(1000)], now);
    expect(pool).toEqual([]);
  });
});
