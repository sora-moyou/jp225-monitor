import { describe, it, expect, beforeEach } from 'vitest';
import { noteReferencedNews, newsSinceForAlert, _reset } from './shockWindow.js';

describe('shockWindow 実参照アンカー', () => {
  beforeEach(() => _reset());
  it('初期は 0', () => { expect(newsSinceForAlert()).toBe(0); });
  it('noteReferencedNews で単調前進', () => {
    noteReferencedNews(1000);
    expect(newsSinceForAlert()).toBe(1000);
    noteReferencedNews(500);
    expect(newsSinceForAlert()).toBe(1000);
    noteReferencedNews(2000);
    expect(newsSinceForAlert()).toBe(2000);
  });
  it('0 は前進させない（材料なし）', () => {
    noteReferencedNews(1500);
    noteReferencedNews(0);
    expect(newsSinceForAlert()).toBe(1500);
  });
});
