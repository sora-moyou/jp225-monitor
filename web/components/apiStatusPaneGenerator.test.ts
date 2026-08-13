import { describe, it, expect } from 'vitest';

// ─── ★「止まったことに気づく」表示 ───────────────────────────────────────────────
//
// 1年かけて溜める実験の最悪の失敗形は「1年後に、実は3か月動いていなかった」。
// 分析用側だけの死活監視は分析用が死んだら一緒に死ぬので、**ユーザーが毎日見る画面** に出す。
//
// ★否定対照: renderGeneratorDot を常に '' を返す実装にすると、下の「無記録が長いと警告色」
//   「最終記録の分数を出す」が赤。逆に available:false でも出す実装にすると
//   「未導入の PC では何も出さない」が赤。

import { renderGeneratorDot } from './apiStatusPane.js';

describe('分析用の死活表示', () => {
  it('★台帳が無い(未導入・公開版)なら何も出さない', () => {
    expect(renderGeneratorDot(undefined)).toBe('');
    expect(renderGeneratorDot({ available: false, lastRecordAt: null, ageMin: null, total: 0 })).toBe('');
  });

  it('直近に記録があれば緑で「最終記録 N分前」', () => {
    const html = renderGeneratorDot({ available: true, lastRecordAt: 1, ageMin: 2, total: 1234 });
    expect(html).toContain('🟢');
    expect(html).toContain('最終記録 2分前');
    expect(html).toContain('1234 件');
    expect(html).not.toContain('止まっている');
  });

  it('★無記録が続くと警告色 + 「止まっている可能性があります」', () => {
    const html = renderGeneratorDot({ available: true, lastRecordAt: 1, ageMin: 60, total: 10 });
    expect(html).toContain('🟡');
    expect(html).toContain('止まっている可能性があります');
  });

  it('台帳はあるが1件も無い場合は「記録が1件もありません」', () => {
    const html = renderGeneratorDot({ available: true, lastRecordAt: null, ageMin: null, total: 0 });
    expect(html).toContain('⚪');
    expect(html).toContain('記録が1件もありません');
  });
});
