import { describe, it, expect, beforeEach } from 'vitest';
import { mergeSources, mergeWithCached } from './priceLoop.js';
import { setPrices, getPrices } from '../cache.js';
import type { Price } from '../types.js';

// 実弾安全: NIY=F(実際に建てる大阪日経先物)は Yahoo(CME・約10分ディレイ)を絶対に出さない。
// LIVE の供給源はリアルタイム feed のみ。feed が無い/stale のときは stale(取得不能)で、
// Yahoo の遅延値では決して埋めない。過去、この静かなフォールバックで約10分古い価格が
// ボットへ渡り実損した。

const YAHOO_NIY = 40000;   // Yahoo(CME・約10分遅延)の NIY=F。決してこの値を採用してはならない。
const FEED_NIY_LIVE = 40120;

function px(symbol: Price['symbol'], price: number, stale = false, timestamp = 1000): Price {
  return { symbol, price, changePercent: 0.1, timestamp, stale };
}

describe('mergeSources — NIY=F は Yahoo(遅延)を絶対に採用しない', () => {
  it('feed に LIVE な NIY=F があればそれを採用', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY), px('NQ=F', 20000)];
    const feed = [px('NIY=F', FEED_NIY_LIVE, /*stale*/ false)];
    const merged = mergeSources(yahoo, feed);
    const niy = merged.find(p => p.symbol === 'NIY=F')!;
    expect(niy.price).toBe(FEED_NIY_LIVE);
    expect(niy.stale).toBe(false);
    // 念のため: Yahoo の値ではない
    expect(niy.price).not.toBe(YAHOO_NIY);
  });

  it('feed に NIY=F が全く無いとき、Yahoo の NIY=F は結果に混ざらない', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY), px('NQ=F', 20000)];
    const feed: Price[] = [];   // フィード停止(現状の実態)
    const merged = mergeSources(yahoo, feed);
    // NIY=F は fresh に一切入らない(下流 mergeWithCached が前回値を stale で持ち越す)
    expect(merged.find(p => p.symbol === 'NIY=F')).toBeUndefined();
    // 他銘柄は Yahoo フォールバックが効く
    expect(merged.find(p => p.symbol === 'NQ=F')?.price).toBe(20000);
  });

  it('feed が stale な NIY=F を返しても fresh には載せない(古い now で timestamp を更新しない)', () => {
    const yahoo = [px('NIY=F', YAHOO_NIY)];
    const feed = [px('NIY=F', 39990, /*stale*/ true, /*timestamp*/ 9999)];
    const merged = mergeSources(yahoo, feed);
    // stale feed 値も Yahoo 値も採用されない → NIY=F は fresh から欠落
    expect(merged.find(p => p.symbol === 'NIY=F')).toBeUndefined();
  });

  it('NIY=F 以外は従来どおり feed 優先・無ければ Yahoo フォールバック', () => {
    const yahoo = [px('NQ=F', 20000), px('CL=F', 75)];
    const feed = [px('NQ=F', 20050)];
    const merged = mergeSources(yahoo, feed);
    expect(merged.find(p => p.symbol === 'NQ=F')?.price).toBe(20050);  // feed 優先
    expect(merged.find(p => p.symbol === 'CL=F')?.price).toBe(75);     // Yahoo フォールバック
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
