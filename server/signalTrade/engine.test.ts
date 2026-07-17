import { describe, it, expect, afterEach } from 'vitest';
import {
  detectFill, detectRangeFill, unrealizedPt, detectExit, realizedPnl, equitySeries,
  advance, toSignalTradeState, planToArmed, restingStopOf, armedToCurrentSignal,
  computeHold, inCooldown,
  type ArmedBracket, type OpenPosition, type EngineState, type CurrentSignal,
} from './engine.js';
import { _setExitImpl } from './exit/index.js';

afterEach(() => _setExitImpl(null));   // 簡易版(初期LC固定)へ戻す

// ─── detectFill ───
describe('detectFill', () => {
  const buy: ArmedBracket = {
    direction: 'buy', limitEntry: 37950, stopEntry: 38100,
    stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'x', at: 0,
  };
  it('buy 指値: 現値が指値以下へ下落で約定', () => {
    expect(detectFill(buy, 37950)).toEqual({ leg: 'limit', entryPrice: 37950, initialStop: 37900 });
    expect(detectFill(buy, 37800)).toEqual({ leg: 'limit', entryPrice: 37950, initialStop: 37900 });
  });
  it('buy 逆指値: 現値が逆指値以上へ上昇で約定', () => {
    expect(detectFill(buy, 38100)).toEqual({ leg: 'stop', entryPrice: 38100, initialStop: 38050 });
  });
  it('両entryの間では未約定', () => {
    expect(detectFill(buy, 38000)).toBeNull();
  });
  it('両レッグが同時に満たす場合は指値優先', () => {
    const both: ArmedBracket = { direction: 'buy', limitEntry: 38000, stopEntry: 37000, stopLossForLimit: 37950, stopLossForStop: 36950, rationale: 'x', at: 0 };
    expect(detectFill(both, 37500)?.leg).toBe('limit');
  });
  it('sell 指値は上昇で約定・逆指値は下落で約定', () => {
    const sell: ArmedBracket = { direction: 'sell', limitEntry: 38100, stopEntry: 37900, stopLossForLimit: 38150, stopLossForStop: 37850, rationale: 'x', at: 0 };
    expect(detectFill(sell, 38100)?.leg).toBe('limit');
    expect(detectFill(sell, 37900)?.leg).toBe('stop');
    expect(detectFill(sell, 38000)).toBeNull();
  });
  it('片レッグ(指値のみ)のブラケットは逆指値では約定しない', () => {
    const only: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'x', at: 0 };
    expect(detectFill(only, 39000)).toBeNull();   // 逆指値が無いので上抜けでは約定しない
    expect(detectFill(only, 37900)?.leg).toBe('limit');
  });
});

// ─── unrealized / exit / pnl ───
describe('unrealizedPt / detectExit / realizedPnl', () => {
  it('含み損益は方向で符号が反転する', () => {
    expect(unrealizedPt('buy', 38000, 38050)).toBe(50);
    expect(unrealizedPt('buy', 38000, 37950)).toBe(-50);
    expect(unrealizedPt('sell', 38000, 37950)).toBe(50);
  });
  it('buy は現値が逆指値以下で決済', () => {
    const pos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'x', at: 0 };
    expect(detectExit(pos, 37950, 37950)).toBe(37950);
    expect(detectExit(pos, 37960, 37950)).toBeNull();
  });
  it('sell は現値が逆指値以上で決済', () => {
    const pos: OpenPosition = { direction: 'sell', entryPrice: 38000, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'x', at: 0 };
    expect(detectExit(pos, 38050, 38050)).toBe(38050);
  });
  it('stop が null なら決済しない', () => {
    const pos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'x', at: 0 };
    expect(detectExit(pos, 1, null)).toBeNull();
  });
  it('実現損益は方向×枚数', () => {
    expect(realizedPnl('buy', 38000, 38120, 1)).toBe(120);
    expect(realizedPnl('sell', 38000, 37900, 2)).toBe(200);
  });
});

// ─── equitySeries ───
describe('equitySeries', () => {
  it('exit_t 昇順で累積損益を作る', () => {
    const out = equitySeries([
      { exit_t: 300, pnl: -20 }, { exit_t: 100, pnl: 50 }, { exit_t: 200, pnl: 30 },
    ]);
    expect(out.map(p => p.cum)).toEqual([50, 80, 60]);
    expect(out.map(p => p.t)).toEqual([100, 200, 300]);
  });
  it('空配列は空', () => {
    expect(equitySeries([])).toEqual([]);
  });
});

