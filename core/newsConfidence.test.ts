import { describe, it, expect } from 'vitest';
import type { NewsItem } from './types.js';
import {
  assessConfidence, withConfidence, sourceTier, confidenceBadgeLabel, confidenceTooltip,
} from './newsConfidence.js';
import { scoreNewsImpact } from './newsImpact.js';
import { bigramOverlap } from './textBigrams.js';

const NOW = 1_800_000_000_000;

function n(id: string, title: string, source: string, lang: 'ja' | 'en' = 'ja'): NewsItem {
  return { id, title, source, lang, url: `https://example.com/${id}`, publishedAt: NOW - 60_000 };
}

describe('sourceTier — 階層は 2 段だけ(細かくしない)', () => {
  it('一次情報', () => {
    expect(sourceTier('Fed')).toBe('primary');
    expect(sourceTier('White House')).toBe('primary');
    expect(sourceTier('米経済指標')).toBe('primary');
  });
  it('通信社・主要報道', () => {
    expect(sourceTier('NHK ビジネス')).toBe('wire');
    expect(sourceTier('CNBC Top News')).toBe('wire');
  });
  it('それ以外(速報ブログ・集約系)', () => {
    expect(sourceTier('ZeroHedge')).toBe('other');
    expect(sourceTier('SeekingAlpha')).toBe('other');
    expect(sourceTier('ForexLive')).toBe('other');
  });
});

describe('★単独ソース = 未確認(落とさず、順位も下げず、バッジだけ付ける)', () => {
  it('速報ブログの単独報は unconfirmed', () => {
    const items = [n('1', 'トランプ大統領、対中関税を突如発動と関係者', 'ZeroHedge')];
    const c = assessConfidence(items).get('1')!;
    expect(c.level).toBe('unconfirmed');
    expect(c.basis).toBe('single');
  });

  it('★未確認でも一覧から落ちない(withConfidence は件数を変えない)', () => {
    const items = [n('1', '未確認の第一報', 'ZeroHedge'), n('2', '別の話題', 'ForexLive')];
    expect(withConfidence(items)).toHaveLength(2);
  });

  it('★確度はスコアに影響しない(未確認でもインパクトは同じ)', () => {
    const item = n('1', 'トランプ大統領、対中関税を発動', 'ZeroHedge');
    const scoreBefore = scoreNewsImpact(item, NOW).score;
    const withC = withConfidence([item])[0]!;
    expect(withC.confidence!.level).toBe('unconfirmed');
    expect(scoreNewsImpact(withC, NOW).score).toBe(scoreBefore);
  });
});

describe('確認済みの根拠', () => {
  it('一次情報は単独でも確認済み', () => {
    const c = assessConfidence([n('1', 'Powell speaks on the economic outlook', 'Fed Speeches', 'en')]).get('1')!;
    expect(c.level).toBe('confirmed');
    expect(c.basis).toBe('primary');
  });

  it('通信社は単独でも確認済み', () => {
    const c = assessConfidence([n('1', '日銀が政策金利を据え置き', 'NHK ビジネス')]).get('1')!;
    expect(c.basis).toBe('wire');
  });

  it('★別ソースに同じ出来事が出ていれば裏取り成立', () => {
    const items = [
      n('1', '日銀が政策金利を0.75%へ引き上げ', 'ZeroHedge'),
      n('2', '日銀が政策金利を0.75%へ引き上げると発表', 'ForexLive'),
    ];
    const c = assessConfidence(items).get('1')!;
    expect(c.level).toBe('confirmed');
    expect(c.basis).toBe('corroborated');
    expect(c.corroboratedBy).toContain('ForexLive');
  });

  it('★同一ソース内の続報は裏取りにならない', () => {
    const items = [
      n('1', '日銀が政策金利を0.75%へ引き上げ', 'ZeroHedge'),
      n('2', '日銀が政策金利を0.75%へ引き上げると発表', 'ZeroHedge'),
    ];
    expect(assessConfidence(items).get('1')!.basis).toBe('single');
  });

  it('無関係な見出しは裏取りにならない', () => {
    const items = [
      n('1', '日銀が政策金利を0.75%へ引き上げ', 'ZeroHedge'),
      n('2', '原油先物が3日続落、需要減退の観測', 'ForexLive'),
    ];
    expect(assessConfidence(items).get('1')!.basis).toBe('single');
  });
});

describe('★時間経過で確度が変わる(第一報 → 裏取り済み)', () => {
  it('最初は単独 = 未確認、後から他社が報じると確認済みへ変わる', () => {
    const first = n('1', '米財務長官ベッセント氏、為替介入の可能性に言及', 'ForexLive');
    // T+0: 自分しかいない
    expect(assessConfidence([first]).get('1')!.level).toBe('unconfirmed');
    // T+30分: 他社が同じ出来事を報じた
    const later = [first, n('2', 'ベッセント米財務長官、為替介入の可能性に言及と報道', 'Investing.com')];
    const c = assessConfidence(later).get('1')!;
    expect(c.level).toBe('confirmed');
    expect(c.basis).toBe('corroborated');
  });
});

describe('バッジは属性であって警告ではない', () => {
  it('確認済みにはバッジを出さない(無印)', () => {
    expect(confidenceBadgeLabel({ level: 'confirmed', basis: 'wire', corroboratedBy: [] })).toBeNull();
  });
  it('未確認だけ控えめな目印が付く', () => {
    expect(confidenceBadgeLabel({ level: 'unconfirmed', basis: 'single', corroboratedBy: [] })).toBe('？未確認');
  });
  it('なぜその判定かを画面から辿れる', () => {
    expect(confidenceTooltip({ level: 'confirmed', basis: 'corroborated', corroboratedBy: ['NHK'] })).toContain('NHK');
    expect(confidenceTooltip({ level: 'unconfirmed', basis: 'single', corroboratedBy: [] })).toContain('第一報');
  });
});

describe('bigramOverlap — 既存手法の再利用', () => {
  it('要約と詳報を同じ出来事と見なせる(長さの差で落ちない)', () => {
    expect(bigramOverlap('日銀、利上げ', '日銀が政策金利を引き上げ、市場予想通りの利上げ')).toBeGreaterThan(0.5);
  });
  it('無関係な見出しは低い', () => {
    expect(bigramOverlap('日銀が利上げ', '原油先物が続落')).toBeLessThan(0.3);
  });
  it('空文字は 0', () => {
    expect(bigramOverlap('', 'あ')).toBe(0);
  });
});
