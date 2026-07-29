import { describe, it, expect } from 'vitest';
import { buildScalpMarketData, buildScalpTradeHistory, parseTradeSettings, type ScalpMarketDataInput } from './scalpContext.js';
import type { SignalSettingsSnapshot } from '../types.js';
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

  it('現値が本日高安を外れていても符号が壊れない(「+-118円」を出さない)', () => {
    const bars: Bar1m[] = [];
    for (let i = 0; i < 16; i++) bars.push(bar(NOW - (16 - i) * MIN, 38000, 38020, 37980, 38010));
    const session: SessionOHLC = {
      sessionDate: '2026-07-16', session: 'Day', open: 38000, high: 38300, low: 38100, close: 38200,
      highT: NOW, lowT: NOW, openT: NOW,
    };
    // session の高値(38300)を現値(38418)が上抜けている状況(セッション集計が追いつく前など)。
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38418, session });
    expect(s).not.toContain('+-');
    expect(s).toContain('高値まで-118円');
    expect(s).toContain('安値まで-318円');
  });

  it('現値がちょうど本日高値に一致する境界は「0円」(符号なし・意図した唯一の差分)', () => {
    const bars: Bar1m[] = [];
    for (let i = 0; i < 16; i++) bars.push(bar(NOW - (16 - i) * MIN, 38000, 38020, 37980, 38010));
    const session: SessionOHLC = {
      sessionDate: '2026-07-16', session: 'Day', open: 38000, high: 38300, low: 38100, close: 38300,
      highT: NOW, lowT: NOW, openT: NOW,
    };
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38300, session });
    expect(s).toContain('高値まで0円');    // 旧: +0円
    expect(s).toContain('安値まで-200円');
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

// ─────────────────────────────────────────────────────────────────────────────
// ★長い時間軸の方向(1時間/2時間/当日始値比)。「直近の勢い」が最長30分しか無く、
//   AI が大きな流れを数値で読めなかったための追加ブロック(ADD-ONLY)。
// ─────────────────────────────────────────────────────────────────────────────
describe('buildScalpMarketData 長い時間軸ブロック', () => {
  /** now から hoursBack 時間前まで 1分刻みで埋めた足(close は closeFn(minAgo))。 */
  function filled(minutes: number, closeFn: (minAgo: number) => number): Bar1m[] {
    const out: Bar1m[] = [];
    for (let i = minutes; i >= 0; i--) {
      const c = closeFn(i);
      out.push(bar(NOW - i * MIN, c, c, c, c));
    }
    return out;
  }

  it('1時間/2時間/当日始値比 の変化額を現在値との差で出す', () => {
    // 2時間前=38500 / 1時間前=38300 / 現在値=38000。
    const bars = filled(150, minAgo => (minAgo >= 120 ? 38500 : minAgo >= 60 ? 38300 : 38000));
    const session: SessionOHLC = {
      sessionDate: '2026-07-16', session: 'Day', open: 38800, high: 38900, low: 38000, close: 38000,
      highT: NOW, lowT: NOW, openT: NOW - 150 * MIN,
    };
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000, session });
    expect(s).toContain('長い時間軸(現在値との差)');
    expect(s).toContain('1時間-300円');
    expect(s).toContain('2時間-500円');
    expect(s).toContain('当日始値比-800円');
  });

  it('上昇局面は + 符号で出す', () => {
    const bars = filled(150, minAgo => (minAgo >= 120 ? 37500 : minAgo >= 60 ? 37800 : 38000));
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000 });
    expect(s).toContain('1時間+200円');
    expect(s).toContain('2時間+500円');
  });

  it('足が足りない期間は「—」で欠測を明示する(嘘の数字を出さない)', () => {
    // 直近70分ぶんしか無い → 1時間は出せるが 2時間は欠測。session なしで当日始値比も欠測。
    const bars = filled(70, minAgo => 38000 + minAgo);
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000 });
    expect(s).toContain('1時間-60円');
    expect(s).toContain('2時間—');
    expect(s).toContain('当日始値比—');
  });

  it('目標時刻から離れすぎた足しか無ければ「—」(セッション跨ぎの偽の数値を出さない)', () => {
    // 直近30分ぶん + 6時間前の足だけ。6時間前の足を「1時間前」として使わない。
    const bars: Bar1m[] = [bar(NOW - 360 * MIN, 39500, 39500, 39500, 39500)];
    for (let i = 30; i >= 0; i--) bars.push(bar(NOW - i * MIN, 38000, 38000, 38000, 38000));
    const session: SessionOHLC = {
      sessionDate: '2026-07-16', session: 'Day', open: 38050, high: 39500, low: 38000, close: 38000,
      highT: NOW, lowT: NOW, openT: NOW - 30 * MIN,
    };
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000, session });
    expect(s).toContain('1時間—');
    expect(s).toContain('2時間—');
    expect(s).not.toContain('-1500円');
  });

  it('全部欠測(足なし)ならブロックごと省略する', () => {
    const s = buildScalpMarketData({ bars: [], levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000 });
    expect(s).not.toContain('長い時間軸');
  });
});

