import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseAjaxCme, fetchAjaxCmePrice, fetchAjaxCmePrices, pricesFromAjaxText } from './ajaxCmePrice.js';

afterEach(() => { vi.unstubAllGlobals(); });

// jss2.nikkei225jp.com/ajaxindex/ajax_cme.js の実サンプル断片。
// 形式: A[code]="price_change_changePct_time_liveFlag_high_low";
// code 136 = 日経先物mini(NIY=F)。
const SAMPLE = `A[136]="68320.00_-100.00_-0.15_20:15_1_68665.00_68285.00";
A[191]="68166.80_-226.80_-0.33_20:14_1_68500.00_68100.00";
A[131]="39000.00_+50.00_+0.13_07/07_0_39100.00_38900.00";`;

// 複数コード(136 NIY=F / 731 YM=F / 737 NQ=F)を含む実サンプル(21:37 JST・全ライブ)。
const MULTI = `A[136]="68320.00_-100.00_-0.15_21:37_1_68665.00_68285.00";
A[731]="53224.40_+130.40_+0.25_21:37_1_53300.00_53000.00";
A[737]="29451.50_-257.00_-0.87_21:37_1_29800.00_29400.00";`;

describe('parseAjaxCme', () => {
  it('code 136 の値を price/changePct/live/high/low に分解する', () => {
    const q = parseAjaxCme(SAMPLE, '136');
    expect(q).toEqual({
      price: 68320,
      changePct: -0.15,
      high: 68665,
      low: 68285,
      live: true,   // liveFlag[4]='1'
    });
  });

  it('code が存在しなければ null', () => {
    expect(parseAjaxCme(SAMPLE, '999')).toBeNull();
  });

  it('price が数値でなければ null', () => {
    expect(parseAjaxCme('A[136]="-_-_-_20:15_1__";', '136')).toBeNull();
  });

  it('price が非正なら null', () => {
    expect(parseAjaxCme('A[136]="0.00_-1_-0.1_20:15_1__";', '136')).toBeNull();
  });

  it('停止中の行(liveFlag=0・時刻が MM/DD)でも price は取れ live=false', () => {
    const q = parseAjaxCme(SAMPLE, '131');
    expect(q).not.toBeNull();
    expect(q!.price).toBe(39000);
    expect(q!.live).toBe(false);   // liveFlag[4]='0'
  });

  it('changePct/high/low が壊れていても price が有効なら null 埋めで返す', () => {
    const q = parseAjaxCme('A[136]="68320.00___20:15_1__";', '136');
    expect(q).not.toBeNull();
    expect(q!.price).toBe(68320);
    expect(q!.changePct).toBeNull();
    expect(q!.high).toBeNull();
    expect(q!.low).toBeNull();
    expect(q!.live).toBe(true);
  });

  it('空文字/壊れた入力でも例外を投げず null', () => {
    expect(parseAjaxCme('', '136')).toBeNull();
    expect(parseAjaxCme('garbage <<>>', '136')).toBeNull();
  });
});

