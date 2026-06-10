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