function trade(over: Partial<SignalTradeRow>): SignalTradeRow {
  return {
    id: 1, entry_t: 1000, entry_price: 38000, dir: 'buy',
    exit_t: 2000, exit_price: 38050, pnl: 50, qty: 1,
    rationale: null, meta: null, mode: null, system: null, signal_id: null, ...over,
  };
}

describe('buildScalpTradeHistory', () => {
  it('件数が少ない(<3)/空は省略(空文字)', () => {
    expect(buildScalpTradeHistory([], NOW)).toBe('');
    expect(buildScalpTradeHistory([trade({}), trade({})], NOW)).toBe('');
  });

  it('直近から負けが続くと連敗数を出す(trades は exit_t DESC=新しい順)', () => {
    // 先頭(最新)から3連敗 → 「3連敗中」。range 切替検討の材料。
    const losing: SignalTradeRow[] = [
      trade({ id: 1, pnl: -30 }), trade({ id: 2, pnl: -40 }), trade({ id: 3, pnl: -20 }), trade({ id: 4, pnl: 50 }),
    ];
    expect(buildScalpTradeHistory(losing, NOW)).toContain('3連敗中');
    // 最新が勝ち → 連敗行は出さない。
    const notLosing: SignalTradeRow[] = [
      trade({ id: 1, pnl: 40 }), trade({ id: 2, pnl: -40 }), trade({ id: 3, pnl: -20 }),
    ];
    expect(buildScalpTradeHistory(notLosing, NOW)).not.toContain('連敗中');
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

  // ─── v0.7.56: 設定つき成績(委任別集計 + 設定つき直近) ───
  it('meta.settings が無い(旧世代)は従来フォーマットのみ(委任別は出さない)', () => {
    const trades: SignalTradeRow[] = [
      trade({ id: 1, pnl: 10 }), trade({ id: 2, pnl: 10 }), trade({ id: 3, pnl: -5 }),
    ];
    const s = buildScalpTradeHistory(trades, NOW);
    expect(s).toContain('全体:');
    expect(s).not.toContain('LC委任別');
    expect(s).not.toContain('設定つき直近');
  });

  it('meta.settings があると委任別成績(LC=AI/手動)と設定つき直近を併記', () => {
    const mk = (over: Partial<SignalSettingsSnapshot>): string => JSON.stringify({
      ctxV: 'rich',
      settings: {
        lcFloor: { mode: 'manual', value: 45 }, lcCeiling: { mode: 'manual', value: 65 },
        lcHardMax: { enabled: true, value: 150 },
        trendVeto: { mode: 'manual', value: 100 }, cooldown: { mode: 'manual', value: 90 },
        bias: { mode: 'manual', value: 'none' }, range: { mode: 'manual', value: false },
        ...over,
      },
    });
    const trades: SignalTradeRow[] = [
      trade({ id: 1, dir: 'buy', pnl: 65, meta: mk({ lcCeiling: { mode: 'ai', value: 120 } }) }),
      trade({ id: 2, dir: 'sell', pnl: -30, meta: mk({ lcCeiling: { mode: 'ai', value: 110 } }) }),
      trade({ id: 3, dir: 'buy', pnl: 40, meta: mk({ lcCeiling: { mode: 'manual', value: 65 } }) }),
    ];
    const s = buildScalpTradeHistory(trades, NOW);
    // LC委任別: AI n=2(勝1=50%,+35) / 手動 n=1(勝1=100%,+40)
    expect(s).toContain('LC委任別');
    expect(s).toContain('AI n=2');
    expect(s).toContain('手動 n=1');
    // 設定つき直近: 「buy LC=120(AI) veto=手動 bias=手動 → +65」形
    expect(s).toContain('設定つき直近');
    expect(s).toContain('LC=120(AI)');
    expect(s).toContain('→ +65');
  });
});

describe('parseTradeSettings', () => {
  it('meta 無し/壊れ/settings 欠落は null', () => {
    expect(parseTradeSettings(null)).toBeNull();
    expect(parseTradeSettings('not json')).toBeNull();
    expect(parseTradeSettings(JSON.stringify({ ctxV: 'rich' }))).toBeNull();
  });
  it('meta.settings を取り出す', () => {
    const meta = JSON.stringify({ ctxV: 'rich', settings: { lcCeiling: { mode: 'ai', value: 120 } } });
    const s = parseTradeSettings(meta);
    expect(s?.lcCeiling).toEqual({ mode: 'ai', value: 120 });
  });
});

// ─── ★ブロック G: テクニカル指標(RSI14/SMA14/BB±1.5σ・5分足) ───
describe('buildScalpMarketData テクニカル指標ブロック(G)', () => {
  // 5分足で16本以上(=確定足15本以上)が必要。1分足を 16*5+5 本作る(最後の1本は形成中として落ちる)。
  function longBars(): Bar1m[] {
    const bars: Bar1m[] = [];
    const n = 90;
    for (let i = 0; i < n; i++) {
      const t = NOW - (n - i) * MIN;
      const c = 38000 + Math.round(Math.sin(i / 4) * 60);   // 上下する波(RSI が 0/100 に張り付かない)
      bars.push(bar(t, c, c + 10, c - 10, c));
    }
    return bars;
  }

  it('十分な本数があれば RSI14/SMA14/BB/%B と RSI推移を出す', () => {
    const s = buildScalpMarketData({ bars: longBars(), levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000 });
    expect(s).toContain('テクニカル指標(5分足・RSI14/SMA14/BB±1.5σ)');
    expect(s).toContain('RSI14=');
    expect(s).toContain('SMA14=');
    expect(s).toContain('BB[±1.5σ]=');
    expect(s).toContain('%B=');
    expect(s).toContain('RSI推移');
  });

  // U+301C(WAVE DASH)は cp932 環境で '?' に化ける。BB の範囲区切りは U+FF5E(FULLWIDTH TILDE)。
  it('BB の範囲区切りは U+FF5E(～)で U+301C を使わない', () => {
    const s = buildScalpMarketData({ bars: longBars(), levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000 });
    const bbLine = s.split('\n').find(l => l.includes('BB[±1.5σ]='))!;
    expect(bbLine).toContain('～');
    expect(bbLine).not.toContain('〜');
  });

  it('indicatorsEnabled=false ではブロック G を出さない(AIへテクニカルを供給しない)', () => {
    const s = buildScalpMarketData({
      bars: longBars(), levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38000, indicatorsEnabled: false,
    });
    expect(s).not.toContain('テクニカル指標(5分足');
    expect(s).toContain('直近の足(時刻 O/H/L/C)');   // 他のブロックは従来どおり出る
  });

  it('本数不足(確定5分足が15本未満)ではブロック G を省略する', () => {
    const bars: Bar1m[] = [];
    for (let i = 0; i < 20; i++) {
      const t = NOW - (20 - i) * MIN;
      bars.push(bar(t, 38000 + i, 38010 + i, 37990 + i, 38005 + i));
    }
    const s = buildScalpMarketData({ bars, levels: emptyLevels(), alerts: [], now: NOW, currentPrice: 38024 });
    expect(s).not.toContain('テクニカル指標(5分足');
  });
});
