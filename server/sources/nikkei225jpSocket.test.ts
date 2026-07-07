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
  _setPrimaryLagForTest,
  _setLagWithinIntervalForTest,
  _getLastForceReconnectAtForTest,
  _hasWatchdogForTest,
  _runProactiveForTest,
  _runMbbTimeoutForTest,
  _getActiveSocketForTest,
  _getSocketNextForTest,
  _isSwappingForTest,
  _hasProactiveTimerForTest,
  SOCKET_STALE_MS,
  TICK_WATCHDOG_MS,
  TICK_STALE_LAG_MS,
  RECONNECT_GRACE_MS,
  PROACTIVE_RECONNECT_MS,
  MAKE_BEFORE_BREAK_TIMEOUT_MS,
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
/** fake socket に登録された event ハンドラを発火する(実 socket.io の tick 到着を模す)。
 *  同 event に複数登録されていれば全て呼ぶ(active 用と probe 用が並存しても両方走る)。 */
function fireSocketEvent(s: FakeSocket, event: string, ...args: unknown[]): void {
  for (const call of s.on.mock.calls) {
    if (call[0] === event && typeof call[1] === 'function') (call[1] as (...a: unknown[]) => void)(...args);
  }
}
/** code 136(NIY=F)の tick 配列。make-before-break の「最初の tick」に使う。 */
function niyTick(price = 69920, tsMs = Date.now()): string[] {
  return ['136', String(tsMs), String(price)];
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

// ── stale-timestamp watchdog(B): tick は届き続けるが価格値=tsMs が古い半死セッション ──
// 実測(2026-07-07): 起動直後は real-time(lag 数秒)→ 時間経過で同一 socket の**価格値が約10分遅延**へ
// ドリフト(tsMs もそれに連れて古くなる)→ 再接続(=新規接続)で real-time に復帰。これが繰り返し起きる。
// arrival だけ見る (A) は tick が届くので発火しない → tsMs 遅延ベースの (B) が必要。
// v0.7.14: give-up cap は撤去。ドリフトを検知するたびに(min-interval を空けて)何度でも張り直す。

describe('socket watchdog (B) — 価格値ドリフト(tsMs 遅延)からの強制再接続', () => {
  afterEach(() => { stopSocket(); vi.useRealTimers(); });

  it('lag > 閾値の tick が TICK_STALE_LAG_STREAK 回連続で届いたら強制再接続する', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, Date.now());   // connected・無 tick watchdog は発火しない状態

    // 1回目: lag 大 → streak=1 だけで再接続しない(一発ノイズ耐性)。
    _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000);   // 約570s 相当
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(1);   // まだ再接続なし

    // 2回目: 連続で lag 大 → streak=2 で強制再接続(connector 再呼び)。
    _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000);
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(2);
    // 強制再接続時刻が記録される(min-interval の基準)。
    expect(_getLastForceReconnectAtForTest()).toBeGreaterThan(0);
  });

  it('fresh(lag 小)な tick が届いている間は再接続しない', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, Date.now());
    for (let i = 0; i < 5; i++) {
      _setPrimaryLagForTest(2_000);   // real-time(≈2s)
      _runWatchdogForTest();
    }
    expect(connector).toHaveBeenCalledTimes(1);   // 再接続なし
  });

  it('一発だけ lag 大(単発ノイズ)では再接続しない', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, Date.now());
    _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000);   // 大
    _runWatchdogForTest();                                 // streak=1
    _setPrimaryLagForTest(2_000);                          // 次は fresh → streak リセット
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(1);   // sustained でないので再接続なし
  });

  // v0.7.14 の核心: give-up せず、ドリフトが再発するたびに何度でも張り直す(絶対的な打ち止めなし)。
  it('give-up cap なし: ドリフトが再発するたびに何度でも再接続する', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    // 1 サイクル = sustained ドリフト検知 → 強制再接続。_setPrimaryLagForTest が min-interval を過去化するので
    // 毎サイクルで再接続が許可される(= min-interval を空けて撃ち直す状況の代理)。
    const driftCycle = (): void => {
      _setConnStateForTest(true, Date.now());
      _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();   // streak=1
      _setConnStateForTest(true, Date.now());
      _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();   // streak=2 → reconnect
    };
    const N = 6;   // 旧 cap(3)を大きく超える回数。打ち止めが無いことを示す。
    for (let i = 0; i < N; i++) driftCycle();
    // 初回 startSocket の1回 + 各サイクルで必ず1回ずつ再接続 → 打ち止めなし。
    expect(connector).toHaveBeenCalledTimes(1 + N);
  });

  it('min-interval: 前回の強制再接続から RECONNECT_GRACE_MS 未満は再接続しない(rapid thrash 防止)', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    // sustained ドリフトで1回目の再接続を起こす。
    _setConnStateForTest(true, Date.now());
    _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();   // streak=1
    _setPrimaryLagForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();   // streak=2 → reconnect
    expect(connector).toHaveBeenCalledTimes(2);
    // 直後(min-interval 内)にまた lag 大が続いても再接続しない。
    //   _setLagWithinIntervalForTest は lastForceReconnectAt=now を保つ(= 再接続直後)。
    _setConnStateForTest(true, Date.now());
    _setLagWithinIntervalForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();
    _setLagWithinIntervalForTest(TICK_STALE_LAG_MS + 480_000); _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(2);   // min-interval 内なので増えない
    expect(RECONNECT_GRACE_MS).toBeGreaterThan(0);   // min-interval は正の値
  });

  it('無 tick(A)経路は 価格ドリフト(B)と独立に依然として発火する', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    _setConnStateForTest(true, Date.now() - (TICK_WATCHDOG_MS + 5_000));   // 完全沈黙
    _runWatchdogForTest();
    expect(connector).toHaveBeenCalledTimes(2);
  });
});

