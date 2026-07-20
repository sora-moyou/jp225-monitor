import { describe, it, expect } from 'vitest';
import { buildSignalView, buildPositionView, type SignalTradeState } from './signalPanel.js';

// ─── シグナル枠(buildSignalView): 現在シグナル(s.signal)を常時描く=保有中も消えない ───
describe('buildSignalView(シグナル枠)', () => {
  it('signal 無しは「シグナル待機」', () => {
    expect(buildSignalView(null).main).toBe('シグナル待機');
    expect(buildSignalView({ phase: 'flat', updatedAt: 0 }).main).toBe('シグナル待機');
  });

  it('現在シグナル(指値/逆指値+LC)を「🎯 シグナル：…」で描き、理由も出す', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, stopEntry: 65520, stopLossForStop: 65470, rationale: '押し目買い', at: 1 },
    };
    const v = buildSignalView(s);
    expect(v.cls).toBe('armed');
    expect(v.main).toContain('買い 65,395 指値 (LC 65,345)');
    expect(v.main).toContain('買い 65,520 逆指値 (LC 65,470)');
    expect(v.rationale).toBe('押し目買い');
  });

  it('★保有中(filled + position)でも signal がある限りシグナルを描き続ける(消えない)', () => {
    const s: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      signal: { direction: 'buy', limitEntry: 65395, stopLossForLimit: 65345, rationale: 'r', at: 1 },
      position: { direction: 'buy', entryPrice: 65395, qty: 1, unrealized: 30, at: 2 },
    };
    const v = buildSignalView(s);
    expect(v.main).toContain('🎯 シグナル');
    expect(v.main).toContain('65,395 指値');
    expect(v.main).not.toContain('保有');   // 保有はシグナル枠には出さない(別枠)
  });

  it('レンジ両面は上下レッグを描く', () => {
    const s: SignalTradeState = {
      phase: 'armed', updatedAt: 0,
      signal: {
        direction: 'buy', mode: 'range', rationale: 'range', at: 1,
        range: {
          upper: { side: 'sell', type: 'limit', entry: 66000, stopLoss: 66050 },
          lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64950 },
        },
      },
    };
    const v = buildSignalView(s);
    expect(v.main).toContain('🎯 レンジ');
    expect(v.main).toContain('売り66,000指値(上)');
    expect(v.main).toContain('買い65,000指値(下)');
  });
});

// ─── 保有枠(buildPositionView): 建値+含み / 直近決済 / 保有なし。シグナルとは独立 ───
describe('buildPositionView(保有枠)', () => {
  const NOW = 1_000_000;

  it('無保有は「保有なし」', () => {
    expect(buildPositionView(null, NOW).main).toBe('保有なし');
    expect(buildPositionView({ phase: 'flat', updatedAt: 0 }, NOW).main).toBe('保有なし');
  });

  it('保有中は建値と含み(pt)を描く(決済逆指値は出さない)', () => {
    const s: SignalTradeState = {
      phase: 'filled', updatedAt: 0,
      position: { direction: 'buy', entryPrice: 65395, qty: 1, unrealized: 120, at: 2 },
    };
    const v = buildPositionView(s, NOW);
    expect(v.cls).toBe('filled');
    expect(v.main).toBe('● 保有：買い @65,395（含み +120）');
  });

  it('直近決済は数十秒だけ「✔ 決済 …」を出し、以降は「保有なし」', () => {
    const s: SignalTradeState = { phase: 'flat', updatedAt: 0, lastExit: { exitPrice: 65500, pnl: 105, at: NOW - 1000 } };
    expect(buildPositionView(s, NOW).main).toBe('✔ 決済 65,500（+105）');
    // 40秒超で消える
    expect(buildPositionView(s, NOW + 41_000).main).toBe('保有なし');
  });
});
