import { describe, it, expect } from 'vitest';
import { rsi14, sma, bollinger, computeIndicators, pctBOf, aggregate5m, indicatorProgress, MIN_CLOSES_FOR_MAIN } from './indicators.js';

describe('rsi14 (Wilder)', () => {
  // StockCharts の教科書データ。最初の14変化(15本)で first RSI ≈ 70.53。
  const closes = [
    44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245,
    45.8433, 46.0826, 45.8931, 46.0328, 45.6140, 46.2820, 46.2820,
  ];
  it('既知の参照列で first RSI ≈ 70.53', () => {
    const r = rsi14(closes);
    expect(r).not.toBeNull();
    expect(r!).toBeCloseTo(70.53, 1);
  });
  it('15本未満(14本)は null=データ不足', () => {
    expect(rsi14(closes.slice(0, 14))).toBeNull();
  });
  it('単調上昇(損失なし)は 100', () => {
    const up = Array.from({ length: 16 }, (_, i) => 100 + i);
    expect(rsi14(up)).toBe(100);
  });
});

describe('sma', () => {
  it('直近 period 本の平均', () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([2, 4, 6, 8], 2)).toBe(7);   // 末尾2本 (6,8)
  });
  it('本数不足/非正 period は null', () => {
    expect(sma([1, 2], 5)).toBeNull();
    expect(sma([1, 2, 3], 0)).toBeNull();
  });
});

describe('bollinger', () => {
  it('中央=SMA14 / 上下=中央 ± 1.5σ(母集団)', () => {
    // 1..14 の SMA=7.5。母集団分散= (Σ(x-7.5)^2)/14 = 227.5/14 = 16.25 → σ≈4.0311。
    const closes = Array.from({ length: 14 }, (_, i) => i + 1);
    const b = bollinger(closes, 14, 1.5);
    expect(b.mid!).toBeCloseTo(7.5, 6);
    const sd = Math.sqrt(16.25);
    expect(b.upper!).toBeCloseTo(7.5 + 1.5 * sd, 6);
    expect(b.lower!).toBeCloseTo(7.5 - 1.5 * sd, 6);
  });
  it('全同値は σ=0 → 上下=中央(幅0)', () => {
    const closes = Array.from({ length: 14 }, () => 41000);
    const b = bollinger(closes, 14, 1.5);
    expect(b.mid).toBe(41000);
    expect(b.upper).toBe(41000);
    expect(b.lower).toBe(41000);
  });
  it('本数不足は全て null', () => {
    const b = bollinger([1, 2, 3], 14, 1.5);
    expect(b.mid).toBeNull();
    expect(b.upper).toBeNull();
    expect(b.lower).toBeNull();
  });
});

describe('pctBOf', () => {
  it('(price − lower)/(upper − lower)', () => {
    expect(pctBOf(41300, 41400, 41000)).toBeCloseTo(0.75, 6);
  });
  it('幅0/未算出は null', () => {
    expect(pctBOf(41000, 41000, 41000)).toBeNull();
    expect(pctBOf(41000, null, 41000)).toBeNull();
  });
});

describe('computeIndicators', () => {
  it('十分な本数で現在値 + 系列を返す', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 41000 + Math.sin(i / 3) * 50);
    const snap = computeIndicators(closes);
    expect(snap.rsi).not.toBeNull();
    expect(snap.sma).not.toBeNull();
    expect(snap.bbUpper).not.toBeNull();
    expect(snap.bbLower).not.toBeNull();
    expect(snap.price).toBe(closes[closes.length - 1]);
    expect(snap.series.length).toBe(12);   // 直近12点
    // pctB は 0..1 近傍(バンド内位置)。
    expect(snap.pctB).not.toBeNull();
  });
  it('本数不足では指標は null(price/series は返る)', () => {
    const closes = [41000, 41010, 41020];
    const snap = computeIndicators(closes);
    expect(snap.rsi).toBeNull();
    expect(snap.sma).toBeNull();
    expect(snap.bbUpper).toBeNull();
    expect(snap.pctB).toBeNull();
    expect(snap.price).toBe(41020);
    expect(snap.series.length).toBe(3);
  });
  it('times を渡すと系列/スナップショットに t が付く', () => {
    const closes = Array.from({ length: 16 }, (_, i) => 41000 + i);
    const times = Array.from({ length: 16 }, (_, i) => i * 300_000);
    const snap = computeIndicators(closes, times);
    expect(snap.t).toBe(times[15]);
    expect(snap.series[snap.series.length - 1]!.t).toBe(times[15]);
  });
});

describe('indicatorProgress', () => {
  it('窓内の1分足が0本なら no-bars(データ供給そのものが無い)', () => {
    expect(indicatorProgress(0, 0)).toEqual({ state: 'no-bars', remaining: MIN_CLOSES_FOR_MAIN });
  });
  it('足はあるが本数不足なら warming + 残り本数', () => {
    expect(indicatorProgress(120, 7)).toEqual({ state: 'warming', remaining: MIN_CLOSES_FOR_MAIN - 7 });
    expect(indicatorProgress(120, 0)).toEqual({ state: 'warming', remaining: MIN_CLOSES_FOR_MAIN });
  });
  it('主指標(SMA14/BB14)が算出できる本数に達したら ready(remaining=0)', () => {
    expect(indicatorProgress(300, MIN_CLOSES_FOR_MAIN)).toEqual({ state: 'ready', remaining: 0 });
    expect(indicatorProgress(300, MIN_CLOSES_FOR_MAIN + 30)).toEqual({ state: 'ready', remaining: 0 });
  });
  it('残り本数は SMA/BB の実要件と整合する(remaining=0 で sma が算出できる)', () => {
    const closes = Array.from({ length: MIN_CLOSES_FOR_MAIN }, (_, i) => 41000 + i);
    expect(indicatorProgress(999, closes.length).remaining).toBe(0);
    expect(sma(closes, 14)).not.toBeNull();
    expect(sma(closes.slice(0, -1), 14)).toBeNull();   // 1本欠けると算出できない
  });
});

describe('aggregate5m', () => {
  it('1分足を5分足へ集約(O/H/L/C)', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      t: i * 60_000, o: 100 + i, h: 100 + i + 2, l: 100 + i - 1, c: 100 + i,
    }));
    const b5 = aggregate5m(bars);
    expect(b5.length).toBe(2);   // 0-4分, 5-9分
    expect(b5[0]!.o).toBe(100);          // 最初
    expect(b5[0]!.c).toBe(104);          // 最後(4分)
    expect(b5[0]!.h).toBe(106);          // 最大(4分の h=104+2)
  });
});