// ─── advance: 状態遷移(簡易 exit=初期LC固定) ───
describe('advance', () => {
  it('armed → 指値約定で filled(建値・初期LC・peak を設定)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 0 },
    };
    const { next } = advance(st, 37950, 1000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ direction: 'buy', entryPrice: 37950, initialStop: 37900, qty: 1, at: 1000 });
  });

  it('armed で未約定なら据え置き', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 0 },
    };
    expect(advance(st, 38000, 1).next.phase).toBe('armed');
  });

  it('filled → 逆指値ヒットで flat + 決済記録(簡易=初期LC固定)', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500 },
    };
    const { next, recorded } = advance(st, 37950, 2000);
    expect(next.phase).toBe('flat');
    expect(next.lastExit).toEqual({ exitPrice: 37950, pnl: -50, at: 2000 });
    expect(recorded).toEqual({ entryT: 500, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 37950, pnl: -50, qty: 1, rationale: 'r' });
  });

  it('filled → 含み益が乗るだけでは決済せず peakProfit を更新', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 0 },
    };
    const { next, recorded } = advance(st, 38200, 10);
    expect(next.phase).toBe('filled');
    expect(recorded).toBeUndefined();
    expect(next.position?.peakProfit).toBe(200);
  });

  it('ラチェット差し替え時: 含み益ピーク後の押し戻りで床決済する', () => {
    // 差し替え実装: peak>=100 で建値+30 に床を上げる(単純ラチェット)。
    _setExitImpl(s => s.peakProfit >= 100 ? s.entryPrice + 30 : s.initialStop);
    let st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 0 },
    };
    st = advance(st, 38150, 1).next;                 // peak=150 → 床=38030
    expect(st.phase).toBe('filled');
    const { next, recorded } = advance(st, 38030, 2);  // 押し戻りで床ヒット
    expect(next.phase).toBe('flat');
    expect(recorded?.pnl).toBe(30);                  // 建値+30 で利益ロック決済
  });

  it('一巡: flat の armed→fill→exit を通しで回す', () => {
    let st: EngineState = {
      phase: 'armed',
      armed: { direction: 'sell', limitEntry: 38100, stopLossForLimit: 38150, rationale: 'r', at: 0 },
    };
    st = advance(st, 38100, 1).next;   // sell 指値約定
    expect(st.phase).toBe('filled');
    const r = advance(st, 38150, 2);   // 初期LC(38150)ヒット
    expect(r.next.phase).toBe('flat');
    expect(r.recorded?.pnl).toBe(-50);
  });
});

// ─── restingStopOf(委譲確認) ───
describe('restingStopOf', () => {
  it('簡易版では初期LCを返す', () => {
    const pos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 400, rationale: 'x', at: 0 };
    expect(restingStopOf(pos)).toBe(37950);
  });
});

// ─── toSignalTradeState ───
describe('toSignalTradeState', () => {
  it('armed は entry(初期LCを1つに正規化)を出す', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', at: 5 },
    };
    const s = toSignalTradeState(st, 38000, 9);
    expect(s.phase).toBe('armed');
    expect(s.entry).toMatchObject({ direction: 'buy', limitEntry: 37950, stopEntry: 38100, initialStop: 37900, at: 5 });
    expect(s.position).toBeUndefined();
  });

  it('filled は position(含み)を出し決済逆指値は出さない', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 100, rationale: 'r', at: 7 },
    };
    const s = toSignalTradeState(st, 38080, 9);
    expect(s.position).toMatchObject({ direction: 'buy', entryPrice: 38000, qty: 1, unrealized: 80, at: 7 });
    // 決済逆指値/initialStop はどこにも露出しない
    expect(JSON.stringify(s)).not.toContain('37950');
  });

  it('flat + lastExit を保持', () => {
    const st: EngineState = { phase: 'flat', lastExit: { exitPrice: 38200, pnl: 200, at: 3 } };
    const s = toSignalTradeState(st, 38200, 9);
    expect(s.phase).toBe('flat');
    expect(s.lastExit).toEqual({ exitPrice: 38200, pnl: 200, at: 3 });
  });
});