// ── proactive make-before-break(v0.7.15)──────────────────────────────
// 一定周期で新 socket を先に開き、それが最初の tick を出したら旧 socket を閉じて差し替える(ギャップ0)。
// 目的: 長寿命セッションが約10分遅延へ劣化する前に、常に「初回接続=real-time」状態へ更新し続ける。

describe('proactive make-before-break — 周期的なゼロギャップ差し替え', () => {
  afterEach(() => { stopSocket(); _clearLatestForTest(); vi.useRealTimers(); });

  it('startSocket は proactive timer を張る(定数は正の周期)', () => {
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    expect(_hasProactiveTimerForTest()).toBe(true);
    expect(PROACTIVE_RECONNECT_MS).toBeGreaterThan(0);
    expect(MAKE_BEFORE_BREAK_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('周期発火で新 socket を開く(旧 socket は閉じない=make-before-break の「make」側)', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    const oldSock = sockets[0]!;
    expect(_getActiveSocketForTest()).toBe(oldSock);

    _runProactiveForTest();   // 周期発火(setInterval を待たず直接)
    // 新 socket が開かれた(connector が2回目)。旧 socket はまだ閉じていない。
    expect(connector).toHaveBeenCalledTimes(2);
    expect(_isSwappingForTest()).toBe(true);
    expect(_getSocketNextForTest()).toBe(sockets[1]);
    expect(oldSock.disconnect).not.toHaveBeenCalled();          // 旧はまだ active(ギャップ0)
    expect(_getActiveSocketForTest()).toBe(oldSock);            // active はまだ旧のまま
  });

  it('新 socket の最初の tick で差し替え: そこで初めて旧 socket を閉じ、latest は新 socket 由来になる', () => {
    _clearLatestForTest();
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    const oldSock = sockets[0]!;

    _runProactiveForTest();
    const newSock = sockets[1]!;
    expect(oldSock.disconnect).not.toHaveBeenCalled();   // 差し替え前は旧を閉じない

    // 新 socket が最初の tick(code 136)を配信 → 差し替え発火。
    fireSocketEvent(newSock, 'tick', niyTick(70010));

    // 差し替え後: 旧 socket は破棄され、active は新 socket、swapping は解除。
    expect(oldSock.removeAllListeners).toHaveBeenCalled();
    expect(oldSock.disconnect).toHaveBeenCalled();
    expect(_getActiveSocketForTest()).toBe(newSock);
    expect(_getSocketNextForTest()).toBeNull();
    expect(_isSwappingForTest()).toBe(false);
    // latest は新 socket の tick 由来(価格が供給され続ける=ギャップ0)。
    const niy = getSocketPrices(Date.now()).find(p => p.symbol === 'NIY=F')!;
    expect(niy.price).toBe(70010);
    _clearLatestForTest();
  });

  it('make-before-break 中も latest は途切れない: 旧 socket の tick が差し替え前も供給される', () => {
    _clearLatestForTest();
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    const oldSock = sockets[0]!;

    // 旧 socket が供給(差し替え前)。
    fireSocketEvent(oldSock, 'tick', niyTick(69900));
    expect(getSocketPrices(Date.now()).find(p => p.symbol === 'NIY=F')!.price).toBe(69900);

    _runProactiveForTest();   // 新 socket を開く(差し替えはまだ)
    // この間も旧 socket は生きていて供給し続けられる(latest は空にならない)。
    fireSocketEvent(oldSock, 'tick', niyTick(69950));
    expect(getSocketPrices(Date.now()).find(p => p.symbol === 'NIY=F')!.price).toBe(69950);
    expect(oldSock.disconnect).not.toHaveBeenCalled();
    _clearLatestForTest();
  });

  it('新 socket が猶予内に tick を出さない → 新を捨てて旧を維持(retry は次周期)', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    const oldSock = sockets[0]!;

    _runProactiveForTest();
    const newSock = sockets[1]!;
    expect(_isSwappingForTest()).toBe(true);

    // timeout 到達(tick 無し)→ 新 socket を破棄し、旧を active のまま維持。
    _runMbbTimeoutForTest();
    expect(newSock.disconnect).toHaveBeenCalled();      // 新は捨てる
    expect(newSock.removeAllListeners).toHaveBeenCalled();
    expect(_getSocketNextForTest()).toBeNull();
    expect(_isSwappingForTest()).toBe(false);
    expect(_getActiveSocketForTest()).toBe(oldSock);    // 旧は維持(socket 無しにしない)
    expect(oldSock.disconnect).not.toHaveBeenCalled();

    // 次周期でまた新 socket を開ける(retry)。
    _runProactiveForTest();
    expect(connector).toHaveBeenCalledTimes(3);         // 1(初回)+1(1回目)+1(retry)
    expect(_isSwappingForTest()).toBe(true);
  });

  it('進行中サイクルの多重発火ガード: swapping 中に再度周期が来ても新 socket を重ねない', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    _runProactiveForTest();
    expect(connector).toHaveBeenCalledTimes(2);
    // 進行中にもう一度周期 → 何もしない(socketNext を積み上げない)。
    _runProactiveForTest();
    expect(connector).toHaveBeenCalledTimes(2);
    expect(_isSwappingForTest()).toBe(true);
  });

  it('stopSocket は proactive timer を止め、進行中の新 socket も閉じる', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    _runProactiveForTest();
    const oldSock = sockets[0]!;
    const newSock = sockets[1]!;

    stopSocket();
    expect(_hasProactiveTimerForTest()).toBe(false);
    expect(_isSwappingForTest()).toBe(false);
    expect(oldSock.disconnect).toHaveBeenCalled();
    expect(newSock.disconnect).toHaveBeenCalled();      // 進行中の新 socket も閉じる
  });

  it('setInterval 経路でも proactive が発火して新 socket を開く(fake timers)', () => {
    vi.useFakeTimers();
    const connector = vi.fn(makeFakeSocket) as unknown as SocketConnector;
    startSocket(connector);
    expect(connector).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(PROACTIVE_RECONNECT_MS + 1_000);
    expect(connector).toHaveBeenCalledTimes(2);          // 周期で新 socket を開いた
    expect(_isSwappingForTest()).toBe(true);
  });

  it('force reconnect(watchdog A/B)は進行中の make-before-break を破棄してから張り直す', () => {
    const sockets: FakeSocket[] = [];
    const connector = vi.fn(() => { const s = makeFakeSocket(); sockets.push(s); return s; }) as unknown as SocketConnector;
    startSocket(connector);
    _runProactiveForTest();
    const newSock = sockets[1]!;
    expect(_isSwappingForTest()).toBe(true);

    // 無 tick watchdog(A)を発火 → force reconnect が進行中 mbb を破棄。
    _setConnStateForTest(true, Date.now() - (TICK_WATCHDOG_MS + 5_000));
    _runWatchdogForTest();
    expect(newSock.disconnect).toHaveBeenCalled();      // 進行中の新 socket は破棄
    expect(_isSwappingForTest()).toBe(false);
    expect(_getSocketNextForTest()).toBeNull();
  });
});
