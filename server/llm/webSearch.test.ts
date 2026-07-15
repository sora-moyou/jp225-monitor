import { describe, it, expect, vi } from 'vitest';
import { parseGrounding, formatGrounded, geminiGroundedSearch } from './webSearch.js';

describe('parseGrounding', () => {
  it('answer(parts結合) と sources(groundingChunks) を抽出', () => {
    const json = {
      candidates: [{
        content: { parts: [{ text: '日経は' }, { text: '上昇。' }] },
        groundingMetadata: {
          groundingChunks: [
            { web: { uri: 'https://a.example', title: 'A社' } },
            { web: { uri: 'https://b.example', title: 'B社' } },
          ],
        },
      }],
    };
    const r = parseGrounding(json);
    expect(r.answer).toBe('日経は上昇。');
    expect(r.sources).toEqual([
      { title: 'A社', url: 'https://a.example', content: '' },
      { title: 'B社', url: 'https://b.example', content: '' },
    ]);
  });
  it('grounding欠損でも answer は取れる / chunks無しは sources空', () => {
    const r = parseGrounding({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
    expect(r.answer).toBe('x');
    expect(r.sources).toEqual([]);
  });
  it('uri欠けの chunk はスキップ・title欠けは uri を代用', () => {
    const r = parseGrounding({ candidates: [{ groundingMetadata: { groundingChunks: [
      { web: { title: 'notitle-nouri' } },
      { web: { uri: 'https://c.example' } },
    ] } }] });
    expect(r.sources).toEqual([{ title: 'https://c.example', url: 'https://c.example', content: '' }]);
  });
  it('null / 非オブジェクト / candidates無し → 空', () => {
    expect(parseGrounding(null)).toEqual({ answer: '', sources: [] });
    expect(parseGrounding('x')).toEqual({ answer: '', sources: [] });
    expect(parseGrounding({})).toEqual({ answer: '', sources: [] });
  });
});

describe('formatGrounded', () => {
  it('answer + 出典番号付き', () => {
    const s = formatGrounded({ answer: '要約', sources: [{ title: 'A', url: 'https://a', content: '' }] });
    expect(s).toContain('要約');
    expect(s).toContain('出典:');
    expect(s).toContain('1. A (https://a)');
  });
  it('title===url なら URL 重複表示しない', () => {
    const s = formatGrounded({ answer: '', sources: [{ title: 'https://a', url: 'https://a', content: '' }] });
    expect(s).toContain('1. https://a');
    expect(s).not.toContain('(https://a)');
  });
  it('answer も sources も無ければ「検索結果なし」', () => {
    expect(formatGrounded({ answer: '', sources: [] })).toContain('なし');
  });
});

describe('geminiGroundedSearch', () => {
  it('正常応答を GroundedResult に', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://s', title: 'S' } }] } }] }),
    })) as unknown as typeof fetch;
    const r = await geminiGroundedSearch('日経 急落', 'AIzaKEY', 'gemini-flash-latest', fetchMock);
    expect(r.answer).toBe('ok');
    expect(r.sources).toHaveLength(1);
    // google_search ツール付きで generateContent を叩く
    const [url, init] = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain(':generateContent');
    expect(String(url)).toContain('gemini-flash-latest');
    expect(JSON.parse((init as RequestInit).body as string).tools).toEqual([{ google_search: {} }]);
  });
  it('非200は空結果', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    expect(await geminiGroundedSearch('q', 'K', 'm', fetchMock)).toEqual({ answer: '', sources: [] });
  });
  it('キー無し(空文字)は fetch せず空結果', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    // 注意: undefined を渡すとデフォルト引数(resolveWebSearchKey)が発動し実キーで叩いてしまう。空文字で「未設定」を表す。
    expect(await geminiGroundedSearch('q', '', 'm', fetchMock)).toEqual({ answer: '', sources: [] });
    expect(fetchMock as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
  it('fetch 例外は空結果(チャットを止めない)', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    expect(await geminiGroundedSearch('q', 'K', 'm', fetchMock)).toEqual({ answer: '', sources: [] });
  });
});
