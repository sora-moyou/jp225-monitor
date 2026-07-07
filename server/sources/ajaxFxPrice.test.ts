import { describe, it, expect, vi, afterEach } from 'vitest';
import { pricesFromAjaxFxText, fetchAjaxFxPrices } from './ajaxFxPrice.js';

afterEach(() => { vi.unstubAllGlobals(); });

// jss2.nikkei225jp.com/ajaxindex/ajax_fx.js の実サンプル断片(ajax_cme と同形式)。
// code 511 = ドル円(JPY=X)。
const SAMPLE = `A[511]="161.785_-0.287_-0.18_21:38_1_162.100_161.500";
A[512]="174.200_+0.100_+0.06_21:38_1__";`;

describe('pricesFromAjaxFxText — 511 → JPY=X', () => {
  it('511 を JPY=X の fresh Price に展開する', () => {
    const prices = pricesFromAjaxFxText(SAMPLE);
    expect(prices.length).toBe(1);
    const jpy = prices[0]!;
    expect(jpy.symbol).toBe('JPY=X');
    expect(jpy.price).toBe(161.785);
    expect(jpy.changePercent).toBe(-0.18);
    expect(jpy.stale).toBe(false);   // liveFlag='1'
  });

  it('liveFlag=0(停止)は stale:true', () => {
    const text = `A[511]="161.500_0_0_07/07_0__";`;
    const jpy = pricesFromAjaxFxText(text)[0]!;
    expect(jpy.stale).toBe(true);
    expect(jpy.price).toBe(161.5);
  });

  it('511 が無ければ空配列', () => {
    expect(pricesFromAjaxFxText(`A[512]="174.2_0_0_21:38_1__";`)).toEqual([]);
  });
});

describe('fetchAjaxFxPrices', () => {
  it('正常応答を JPY=X の Price[] にする(timestamp≈now)', async () => {
    const before = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SAMPLE })));
    const prices = await fetchAjaxFxPrices();
    expect(prices.map(p => p.symbol)).toEqual(['JPY=X']);
    expect(prices[0]!.timestamp).toBeGreaterThanOrEqual(before);
    expect(prices[0]!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('両 URL とも失敗 → [](throw しない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    expect(await fetchAjaxFxPrices()).toEqual([]);
  });

  it('fetch が throw しても [](例外を伝播しない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchAjaxFxPrices()).toEqual([]);
  });

  it('ajax_fx.js を Referer 4fx で cache-buster 付き GET する', async () => {
    const f = vi.fn(async (_url: unknown, _opts: unknown) => ({ ok: true, status: 200, text: async () => SAMPLE }));
    vi.stubGlobal('fetch', f);
    await fetchAjaxFxPrices();
    const [url, opts] = f.mock.calls[0]!;
    expect(String(url)).toContain('ajax_fx.js?_=');
    expect((opts as { headers: Record<string, string> }).headers.Referer).toContain('225225.jp/4fx');
  });
});
