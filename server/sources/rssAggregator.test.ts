import { describe, it, expect } from 'vitest';
import { isFinanceRelevant } from './rssAggregator.js';

describe('isFinanceRelevant (v0.3.9 title+body hybrid)', () => {
  it('passes HIGH_IMPACT keyword in title', () => {
    expect(isFinanceRelevant('植田総裁、利上げ示唆', '')).toBe(true);
  });

  it('passes HIGH_IMPACT keyword in body only', () => {
    expect(isFinanceRelevant('今日のニュースまとめ', 'トランプ大統領が関税発表')).toBe(true);
  });

  it('passes when title has 2 finance keywords', () => {
    expect(isFinanceRelevant('株価が決算で続伸', '')).toBe(true);
  });

  it('passes when title 1 + body 1 finance keywords (recall boost)', () => {
    expect(isFinanceRelevant('為替動向まとめ', 'トヨタの業績好調')).toBe(true);
  });

  it('rejects when title has only 1 finance keyword and body has none', () => {
    expect(isFinanceRelevant('為替動向まとめ', '')).toBe(false);
  });

  it('rejects BLACKLIST in title even if finance keywords in body', () => {
    expect(isFinanceRelevant('新作映画レビュー', '株式市場で業績や決算ネタを比喩に')).toBe(false);
  });

  it('does NOT reject when blacklist word appears only in body (title is clearly finance)', () => {
    expect(isFinanceRelevant('株価決算で続伸、年初来高値', 'スタッフは映画好き')).toBe(true);
  });

  it('rejects unrelated topic with no finance keywords', () => {
    expect(isFinanceRelevant('人気ラーメン店、新メニュー発表', '')).toBe(false);
  });
});
