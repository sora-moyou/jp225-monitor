import { describe, it, expect } from 'vitest';
import { buildNikkeiTechnical } from './chatContext.js';
import type { Bar } from './correlation.js';

// 単調増加 70 本: 現値 > 15分平均 > 60分平均 → 上昇寄り
function rising(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10000 + i * 10 }));
}

// 単調減少 70 本: 現値 < 15分平均 < 60分平均 → 下降寄り
function falling(n = 70): Bar[] {
  return Array.from({ length: n }, (_, i) => ({ t: i * 60000, close: 10700 - i * 10 }));
}

describe('buildNikkeiTechnical', () => {
  it('summarizes a 15-60min view with trend, change, 4h levels and target candidates', () => {
    const getBars = (sym: string) => (sym === 'NIY=F' ? rising() : []);
    const out = buildNikkeiTechnical(getBars);
    expect(out).not.toBeNull();
    expect(out!).toContain('日経225先物');
    expect(out!).toContain('15〜60分');
    expect(out!).toContain('現値');
    expect(out!).toContain('30分変化率');
    expect(out!).toContain('傾向: 上昇寄り');
    expect(out!).toContain('上昇目途候補');
    expect(out!).toContain('下落目途候補');
    expect(out!).toContain('4時間');   // 4時間高安が候補に入る
    expect(out!).toContain('節目');
  });

  it('marks a trend-reversal node on the breakout side', () => {
    // rising = 上昇寄り → 下落側に「トレンド転換」ノードが付く
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? rising() : []))!;
    expect(out).toContain('トレンド転換');
    const down = out.match(/下落目途候補: (.+)/)![1]!;
    expect(down).toContain('トレンド転換');
  });

  it('puts the trend-reversal node on the upside in a downtrend (user scenario)', () => {
    // falling = 下降寄り → 上昇側に「トレンド転換」ノードが付く
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? falling() : []))!;
    expect(out).toContain('傾向: 下降寄り');
    const up = out.match(/上昇目途候補: (.+)/)![1]!;
    expect(up).toContain('トレンド転換');
    const down = out.match(/下落目途候補: (.+)/)![1]!;
    expect(down).not.toContain('トレンド転換');
  });

  it('lists multiple downside target candidates (a ladder, not a single level)', () => {
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? rising() : []))!;
    const line = out.match(/下落目途候補: (.+)/)![1]!;
    expect(line.split(' / ').length).toBeGreaterThanOrEqual(2);
  });

  it('annotates levels with distances rounded to 5 yen', () => {
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? rising() : []))!;
    const m = out.match(/中期\(15分平均\)[^/]*現在値 ([+-]\d+)円/);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1])) % 5).toBe(0);
  });

  it('returns null when there are too few bars', () => {
    const getBars = () => Array.from({ length: 10 }, (_, i) => ({ t: i, close: 100 }));
    expect(buildNikkeiTechnical(getBars)).toBeNull();
  });
});
