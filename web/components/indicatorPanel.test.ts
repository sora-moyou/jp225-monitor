import { describe, it, expect } from 'vitest';
import { buildIndicatorHtml, rsiClass } from './indicatorPanel.js';
import type { IndicatorSnapshot } from '../types.js';

// buildIndicatorHtml / rsiClass は DOM 非依存の純関数。表示整形と RSI 色分類を検証する。

const base: IndicatorSnapshot = {
  rsi: 62, sma: 41230, bbUpper: 41410, bbMid: 41230, bbLower: 41050,
  price: 41300, pctB: 0.78, series: [],
};

describe('buildIndicatorHtml', () => {
  it('主指標が揃えば RSI/SMA/BB/価格位置を表示', () => {
    const html = buildIndicatorHtml(base);
    expect(html).toContain('RSI');
    expect(html).toContain('62');
    expect(html).toContain('41,230');            // SMA(桁区切り)
    expect(html).toContain('41,050〜41,410');     // BB
    expect(html).toContain('%B 0.78');
    expect(html).not.toContain('蓄積中');
  });
  it('データ未到達(null)は「蓄積中…」', () => {
    expect(buildIndicatorHtml(null)).toContain('蓄積中');
    const empty: IndicatorSnapshot = { ...base, rsi: null, sma: null, bbUpper: null, bbLower: null, bbMid: null, pctB: null };
    expect(buildIndicatorHtml(empty)).toContain('蓄積中');
  });
  it('%B が高い/低いで位置ラベルが変わる', () => {
    expect(buildIndicatorHtml({ ...base, pctB: 0.9 })).toContain('上寄り');
    expect(buildIndicatorHtml({ ...base, pctB: 0.1 })).toContain('下寄り');
    expect(buildIndicatorHtml({ ...base, pctB: 0.5 })).toContain('中央');
  });
});

describe('rsiClass', () => {
  it('≥70=買われすぎ / ≤30=売られすぎ / それ以外=中立', () => {
    expect(rsiClass(72)).toBe('ind-rsi-ob');
    expect(rsiClass(28)).toBe('ind-rsi-os');
    expect(rsiClass(50)).toBe('ind-rsi-neutral');
    expect(rsiClass(null)).toBe('ind-rsi-neutral');
  });
});
