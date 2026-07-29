import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// indicatorsLoop の配線(足の供給元)を固定する回帰テスト。
//   事故: 足を DB(bars_1m=collector デーモンだけが書く)からしか取らず、モニタ本体のメモリ内ライブ足を
//         見ていなかったため、collector 未稼働の環境では窓内0本 → 無音 return → SSE 'indicators' が
//         一度も飛ばず、パネルが永久に「蓄積中…」だった。
//   期待: ①DB が空でもメモリ内ライブ足だけで indicators が配信される
//         ②足が1本も無くても状態マーカー(progress.state='no-bars')付きで配信される(画面で自己診断できる)
// DB/SSE/設定/セッション判定はモックし、足は本物の feedBars に投入する。

const broadcastMock = vi.fn<[{ type: string; payload: unknown }], void>();
vi.mock('../sse/broker.js', () => ({ broadcast: (e: { type: string; payload: unknown }) => broadcastMock(e) }));

// DB は「開けるが bars_1m が空」= 実機(NIY=F の最新足が数週間前)と同じ状況。
vi.mock('../db/store.js', () => ({
  openDb: () => ({ close: () => {} }),
  resolveDbPath: () => ':memory:',
  getRecentBars: () => [],
}));

const indicatorsEnabledMock = vi.fn<[], boolean>(() => true);
vi.mock('../configStore.js', () => ({ resolveIndicatorsEnabled: () => indicatorsEnabledMock() }));

// 取引時間内/外をテストから切り替える(時計に依存させない)。他の export は実物を使う。
const inPollWindowMock = vi.fn<[], boolean>(() => true);
vi.mock('../../core/session.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inPollWindow: () => inPollWindowMock(),
}));

import { startIndicatorsLoop, stopIndicatorsLoop, getIndicatorsSnapshot, _reset as resetLoop } from './indicatorsLoop.js';
import { feedRealtimePrice, _reset } from '../feedBars.js';
import type { IndicatorSnapshot } from '../indicators.js';

const MIN = 60_000;

/** broadcast された最新の indicators ペイロード。 */
function lastIndicators(): IndicatorSnapshot | null {
  const calls = broadcastMock.mock.calls.filter(c => c[0]?.type === 'indicators');
  return calls.length > 0 ? (calls[calls.length - 1]![0].payload as IndicatorSnapshot) : null;
}

describe('indicatorsLoop — 足の供給元(DB ∪ メモリ内ライブ足)', () => {
  beforeEach(() => {
    // 配信状態(de-dup 署名/直近スナップショット)はモジュールに残るのでテストごとに初期化する。
    broadcastMock.mockReset(); _reset(); stopIndicatorsLoop(); resetLoop();
    inPollWindowMock.mockReturnValue(true);
    indicatorsEnabledMock.mockReturnValue(true);
  });
  afterEach(() => { stopIndicatorsLoop(); });

  it('DB が空でもメモリ内ライブ足だけで indicators を配信する(蓄積中…から抜けられる)', () => {
    // 5分足16本ぶん(=主指標が算出できる本数)を1分足として投入。
    const now = Date.now();
    const start = Math.floor((now - 90 * MIN) / MIN) * MIN;
    for (let i = 0; i < 90; i++) {
      feedRealtimePrice('NIY=F', 41000 + Math.sin(i / 4) * 60, start + i * MIN);
    }
    startIndicatorsLoop();
    const snap = lastIndicators();
    expect(snap).not.toBeNull();
    expect(snap!.sma).not.toBeNull();
    expect(snap!.rsi).not.toBeNull();
    expect(snap!.progress).toEqual({ state: 'ready', remaining: 0 });
    expect(getIndicatorsSnapshot()).not.toBeNull();
  });

  it('足が1本も無いときも no-bars マーカー付きで配信する(画面で「足データ未取得」と分かる)', () => {
    startIndicatorsLoop();
    const snap = lastIndicators();
    expect(snap).not.toBeNull();
    expect(snap!.sma).toBeNull();
    expect(snap!.progress?.state).toBe('no-bars');
  });

  it('足はあるが本数不足なら warming + 残り本数を配信する', () => {
    const now = Date.now();
    const start = Math.floor((now - 20 * MIN) / MIN) * MIN;
    for (let i = 0; i < 20; i++) feedRealtimePrice('NIY=F', 41000 + i, start + i * MIN);
    startIndicatorsLoop();
    const snap = lastIndicators();
    expect(snap!.sma).toBeNull();
    expect(snap!.progress?.state).toBe('warming');
    expect(snap!.progress!.remaining).toBeGreaterThan(0);
  });

  // 引け後/早朝(取引時間外)と機能OFFは、これまで broadcast 自体が走らず、パネルが無言のまま
  // 初期表示の「蓄積中…」を出し続けていた(最も問い合わせが来る時間帯に理由が見えない)。
  it('取引時間外は closed 状態を1回だけ配信して return する(DB読み/計算はしない)', () => {
    inPollWindowMock.mockReturnValue(false);
    startIndicatorsLoop();
    const snap = lastIndicators();
    expect(snap!.progress?.state).toBe('closed');
    // 同じ状態の再送はしない(JSON de-dup)。
    const before = broadcastMock.mock.calls.length;
    stopIndicatorsLoop();
    startIndicatorsLoop();
    expect(broadcastMock.mock.calls.length).toBe(before);
  });

  it('機能OFF(indicatorsEnabled=false)は disabled 状態を配信する', () => {
    indicatorsEnabledMock.mockReturnValue(false);
    startIndicatorsLoop();
    expect(lastIndicators()!.progress?.state).toBe('disabled');
  });

  // 引け後に「そのセッションの最終 RSI/BB」を見るのは実用的な用途なので、算出済みの値は消さない。
  it('算出済みのまま取引時間外に入ったら、直前の値を保持して closed を付けて配信する', () => {
    const now = Date.now();
    const start = Math.floor((now - 90 * MIN) / MIN) * MIN;
    for (let i = 0; i < 90; i++) feedRealtimePrice('NIY=F', 41000 + Math.sin(i / 4) * 60, start + i * MIN);
    startIndicatorsLoop();
    const ready = lastIndicators()!;
    expect(ready.progress?.state).toBe('ready');
    // 引け → 時間外ゲートに入る。
    inPollWindowMock.mockReturnValue(false);
    stopIndicatorsLoop();
    startIndicatorsLoop();
    const closed = lastIndicators()!;
    expect(closed.progress?.state).toBe('closed');
    expect(closed.rsi).toBe(ready.rsi);          // 値は消さない
    expect(closed.sma).toBe(ready.sma);
    expect(closed.bbUpper).toBe(ready.bbUpper);
    expect(closed.series.length).toBe(ready.series.length);
  });

  it('取引時間外 → 時間内に戻ると通常の算出/配信が再開する', () => {
    const now = Date.now();
    const start = Math.floor((now - 90 * MIN) / MIN) * MIN;
    for (let i = 0; i < 90; i++) feedRealtimePrice('NIY=F', 41000 + Math.sin(i / 4) * 60, start + i * MIN);
    inPollWindowMock.mockReturnValue(false);
    startIndicatorsLoop();
    expect(lastIndicators()!.progress?.state).toBe('closed');
    inPollWindowMock.mockReturnValue(true);
    stopIndicatorsLoop();
    startIndicatorsLoop();
    expect(lastIndicators()!.progress?.state).toBe('ready');
  });
});
