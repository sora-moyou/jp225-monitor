import { describe, it, expect } from 'vitest';
import {
  parseTick,
  parsePriceTChangePercent,
  isStale,
  buildSocketPrices,
  getSocketPrices,
  _setLatestForTest,
  _clearLatestForTest,
  SOCKET_STALE_MS,
  type SocketQuote,
} from './nikkei225jpSocket.js';
import type { Symbol } from '../types.js';

// ネットワーク socket は張らない。純関数 + テスト注入で検証する。

describe('parseTick — tick [code, tsMs, price] の解釈', () => {
  it('code 136 → NIY=F(OSE mini)を epoch-ms/price で返す', () => {
    // 実捕捉フォーマット: 全て文字列。
    expect(parseTick(['136', '1783334741000', '69920.00'])).toEqual({
      symbol: 'NIY=F', price: 69920, timestamp: 1783334741000,
    });
  });

  it('他の対象コード(737→NQ=F 等)も解釈する', () => {
    expect(parseTick(['737', '1783334741000', '30468.70'])?.symbol).toBe('NQ=F');
    expect(parseTick(['511', '1783334741000', '159.438'])?.symbol).toBe('JPY=X');
  });

  it('対象外コード(732 FTSE / 1001 BTC)は null', () => {
    expect(parseTick(['732', '1783334741000', '8000'])).toBeNull();
    expect(parseTick(['1001', '1783334741000', '90000'])).toBeNull();
  });

  it('壊れた入力は null(配列でない/要素不足/非数値/非正)', () => {
    expect(parseTick(null)).toBeNull();
    expect(parseTick(['136', '1783334741000'])).toBeNull();          // 要素不足
    expect(parseTick(['136', 'not-a-number', '69920'])).toBeNull();  // ts 不正
    expect(parseTick(['136', '1783334741000', 'x'])).toBeNull();     // price 不正
    expect(parseTick(['136', '1783334741000', '0'])).toBeNull();     // price<=0
    expect(parseTick(['136', '-5', '69920'])).toBeNull();            // ts<=0
  });
});

describe('parsePriceTChangePercent — priceT バッチから騰落率', () => {
  it('A[136]="..." から NIY=F の pct を取り出す(parseAjaxTop 再利用)', () => {
    const batch = 'A[136]="69925.00_-85.00_-0.12_19:45_1__";\nA[737]="30468.70_-30.00_-0.10_10:06_1__";';
    const m = parsePriceTChangePercent(batch);
    expect(m.get('NIY=F')).toBe(-0.12);
    expect(m.get('NQ=F')).toBe(-0.10);
  });

  it('対象外コードは含めない', () => {
    const batch = 'A[732]="8000_+10_+0.13_19:45_1__";';   // FTSE=対象外
    expect(parsePriceTChangePercent(batch).size).toBe(0);
  });
});

describe('isStale — 鮮度判定', () => {
  const now = 1783334800000;
  it('SOCKET_STALE_MS 以内の tick は fresh', () => {
    const q: SocketQuote = { price: 69920, timestamp: now - 5000, changePercent: 0 };
    expect(isStale(q, now)).toBe(false);
  });
  it('SOCKET_STALE_MS 超の tick は stale', () => {
    const q: SocketQuote = { price: 69920, timestamp: now - (SOCKET_STALE_MS + 1), changePercent: 0 };
    expect(isStale(q, now)).toBe(true);
  });
  it('未受信(undefined)は stale', () => {
    expect(isStale(undefined, now)).toBe(true);
  });
});

describe('buildSocketPrices — latest → Price[](鮮度付与)', () => {
  const now = 1783334800000;
  it('fresh な NIY=F は stale=false・実 timestamp を保持', () => {
    const latest = new Map<Symbol, SocketQuote>([
      ['NIY=F', { price: 69920, timestamp: now - 3000, changePercent: -0.12 }],
    ]);
    const prices = buildSocketPrices(latest, now);
    const niy = prices.find(p => p.symbol === 'NIY=F')!;
    expect(niy.stale).toBe(false);
    expect(niy.price).toBe(69920);
    expect(niy.timestamp).toBe(now - 3000);   // tick の実 epoch-ms(now を上書きしない)
    expect(niy.changePercent).toBe(-0.12);
  });

  it('古い tick の銘柄は stale=true(下流で Yahoo に埋められない)', () => {
    const latest = new Map<Symbol, SocketQuote>([
      ['NIY=F', { price: 69920, timestamp: now - (SOCKET_STALE_MS + 10_000), changePercent: 0 }],
    ]);
    const niy = buildSocketPrices(latest, now).find(p => p.symbol === 'NIY=F')!;
    expect(niy.stale).toBe(true);
    expect(niy.timestamp).toBe(now - (SOCKET_STALE_MS + 10_000));   // 古い timestamp のまま
  });

  it('未受信の銘柄は結果に含めない', () => {
    const prices = buildSocketPrices(new Map(), now);
    expect(prices).toHaveLength(0);
  });
});

describe('getSocketPrices — シングルトン latest 経由(注入)', () => {
  it('_setLatestForTest で入れた値がスナップショットで返る', () => {
    _clearLatestForTest();
    const now = 1783334800000;
    _setLatestForTest('NIY=F', { price: 70050, timestamp: now - 2000, changePercent: 0.3 });
    const prices = getSocketPrices(now);
    const niy = prices.find(p => p.symbol === 'NIY=F')!;
    expect(niy.price).toBe(70050);
    expect(niy.stale).toBe(false);
    _clearLatestForTest();
  });

  it('stale な NIY=F はスナップショットで stale=true', () => {
    _clearLatestForTest();
    const now = 1783334800000;
    _setLatestForTest('NIY=F', { price: 70050, timestamp: now - (SOCKET_STALE_MS + 1), changePercent: 0 });
    expect(getSocketPrices(now).find(p => p.symbol === 'NIY=F')!.stale).toBe(true);
    _clearLatestForTest();
  });
});
