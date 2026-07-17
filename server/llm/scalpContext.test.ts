import { describe, it, expect } from 'vitest';
import { buildScalpMarketData, buildScalpTradeHistory, type ScalpMarketDataInput } from './scalpContext.js';
import type { Bar1m, AlertRow, SignalTradeRow, SessionOHLC } from '../db/store.js';
import type { LevelsResult, Level } from '../levels.js';

// JST 2026-07-16 09:00 相当の適当な now。
const NOW = Date.UTC(2026, 6, 16, 0, 0, 0);   // 09:00 JST
const MIN = 60_000;

function bar(t: number, o: number, h: number, l: number, c: number): Bar1m {
  return { symbol: 'NIY=F', session_date: null, session: null, t, o, h, l, c };
}

function level(price: number, tier: 0 | 1 | 2, score: number, label: string): Level {
  return { price, dist: 0, labels: [label], strong: tier >= 1, score, tier, confluence: false };
}

function emptyLevels(): LevelsResult {
  return { current: 0, up: [], down: [], swing: null, reversalSatisfied: false, asOf: 0 };
}

describe('buildScalpMarketData', () => {
  it('全欠損(bars空・levels空・alerts空)でも例外を投げずセッション行だけ返す', () => {
    const input: ScalpMarketDataInput = {
      bars: [], levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 0,
    };
    const s = buildScalpMarketData(input);
    // 足/節目/ボラ/スイングは省略され、セッション行だけ残る(空文字ではない)。
    expect(s).toContain('セッション/時刻');
    expect(s).not.toContain('直近の足');
    expect(s).not.toContain('主要節目');
  });

  it('実 OHLC の足を1分足/5分足で整形する(HH:MM O/H/L/C)', () => {
    const bars: Bar1m[] = [];
    for (let i = 0; i < 20; i++) {
      const t = NOW - (20 - i) * MIN;
      bars.push(bar(t, 38000 + i, 38010 + i, 37990 + i, 38005 + i));
    }
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38024 });
    expect(s).toContain('直近の足(時刻 O/H/L/C)');
    expect(s).toContain('1分足:');
    expect(s).toContain('5分足:');
    // OHLC は "O/H/L/C" スラッシュ区切り。
    expect(s).toMatch(/\d{2}:\d{2} \d+\/\d+\/\d+\/\d+/);
  });

  it('5分足に集約する(O=最初/H=最大/L=最小/C=最後)', () => {
    // 同一5分バケット(NOW-5..NOW-1分)に5本。
    const base = Math.floor((NOW - 5 * MIN) / (5 * MIN)) * (5 * MIN);
    const bars: Bar1m[] = [
      bar(base + 0 * MIN, 100, 110, 95, 105),
      bar(base + 1 * MIN, 105, 130, 90, 120),   // 最高値130・最安値90
      bar(base + 2 * MIN, 120, 125, 115, 118),
      bar(base + 3 * MIN, 118, 122, 100, 111),
      bar(base + 4 * MIN, 111, 115, 108, 112),   // 最後の close=112
    ];
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: base + 5 * MIN, currentPrice: 112 });
    // O=100 / H=130 / L=90 / C=112 の集約が出る。
    expect(s).toContain('100/130/90/112');
  });

  it('節目を現在値に近い順で強度・距離つきに整形する', () => {
    const levels: LevelsResult = {
      ...emptyLevels(),
      up: [level(38400, 2, 2.4, '前日高値'), level(38900, 1, 1.1, 'グリッド')],
      down: [level(38100, 1, 1.5, '押し安値')],
    };
    const s = buildScalpMarketData({ bars: [], levels, alerts: [], now: NOW, currentPrice: 38250 });
    expect(s).toContain('主要節目');
    expect(s).toContain('38400 レジ +150円 ★★');
    expect(s).toContain('38100 サポ -150円');
    expect(s).toContain('前日高値');
  });

  it('ボラ/レンジ: session の高安を正に位置%と距離を出す', () => {
    const bars: Bar1m[] = [];
    for (let i = 0; i < 16; i++) bars.push(bar(NOW - (16 - i) * MIN, 38000, 38020, 37980, 38010));
    const session: SessionOHLC = {
      sessionDate: '2026-07-16', session: 'Day', open: 38000, high: 38300, low: 38100, close: 38200,
      highT: NOW, lowT: NOW, openT: NOW,
    };
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38200, session });
    expect(s).toContain('ボラ/レンジ');
    expect(s).toContain('ATR14');
    expect(s).toContain('本日高安 38300〜38100');
    // 位置% = (38200-38100)/(38300-38100)=50%
    expect(s).toContain('レンジ内位置50%');
    expect(s).toContain('高値まで+100円');
    expect(s).toContain('安値まで-100円');
  });

  it('直近アラート+その後(ret5/15/30)を併記し、ret 欠落は省く', () => {
    const alerts: AlertRow[] = [
      {
        id: 1, symbol: 'NIY=F', triggered_at: NOW - 20 * MIN, direction: 'up',
        detection_kind: 'break', window_seconds: 60, change_percent: 0, price: 38300,
        session_date: null, session: null, ret5: 0.12, ret15: 0.2, ret30: null,
        reference_kind: null, reference_price: null,
      },
    ];
    const s = buildScalpMarketData({ bars: [], levels: emptyLevels(), alerts, now: NOW, currentPrice: 38250 });
    expect(s).toContain('直近アラートとその後');
    expect(s).toContain('水準ブレイク');
    expect(s).toContain('5分+0.12%');
    expect(s).toContain('15分+0.20%');
    expect(s).not.toContain('30分');   // ret30=null は省く
  });
});

