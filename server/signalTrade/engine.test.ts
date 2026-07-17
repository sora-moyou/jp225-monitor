import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFill, detectRangeFill, unrealizedPt, detectExit, realizedPnl, equitySeries,
  advance, toSignalTradeState, planToArmed, restingStopOf, armedToCurrentSignal,
  computeHold, inCooldown, buildPlanMeta, buildTradeMetaJson,
  buildSettingsSnapshot, knobSnapshot, realizedLcFromArmed,
  type ArmedBracket, type OpenPosition, type EngineState, type CurrentSignal,
} from './engine.js';
import { resetConfigCache, type KnobDirective } from '../configStore.js';
import type { SignalSettingsSnapshot } from '../types.js';
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
  it('armed は entry を出す(初期LCはレッグ別=指値/逆指値それぞれ露出+単一正規化も後方互換)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', at: 5 },
    };
    const s = toSignalTradeState(st, 38000, 9);
    expect(s.phase).toBe('armed');
    // ★逆指値レッグの LC(stopLossForStop) もパネルへ露出する(旧: initialStop 1本だけで逆指値LCが出なかった)
    expect(s.entry).toMatchObject({
      direction: 'buy', limitEntry: 37950, stopEntry: 38100,
      initialStop: 37900, stopLossForLimit: 37900, stopLossForStop: 38050, at: 5,
    });
    expect(s.position).toBeUndefined();
  });

  it('逆指値のみ計画: 逆指値レッグの LC が出る', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', stopEntry: 38100, stopLossForStop: 38050, rationale: 'r', at: 5 },
    };
    const s = toSignalTradeState(st, 38000, 9);
    expect(s.entry?.stopLossForStop).toBe(38050);
    expect(s.entry?.limitEntry).toBeUndefined();
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

