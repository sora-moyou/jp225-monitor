import { describe, it, expect } from 'vitest';
import { buildNikkeiTechnical } from './chatContext.js';
import type { Bar } from './correlation.js';

// 単調増加 70 本: 現値 > 5分平均 > 60分平均 → 上昇寄り
function rising(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10000 + i * 10 }));
}

describe('buildNikkeiTechnical', () => {
  it('summarizes current price, 1h range, 15m change and trend for a rising series', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars);
    expect(out).not.toBeNull();
    expect(out!).toContain('日経225先物');
    expect(out!).toContain('現値');
    expect(out!).toContain('1時間');
    expect(out!).toContain('15分変化率');
    expect(out!).toContain('傾向: 上昇寄り');
  });

  it('returns null when there are too few bars', () => {
    const getBars = () => Array.from({ length: 10 }, (_, i) => ({ t: i, close: 100 }));
    expect(buildNikkeiTechnical(getBars)).toBeNull();
  });
});
