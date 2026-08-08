import { describe, it, expect } from 'vitest';
import { isFinanceRelevant } from './rssAggregator.js';
 import { RSS_FEEDS } from '../config.js';
 import { PRIMARY_SOURCES, sourceTier } from '../../core/newsConfidence.js';

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

// ★PRIMARY_SOURCES(一次情報)は **ソース名の完全一致** で照合する(第三者ブログが
//   "Fed Watch Blog" のような名前で一次情報を名乗れないようにするため)。
//   完全一致は「config の name を変えたら黙って primary でなくなる」という脆さと引き換えなので、
//   ここで実際のフィード名と突き合わせて守る(無言の失格を作らない)。
describe('★一次情報の名前が config と一致していること', () => {
  it('Fed / Fed Speeches / White House は primary と判定される', () => {
    const names = [...RSS_FEEDS.ja, ...RSS_FEEDS.en].map(f => f.name);
    for (const name of ['Fed', 'Fed Speeches', 'White House']) {
      expect(names, `${name} が config から消えている`).toContain(name);
      expect(sourceTier(name), name).toBe('primary');
    }
  });

  it('米経済指標(econIndicators の source)も primary', () => {
    expect(sourceTier('米経済指標')).toBe('primary');
  });

  it('PRIMARY_SOURCES の各エントリは、その名前そのもので primary になる', () => {
    for (const p of PRIMARY_SOURCES) expect(sourceTier(p), p).toBe('primary');
  });
});