function trade(over: Partial<SignalTradeRow>): SignalTradeRow {
  return {
    id: 1, entry_t: 1000, entry_price: 38000, dir: 'buy',
    exit_t: 2000, exit_price: 38050, pnl: 50, qty: 1,
    rationale: null, meta: null, mode: null, ...over,
  };
}

describe('buildScalpTradeHistory', () => {
  it('件数が少ない(<3)/空は省略(空文字)', () => {
    expect(buildScalpTradeHistory([], NOW)).toBe('');
    expect(buildScalpTradeHistory([trade({}), trade({})], NOW)).toBe('');
  });

  it('全体勝率・純pnl・方向別・mode別・負け例を集計する', () => {
    const trades: SignalTradeRow[] = [
      trade({ id: 1, dir: 'buy', pnl: 60, mode: 'directional' }),
      trade({ id: 2, dir: 'buy', pnl: -40, mode: 'directional', entry_price: 38100, exit_price: 38060 }),
      trade({ id: 3, dir: 'sell', pnl: 30, mode: 'range' }),
      trade({ id: 4, dir: 'sell', pnl: -20, mode: 'range', entry_price: 38200, exit_price: 38220 }),
    ];
    const s = buildScalpTradeHistory(trades, NOW);
    expect(s).toContain('本シグナルエンジン');
    // 全体: 4件・勝ち2(60,30)=50%・純損益 60-40+30-20=+30
    expect(s).toContain('全体: 4件 勝率50% 純損益+30pt');
    // 方向別: buy 2件(勝1=50%,pnl+20) / sell 2件(勝1=50%,pnl+10)
    expect(s).toContain('buy 2件 勝率50% +20');
    expect(s).toContain('sell 2件 勝率50% +10');
    // mode別: directional 2件(+20) / range 2件(+10)
    expect(s).toContain('directional 2件 勝率50% +20');
    expect(s).toContain('range 2件 勝率50% +10');
    // 負け例: 直近の負け2件。
    expect(s).toContain('直近の負け:');
    expect(s).toContain('buy 38100→38060 -40');
    expect(s).toContain('sell 38200→38220 -20');
  });

  it('mode 未指定(NULL)は directional 扱い', () => {
    const trades: SignalTradeRow[] = [
      trade({ id: 1, pnl: 10 }), trade({ id: 2, pnl: 10 }), trade({ id: 3, pnl: 10 }),
    ];
    const s = buildScalpTradeHistory(trades, NOW);
    expect(s).toContain('directional 3件');
    expect(s).toContain('range 0件');
  });
});
