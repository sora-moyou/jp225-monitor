import { describe, it, expect } from 'vitest';
import { explain } from './openai.js';

describe('explain 戻り値(実参照アンカー)', () => {
  it('材料ニュースなし→テクニカル要因・newsMaxPublishedAt=0(LLM未呼び出し)', async () => {
    const r = await explain({
      symbol: 'NIY=F', symbolLabel: '日経平均先物', changePercent: 0.05, windowSeconds: 30,
      detectionKind: 'slope', direction: 'up', change15min: null, pa15min: null, range1h: null,
      news: [], crossAsset: [],
    });
    expect(r.newsMaxPublishedAt).toBe(0);
    expect(typeof r.text).toBe('string');
    expect(r.text).toContain('テクニカル');
  });
});

import { formatNewsForChat } from './openai.js';

describe('formatNewsForChat 文脈フィルタ', () => {
  const now = Date.now();
  const news = [
    { id: '1', title: 'トヨタ 通期見通し上方修正', source: 'X', lang: 'ja' as const, url: 'u1', publishedAt: now - 60000 },
    { id: '2', title: '米CPI 予想下回る', source: 'Y', lang: 'ja' as const, url: 'u2', publishedAt: now - 120000 },
  ];
  it('クエリ語に一致するニュースを優先', () => {
    const s = formatNewsForChat(news, now, 'トヨタの決算どう?');
    expect(s).toContain('トヨタ');
    // 関連ヒット(トヨタ)のみ → CPI は含まれない
    expect(s).not.toContain('CPI');
  });
  it('一致ゼロなら直近にフォールバック(両方表示)', () => {
    const s = formatNewsForChat(news, now, '全く無関係なクエリ xyz');
    expect(s).toContain('トヨタ');
    expect(s).toContain('CPI');
  });
});