describe('fetchAjaxCmePrice', () => {
  it('正常応答を Price{symbol:NIY=F, stale:false, timestamp≈now} にする', async () => {
    const before = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => SAMPLE,
    })));
    const p = await fetchAjaxCmePrice('136');
    expect(p).not.toBeNull();
    expect(p!.symbol).toBe('NIY=F');
    expect(p!.price).toBe(68320);
    expect(p!.changePercent).toBe(-0.15);
    expect(p!.stale).toBe(false);
    expect(p!.timestamp).toBeGreaterThanOrEqual(before);
    expect(p!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it('non-200 は両 URL とも失敗 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    expect(await fetchAjaxCmePrice('136')).toBeNull();
  });

  it('fetch が throw しても null(例外を伝播しない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await fetchAjaxCmePrice('136')).toBeNull();
  });

  it('parse-null(code 不在)なら null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => 'A[191]="1_0_0_20:15_1__";',
    })));
    expect(await fetchAjaxCmePrice('136')).toBeNull();
  });

  it('PRIMARY 失敗 → FALLBACK URL で成功する(フォールバック経路)', async () => {
    let call = 0;
    const f = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 500, text: async () => '' };
      return { ok: true, status: 200, text: async () => SAMPLE };
    });
    vi.stubGlobal('fetch', f);
    const p = await fetchAjaxCmePrice('136');
    expect(f).toHaveBeenCalledTimes(2);   // PRIMARY 失敗 → FALLBACK
    expect(p!.price).toBe(68320);
  });

  it('cache-buster クエリと Referer ヘッダを付けて GET する', async () => {
    const f = vi.fn(async (_url: unknown, _opts: unknown) => ({ ok: true, status: 200, text: async () => SAMPLE }));
    vi.stubGlobal('fetch', f);
    await fetchAjaxCmePrice('136');
    const [url, opts] = f.mock.calls[0]!;
    expect(String(url)).toContain('ajax_cme.js?_=');
    expect((opts as { headers: Record<string, string> }).headers.Referer).toContain('225225.jp');
  });
});

describe('pricesFromAjaxText — 複数コード → Price[]', () => {
  it('136/731/737 を NIY=F/YM=F/NQ=F の fresh Price に展開する', () => {
    const prices = pricesFromAjaxText(MULTI);
    const bySym = Object.fromEntries(prices.map(p => [p.symbol, p]));
    expect(bySym['NIY=F']!.price).toBe(68320);
    expect(bySym['NIY=F']!.changePercent).toBe(-0.15);
    expect(bySym['NIY=F']!.stale).toBe(false);
    expect(bySym['YM=F']!.price).toBe(53224.4);
    expect(bySym['YM=F']!.changePercent).toBe(0.25);
    expect(bySym['NQ=F']!.price).toBe(29451.5);
    expect(bySym['NQ=F']!.changePercent).toBe(-0.87);
    expect(prices.length).toBe(3);
  });

  it('liveFlag=0(清算)の銘柄は stale:true(持ち越しに回す)', () => {
    const text = `A[136]="68320.00_-100.00_-0.15_21:37_1__";
A[731]="53000.00_+10.00_+0.02_07/07_0__";`;   // 731 は liveFlag=0
    const bySym = Object.fromEntries(pricesFromAjaxText(text).map(p => [p.symbol, p]));
    expect(bySym['NIY=F']!.stale).toBe(false);
    expect(bySym['YM=F']!.stale).toBe(true);   // 清算 → stale
    expect(bySym['YM=F']!.price).toBe(53000);  // price 自体は取れる
  });

  it('存在しないコードは落とす(部分取得に強い)', () => {
    const text = `A[136]="68320.00_-100.00_-0.15_21:37_1__";`;   // 731/737 無し
    const prices = pricesFromAjaxText(text);
    expect(prices.map(p => p.symbol)).toEqual(['NIY=F']);
  });
});

describe('fetchAjaxCmePrices — 1 GET で複数コード', () => {
  it('正常応答を NIY=F/YM=F/NQ=F の Price[] にする(timestamp≈now)', async () => {
    const before = Date.now();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => MULTI })));
    const prices = await fetchAjaxCmePrices();
    expect(prices.map(p => p.symbol).sort()).toEqual(['NIY=F', 'NQ=F', 'YM=F']);
    for (const p of prices) {
      expect(p.timestamp).toBeGreaterThanOrEqual(before);
      expect(p.timestamp).toBeLessThanOrEqual(Date.now());
    }
  });

  it('両 URL とも失敗 → [](throw しない)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
    expect(await fetchAjaxCmePrices()).toEqual([]);
  });

  it('1 レスポンスから全コードを取る(GET は 1 回)', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, text: async () => MULTI }));
    vi.stubGlobal('fetch', f);
    await fetchAjaxCmePrices();
    expect(f).toHaveBeenCalledTimes(1);   // PRIMARY 成功 → FALLBACK は叩かない
  });
});
