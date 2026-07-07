import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTick,
  parsePriceTChangePercent,
  isStale,
  buildSocketPrices,
  getSocketPrices,
  startSocket,
  stopSocket,
  _setLatestForTest,
  _clearLatestForTest,
  _runWatchdogForTest,
  _setConnStateForTest,
  _hasWatchdogForTest,
  SOCKET_STALE_MS,
  TICK_WATCHDOG_MS,
  type SocketConnector,
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

// ── tick watchdog + 強制再接続(2026-07-07 NIY=F 恒久 stale 事故対策) ────────────────
// 実 socket.io は張らず、connector シームで fake Socket を注入する。

interface FakeSocket {
  on: ReturnType<typeof vi.fn>;
  io: { on: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
}
function makeFakeSocket(): FakeSocket {
  return {
    on: vi.fn(),
    io: { on: vi.fn() },
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

describe('socket watchdog — 半死(tick 途絶)からの強制フル再接続', () => {
  afterEach(() => { stopSocket(); vi.useRealTimers(); });

  it('startSocket は connector を1回呼び watchdog interval を張る(冪等)', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    expect(connector).toHaveBeenCalledTimes(1);
    expect(_hasWatchdogForTest()).toBe(true);
    // 二重起動ガード: 再呼び出しでも connector は増えない。
    startSocket(connector);
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it('connected 中に TICK_WATCHDOG_MS 超で tick 途絶 → フル再接続(connector 再呼び + 旧 socket 破棄)', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    expect(connector).toHaveBeenCalledTimes(1);
    const first = sockets[0]!;

    // connected=true・直近 tick が watchdog 閾値を超えて古い状態を注入。
    _setConnStateForTest(true, Date.now() - (TICK_WATCHDOG_MS + 5_000));
    _runWatchdogForTest();

    // 旧 socket は破棄(removeAllListeners+disconnect)され、connector が再度呼ばれて再作成される。
    expect(first.removeAllListeners).toHaveBeenCalled();
    expect(first.disconnect).toHaveBeenCalled();
    expect(connector).toHaveBeenCalledTimes(2);
  });

  it('tick が新しい(閾値内)なら再接続しない', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, Date.now() - 5_000);   // 新しい
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(1);   // 再接続なし
  });

  it('disconnected 中は watchdog で再作成しない(透過再接続に任せる)', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(false, Date.now() - (TICK_WATCHDOG_MS + 5_000));
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it('まだ一度も tick が無い(起動直後)なら誤発火しない', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, 0);   // lastTickAt=0 = 未受信
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it('stopSocket は watchdog interval をクリアし socket を破棄する(冪等)', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    const s = sockets[0]!;
    stopSocket();
    expect(_hasWatchdogForTest()).toBe(false);
    expect(s.removeAllListeners).toHaveBeenCalled();
    expect(s.disconnect).toHaveBeenCalled();
    // 2回目の stopSocket も throw しない(冪等)。
    expect(() => stopSocket()).not.toThrow();
  });

  it('setInterval 経路でも watchdog が発火する(fake timers)', () => {
    vi.useFakeTimers();
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    // 十分古い tick 状態にして 15s の点検間隔を進める。
    _setConnStateForTest(true, Date.now() - (TICK_WATCHDOG_MS + 20_000));
    vi.advanceTimersByTime(16_000);
    expect(connector).toHaveBeenCalledTimes(2);   // 点検で1回強制再接続
  });
});