// ─── planToArmed ───
describe('planToArmed', () => {
  it('両レッグの plan を armed に変換', () => {
    const a = planToArmed({ direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r' }, 5);
    expect(a).toMatchObject({ direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, at: 5 });
  });
  it('direction:none は null', () => {
    expect(planToArmed({ direction: 'none', rationale: '見送り' }, 0)).toBeNull();
  });
  it('片レッグ(指値のみ)も許可', () => {
    const a = planToArmed({ direction: 'sell', limitEntry: 38100, stopLossForLimit: 38150, rationale: 'r' }, 0);
    expect(a).toMatchObject({ direction: 'sell', limitEntry: 38100, stopLossForLimit: 38150 });
    expect(a?.stopEntry).toBeUndefined();
  });
  it('両レッグ欠落は null', () => {
    expect(planToArmed({ direction: 'buy', rationale: 'r' }, 0)).toBeNull();
  });
});

// ─── armedToCurrentSignal ───
describe('armedToCurrentSignal', () => {
  it('両レッグの armed から full plan + signalId を組み立てる', () => {
    const a: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', at: 5 };
    expect(armedToCurrentSignal(a, 3)).toEqual({
      signalId: 3, at: 5, direction: 'buy', rationale: 'r',
      limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050,
    });
  });
  it('片レッグ(指値のみ)は欠落フィールドを付与しない', () => {
    const a: ArmedBracket = { direction: 'sell', limitEntry: 38100, stopLossForLimit: 38150, rationale: 'r', at: 0 };
    const s = armedToCurrentSignal(a, 1);
    expect(s).toEqual({ signalId: 1, at: 0, direction: 'sell', rationale: 'r', limitEntry: 38100, stopLossForLimit: 38150 });
    expect('stopEntry' in s).toBe(false);
    expect('stopLossForStop' in s).toBe(false);
  });
});

// ─── computeHold(保有中の意図・exitStop 公開) ───
describe('computeHold', () => {
  const sig: CurrentSignal = { signalId: 7, at: 5, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };

  it('filled: signalId(ARM采番)+direction+entryPrice+exitStop(簡易=初期LC)+at(建値時刻)', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 37950, qty: 1, initialStop: 37900, peakProfit: 400, rationale: 'r', at: 7 },
    };
    expect(computeHold(st, sig)).toEqual({
      signalId: 7, direction: 'buy', entryPrice: 37950, exitStop: 37900, at: 7,
    });
  });

  it('ラチェット差し替え時は exitStop が動く(毎tick算出)', () => {
    _setExitImpl(s => s.peakProfit >= 100 ? s.entryPrice + 30 : s.initialStop);
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 150, rationale: 'r', at: 1 },
    };
    expect(computeHold(st, sig)?.exitStop).toBe(38030);   // 建値+30 に上がった床
  });

  it('flat / armed / signal 未指定 では hold なし(null)', () => {
    expect(computeHold({ phase: 'flat' }, sig)).toBeNull();
    expect(computeHold({ phase: 'armed', armed: { direction: 'buy', limitEntry: 1, stopLossForLimit: 1, rationale: 'r', at: 0 } }, sig)).toBeNull();
    const filled: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 1, qty: 1, initialStop: 1, peakProfit: 0, rationale: 'r', at: 0 } };
    expect(computeHold(filled, null)).toBeNull();   // signal 無ければ hold は付けない
  });

  it('signalId は entry(currentSignal)と対応する', () => {
    const st: EngineState = { phase: 'filled', position: { direction: 'sell', entryPrice: 38100, qty: 1, initialStop: 38150, peakProfit: 0, rationale: 'r', at: 2 } };
    const s: CurrentSignal = { signalId: 42, at: 1, direction: 'sell', rationale: 'r', limitEntry: 38100, stopLossForLimit: 38150 };
    expect(computeHold(st, s)?.signalId).toBe(42);
  });
});

