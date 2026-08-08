// ★AI が読むニュースは「原文のまま」であること を固定するテスト。
//
// なぜこれをテストで縛るか:
//   見出しを訳文に差し替えると **AI が見るものが変わり、取引の判断が変わる**。
//   それは別途 A/B で測るべき変更であって、「表示を日本語にする」作業のついでに
//   混ぜてよいものではない。実装上は titleJa という別欄に分けてあるが、分けただけでは
//   将来 `n.titleJa ?? n.title` と書き換えられて **無言で** AI 入力が変わりうる。
//   だからここで「AI 側の出力に原文が出て訳文が出ない」ことを直接固定する。

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewsItem } from '../types.js';
import { formatNewsForChat } from './dataTools.js';

const NOW = 1_800_000_000_000;

/** 原文と訳文の両方を持つニュース(= 実運用で常時こうなる)。 */
function bilingual(): NewsItem[] {
  return [{
    id: 'x:1',
    title: 'BOJ raises policy rate to 0.75% in surprise move',
    titleJa: '日銀、サプライズで政策金利を0.75%へ引き上げ',
    source: 'CNBC Top News',
    lang: 'en',
    url: 'https://example.com/1',
    publishedAt: NOW - 60_000,
  }];
}

describe('★AI 文脈は原文を使い続ける', () => {
  it('formatNewsForChat(= scalp-plan と chat が使う)は原文を出し、訳文を出さない', () => {
    const out = formatNewsForChat(bilingual(), NOW);
    expect(out).toContain('BOJ raises policy rate to 0.75% in surprise move');
    expect(out).not.toContain('日銀、サプライズで政策金利を0.75%へ引き上げ');
  });

  it('訳文の有無で AI へ渡る文字列が 1 バイトも変わらない', () => {
    const withJa = formatNewsForChat(bilingual(), NOW);
    const withoutJa = formatNewsForChat(bilingual().map(({ titleJa: _drop, ...rest }) => rest), NOW);
    expect(withJa).toBe(withoutJa);
  });

  it('翻訳に失敗した記事でも AI へ渡る文字列は変わらない', () => {
    const failed = bilingual().map(n => ({ ...n, titleJa: undefined, translateError: '429 rate limited' }));
    const plain = bilingual().map(({ titleJa: _drop, ...rest }) => rest);
    expect(formatNewsForChat(failed, NOW)).toBe(formatNewsForChat(plain, NOW));
  });
});

describe('★構造で固定: server/llm/** は訳文の欄を参照しない', () => {
  const llmDir = fileURLToPath(new URL('.', import.meta.url));

  it('titleJa / translateError が AI 側のコードに現れない', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(llmDir)) {
      if (!f.endsWith('.ts')) continue;
      if (f.endsWith('.test.ts')) continue;          // テスト自身は対象外
      if (f === 'translateNews.ts') continue;        // 翻訳器そのものは例外(訳文を作る側)
      const src = readFileSync(join(llmDir, f), 'utf8');
      if (/\btitleJa\b|\btranslateError\b/.test(src)) offenders.push(f);
    }
    expect(offenders, `AI 側のコードが訳文欄を参照している: ${offenders.join(', ')}`).toEqual([]);
  });
});
