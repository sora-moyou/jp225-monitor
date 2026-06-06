import { describe, it, expect } from 'vitest';
import { computeTrendLines } from './trendLines.js';
import type { SwingPivot } from './swingPivots.js';

const low = (t: number, price: number): SwingPivot => ({ t, price, kind: 'low' });
const high = (t: number, price: number): SwingPivot => ({ t, price, kind: 'high' });

describe('computeTrendLines', () => {
  it('切り上がる安値3点 → 上昇トレンドライン(now へ延長)', () => {
    // line(t)=100+1*t。3点が線上、1点は線より上(=破断しない)。
    const piv = [low(0, 100), low(5, 130), low(10, 110), low(20, 120)];
    const lines = computeTrendLines(piv, /*current*/130, /*now*/30);
    const sup = lines.find(l => l.kind === 'support');
    expect(sup).toBeDefined();
    expect(sup!.touches).toBeGreaterThanOrEqual(3);
    expect(sup!.slope).toBeGreaterThan(0);
    expect(sup!.priceNow).toBe(130);   // line(30)=130
  });

  it('切り下がる高値3点 → 下降トレンドライン', () => {
    const piv = [high(0, 200), high(10, 190), high(20, 180)];
    const lines = computeTrendLines(piv, /*current*/170, /*now*/30);
    const res = lines.find(l => l.kind === 'resistance');
    expect(res).toBeDefined();
    expect(res!.touches).toBe(3);
    expect(res!.slope).toBeLessThan(0);
    expect(res!.priceNow).toBe(170);   // line(30)=170
  });

  it('2点では引かない(3点必須)', () => {
    const piv = [low(0, 100), low(10, 110)];
    expect(computeTrendLines(piv, 120, 30)).toEqual([]);
  });

  it('現値が線を割っていればブレイク済み=無効', () => {
    const piv = [low(0, 100), low(10, 110), low(20, 120)];   // line(30)=130
    expect(computeTrendLines(piv, /*current*/120, /*now*/30).some(l => l.kind === 'support')).toBe(false);
  });

  it('線を明確に下抜けた安値があれば破断=無効', () => {
    const piv = [low(0, 100), low(10, 110), low(15, 110), low(20, 120)];  // (15,110) は line(15)=115 を下抜け
    expect(computeTrendLines(piv, 130, 30).some(l => l.kind === 'support')).toBe(false);
  });
});
