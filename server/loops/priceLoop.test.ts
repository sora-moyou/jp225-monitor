import { describe, it, expect, beforeEach } from 'vitest';
import { mergeSources, mergeWithCached } from './priceLoop.js';
import { setPrices } from '../cache.js';
import type { Price } from '../types.js';

// v0.7.20(全銘柄 HTTP 化): 価格の全経路を公開 HTTP(ajax_cme.js / ajax_fx.js)に統一。socket / Yahoo は全廃。
// mergeSources は各 HTTP 源の fresh(stale:false)のみを採用し、stale(清算/取得失敗)は落とす →
// 下流の mergeWithCached が前回値を古い timestamp のまま stale で持ち越す(実弾安全 v0.7.9 を全銘柄へ徹底)。

function px(symbol: Price['symbol'], price: number, stale = false, timestamp = 1000): Price {
  return { symbol, price, changePercent: 0.1, timestamp, stale };
}

describe('mergeSources — HTTP 各源の fresh のみ採用', () => {
  it('ajax_cme(NIY/YM/NQ)+ ajax_fx(JPY)の fresh を全て採用する', () => {
    const cme = [px('NIY=F', 68320), px('YM=F', 53224), px('NQ=F', 29451)];
    const fx = [px('JPY=X', 161.785)];
    const merged = mergeSources([cme, fx]);
    const bySym = Object.fromEntries(merged.map(p => [p.symbol, p]));
    expect(bySym['NIY=F']!.price).toBe(68320);
    expect(bySym['YM=F']!.price).toBe(53224);
    expect(bySym['NQ=F']!.price).toBe(29451);
    expect(bySym['JPY=X']!.price).toBe(161.785);
    expect(merged.length).toBe(4);
  });

  it('stale な銘柄(清算/liveFlag=0)は fresh に載せない(持ち越しに回す)', () => {
    const cme = [px('NIY=F', 68320, /*stale*/ false), px('YM=F', 53224, /*stale*/ true)];
    const fx: Price[] = [];
    const merged = mergeSources([cme, fx]);
    expect(merged.find(p => p.symbol === 'NIY=F')?.price).toBe(68320);
    expect(merged.find(p => p.symbol === 'YM=F')).toBeUndefined();   // stale は落ちる
  });

  it('全源が空(取得失敗)なら空配列(=下流でバックオフ)', () => {
    expect(mergeSources([[], []])).toEqual([]);
  });
});

describe('mergeWithCached — fresh に無い銘柄は前回値+古い timestamp を stale で持ち越す', () => {
  beforeEach(() => setPrices([]));

  it('取得失敗の NIY=F は前回のライブ値を stale として古い timestamp のまま持ち越す(遅延値で埋めない)', () => {
    setPrices([px('NIY=F', 68320, /*stale*/ false, /*timestamp*/ 5000)]);
    // 今回 fresh に NIY=F が無い(HTTP 失敗 or stale で mergeSources が落とした)
    const merged = mergeWithCached([px('YM=F', 53224, false, 8000)]);
    const niy = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy.stale).toBe(true);
    expect(niy.price).toBe(68320);        // 前回のライブ値
    expect(niy.timestamp).toBe(5000);     // timestamp は更新されない(古いまま)
  });

  it('連続ポーリングでも stale な NIY=F の timestamp は前進しない', () => {
    setPrices([px('NIY=F', 68320, false, 5000)]);
    let merged = mergeWithCached([px('YM=F', 53224, false, 8000)]);
    setPrices(merged);
    const t1 = merged.find(p => p.symbol === 'NIY=F')!.timestamp;
    merged = mergeWithCached([px('YM=F', 53230, false, 9000)]);
    setPrices(merged);
    const niy2 = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy2.timestamp).toBe(t1);
    expect(niy2.timestamp).toBe(5000);
    expect(niy2.stale).toBe(true);
    expect(niy2.price).toBe(68320);
  });

  it('fresh な 4 銘柄はそのまま(INSTRUMENTS 順に整列)', () => {
    const merged = mergeWithCached([
      px('JPY=X', 161.785, false, 8000),
      px('NIY=F', 68320, false, 8000),
      px('NQ=F', 29451, false, 8000),
      px('YM=F', 53224, false, 8000),
    ]);
    // INSTRUMENTS 順: NIY=F, NQ=F, YM=F, JPY=X
    expect(merged.map(p => p.symbol)).toEqual(['NIY=F', 'NQ=F', 'YM=F', 'JPY=X']);
    expect(merged.every(p => !p.stale)).toBe(true);
  });
});
