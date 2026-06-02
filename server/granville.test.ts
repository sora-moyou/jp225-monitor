import { describe, it, expect } from 'vitest';
import { detectGranvilleReversal, type GranvilleParams } from './granville.js';

const P: GranvilleParams = { maPeriod: 10, slopeBack: 5 };

describe('detectGranvilleReversal (グランビル①トレンド転換)', () => {
  it('買い転換: MAが下落→上向き＋価格が下から上抜け', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);   // 100..81
    const up = [85, 95, 105, 110, 112];                           // 反発して MA を上抜け
    const sig = detectGranvilleReversal([...down, ...up], P);
    expect(sig?.dir).toBe('up');
    expect(sig!.deviation).toBeGreaterThan(0);
  });

  it('売り転換: MAが上昇→下向き＋価格が上から下抜け', () => {
    const upTrend = Array.from({ length: 20 }, (_, i) => 80 + i);  // 80..99
    const down = [95, 85, 75, 70, 68];                            // 反落して MA を下抜け
    const sig = detectGranvilleReversal([...upTrend, ...down], P);
    expect(sig?.dir).toBe('down');
    expect(sig!.deviation).toBeLessThan(0);
  });

  it('単調下落(転換なし)は null', () => {
    const mono = Array.from({ length: 25 }, (_, i) => 100 - i);
    expect(detectGranvilleReversal(mono, P)).toBeNull();
  });

  it('データ不足は null', () => {
    expect(detectGranvilleReversal([1, 2, 3], P)).toBeNull();
  });
});
