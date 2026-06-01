import { describe, it, expect, beforeEach } from 'vitest';
import { feedPrice, getMomentum, _reset, seedBuffer } from './tickDetector.js';
import type { Price } from './types.js';

function px(price: number, t: number, symbol: Price['symbol'] = 'NIY=F'): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale: false };
}

describe('getMomentum (日経カード: 超短期=値幅円 / 短期=率%)', () => {
  beforeEach(() => _reset());

  it('データ不足(0〜1本)なら null', () => {
    expect(getMomentum('NIY=F')).toBeNull();
    feedPrice([px(67000, 0)]);
    expect(getMomentum('NIY=F')).toBeNull();   // 1本のみ
  });

  it('超短期は10秒窓の値幅(円)を返す', () => {
    feedPrice([px(67000, 0)]);
    feedPrice([px(67050, 5000)]);
    feedPrice([px(67030, 10000)]);
    const m = getMomentum('NIY=F')!;
    // 10秒前(67000)から +30 (固定10秒窓)
    expect(m.ultraShortYen).toBe(30);
    // 60秒前のサンプルが無い → 短期は null
    expect(m.shortPct).toBeNull();
  });

  it('60秒離れたサンプルから短期率(%)を返す', () => {
    feedPrice([px(67000, 0)]);
    feedPrice([px(67067, 62000)]);   // 62秒後, +67円 ≈ +0.10%
    const m = getMomentum('NIY=F')!;
    expect(m.shortPct).toBeCloseTo(0.10, 2);
    expect(m.ultraShortYen).toBe(67);
  });

  it('NIY=F 以外はバッファに入らない', () => {
    feedPrice([px(30000, 0, 'NQ=F')]);
    feedPrice([px(30100, 5000, 'NQ=F')]);
    expect(getMomentum('NQ=F')).toBeNull();
  });
});

describe('seedBuffer (DB warmup)', () => {
  beforeEach(() => _reset());

  it('seeds the tick buffer so getMomentum has history immediately; no overwrite if data exists', () => {
    seedBuffer('NIY=F', [{ t: 0, price: 67000 }, { t: 10_000, price: 67040 }]);
    const m = getMomentum('NIY=F')!;
    expect(m.ultraShortYen).toBe(40);   // 10秒窓: 67040-67000
    // 既存があれば上書きしない
    seedBuffer('NIY=F', [{ t: 0, price: 1 }]);
    expect(getMomentum('NIY=F')!.ultraShortYen).toBe(40);
  });
});