// ─── toSignalTradeState: hold 付与(exitStop 公開) ───
describe('toSignalTradeState hold', () => {
  const sig: CurrentSignal = { signalId: 9, at: 3, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
  it('filled + signal で SSE state に hold(exitStop 絶対価格)が入る', () => {
    const st: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 37950, qty: 1, initialStop: 37900, peakProfit: 0, rationale: 'r', at: 8 } };
    const s = toSignalTradeState(st, 38000, 9, sig);
    expect(s.hold).toEqual({ signalId: 9, direction: 'buy', entryPrice: 37950, exitStop: 37900, at: 8 });
    expect(s.position).toBeDefined();   // 既存 position 表示は不変
  });
  it('flat/armed では hold は付かない', () => {
    expect(toSignalTradeState({ phase: 'flat' }, 38000, 9, sig).hold).toBeUndefined();
    const armed: EngineState = { phase: 'armed', armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 3 } };
    expect(toSignalTradeState(armed, 38000, 9, sig).hold).toBeUndefined();
  });
});

// ─── inCooldown(決済後の再ARM抑止) ───
describe('inCooldown', () => {
  it('決済からの経過が秒数未満なら true(=まだ再ARMしない)', () => {
    expect(inCooldown(1000, 1000 + 89_000, 90)).toBe(true);
  });
  it('秒数を過ぎたら false(=再ARM可)', () => {
    expect(inCooldown(1000, 1000 + 90_000, 90)).toBe(false);   // 境界(=90秒)は解除
    expect(inCooldown(1000, 1000 + 120_000, 90)).toBe(false);
  });
  it('cooldownSec<=0 は無効(常に false)', () => {
    expect(inCooldown(1000, 1000, 0)).toBe(false);
    expect(inCooldown(1000, 1000 + 10, -5)).toBe(false);
  });
  it('まだ決済していない(lastExitAt=null)は false', () => {
    expect(inCooldown(null, 999_999, 90)).toBe(false);
  });
});

// ─── レンジ両面ストラドル(range) ───
describe('detectRangeFill', () => {
  // 上=売り指値38400 / 下=買い指値38100(現在値の上下)。
  const armed: ArmedBracket = {
    direction: 'buy', rationale: 'range', at: 0, mode: 'range',
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    },
  };
  it('現在値が upper.entry 以上→上レッグ約定(side/建値/初期LC)', () => {
    expect(detectRangeFill(armed, 38400)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
    expect(detectRangeFill(armed, 38500)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
  });
  it('現在値が lower.entry 以下→下レッグ約定', () => {
    expect(detectRangeFill(armed, 38100)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
    expect(detectRangeFill(armed, 38000)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
  });
  it('上下の間(未到達)は null', () => {
    expect(detectRangeFill(armed, 38250)).toBeNull();
  });
  it('片面 range(下レッグのみ)は上抜けでは約定しない', () => {
    const only: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range',
      range: { lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } };
    expect(detectRangeFill(only, 39000)).toBeNull();
    expect(detectRangeFill(only, 38100)?.side).toBe('buy');
  });
});

describe('advance range→filled→exit', () => {
  it('range armed → 下レッグ約定で filled(約定 side=buy・建値・初期LC・mode=range)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      } },
    };
    const { next } = advance(st, 38100, 1000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ direction: 'buy', entryPrice: 38100, initialStop: 38050, qty: 1, at: 1000, mode: 'range' });
  });

  it('range armed → 上レッグ約定で filled(約定 side=sell)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      } },
    };
    const { next } = advance(st, 38400, 1);
    expect(next.position).toMatchObject({ direction: 'sell', entryPrice: 38400, initialStop: 38450, mode: 'range' });
  });

  it('range 未到達では armed 据え置き', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      } },
    };
    expect(advance(st, 38250, 1).next.phase).toBe('armed');
  });

  it('一巡: range armed→下レッグ約定(buy)→初期LCヒットで flat + recorded に mode=range タグ', () => {
    let st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      } },
    };
    st = advance(st, 38100, 1).next;   // buy 約定 @38100
    expect(st.phase).toBe('filled');
    const r = advance(st, 38050, 2);   // 初期LC(38050)ヒット
    expect(r.next.phase).toBe('flat');
    expect(r.recorded?.pnl).toBe(-50);
    expect(r.recorded?.dir).toBe('buy');
    expect(r.recorded?.mode).toBe('range');   // 別枠集計タグ
  });

  it('directional の recorded に mode は付かない(既存互換)', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500 },
    };
    const { recorded } = advance(st, 37950, 2000);
    expect(recorded?.mode).toBeUndefined();
  });
});

