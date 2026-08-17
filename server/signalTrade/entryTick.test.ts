import { describe, it, expect } from 'vitest';
import { roundEntryToTick, ENTRY_TICK_YEN } from './entryTick.js';

describe('roundEntryToTick', () => {
  it('刻みは5円', () => expect(ENTRY_TICK_YEN).toBe(5));

  it('既に刻み上なら値を変えない', () => {
    expect(roundEntryToTick(68990, 'buy', 'limit')).toBe(68990);
    expect(roundEntryToTick(68995, 'sell', 'stop')).toBe(68995);
  });

  // ★丸めは必ず「不利でない側」へ寄せる=約定しにくくなる向き。
  //   有利側へ寄せると、AI が意図していない価格で約定しうる。
  it('買いの指値は切り下げる(より安く買う=約定しにくい側)', () => {
    expect(roundEntryToTick(68993, 'buy', 'limit')).toBe(68990);
  });
  it('売りの指値は切り上げる(より高く売る=約定しにくい側)', () => {
    expect(roundEntryToTick(68992, 'sell', 'limit')).toBe(68995);
  });
  it('買いの逆指値は切り上げる(より高く入る=約定しにくい側)', () => {
    expect(roundEntryToTick(69101, 'buy', 'stop')).toBe(69105);
  });
  it('売りの逆指値は切り下げる(より安く入る=約定しにくい側)', () => {
    expect(roundEntryToTick(69104, 'sell', 'stop')).toBe(69100);
  });

  it('非有限はそのまま返す(呼び出し側の既存の欠損処理を壊さない)', () => {
    expect(Number.isNaN(roundEntryToTick(NaN, 'buy', 'limit'))).toBe(true);
  });

  // ★4象限すべてで「丸めた結果が元の値より不利にならない」ことを掃引で確かめる。
  //   buy は安く(≤)、sell は高く(≥) なる方向にだけ動く…ではなく、
  //   「約定しにくい側」= buy指値/sell逆指値は下、sell指値/buy逆指値は上。
  it('掃引: 4象限すべてで向きが規定どおり', () => {
    for (let p = 68990; p <= 69010; p++) {
      expect(roundEntryToTick(p, 'buy', 'limit')).toBeLessThanOrEqual(p);
      expect(roundEntryToTick(p, 'sell', 'stop')).toBeLessThanOrEqual(p);
      expect(roundEntryToTick(p, 'sell', 'limit')).toBeGreaterThanOrEqual(p);
      expect(roundEntryToTick(p, 'buy', 'stop')).toBeGreaterThanOrEqual(p);
      // 動く量は必ず刻み未満
      for (const [s, k] of [['buy','limit'],['sell','limit'],['buy','stop'],['sell','stop']] as const) {
        expect(Math.abs(roundEntryToTick(p, s, k) - p)).toBeLessThan(ENTRY_TICK_YEN);
        expect(roundEntryToTick(p, s, k) % ENTRY_TICK_YEN).toBe(0);
      }
    }
  });
});
