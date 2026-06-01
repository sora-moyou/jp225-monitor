import { describe, it, expect } from 'vitest';
import { buildNikkeiTechnical, formatLevelsBlock } from './chatContext.js';
import type { Bar } from './correlation.js';
import type { LevelsResult } from './levels.js';

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

  it('marks reversal on downside and acceleration on upside in an uptrend', () => {
    // rising = 上昇寄り → 下抜けで転換(下側)、上抜けで加速(上側)
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? rising() : []))!;
    expect(out).toContain('傾向: 上昇寄り');
    const up = out.match(/上昇目途候補: (.+)/)![1]!;
    const down = out.match(/下落目途候補: (.+)/)![1]!;
    expect(down).toContain('トレンド転換');
    expect(up).toContain('トレンド加速');
  });

  it('marks reversal on upside and acceleration on downside in a downtrend', () => {
    // falling = 下降寄り → 上抜けで転換(上側)、下抜けで加速(下側)
    const out = buildNikkeiTechnical((sym) => (sym === 'NIY=F' ? falling() : []))!;
    expect(out).toContain('傾向: 下降寄り');
    const up = out.match(/上昇目途候補: (.+)/)![1]!;
    const down = out.match(/下落目途候補: (.+)/)![1]!;
    expect(up).toContain('トレンド転換');
    expect(down).toContain('トレンド加速');
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

  it('returns null only when no bars and no fallback price', () => {
    expect(buildNikkeiTechnical(() => [])).toBeNull();
  });

  it('falls back to grid-only meds (節目) from current price when bars are few', () => {
    // バー不足でも 節目 ベースの上値/下値メドは価格で返す (AI が「データなし」にならないように)
    const out = buildNikkeiTechnical(() => Array.from({ length: 5 }, (_, i) => ({ t: i, close: 66920 })))!;
    expect(out).not.toBeNull();
    expect(out).toContain('上昇目途候補');
    expect(out).toContain('67,000円');   // 66,920 の上の 250 節目
  });

  it('uses fallbackPrice for grid-only meds when bars are empty', () => {
    const out = buildNikkeiTechnical(() => [], 66920)!;
    expect(out).toContain('67,000円');
    expect(out).toContain('下落目途候補');
  });
});

describe('formatLevelsBlock', () => {
  const base: LevelsResult = {
    current: 67100,
    up: [{ price: 67300, dist: 200, labels: ['6/1夜高'], strong: false }],
    down: [{ price: 67000, dist: -100, labels: ['Fib50%'], strong: false, fib: 0.5, reversalLine: true }],
    swing: { high: 68000, low: 66000, leg: 'down' },
    reversalSatisfied: true,
    asOf: 0,
  };

  it('上値/下値メドを価格＋ラベルで、フィボ50%の転換判定を文章で出す', () => {
    const out = formatLevelsBlock(base)!;
    expect(out).toContain('67,300');
    expect(out).toContain('6/1夜高');
    expect(out).toContain('上値メド');
    expect(out).toContain('下値メド');
    expect(out).toContain('方向転換');
    expect(out).toContain('満たす');
  });

  it('レベルが空なら null', () => {
    const empty: LevelsResult = { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
    expect(formatLevelsBlock(empty)).toBeNull();
  });
});
