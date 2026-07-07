import { describe, it, expect, beforeEach } from 'vitest';
import { mergeSources, mergeWithCached } from './priceLoop.js';
import { setPrices, getPrices } from '../cache.js';
import { buildSocketPrices, SOCKET_STALE_MS, type SocketQuote } from '../sources/nikkei225jpSocket.js';
import type { Price, Symbol } from '../types.js';

// 実弾安全: NIY=F(実際に建てる大阪日経先物)は Yahoo(CME・約10分ディレイ)を絶対に出さない。
// LIVE の供給源はリアルタイム feed のみ。feed が無い/stale のときは stale(取得不能)で、
// Yahoo の遅延値では決して埋めない。過去、この静かなフォールバックで約10分古い価格が
// ボットへ渡り実損した。

const YAHOO_NIY = 40000;   // Yahoo(CME・約10分遅延)の NIY=F。決してこの値を採用してはならない。
const FEED_NIY_LIVE = 40120;

function px(symbol: Price['symbol'], price: number, stale = false, timestamp = 1000): Price {
  return { symbol, price, changePercent: 0.1, timestamp, stale };
}

const AJAX_NIY_LIVE = 68320;   // ajax_cme(公開HTTP・毎GET新スナップ)の NIY=F。v0.7.16 で NIY=F の唯一の LIVE 源。

describe('mergeSources — NIY=F は Yahoo(遅延)を絶対に採用しない', () => {
  it('ajax_cme に LIVE な NIY=F があればそれを採用(socket 136/Yahoo より優先)', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY), px('NQ=F', 20000)];
    const feed = [px('NIY=F', FEED_NIY_LIVE, /*stale*/ false)];   // socket 136(使わない)
    const ajaxCme = px('NIY=F', AJAX_NIY_LIVE, /*stale*/ false);
    const merged = mergeSources(yahoo, feed, ajaxCme);
    const niy = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy.price).toBe(AJAX_NIY_LIVE);   // ajax_cme を採用
    expect(niy.stale).toBe(false);
    expect(niy.price).not.toBe(FEED_NIY_LIVE);   // socket 136 は使わない
    expect(niy.price).not.toBe(YAHOO_NIY);       // Yahoo でもない
  });

  it('socket に NIY=F(136)があっても ajax_cme が無ければ NIY=F は fresh から欠落(socket 136 は使わない)', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY), px('NQ=F', 20000)];
    const feed = [px('NIY=F', FEED_NIY_LIVE, /*stale*/ false)];   // socket 136 live
    const merged = mergeSources(yahoo, feed, /*ajaxCme*/ null);
    // socket 136 も Yahoo も NIY=F には使わない → 下流が前回値を stale で持ち越す
    expect(merged.find(p => p.symbol === 'NIY=F')).toBeUndefined();
    expect(merged.find(p => p.symbol === 'NQ=F')?.price).toBe(20000);
  });

  it('ajax_cme fail(null)のとき、Yahoo の NIY=F は結果に混ざらない', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY), px('NQ=F', 20000)];
    const feed: Price[] = [];
    const merged = mergeSources(yahoo, feed, null);
    expect(merged.find(p => p.symbol === 'NIY=F')).toBeUndefined();
    expect(merged.find(p => p.symbol === 'NQ=F')?.price).toBe(20000);   // 他銘柄は Yahoo フォールバック
  });

  it('ajax_cme が stale な NIY=F を返しても fresh には載せない(古い now で timestamp を更新しない)', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY)];
    const feed: Price[] = [];
    const ajaxCme = px('NIY=F', 39990, /*stale*/ true, /*timestamp*/ 9999);
    const merged = mergeSources(yahoo, feed, ajaxCme);
    expect(merged.find(p => p.symbol === 'NIY=F')).toBeUndefined();
  });

  it('NIY=F 以外は従来どおり socket feed 優先・無ければ Yahoo フォールバック', () => {
    const yahoo = [px('NQ=F', 20000), px('CL=F', 75)];
    const feed = [px('NQ=F', 20050)];
    const merged = mergeSources(yahoo, feed, null);
    expect(merged.find(p => p.symbol === 'NQ=F')?.price).toBe(20050);  // socket 優先
    expect(merged.find(p => p.symbol === 'CL=F')?.price).toBe(75);     // Yahoo フォールバック
  });
});

