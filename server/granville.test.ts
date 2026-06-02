import { describe, it, expect } from 'vitest';
import { detectGranvilleReversal, detectGranvilleContinuation,
  type GranvilleParams, type GranvilleContParams } from './granville.js';

const P: GranvilleParams = { maPeriod: 10, slopeBack: 5 };
const PC: GranvilleContParams = { maPeriod: 10, slopeBack: 5, retestBack: 5, touchBand: 0.02 };

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

describe('detectGranvilleContinuation (グランビル②③トレンド継続)', () => {
  it('売り継続(戻り売り): 下降MAで戻りがMA手前で否定→下落再開', () => {
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);   // 100..81 下降
    const fail = [84, 85, 85, 84, 83];                            // MA手前まで戻すが超えられず下落
    const sig = detectGranvilleContinuation([...down, ...fail], PC);
    expect(sig?.dir).toBe('down');
  });

  it('買い継続(押し目買い): 上昇MOで押しがMA手前で支持→上昇再開', () => {
    const up = Array.from({ length: 20 }, (_, i) => 80 + i);      // 80..99 上昇
    const hold = [96, 95, 95, 96, 97];                           // MA手前まで押すが割らず上昇
    const sig = detectGranvilleContinuation([...up, ...hold], PC);
    expect(sig?.dir).toBe('up');
  });

  it('単調トレンド(戻り/押しなし)は null', () => {
    const mono = Array.from({ length: 25 }, (_, i) => 100 - i);
    expect(detectGranvilleContinuation(mono, PC)).toBeNull();
  });
});
