import { describe, it, expect } from 'vitest';
import { buildNikkeiTechnical } from './chatContext.js';
import type { Bar } from './correlation.js';

// 単調増加 70 本: 現値 > 15分平均 > 60分平均 → 上昇寄り
function rising(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10000 + i * 10 }));
}

describe('buildNikkeiTechnical', () => {
  it('summarizes a 15-60min view with trend and 30/60min change for a rising series', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars);
    expect(out).not.toBeNull();
    expect(out!).toContain('日経225先物');
    expect(out!).toContain('15〜60分');
    expect(out!).toContain('現値');
    expect(out!).toContain('30分変化率');
    expect(out!).toContain('中期(15分平均)');
    expect(out!).toContain('傾向: 上昇寄り');
  });

  it('annotates reference levels with a distance rounded to 5 yen', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars)!;
    // 中期(15分平均)の距離が「現在値 ±N円」形式で、N は 5 円単位
    const m = out.match(/中期\(15分平均\)[^/]*現在値 ([+-]\d+)円/);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1])) % 5).toBe(0);
  });

  it('returns null when there are too few bars', () => {
    const getBars = () => Array.from({ length: 10 }, (_, i) => ({ t: i, close: 100 }));
    expect(buildNikkeiTechnical(getBars)).toBeNull();
  });
});