// v0.7.16: socket 経路は NIY=F **以外**の銘柄のみ供給する(NIY=F の LIVE 源は ajax_cme に移行)。
// socket が code 136 の live/stale どちらを返しても NIY=F には使わず、他銘柄は従来どおり socket が供給する。
describe('socket 経路 — NIY=F 以外を供給・NIY=F(136)は使わない(ajax_cme が正)', () => {
  const now = 1783334800000;

  it('socket の live な NQ=F はそのまま採用(実 timestamp を保持)', () => {
    const latest = new Map<Symbol, SocketQuote>([
      ['NQ=F', { price: 20050, timestamp: now - 2000, changePercent: 0.1 }],
    ]);
    const feed = buildSocketPrices(latest, now);
    const yahoo = [px('NQ=F', 20000)];
    const nq = mergeSources(yahoo, feed, null).find(p => p.symbol === 'NQ=F')!;
    expect(nq.price).toBe(20050);
    expect(nq.timestamp).toBe(now - 2000);   // socket tick の実 epoch-ms
  });

  it('socket が live な NIY=F(136)を持っていても NIY=F には使わない(ajax_cme が正)', () => {
    const latest = new Map<Symbol, SocketQuote>([
      ['NIY=F', { price: FEED_NIY_LIVE, timestamp: now - 2000, changePercent: 0.1 }],
    ]);
    const feed = buildSocketPrices(latest, now);   // socket 136 live
    const yahoo = [px('NIY=F', YAHOO_NIY)];
    // ajax_cme を渡さない → socket 136 も Yahoo も NIY=F には載らない
    expect(mergeSources(yahoo, feed, null).find(p => p.symbol === 'NIY=F')).toBeUndefined();
  });

  it('socket NIY=F(136)が stale でも NIY=F には無関係(元から使わない)', () => {
    const latest = new Map<Symbol, SocketQuote>([
      ['NIY=F', { price: 39990, timestamp: now - (SOCKET_STALE_MS + 5000), changePercent: 0 }],
    ]);
    const feed = buildSocketPrices(latest, now);
    const yahoo = [px('NIY=F', YAHOO_NIY)];
    expect(mergeSources(yahoo, feed, null).find(p => p.symbol === 'NIY=F')).toBeUndefined();
  });
});

describe('mergeWithCached — stale な NIY=F は前回値+古い timestamp を保持', () => {
  beforeEach(() => setPrices([]));

  it('feed に NIY=F が無いとき、前回の NIY=F を stale として古い timestamp のまま持ち越す', () => {
    // 前回ライブだった NIY=F を cache にセット(timestamp=5000)
    setPrices([px('NIY=F', FEED_NIY_LIVE, /*stale*/ false, /*timestamp*/ 5000)]);
    // 今回 fresh には NIY=F が無い(Yahoo は mergeSources で除外済み)
    const merged = mergeWithCached([px('NQ=F', 20000, false, 8000)]);
    const niy = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy.stale).toBe(true);
    expect(niy.price).toBe(FEED_NIY_LIVE);   // Yahoo(遅延)値ではなく前回のライブ値
    expect(niy.price).not.toBe(YAHOO_NIY);
    expect(niy.timestamp).toBe(5000);        // timestamp は更新されない(古いまま)
  });

  it('連続ポーリングでも stale な NIY=F の timestamp は前進しない', () => {
    setPrices([px('NIY=F', FEED_NIY_LIVE, false, 5000)]);
    // ポール1: NIY=F 欠落 → stale 持ち越し
    let merged = mergeWithCached([px('NQ=F', 20000, false, 8000)]);
    setPrices(merged);
    const t1 = merged.find(p => p.symbol === 'NIY=F')!.timestamp;
    // ポール2: 再び NIY=F 欠落
    merged = mergeWithCached([px('NQ=F', 20010, false, 9000)]);
    setPrices(merged);
    const niy2 = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy2.timestamp).toBe(t1);   // 2回目のポールでも timestamp 据え置き
    expect(niy2.timestamp).toBe(5000);
    expect(niy2.stale).toBe(true);
    expect(niy2.price).toBe(FEED_NIY_LIVE);
  });
});
