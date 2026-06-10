import { describe, it, expect, vi, afterEach } from 'vitest';
import { tavilySearch, formatHits } from './webSearch.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('tavilySearch', () => {
  it('正常応答を SearchHit[] にパース', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'http://x', content: 'C', published_date: '2026-06-11' }] }),
    })));
    const hits = await tavilySearch('日経 急落', 5, 'KEY');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ title: 'T', url: 'http://x', content: 'C' });
  });
  it('非200は空配列', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    expect(await tavilySearch('q', 5, 'KEY')).toEqual([]);
  });
  it('キー無しは空配列(fetchしない)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await tavilySearch('q', 5, undefined)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });
  it('formatHits は番号付きテキスト', () => {
    const s = formatHits([{ title: 'A', url: 'u', content: 'c' }]);
    expect(s).toContain('A'); expect(s).toContain('u');
    expect(formatHits([])).toContain('なし');
  });
});