// ─── v0.7.54: AI 自己レジーム/確信度/veto の meta 持ち回り ───
describe('planMeta 持ち回り(regime/confidence/vetoFired → meta)', () => {
  it('buildPlanMeta: 全欠落は undefined・一部でも在れば object', () => {
    expect(buildPlanMeta(undefined, undefined, undefined)).toBeUndefined();
    expect(buildPlanMeta('trend_up', 70, true)).toEqual({ regime: 'trend_up', confidence: 70, vetoFired: true });
    expect(buildPlanMeta(undefined, undefined, false)).toEqual({ vetoFired: false });
    // 非有限 confidence は落とす。
    expect(buildPlanMeta('range', NaN, undefined)).toEqual({ regime: 'range' });
  });

  it('buildTradeMetaJson: ctxV:"rich" は常時・planMeta の各値をマージ', () => {
    expect(JSON.parse(buildTradeMetaJson(undefined))).toEqual({ ctxV: 'rich' });
    expect(JSON.parse(buildTradeMetaJson({ regime: 'trend_down', confidence: 55, vetoFired: true })))
      .toEqual({ ctxV: 'rich', regime: 'trend_down', confidence: 55, vetoFired: true });
  });

  it('planToArmed が plan.regime/confidence と vetoFired を armed.planMeta に載せる', () => {
    const a = planToArmed(
      { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', regime: 'trend_up', confidence: 80 },
      5, { vetoFired: false },
    );
    expect(a?.planMeta).toEqual({ regime: 'trend_up', confidence: 80, vetoFired: false });
  });

  it('planMeta が約定→決済で position/RecordedTrade まで運ばれ meta JSON になる', () => {
    const armed: ArmedBracket = {
      direction: 'buy', limitEntry: 38000, stopLossForLimit: 37960, rationale: 'r', at: 0,
      planMeta: { regime: 'trend_up', confidence: 66, vetoFired: true },
    };
    // 約定(現値が指値到達)。
    const filled = advance({ phase: 'armed', armed }, 38000, 100);
    expect(filled.next.phase).toBe('filled');
    expect(filled.next.position?.planMeta).toEqual({ regime: 'trend_up', confidence: 66, vetoFired: true });
    // 決済(初期LC 37960 に到達)。
    const exited = advance(filled.next, 37960, 200);
    expect(exited.recorded).toBeDefined();
    expect(exited.recorded?.planMeta).toEqual({ regime: 'trend_up', confidence: 66, vetoFired: true });
    expect(JSON.parse(buildTradeMetaJson(exited.recorded?.planMeta)))
      .toEqual({ ctxV: 'rich', regime: 'trend_up', confidence: 66, vetoFired: true });
  });

  it('planMeta 無し(旧世代)でも meta は ctxV:"rich" のみで壊れない', () => {
    const a = planToArmed({ direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r' }, 5);
    expect(a?.planMeta).toBeUndefined();
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

  // ★向きの belt-and-suspenders: 万一 parse/enforce をすり抜けた不正な向きの損切りを紙エンジンが arm しない。
  it('buy で指値SLが entry の上(逆側)→ 指値レッグを arm しない(逆指値が正なら残す)', () => {
    const a = planToArmed(
      { direction: 'buy', limitEntry: 38200, stopLossForLimit: 38260, stopEntry: 38350, stopLossForStop: 38300, rationale: 'r' },
      0,
    );
    expect(a).not.toBeNull();
    expect(a?.limitEntry).toBeUndefined();       // 逆側の損切り→ arm しない
    expect(a?.stopEntry).toBe(38350);            // 正しい向きは残る
  });

  it('buy で両レッグとも逆側の損切り → null(arm する脚なし)', () => {
    const a = planToArmed(
      { direction: 'buy', limitEntry: 38200, stopLossForLimit: 38260, stopEntry: 38350, stopLossForStop: 38400, rationale: 'r' },
      0,
    );
    expect(a).toBeNull();
  });

  it('sell で SLが entry の下(逆側)の脚は arm しない', () => {
    const a = planToArmed(
      { direction: 'sell', limitEntry: 38300, stopLossForLimit: 38250, stopEntry: 38150, stopLossForStop: 38200, rationale: 'r' },
      0,
    );
    expect(a?.limitEntry).toBeUndefined();       // 下=逆側で落ちる
    expect(a?.stopEntry).toBe(38150);            // 上=正で残る
  });

  it('境界(SL==entry=幅0)の脚は arm しない', () => {
    const a = planToArmed(
      { direction: 'buy', limitEntry: 38200, stopLossForLimit: 38200, stopEntry: 38350, stopLossForStop: 38300, rationale: 'r' },
      0,
    );
    expect(a?.limitEntry).toBeUndefined();
    expect(a?.stopEntry).toBe(38350);
  });
});

// ─── planToArmed range 向きガード ───
describe('planToArmed range 向きガード', () => {
  it('range で向き違反レッグ(buy SLが上)は arm しない', () => {
    const a = planToArmed({ direction: 'range', rationale: 'r', range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },   // 正
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38150 },     // 上=逆側
    } }, 0);
    expect(a?.mode).toBe('range');
    expect(a?.range?.lower).toBeUndefined();
    expect(a?.range?.upper?.side).toBe('sell');
  });

  it('range で両レッグ向き違反 → null', () => {
    const a = planToArmed({ direction: 'range', rationale: 'r', range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38350 },   // 下=逆側
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38150 },     // 上=逆側
    } }, 0);
    expect(a).toBeNull();
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

// ─── v0.7.56: 設定スナップショット(委任モード+値)の生成/持ち回り/露出/記録 ───
describe('knobSnapshot(1 knob 分の整形)', () => {
  it('manual は value を載せる', () => {
    const d: KnobDirective<number> = { mode: 'manual', value: 65 };
    expect(knobSnapshot(d)).toEqual({ mode: 'manual', value: 65 });
  });
  it('ai は原則 value 省略(mode のみ)', () => {
    const d: KnobDirective<number> = { mode: 'ai', value: 65 };
    expect(knobSnapshot(d)).toEqual({ mode: 'ai' });
  });
  it('ai + realizedLc を渡すと実測 LC を value に入れる', () => {
    const d: KnobDirective<number> = { mode: 'ai', value: 65 };
    expect(knobSnapshot(d, 120)).toEqual({ mode: 'ai', value: 120 });
  });
  it('manual は realizedLc を渡しても設定値のまま', () => {
    const d: KnobDirective<string> = { mode: 'manual', value: 'long' };
    expect(knobSnapshot(d, 120)).toEqual({ mode: 'manual', value: 'long' });
  });
});

describe('realizedLcFromArmed(採用レッグの実測 LC)', () => {
  it('directional: 指値レッグ優先 |entry−SL|', () => {
    const a: ArmedBracket = { direction: 'buy', limitEntry: 38200, stopLossForLimit: 38130, stopEntry: 38350, stopLossForStop: 38300, rationale: 'x', at: 0 };
    expect(realizedLcFromArmed(a)).toBe(70);
  });
  it('directional: 指値なしは逆指値レッグ', () => {
    const a: ArmedBracket = { direction: 'buy', stopEntry: 38350, stopLossForStop: 38300, rationale: 'x', at: 0 };
    expect(realizedLcFromArmed(a)).toBe(50);
  });
  it('range: upper 優先', () => {
    const a: ArmedBracket = { direction: 'buy', rationale: 'x', at: 0, mode: 'range', range: { upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38460 }, lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } };
    expect(realizedLcFromArmed(a)).toBe(60);
  });
});

describe('buildTradeMetaJson に settings をマージ', () => {
  const settings: SignalSettingsSnapshot = {
    lcFloor: { mode: 'manual', value: 45 }, lcCeiling: { mode: 'ai', value: 120 },
    lcHardMax: { enabled: true, value: 150 },
    trendVeto: { mode: 'manual', value: 100 }, cooldown: { mode: 'manual', value: 90 },
    bias: { mode: 'manual', value: 'none' }, range: { mode: 'manual', value: false },
  };
  it('settings 省略は従来どおり(ctxV のみ)', () => {
    expect(JSON.parse(buildTradeMetaJson())).toEqual({ ctxV: 'rich' });
  });
  it('settings を渡すと meta.settings に入る', () => {
    const m = JSON.parse(buildTradeMetaJson({ regime: 'trend_up', confidence: 70 }, settings));
    expect(m.ctxV).toBe('rich');
    expect(m.regime).toBe('trend_up');
    expect(m.settings.lcCeiling).toEqual({ mode: 'ai', value: 120 });
    expect(m.settings.lcHardMax).toEqual({ enabled: true, value: 150 });
  });
});

describe('advance が settings を armed→position→recorded へ持ち回る', () => {
  const settings: SignalSettingsSnapshot = {
    lcFloor: { mode: 'manual', value: 45 }, lcCeiling: { mode: 'ai', value: 50 },
    lcHardMax: { enabled: true, value: 150 },
    trendVeto: { mode: 'ai' }, cooldown: { mode: 'manual', value: 90 },
    bias: { mode: 'manual', value: 'none' }, range: { mode: 'manual', value: false },
  };
  it('約定で position.settings、決済で recorded.settings に載る', () => {
    const armed: ArmedBracket = { direction: 'buy', limitEntry: 38000, stopLossForLimit: 37950, rationale: 'x', at: 0, settings };
    const st: EngineState = { phase: 'armed', armed };
    const filled = advance(st, 38000, 10);
    expect(filled.next.phase).toBe('filled');
    expect(filled.next.position?.settings).toEqual(settings);
    // 決済(逆指値=37950 に到達)。
    const exited = advance(filled.next, 37950, 20);
    expect(exited.next.phase).toBe('flat');
    expect(exited.recorded?.settings).toEqual(settings);
  });
});

describe('armedToCurrentSignal / toSignalTradeState が settings を露出', () => {
  const settings: SignalSettingsSnapshot = {
    lcFloor: { mode: 'manual', value: 45 }, lcCeiling: { mode: 'manual', value: 65 },
    lcHardMax: { enabled: true, value: 150 },
    trendVeto: { mode: 'manual', value: 100 }, cooldown: { mode: 'manual', value: 90 },
    bias: { mode: 'manual', value: 'none' }, range: { mode: 'manual', value: false },
  };
  it('armedToCurrentSignal は settings を引き継ぐ', () => {
    const armed: ArmedBracket = { direction: 'buy', limitEntry: 38000, stopLossForLimit: 37950, rationale: 'x', at: 1, settings };
    const sig = armedToCurrentSignal(armed, 3);
    expect(sig.settings).toEqual(settings);
  });
  it('toSignalTradeState は s.signal.settings に露出', () => {
    const sig: CurrentSignal = { signalId: 3, at: 1, direction: 'buy', rationale: 'x', limitEntry: 38000, stopLossForLimit: 37950, settings };
    const s = toSignalTradeState({ phase: 'flat' }, 38000, 5, sig);
    expect(s.signal?.settings).toEqual(settings);
  });
  it('settings 無しの signal は s.signal.settings 未付与(既存互換)', () => {
    const sig: CurrentSignal = { signalId: 3, at: 1, direction: 'buy', rationale: 'x', limitEntry: 38000, stopLossForLimit: 37950 };
    const s = toSignalTradeState({ phase: 'flat' }, 38000, 5, sig);
    expect(s.signal?.settings).toBeUndefined();
  });
});

describe('buildSettingsSnapshot(config から実効設定)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-snap-'));
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.HOME = dir; process.env.USERPROFILE = dir;
    resetConfigCache();
  });
  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
    if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
    resetConfigCache();
    rmSync(dir, { recursive: true, force: true });
  });
  function writeConfig(obj: Record<string, unknown>): void {
    mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
    writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(obj), 'utf-8');
    resetConfigCache();
  }

  it('既定は全 knob manual + 既定値 + hardMax(enabled150)', () => {
    const s = buildSettingsSnapshot();
    expect(s.lcFloor).toEqual({ mode: 'manual', value: 45 });
    expect(s.lcCeiling).toEqual({ mode: 'manual', value: 65 });
    expect(s.trendVeto).toEqual({ mode: 'manual', value: 100 });
    expect(s.cooldown).toEqual({ mode: 'manual', value: 90 });
    expect(s.bias).toEqual({ mode: 'manual', value: 'none' });
    expect(s.range).toEqual({ mode: 'manual', value: false });
    expect(s.lcHardMax).toEqual({ enabled: true, value: 150 });
  });
  it('lcCeiling=ai + realizedLc は実測 LC を value に、他は mode のみ', () => {
    writeConfig({ scalpLcCeilingSource: 'ai', scalpTrendVetoSource: 'ai' });
    const s = buildSettingsSnapshot(118);
    expect(s.lcCeiling).toEqual({ mode: 'ai', value: 118 });
    expect(s.lcFloor).toEqual({ mode: 'manual', value: 45 });   // floor は manual → 設定値
    expect(s.trendVeto).toEqual({ mode: 'ai' });                // trendVeto は LC 系でない → value 省略
  });
});