describe('planToArmed range', () => {
  it('range(両レッグ)→ mode:range の armed', () => {
    const a = planToArmed({ direction: 'range', rationale: 'r', range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    } }, 5);
    expect(a?.mode).toBe('range');
    expect(a?.range?.upper?.side).toBe('sell');
    expect(a?.range?.lower?.side).toBe('buy');
    expect(a?.at).toBe(5);
  });
  it('range(片レッグのみ)も許可', () => {
    const a = planToArmed({ direction: 'range', rationale: 'r', range: {
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    } }, 0);
    expect(a?.mode).toBe('range');
    expect(a?.range?.upper).toBeUndefined();
    expect(a?.range?.lower).toBeDefined();
  });
  it('range で 0 レッグ(range 欠落)→ null', () => {
    expect(planToArmed({ direction: 'range', rationale: 'r' }, 0)).toBeNull();
    expect(planToArmed({ direction: 'range', rationale: 'r', range: {} }, 0)).toBeNull();
  });
});

describe('armedToCurrentSignal range', () => {
  it('range armed から mode/range を引き継ぐ', () => {
    const a: ArmedBracket = { direction: 'buy', rationale: 'r', at: 5, mode: 'range', range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    } };
    const s = armedToCurrentSignal(a, 3);
    expect(s.mode).toBe('range');
    expect(s.range?.upper?.entry).toBe(38400);
    expect(s.range?.lower?.entry).toBe(38100);
    expect(s.signalId).toBe(3);
  });
});

describe('toSignalTradeState range(entry + signal に mode/range)', () => {
  it('range armed は entry に mode/range(両面)を出す', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', rationale: 'r', at: 5, mode: 'range', range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      } },
    };
    const s = toSignalTradeState(st, 38250, 9);
    expect(s.entry?.mode).toBe('range');
    expect(s.entry?.range?.upper?.side).toBe('sell');
    expect(s.entry?.range?.lower?.side).toBe('buy');
  });
  it('range signal は s.signal に mode/range を出す(trade2 追従)', () => {
    const sig: CurrentSignal = {
      signalId: 7, at: 5, direction: 'buy', rationale: 'r', mode: 'range',
      range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const s = toSignalTradeState({ phase: 'armed', armed: { direction: 'buy', rationale: 'r', at: 5, mode: 'range', range: sig.range } }, 38250, 9, sig);
    expect(s.signal?.mode).toBe('range');
    expect(s.signal?.range?.upper?.entry).toBe(38400);
  });
  it('directional は mode/range を付けない(既存互換)', () => {
    const sig: CurrentSignal = { signalId: 1, at: 0, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
    const s = toSignalTradeState({ phase: 'armed', armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 0 } }, 38000, 9, sig);
    expect(s.entry?.mode).toBeUndefined();
    expect(s.signal?.mode).toBeUndefined();
  });
});

// ─── toSignalTradeState: signal 付与(trade2 追従) ───
describe('toSignalTradeState signal', () => {
  const sig = { signalId: 7, at: 5, direction: 'buy' as const, limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r' };
  it('signal を渡すと SSE state に signal(id+full plan)が入る', () => {
    const st: EngineState = { phase: 'flat' };
    const s = toSignalTradeState(st, 38000, 9, sig);
    expect(s.signal).toEqual({ signalId: 7, direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, at: 5 });
  });
  it('filled でも signal を保持(擬似約定後も追従情報が残る)', () => {
    const st: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 37950, qty: 1, initialStop: 37900, peakProfit: 0, rationale: 'r', at: 7 } };
    const s = toSignalTradeState(st, 38000, 9, sig);
    expect(s.signal?.signalId).toBe(7);
    expect(s.position).toBeDefined();   // 既存 position 表示は不変
  });
  it('signal 未指定なら signal は付かない(既存パネル互換)', () => {
    const st: EngineState = { phase: 'armed', armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 5 } };
    const s = toSignalTradeState(st, 38000, 9);
    expect(s.signal).toBeUndefined();
    expect(s.entry).toBeDefined();   // 既存 entry 表示は不変
  });
});
