import { describe, it, expect, beforeEach } from 'vitest';
import {
  escapeHtml, shownTitle, rememberTranslation, cachedTranslation, clearTranslationCacheForTest,
} from './newsFeed.js';

// ★実バグ(画面に見えた): 手動翻訳のキャッシュに **エスケープ済み** の文字列を入れていたのに、
//   描画側が改めて escapeHtml を掛けるので二重に掛かっていた。
//   「訳」ボタンを押した直後は textContent で直接書くので正しく見えるが、
//   次の再描画(約60秒ごと)で "AT&T株" が "AT&amp;T株" に化ける。
describe('★翻訳キャッシュの二重エスケープ', () => {
  beforeEach(() => { clearTranslationCacheForTest(); });

  it('キャッシュには生の訳文が入る(エスケープ済みを入れない)', () => {
    rememberTranslation('AT&T beats in Q3', 'AT&T株、Q3決算で「上振れ」');
    expect(cachedTranslation('AT&T beats in Q3')).toBe('AT&T株、Q3決算で「上振れ」');
  });

  it('描画時のエスケープはちょうど 1 回(画面には AT&T と出る)', () => {
    rememberTranslation('AT&T beats in Q3', 'AT&T株、Q3決算で「上振れ」');
    const html = escapeHtml(shownTitle({ title: 'AT&T beats in Q3' })!);
    expect(html).toBe('AT&amp;T株、Q3決算で「上振れ」');
    // 二重エスケープなら "&amp;amp;" になる。それが起きていないこと。
    expect(html).not.toContain('&amp;amp;');
  });

  it('再描画を何度繰り返しても崩れない(冪等)', () => {
    rememberTranslation('AT&T beats in Q3', 'AT&T株、Q3決算で「上振れ」');
    const once = escapeHtml(shownTitle({ title: 'AT&T beats in Q3' })!);
    const twice = escapeHtml(shownTitle({ title: 'AT&T beats in Q3' })!);
    expect(twice).toBe(once);
  });

  it('サーバ訳(titleJa)が手動訳より優先される', () => {
    rememberTranslation('orig', '手動訳');
    expect(shownTitle({ title: 'orig', titleJa: 'サーバ訳' })).toBe('サーバ訳');
  });

  it('訳が無ければ null(原文を出す合図)', () => {
    expect(shownTitle({ title: 'no translation yet' })).toBeNull();
  });

  it('生の訳文に HTML が混じっていてもエスケープされる(XSS 対策が生きている)', () => {
    rememberTranslation('x', '<img src=x onerror=alert(1)>株');
    expect(escapeHtml(shownTitle({ title: 'x' })!)).toBe('&lt;img src=x onerror=alert(1)&gt;株');
  });
});
