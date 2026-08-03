import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFill, detectRangeFill, unrealizedPt, detectExit, realizedPnl, equitySeries,
  advance, ARMED_TIMEOUT_MS, toSignalTradeState, planToArmed, restingStopOf, armedToCurrentSignal,
  rangeTpTrigger, RANGE_TP_OFFSET_YEN, LIMIT_FILL_MARGIN_YEN, SLIPPAGE_YEN,
  computeHold, inCooldown, buildPlanMeta, realizedLcFromArmed, checkStaleLegs,
  opposite, reverseToDoten, shouldRequestHeldEval, sameHeldPosition,
  computeAvgFillMs, shouldRangeReeval, bothRangeLegsLimit, sameArmedBracket, sameBracketShape,
  REEVAL_FACTOR, AVG_FILL_SAMPLES, MIN_SAMPLES, DEFAULT_AVG_FILL_MS, REEVAL_CAP_MS,
  type ArmedBracket, type OpenPosition, type EngineState, type CurrentSignal, type RecordedTrade,
  type HeldIdentity, type ArmedIdentity,
} from './decisions.js';
import {
  buildTradeMetaJson, buildSettingsSnapshot, knobSnapshot, buildSignalTradeInsert,
  buildExitStopRecord, type ExitStopTracker,
} from './persist.js';
import type { SignalHold } from './decisions.js';
import type { RangeLeg } from '../llm/openai.js';
import {
  getSignalTradeState, getSignalTradeStateB,
  getCurrentSignal, getSignalHold, getSignalPhase,
  _resetSignalEngine, _resetSignalEngineB,
  SignalEngine, resetSignalEngineIdCounter,
} from './engine.js';
import { openDb, resolveDbPath, setSignalIdCounter, getSignalIdCounter } from '../db/store.js';
import { resetConfigCache, type KnobDirective } from '../configStore.js';
import type { SignalSettingsSnapshot } from '../types.js';
import { _setExitImpl } from './exit/index.js';

afterEach(() => _setExitImpl(null));   // 簡易版(初期LC固定)へ戻す

// ─── detectFill ───
describe('LIMIT_FILL_MARGIN_YEN', () => {
  it('指値の保守約定マージンは 5円(定数駆動・trade2 も概念共有)', () => {
    expect(LIMIT_FILL_MARGIN_YEN).toBe(5);
  });
});

describe('SLIPPAGE_YEN', () => {
  it('成行スリッページは 1tick=5円(trade2 の slippageTicks*TICK と一致)', () => {
    expect(SLIPPAGE_YEN).toBe(5);
  });
});

describe('detectFill', () => {
  const buy: ArmedBracket = {
    direction: 'buy', limitEntry: 37950, stopEntry: 38100,
    stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'x', at: 0,
  };
  it('buy 指値: 指値ちょうど/4円手前では不約定・5円下抜けで約定(建値は指値のまま)', () => {
    expect(detectFill(buy, 37950)).toBeNull();   // ★タッチのみ=不約定(保守モデル)
    expect(detectFill(buy, 37946)).toBeNull();   // ★4円手前=不約定
    expect(detectFill(buy, 37945)).toEqual({ leg: 'limit', entryPrice: 37950, initialStop: 37900 });   // 5円下=約定
    expect(detectFill(buy, 37800)).toEqual({ leg: 'limit', entryPrice: 37950, initialStop: 37900 });
  });
  it('buy 逆指値: 現値が逆指値以上へ上昇でタッチ約定・建値は成行スリップで+5円', () => {
    // トリガはタッチ(≥38100)のまま。成行約定なので記録建値は不利方向 +5円(38105)。
    expect(detectFill(buy, 38100)).toEqual({ leg: 'stop', entryPrice: 38105, initialStop: 38050 });
  });
  it('両entryの間では未約定', () => {
    expect(detectFill(buy, 38000)).toBeNull();
  });
  it('両レッグが同時に満たす場合は指値優先', () => {
    const both: ArmedBracket = { direction: 'buy', limitEntry: 38000, stopEntry: 37000, stopLossForLimit: 37950, stopLossForStop: 36950, rationale: 'x', at: 0 };
    expect(detectFill(both, 37500)?.leg).toBe('limit');
  });
  it('sell 指値は指値5円上抜けで約定(タッチ/4円手前は不約定)・逆指値は下落タッチで約定', () => {
    const sell: ArmedBracket = { direction: 'sell', limitEntry: 38100, stopEntry: 37900, stopLossForLimit: 38150, stopLossForStop: 37850, rationale: 'x', at: 0 };
    expect(detectFill(sell, 38100)).toBeNull();          // ★タッチのみ=不約定
    expect(detectFill(sell, 38104)).toBeNull();          // ★4円手前=不約定
    expect(detectFill(sell, 38105)).toEqual({ leg: 'limit', entryPrice: 38100, initialStop: 38150 });  // 5円上=約定・指値は建値ちょうど(スリップ無し)
    expect(detectFill(sell, 37900)).toEqual({ leg: 'stop', entryPrice: 37895, initialStop: 37850 });   // 逆指値はタッチ約定・建値は成行スリップで−5円
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
    const { next } = advance(st, 37945, 1000);   // ★指値37950を5円下抜けで約定(建値は指値37950のまま)
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

  it('armed が ARMED_TIMEOUT_MS 超で未約定 → 取消して flat(armedTimedOut・記録なし)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1000 },
    };
    // タイムアウト直前(未達): 価格が指値37950に未達(38000) → 据え置き。
    const under = advance(st, 38000, 1000 + ARMED_TIMEOUT_MS - 1);
    expect(under.next.phase).toBe('armed');
    expect(under.armedTimedOut).toBeUndefined();
    // タイムアウト到達: 未約定のまま時間切れ → 取消して flat(次計画へ)。決済記録は出さない。
    const over = advance(st, 38000, 1000 + ARMED_TIMEOUT_MS);
    expect(over.next.phase).toBe('flat');
    expect(over.armedTimedOut).toBe(true);
    expect(over.recorded).toBeUndefined();
    expect(over.next.lastExit).toBeUndefined();   // キャンセルは決済ではない(lastExit を作らない)。
  });

  it('range armed も ARMED_TIMEOUT_MS 超で取消→flat', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: {
        direction: 'buy', rationale: 'r', at: 0, mode: 'range',
        range: { upper: { side: 'sell', type: 'limit', entry: 66000, stopLoss: 66050 }, lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64950 } },
      },
    };
    const over = advance(st, 65500, ARMED_TIMEOUT_MS);   // 65500 は上下どちらの entry にも未達。
    expect(over.next.phase).toBe('flat');
    expect(over.armedTimedOut).toBe(true);
  });

  it('filled → 逆指値ヒットで flat + 決済記録(簡易=初期LC固定)', () => {
    const st: EngineState = {
      phase: 'filled',
      position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500 },
    };
    const { next, recorded } = advance(st, 37950, 2000);
    expect(next.phase).toBe('flat');
    // 逆指値トリガ=37950 だが成行決済で不利−5円=37945 で約定・pnl=37945−38000=−55(ロング決済スリップ)。
    expect(next.lastExit).toEqual({ exitPrice: 37945, pnl: -55, at: 2000 });
    // ★記録専用(決済パラメータ分析用): 決済記録に必須3点(理由/約定レッグ初期LC/含み益ピーク)が加わった。
    //   決済の判断・価格・タイミング(exitPrice/pnl/exitT)は上と同じで一切変わっていない。
    expect(recorded).toEqual({
      entryT: 500, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 37945, pnl: -55, qty: 1, rationale: 'r',
      exitReason: 'initial_stop', exitInitialStop: 37950, peakProfit: 0,
    });
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
    // 床=建値+30(38030)だが成行決済で不利−5円=38025 約定・pnl=38025−38000=25。
    expect(recorded?.pnl).toBe(25);
    expect(recorded?.exitPrice).toBe(38025);
  });

  it('一巡: flat の armed→fill→exit を通しで回す', () => {
    let st: EngineState = {
      phase: 'armed',
      armed: { direction: 'sell', limitEntry: 38100, stopLossForLimit: 38150, rationale: 'r', at: 0 },
    };
    st = advance(st, 38105, 1).next;   // sell 指値38100を5円上抜けで約定(建値=38100・指値スリップ無し)
    expect(st.phase).toBe('filled');
    const r = advance(st, 38150, 2);   // 初期LC(38150)ヒット
    expect(r.next.phase).toBe('flat');
    // ショート決済は成行で不利+5円=38155 約定・pnl=38100−38155=−55。
    expect(r.recorded?.pnl).toBe(-55);
    expect(r.recorded?.exitPrice).toBe(38155);
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
    // 約定(現値が指値を5円下抜け)。
    const filled = advance({ phase: 'armed', armed }, 37995, 100);
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
  it('上レッグ(逆張り指値): entry ちょうど/4円手前は不約定・5円上抜けで約定', () => {
    expect(detectRangeFill(armed, 38400)).toBeNull();   // ★タッチのみ=不約定
    expect(detectRangeFill(armed, 38404)).toBeNull();   // ★4円手前=不約定
    expect(detectRangeFill(armed, 38405)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });   // 5円上=約定(建値は据置)
    expect(detectRangeFill(armed, 38500)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
  });
  it('下レッグ(逆張り指値): entry ちょうど/4円手前は不約定・5円下抜けで約定', () => {
    expect(detectRangeFill(armed, 38100)).toBeNull();   // ★タッチのみ=不約定
    expect(detectRangeFill(armed, 38096)).toBeNull();   // ★4円手前=不約定
    expect(detectRangeFill(armed, 38095)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });   // 5円下=約定
    expect(detectRangeFill(armed, 38000)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
  });
  it('上下の間(未到達)は null', () => {
    expect(detectRangeFill(armed, 38250)).toBeNull();
  });
  it('片面 range(下レッグのみ)は上抜けでは約定しない', () => {
    const only: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range',
      range: { lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } };
    expect(detectRangeFill(only, 39000)).toBeNull();
    expect(detectRangeFill(only, 38100)).toBeNull();          // ★タッチのみ=不約定
    expect(detectRangeFill(only, 38095)?.side).toBe('buy');   // 5円下=約定
  });
  it('type=stop(breakout)レッグは約定建値が成行スリップ: 上=買い逆指値+5 / 下=売り逆指値−5(fade指値はスリップ無し)', () => {
    const bo: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range',
      range: {
        upper: { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 },
        lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 },
      } };
    // 上=買い逆指値(breakout上抜け): トリガ38400(タッチ)、成行建値は不利+5=38405。
    expect(detectRangeFill(bo, 38405)).toEqual({ side: 'buy', entryPrice: 38405, initialStop: 38350 });
    // 下=売り逆指値(breakout下抜け): トリガ38100(タッチ)、成行建値は不利−5=38095。
    expect(detectRangeFill(bo, 38095)).toEqual({ side: 'sell', entryPrice: 38095, initialStop: 38150 });
  });
});

// ★レンジ両面の約定条件はレッグ type で分岐する(指値=5円行き過ぎ / 逆指値=タッチ)。
//   旧実装は両レッグ一律に LIMIT_FILL_MARGIN_YEN を課していた(=stop レッグが 1tick 遅い)。
//   実弾(trade2)の逆指値はタッチで発火して成行になるため、紙が待つと
//   「タッチして反転した回=実弾は建玉あり・紙は建玉なし」の台帳食い違いになる。
describe('detectRangeFill: レッグ type 別の約定条件(境界値)', () => {
  const mk = (upper?: RangeLeg, lower?: RangeLeg): ArmedBracket =>
    ({ direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper, lower } });
  const UP_STOP: RangeLeg = { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 };
  const LO_STOP: RangeLeg = { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 };
  const UP_LIMIT: RangeLeg = { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 };
  const LO_LIMIT: RangeLeg = { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 };

  it('上レッグ type=stop: entry−1 は不約定・entry(タッチ)で約定・entry+1 も約定', () => {
    const a = mk(UP_STOP, LO_STOP);
    expect(detectRangeFill(a, 38399)).toBeNull();
    expect(detectRangeFill(a, 38400)).toEqual({ side: 'buy', entryPrice: 38405, initialStop: 38350 });   // ★旧実装は null
    expect(detectRangeFill(a, 38401)).toEqual({ side: 'buy', entryPrice: 38405, initialStop: 38350 });   // ★旧実装は null
  });
  it('下レッグ type=stop: entry+1 は不約定・entry(タッチ)で約定・entry−1 も約定', () => {
    const a = mk(UP_STOP, LO_STOP);
    expect(detectRangeFill(a, 38101)).toBeNull();
    expect(detectRangeFill(a, 38100)).toEqual({ side: 'sell', entryPrice: 38095, initialStop: 38150 });  // ★旧実装は null
    expect(detectRangeFill(a, 38099)).toEqual({ side: 'sell', entryPrice: 38095, initialStop: 38150 });  // ★旧実装は null
  });
  it('上レッグ type=limit: entry+4 は不約定・entry+5 で約定・entry+6 も約定(従来どおり)', () => {
    const a = mk(UP_LIMIT, LO_LIMIT);
    expect(detectRangeFill(a, 38404)).toBeNull();
    expect(detectRangeFill(a, 38405)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
    expect(detectRangeFill(a, 38406)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
  });
  it('下レッグ type=limit: entry−4 は不約定・entry−5 で約定・entry−6 も約定(従来どおり)', () => {
    const a = mk(UP_LIMIT, LO_LIMIT);
    expect(detectRangeFill(a, 38096)).toBeNull();
    expect(detectRangeFill(a, 38095)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
    expect(detectRangeFill(a, 38094)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
  });
  it('混在(上=stop / 下=limit): 上はタッチ約定・下は5円行き過ぎで約定', () => {
    const a = mk(UP_STOP, LO_LIMIT);
    expect(detectRangeFill(a, 38400)).toEqual({ side: 'buy', entryPrice: 38405, initialStop: 38350 });   // タッチ
    expect(detectRangeFill(a, 38100)).toBeNull();          // 下は limit=タッチのみでは不約定
    expect(detectRangeFill(a, 38096)).toBeNull();
    expect(detectRangeFill(a, 38095)).toEqual({ side: 'buy', entryPrice: 38100, initialStop: 38050 });
  });
  it('混在(上=limit / 下=stop): 上は5円行き過ぎ・下はタッチ約定', () => {
    const a = mk(UP_LIMIT, LO_STOP);
    expect(detectRangeFill(a, 38400)).toBeNull();          // 上は limit=タッチのみでは不約定
    expect(detectRangeFill(a, 38404)).toBeNull();
    expect(detectRangeFill(a, 38405)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
    expect(detectRangeFill(a, 38100)).toEqual({ side: 'sell', entryPrice: 38095, initialStop: 38150 });  // タッチ
  });
  it('type 欠落レッグは limit 扱い(現状の規約を維持)= タッチでは不約定・5円行き過ぎで約定', () => {
    // parse を通れば type は必ず在るが、型を落とした経路でも保守側(limit)に倒れることを固定する。
    const noType = { side: 'sell', entry: 38400, stopLoss: 38450 } as unknown as RangeLeg;
    const a = mk(noType, undefined);
    expect(detectRangeFill(a, 38400)).toBeNull();
    expect(detectRangeFill(a, 38404)).toBeNull();
    expect(detectRangeFill(a, 38405)).toEqual({ side: 'sell', entryPrice: 38400, initialStop: 38450 });
  });
  it('片面 range(下レッグのみ stop)はタッチで約定・上抜けでは約定しない', () => {
    const a = mk(undefined, LO_STOP);
    expect(detectRangeFill(a, 39000)).toBeNull();
    expect(detectRangeFill(a, 38100)).toEqual({ side: 'sell', entryPrice: 38095, initialStop: 38150 });
  });
});

// ★単方向ブラケット(detectFill)は無変更。網羅コーパスで「指値=5円行き過ぎ / 逆指値=タッチ」を再確認する
//   (decisions.ts の変更が directional 経路へ漏れていないことの検査)。
describe('detectFill: 単方向は仕様不変(網羅コーパス)', () => {
  it('buy/sell × 全価格グリッドで 指値=entry±5 到達・逆指値=タッチ の境界が保たれる', () => {
    const LIMIT = 38000, STOP = 38200;
    for (const dir of ['buy', 'sell'] as const) {
      // buy: 指値38000(下)/逆指値38200(上) — sell は上下を入れ替える。
      const limitEntry = dir === 'buy' ? LIMIT : STOP;
      const stopEntry = dir === 'buy' ? STOP : LIMIT;
      const a: ArmedBracket = {
        direction: dir, limitEntry, stopEntry,
        stopLossForLimit: dir === 'buy' ? limitEntry - 50 : limitEntry + 50,
        stopLossForStop: dir === 'buy' ? stopEntry - 50 : stopEntry + 50,
        rationale: 'x', at: 0,
      };
      for (let price = LIMIT - 20; price <= STOP + 20; price += 1) {
        const limitHit = dir === 'buy' ? price <= limitEntry - 5 : price >= limitEntry + 5;
        const stopHit = dir === 'buy' ? price >= stopEntry : price <= stopEntry;
        const got = detectFill(a, price);
        if (limitHit) expect({ dir, price, leg: got?.leg }).toEqual({ dir, price, leg: 'limit' });         // 同 tick 同時成立は指値優先
        else if (stopHit) expect({ dir, price, leg: got?.leg }).toEqual({ dir, price, leg: 'stop' });
        else expect({ dir, price, got }).toEqual({ dir, price, got: null });
      }
    }
  });
});

// ★通過済みレッグの veto(stale plan veto)。画像生成+LLM 応答の数秒〜十数秒で価格が動くため、
//   plan.refPrice(チャート撮影時の価格)には妥当でも ARM 時点の live 価格では既にエントリーを通過している
//   計画が届く。それを武装すると次tickで即約定し、現実には執行できない取引が紙の成績に混ざる。
//   判定は detectFill / detectRangeFill の再利用=約定条件と完全に同一規約(指値=5円行き過ぎ / 逆指値=タッチ)。
describe('checkStaleLegs(通過済みレッグを武装しない・境界値)', () => {
  // buy: 指値61900(下・LC61850)/ 逆指値62000(上・LC61950)。
  const buyOco = (): ArmedBracket => ({
    direction: 'buy', limitEntry: 61900, stopEntry: 62000,
    stopLossForLimit: 61850, stopLossForStop: 61950, rationale: 'r', at: 0,
  });
  // sell: 指値62000(上・LC62050)/ 逆指値61900(下・LC61850)。
  const sellOco = (): ArmedBracket => ({
    direction: 'sell', limitEntry: 62000, stopEntry: 61900,
    stopLossForLimit: 62050, stopLossForStop: 61850, rationale: 'r', at: 0,
  });
  const range = (upper: RangeLeg, lower: RangeLeg): ArmedBracket =>
    ({ direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper, lower } });
  const FADE_UP: RangeLeg = { side: 'sell', type: 'limit', entry: 62000, stopLoss: 62050 };
  const FADE_LO: RangeLeg = { side: 'buy', type: 'limit', entry: 61900, stopLoss: 61850 };
  const BREAK_UP: RangeLeg = { side: 'buy', type: 'stop', entry: 62000, stopLoss: 61950 };
  const BREAK_LO: RangeLeg = { side: 'sell', type: 'stop', entry: 61900, stopLoss: 61950 };

  it('live 価格が取れない(null/undefined/NaN)→ 判定せず従来どおり ARM(同一参照・legs 空)', () => {
    const a = buyOco();
    for (const live of [null, undefined, NaN, Infinity]) {
      const r = checkStaleLegs(a, live);
      expect(r.armed).toBe(a);       // ★同一参照=挙動 byte 不変(新しい抑止で取引を止めない)
      expect(r.legs).toEqual([]);
    }
  });

  it('buy 指値(61900): あと1円(61896)は武装・ちょうど(61895)は落とす・1円超過(61894)も落とす', () => {
    expect(checkStaleLegs(buyOco(), 61896).legs).toEqual([
      { name: 'limit', entry: 61900, stale: false }, { name: 'stop', entry: 62000, stale: false },
    ]);
    for (const live of [61895, 61894]) {
      const r = checkStaleLegs(buyOco(), live);
      expect(r.legs).toEqual([
        { name: 'limit', entry: 61900, stale: true }, { name: 'stop', entry: 62000, stale: false },
      ]);
      expect(r.armed).toMatchObject({ direction: 'buy', stopEntry: 62000, stopLossForStop: 61950 });
      expect(r.armed?.limitEntry).toBeUndefined();          // 通過済みの指値レッグだけ落ちる
      expect(r.armed?.stopLossForLimit).toBeUndefined();
    }
  });

  it('buy 逆指値(62000): あと1円(61999)は武装・タッチ(62000)は落とす・1円超過(62001)も落とす', () => {
    expect(checkStaleLegs(buyOco(), 61999).armed).toEqual(buyOco());
    for (const live of [62000, 62001]) {
      const r = checkStaleLegs(buyOco(), live);
      expect(r.legs).toEqual([
        { name: 'limit', entry: 61900, stale: false }, { name: 'stop', entry: 62000, stale: true },
      ]);
      expect(r.armed).toMatchObject({ direction: 'buy', limitEntry: 61900, stopLossForLimit: 61850 });
      expect(r.armed?.stopEntry).toBeUndefined();
      expect(r.armed?.stopLossForStop).toBeUndefined();
    }
  });

  it('sell 指値(62000): あと1円(62004)は武装・ちょうど(62005)は落とす・1円超過(62006)も落とす', () => {
    expect(checkStaleLegs(sellOco(), 62004).armed).toEqual(sellOco());
    for (const live of [62005, 62006]) {
      const r = checkStaleLegs(sellOco(), live);
      expect(r.legs).toEqual([
        { name: 'limit', entry: 62000, stale: true }, { name: 'stop', entry: 61900, stale: false },
      ]);
      expect(r.armed?.limitEntry).toBeUndefined();
      expect(r.armed).toMatchObject({ stopEntry: 61900, stopLossForStop: 61850 });
    }
  });

  it('sell 逆指値(61900): あと1円(61901)は武装・タッチ(61900)は落とす・1円超過(61899)も落とす', () => {
    expect(checkStaleLegs(sellOco(), 61901).armed).toEqual(sellOco());
    for (const live of [61900, 61899]) {
      const r = checkStaleLegs(sellOco(), live);
      expect(r.legs).toEqual([
        { name: 'limit', entry: 62000, stale: false }, { name: 'stop', entry: 61900, stale: true },
      ]);
      expect(r.armed?.stopEntry).toBeUndefined();
      expect(r.armed).toMatchObject({ limitEntry: 62000, stopLossForLimit: 62050 });
    }
  });

  it('range 指値ストラドル(fade): 上=62005 / 下=61895 で落とす(1円手前は武装)', () => {
    expect(checkStaleLegs(range(FADE_UP, FADE_LO), 62004).legs.every(l => !l.stale)).toBe(true);
    expect(checkStaleLegs(range(FADE_UP, FADE_LO), 61896).legs.every(l => !l.stale)).toBe(true);
    for (const live of [62005, 62006]) {
      const r = checkStaleLegs(range(FADE_UP, FADE_LO), live);
      expect(r.legs).toEqual([
        { name: 'upper', entry: 62000, stale: true }, { name: 'lower', entry: 61900, stale: false },
      ]);
      expect(r.armed?.mode).toBe('range');
      expect(r.armed?.range).toEqual({ lower: FADE_LO });   // 通過済みの上レッグだけ落ちる(片面 range で継続)
    }
    for (const live of [61895, 61894]) {
      const r = checkStaleLegs(range(FADE_UP, FADE_LO), live);
      expect(r.legs).toEqual([
        { name: 'upper', entry: 62000, stale: false }, { name: 'lower', entry: 61900, stale: true },
      ]);
      expect(r.armed?.range).toEqual({ upper: FADE_UP });
    }
  });

  it('range 逆指値ストラドル(breakout): 上=タッチ62000 / 下=タッチ61900 で落とす(1円手前は武装)', () => {
    expect(checkStaleLegs(range(BREAK_UP, BREAK_LO), 61999).armed?.range).toEqual({ upper: BREAK_UP, lower: BREAK_LO });
    expect(checkStaleLegs(range(BREAK_UP, BREAK_LO), 61901).armed?.range).toEqual({ upper: BREAK_UP, lower: BREAK_LO });
    for (const live of [62000, 62001]) {
      const r = checkStaleLegs(range(BREAK_UP, BREAK_LO), live);
      expect(r.legs).toEqual([
        { name: 'upper', entry: 62000, stale: true }, { name: 'lower', entry: 61900, stale: false },
      ]);
      expect(r.armed?.range).toEqual({ lower: BREAK_LO });
    }
    for (const live of [61900, 61899]) {
      const r = checkStaleLegs(range(BREAK_UP, BREAK_LO), live);
      expect(r.legs).toEqual([
        { name: 'upper', entry: 62000, stale: false }, { name: 'lower', entry: 61900, stale: true },
      ]);
      expect(r.armed?.range).toEqual({ upper: BREAK_UP });
    }
  });

  it('片レッグしか無いブラケットが通過済み → armed=null(=ARM しない=見送り)', () => {
    const limitOnlyBuy: ArmedBracket = { direction: 'buy', limitEntry: 61900, stopLossForLimit: 61850, rationale: 'r', at: 0 };
    expect(checkStaleLegs(limitOnlyBuy, 61896).armed).toBe(limitOnlyBuy);
    expect(checkStaleLegs(limitOnlyBuy, 61895).armed).toBeNull();
    const stopOnlyBuy: ArmedBracket = { direction: 'buy', stopEntry: 62000, stopLossForStop: 61950, rationale: 'r', at: 0 };
    expect(checkStaleLegs(stopOnlyBuy, 61999).armed).toBe(stopOnlyBuy);
    expect(checkStaleLegs(stopOnlyBuy, 62000).armed).toBeNull();
    const limitOnlySell: ArmedBracket = { direction: 'sell', limitEntry: 62000, stopLossForLimit: 62050, rationale: 'r', at: 0 };
    expect(checkStaleLegs(limitOnlySell, 62004).armed).toBe(limitOnlySell);
    expect(checkStaleLegs(limitOnlySell, 62005).armed).toBeNull();
    const stopOnlySell: ArmedBracket = { direction: 'sell', stopEntry: 61900, stopLossForStop: 61850, rationale: 'r', at: 0 };
    expect(checkStaleLegs(stopOnlySell, 61901).armed).toBe(stopOnlySell);
    expect(checkStaleLegs(stopOnlySell, 61900).armed).toBeNull();
    // 片面 range(下レッグのみ)も同様。
    const lowerOnly: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { lower: FADE_LO } };
    expect(checkStaleLegs(lowerOnly, 61896).armed).toBe(lowerOnly);
    expect(checkStaleLegs(lowerOnly, 61895).armed).toBeNull();
  });

  it('落とすレッグが無ければ引数と同一参照を返す(=挙動 byte 不変)', () => {
    const a = buyOco();
    expect(checkStaleLegs(a, 61950).armed).toBe(a);
    const r = range(FADE_UP, FADE_LO);
    expect(checkStaleLegs(r, 61950).armed).toBe(r);
  });

  it('レッグを落としても付帯情報(planMeta/settings/doten/mode/rationale/at)は保つ', () => {
    const a: ArmedBracket = {
      ...buyOco(), planMeta: { regime: 'range', confidence: 0.7 },
      settings: { lc: { mode: 'manual' } } as unknown as ArmedBracket['settings'], doten: true,
    };
    const r = checkStaleLegs(a, 61895);
    expect(r.armed).toMatchObject({
      direction: 'buy', rationale: 'r', at: 0, doten: true,
      planMeta: { regime: 'range', confidence: 0.7 },
    });
    expect(r.armed?.settings).toBe(a.settings);
    const rg = checkStaleLegs({ ...range(FADE_UP, FADE_LO), planMeta: { confidence: 0.4 } }, 62005);
    expect(rg.armed).toMatchObject({ mode: 'range', planMeta: { confidence: 0.4 } });
  });

  it('type 欠落の range レッグは limit 扱い(=約定判定と同一規約): タッチでは落とさない', () => {
    const noType = { side: 'sell', entry: 62000, stopLoss: 62050 } as unknown as RangeLeg;
    const a: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper: noType } };
    expect(checkStaleLegs(a, 62000).armed).toBe(a);
    expect(checkStaleLegs(a, 62004).armed).toBe(a);
    expect(checkStaleLegs(a, 62005).armed).toBeNull();
  });

  it('約定判定(detectFill/detectRangeFill)と 1円刻みで完全一致する(規約の二重定義が無いことの検査)', () => {
    const cases: ArmedBracket[] = [buyOco(), sellOco(), range(FADE_UP, FADE_LO), range(BREAK_UP, BREAK_LO)];
    for (const a of cases) {
      for (let live = 61850; live <= 62050; live += 1) {
        const isRange = a.mode === 'range';
        const filled = isRange ? detectRangeFill(a, live) != null : detectFill(a, live) != null;
        const r = checkStaleLegs(a, live);
        // 「どれか1レッグでも即約定する」=「stale レッグが在る」と同値(=同じ規約を共有している)。
        expect({ live, any: r.legs.some(l => l.stale) }).toEqual({ live, any: filled });
      }
    }
  });
});

// ★不変条件の再証明(境界グリッド + fuzz)。stale plan veto が満たすべき性質を、約定判定(detectFill /
//   detectRangeFill)を唯一の基準として全数検査する:
//     I1 ゲート後のブラケットは live で即約定しない(=通過済みレッグが残らない)
//     I2 誤抑止=0(live で約定しないレッグは絶対に落とさない)
//     I3 抑止漏れ=0(live で約定するレッグは必ず落とす)
//     + 引数(ArmedBracket)を破壊しない / legs[] の stale フラグが約定判定と一致する
//   ★レッグ単独の約定可否で判定するので「同tick両成立は指値優先」という detectFill の規約に依存しない
//     (=レッグごとの独立判定であることも同時に検査している)。
describe('checkStaleLegs 不変条件の再証明(境界グリッド + fuzz)', () => {
  const isRange = (a: ArmedBracket): boolean => a.mode === 'range' || a.range != null;
  /** そのブラケットが live で(どれかのレッグで)即約定するか=約定判定そのもの。 */
  const fills = (a: ArmedBracket, live: number): boolean =>
    isRange(a) ? detectRangeFill(a, live) != null : detectFill(a, live) != null;
  type LegName = 'limit' | 'stop' | 'upper' | 'lower';
  /** ブラケットに在るレッグ名。 */
  const presentLegs = (a: ArmedBracket): LegName[] => {
    if (isRange(a)) {
      const n: LegName[] = [];
      if (a.range?.upper) n.push('upper');
      if (a.range?.lower) n.push('lower');
      return n;
    }
    const n: LegName[] = [];
    if (a.limitEntry != null && a.stopLossForLimit != null) n.push('limit');
    if (a.stopEntry != null && a.stopLossForStop != null) n.push('stop');
    return n;
  };
  /** そのレッグだけを残したブラケット(レッグ単独の約定可否を約定判定に問うため)。 */
  const single = (a: ArmedBracket, leg: LegName): ArmedBracket => {
    if (leg === 'upper') return { ...a, range: { upper: a.range?.upper } };
    if (leg === 'lower') return { ...a, range: { lower: a.range?.lower } };
    if (leg === 'limit') return { ...a, stopEntry: undefined, stopLossForStop: undefined };
    return { ...a, limitEntry: undefined, stopLossForLimit: undefined };
  };
  /** 1ケース検査して違反文言を返す(空配列=不変条件を満たす)。expect は最後に1回だけ叩く(高速化)。 */
  const check = (a: ArmedBracket, live: number): string[] => {
    const snapshot = JSON.stringify(a);
    const r = checkStaleLegs(a, live);
    const v: string[] = [];
    if (JSON.stringify(a) !== snapshot) v.push('引数破壊');
    const names = presentLegs(a);
    const kept = r.armed ? presentLegs(r.armed) : [];
    for (const n of names) {
      const would = fills(single(a, n), live);
      const rep = r.legs.find(l => l.name === n);
      if (!rep) v.push(`legs[] に ${n} が無い`);
      else if (rep.stale !== would) v.push(`stale フラグ不一致 ${n}(報告=${rep.stale} 約定判定=${would})`);
      if (would && kept.includes(n)) v.push(`I3 抑止漏れ: 即約定する ${n} が残った`);
      if (!would && !kept.includes(n)) v.push(`I2 誤抑止: 未到達の ${n} を落とした`);
    }
    if (r.legs.length !== names.length) v.push(`legs[] 件数不一致(${r.legs.length}≠${names.length})`);
    if (r.armed && fills(r.armed, live)) v.push('I1 違反: ゲート後のブラケットが live で即約定する');
    if (!r.armed && !names.every(n => fills(single(a, n), live))) v.push('null 化したが未到達レッグが在った');
    return v.map(x => `${x} @live=${live} bracket=${snapshot}`);
  };
  const mkDir = (dir: 'buy' | 'sell', limit?: number, stop?: number): ArmedBracket => {
    const a: ArmedBracket = { direction: dir, rationale: 'r', at: 0 };
    if (limit != null) { a.limitEntry = limit; a.stopLossForLimit = dir === 'buy' ? limit - 50 : limit + 50; }
    if (stop != null) { a.stopEntry = stop; a.stopLossForStop = dir === 'buy' ? stop - 50 : stop + 50; }
    return a;
  };
  const mkRange = (upper?: RangeLeg, lower?: RangeLeg): ArmedBracket =>
    ({ direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper, lower } });
  const L = 61900, U = 62100;   // 下側レッグ / 上側レッグの基準価格
  const UP_LIM: RangeLeg = { side: 'sell', type: 'limit', entry: U, stopLoss: U + 50 };
  const LO_LIM: RangeLeg = { side: 'buy', type: 'limit', entry: L, stopLoss: L - 50 };
  const UP_STP: RangeLeg = { side: 'buy', type: 'stop', entry: U, stopLoss: U - 50 };
  const LO_STP: RangeLeg = { side: 'sell', type: 'stop', entry: L, stopLoss: L + 50 };
  const NO_TYPE = { side: 'sell', entry: U, stopLoss: U + 50 } as unknown as RangeLeg;   // type 欠落(limit 扱い)
  const BRACKETS: ArmedBracket[] = [
    mkDir('buy', L, U), mkDir('sell', U, L),                 // OCO(両レッグ)
    mkDir('buy', L), mkDir('buy', undefined, U),             // 片レッグ(指値のみ / 逆指値のみ)
    mkDir('sell', U), mkDir('sell', undefined, L),
    mkRange(UP_LIM, LO_LIM), mkRange(UP_STP, LO_STP),        // fade / breakout ストラドル
    mkRange(UP_STP, LO_LIM), mkRange(UP_LIM, LO_STP),        // 混在
    mkRange(UP_LIM, undefined), mkRange(undefined, LO_STP),  // 片面 range
    mkRange(NO_TYPE, LO_LIM),                                // type 欠落
  ];
  const OFFSETS = [-6, -5, -4, -1, 0, 1, 4, 5, 6];           // ★境界(±0/±4/±5/±6)を必ず踏む

  it('境界グリッド(各レッグ ±0/±4/±5/±6 + 1円刻み全掃引)で I1/I2/I3・引数不変を満たす', () => {
    const violations: string[] = [];
    let cases = 0;
    for (const a of BRACKETS) {
      const entries = presentLegs(a).map(n => (n === 'limit' ? a.limitEntry : n === 'stop' ? a.stopEntry
        : n === 'upper' ? a.range?.upper?.entry : a.range?.lower?.entry) as number);
      const prices = new Set<number>();
      for (const e of entries) for (const o of OFFSETS) prices.add(e + o);
      for (let p = Math.min(...entries) - 40; p <= Math.max(...entries) + 40; p += 1) prices.add(p);
      for (const p of prices) { violations.push(...check(a, p)); cases++; }
    }
    expect(violations.slice(0, 5)).toEqual([]);
    expect(cases).toBeGreaterThan(2000);
  });

  it('fuzz(乱択ブラケット × 乱択 live・境界に寄せた分布)で I1/I2/I3・引数不変を満たす', () => {
    let seed = 20260730;   // 決定的 LCG(再現可能)
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const tick = (x: number): number => Math.round(x / 5) * 5;   // N225 の 5円刻み
    const violations: string[] = [];
    const N = 200_000;
    for (let i = 0; i < N; i++) {
      const base = tick(60_000 + rnd() * 4_000);
      const d1 = tick(5 + rnd() * 200), d2 = tick(5 + rnd() * 200);
      const kind = pick(['dir', 'dir', 'range', 'range'] as const);
      let a: ArmedBracket;
      if (kind === 'dir') {
        const dir = pick(['buy', 'sell'] as const);
        const lo = base - d1, hi = base + d2;
        const limit = dir === 'buy' ? lo : hi, stop = dir === 'buy' ? hi : lo;
        const legs = pick(['both', 'limit', 'stop'] as const);
        a = mkDir(dir, legs === 'stop' ? undefined : limit, legs === 'limit' ? undefined : stop);
      } else {
        const mkLeg = (entry: number, side: 'buy' | 'sell'): RangeLeg => {
          const type = pick(['limit', 'stop', undefined] as const);
          const stopLoss = side === 'buy' ? entry - 50 : entry + 50;
          return (type === undefined ? { side, entry, stopLoss } : { side, type, entry, stopLoss }) as RangeLeg;
        };
        const upper = mkLeg(base + d2, pick(['buy', 'sell'] as const));
        const lower = mkLeg(base - d1, pick(['buy', 'sell'] as const));
        const legs = pick(['both', 'upper', 'lower'] as const);
        a = mkRange(legs === 'lower' ? undefined : upper, legs === 'upper' ? undefined : lower);
      }
      // live は 6割を「いずれかのレッグの境界近傍(±6)」に寄せる(境界の踏破率を上げる)。
      const entries = presentLegs(a).map(n => (n === 'limit' ? a.limitEntry : n === 'stop' ? a.stopEntry
        : n === 'upper' ? a.range?.upper?.entry : a.range?.lower?.entry) as number);
      const live = rnd() < 0.6
        ? pick(entries) + pick([-6, -5, -4, -1, 0, 1, 4, 5, 6] as const)
        : tick(base - 250 + rnd() * 500);
      violations.push(...check(a, live));
      if (violations.length > 0) break;   // 最初の反例で止める(全件列挙は不要)
    }
    expect(violations).toEqual([]);
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
    const { next } = advance(st, 38095, 1000);   // ★下レッグ指値38100を5円下抜けで約定(建値は38100のまま)
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
    const { next } = advance(st, 38405, 1);   // ★上レッグ指値38400を5円上抜けで約定
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
    st = advance(st, 38095, 1).next;   // buy 約定(指値38100を5円下抜け)
    expect(st.phase).toBe('filled');
    const r = advance(st, 38050, 2);   // 初期LC(38050)ヒット
    expect(r.next.phase).toBe('flat');
    // 建値38100(fade指値=スリップ無し)・LC=38050 だが成行決済で−5円=38045・pnl=38045−38100=−55。
    expect(r.recorded?.pnl).toBe(-55);
    expect(r.recorded?.exitPrice).toBe(38045);
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
    expect(s.signal).toEqual({ signalId: 7, direction: 'buy', limitEntry: 37950, stopEntry: 38100, stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', at: 5 });
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

// ─── lastExitedSignalId(trade2 の即時再同期用・ADD-ONLY) ───
describe('toSignalTradeState lastExitedSignalId', () => {
  const sig: CurrentSignal = { signalId: 7, at: 5, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
  it('未指定(=まだ決済無し)では欠落=既存 JSON 不変', () => {
    const flat = toSignalTradeState({ phase: 'flat' }, 38000, 9, sig);
    expect('lastExitedSignalId' in flat).toBe(false);
    // ★dedupe 不変性: lastExitedSignalId を渡さなければ JSON はこの変更前と完全一致(既存フィールドのみ)。
    const before = toSignalTradeState({ phase: 'flat', lastExit: { exitPrice: 38200, pnl: 200, at: 3 } }, 38200, 9);
    expect(before.lastExitedSignalId).toBeUndefined();
    expect(JSON.stringify(before)).not.toContain('lastExitedSignalId');
  });
  it('決済したシグナルの signalId を渡すと SSE state に載る(次の決済まで保持)', () => {
    const s = toSignalTradeState({ phase: 'flat', lastExit: { exitPrice: 37950, pnl: -50, at: 3 } }, 37950, 9, sig, 7);
    expect(s.lastExitedSignalId).toBe(7);
  });
  it('flat/armed/filled いずれでも露出できる(phase 非依存)', () => {
    expect(toSignalTradeState({ phase: 'flat' }, 38000, 9, sig, 3).lastExitedSignalId).toBe(3);
    const armed: EngineState = { phase: 'armed', armed: { direction: 'buy', limitEntry: 1, stopLossForLimit: 1, rationale: 'r', at: 0 } };
    expect(toSignalTradeState(armed, 38000, 9, sig, 4).lastExitedSignalId).toBe(4);
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
    const filled = advance(st, 37995, 10);   // ★指値38000を5円下抜けで約定
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

  it('既定は全 knob manual + 既定値 + hardMax(enabled159)', () => {
    const s = buildSettingsSnapshot();
    expect(s.lcFloor).toEqual({ mode: 'manual', value: 55 });
    expect(s.lcCeiling).toEqual({ mode: 'manual', value: 65 });
    expect(s.trendVeto).toEqual({ mode: 'manual', value: 100 });
    expect(s.cooldown).toEqual({ mode: 'manual', value: 90 });
    expect(s.bias).toEqual({ mode: 'manual', value: 'none' });
    expect(s.range).toEqual({ mode: 'manual', value: false });
    expect(s.lcHardMax).toEqual({ enabled: true, value: 159 });
  });
  it('lcCeiling=ai + realizedLc は実測 LC を value に、他は mode のみ', () => {
    writeConfig({ scalpLcCeilingSource: 'ai', scalpTrendVetoSource: 'ai' });
    const s = buildSettingsSnapshot(118);
    expect(s.lcCeiling).toEqual({ mode: 'ai', value: 118 });
    expect(s.lcFloor).toEqual({ mode: 'manual', value: 55 });   // floor は manual → 設定値(既定)
    expect(s.trendVeto).toEqual({ mode: 'ai' });                // trendVeto は LC 系でない → value 省略
  });

  // ★v0.8.2: buildSettingsSnapshot('B') は signalB を反映(A は不変)。
  it("profile='B' は signalB を反映し、A(省略)は不変", () => {
    writeConfig({ scalpLcCeilingYen: 65, signalB: { scalpLcCeilingYen: 40, scalpBias: 'short' } });
    const a = buildSettingsSnapshot();          // A=省略
    const b = buildSettingsSnapshot(undefined, 'B');
    expect(a.lcCeiling).toEqual({ mode: 'manual', value: 65 });
    expect(a.bias).toEqual({ mode: 'manual', value: 'none' });
    expect(b.lcCeiling).toEqual({ mode: 'manual', value: 40 });   // signalB
    expect(b.bias).toEqual({ mode: 'manual', value: 'short' });   // signalB
    expect(b.lcFloor).toEqual({ mode: 'manual', value: 55 });     // signalB 未設定 → A(既定)へフォールバック
  });
});

// ★v0.8.2: 系統タグ付き DB 挿入(純関数)。A(null)は従来と同一行 / B は system='B'。
describe('buildSignalTradeInsert(系統タグ)', () => {
  const base: RecordedTrade = {
    entryT: 1000, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 38050, pnl: 50, qty: 1, rationale: 'x',
    // ★決済記録の必須3点(記録専用)。この describe の検証対象は系統タグ/signalId なので固定値。
    exitReason: 'initial_stop', exitInitialStop: 37950, peakProfit: 0,
  };
  it('A(null)は system 省略(=既存挙動)・mode=directional', () => {
    const ins = buildSignalTradeInsert(base, null);
    expect(ins.system).toBeUndefined();
    expect(ins.mode).toBe('directional');
    expect(ins.dir).toBe('buy');
  });
  it("B は system='B'", () => {
    const ins = buildSignalTradeInsert(base, 'B');
    expect(ins.system).toBe('B');
  });
  it('range 由来は mode=range(タグは系統と独立)', () => {
    const ins = buildSignalTradeInsert({ ...base, mode: 'range' }, 'B');
    expect(ins.mode).toBe('range');
    expect(ins.system).toBe('B');
  });
  // ★検証用: signalId(ARM 采番)を渡すと signalId 列に載る / 未指定は従来どおり付与しない(byte 互換)。
  it('signalId を渡すと ins.signalId に載る(trade2 結合キー)', () => {
    expect(buildSignalTradeInsert(base, null, 42).signalId).toBe(42);
    expect(buildSignalTradeInsert(base, 'B', 7).signalId).toBe(7);
  });
  it('signalId 未指定/null は付与しない(=既存挙動と byte 一致)', () => {
    expect('signalId' in buildSignalTradeInsert(base, null)).toBe(false);
    expect('signalId' in buildSignalTradeInsert(base, null, null)).toBe(false);
    expect('signalId' in buildSignalTradeInsert(base, null, undefined)).toBe(false);
  });
});

// ★検証用(RECORD-ONLY): 決済逆指値(exit-stop)遷移の記録判定=変化時のみ・不変tickは記録しない。
describe('buildExitStopRecord(exit-stop 遷移の dedupe)', () => {
  const fresh: ExitStopTracker = { openedAt: null, value: null };
  const hold: SignalHold = { signalId: 7, direction: 'buy', entryPrice: 38000, exitStop: 37950, at: 500 };

  it('初回(建玉の initial)は記録行を返す(t/signalId/openedAt/direction/exitStop)', () => {
    const rec = buildExitStopRecord(hold, fresh, 1000);
    expect(rec).toEqual({ t: 1000, signalId: 7, openedAt: 500, direction: 'buy', exitStop: 37950, phase: null });
  });

  it('同一建玉かつ同一 exitStop(不変tick)は null(記録しない)', () => {
    const prev: ExitStopTracker = { openedAt: 500, value: 37950 };
    expect(buildExitStopRecord(hold, prev, 2000)).toBeNull();
  });

  it('同一建玉で exitStop が変化したら記録行を返す(ラチェット移動)', () => {
    const prev: ExitStopTracker = { openedAt: 500, value: 37950 };
    const moved: SignalHold = { ...hold, exitStop: 38030 };
    expect(buildExitStopRecord(moved, prev, 3000)).toMatchObject({ openedAt: 500, exitStop: 38030 });
  });

  it('exitStop が同値でも建玉(openedAt)が変われば記録する(新規建玉)', () => {
    const prev: ExitStopTracker = { openedAt: 500, value: 37950 };
    const next: SignalHold = { ...hold, at: 9000 };   // 同じ exitStop 値だが別建玉
    expect(buildExitStopRecord(next, prev, 4000)).toMatchObject({ openedAt: 9000, exitStop: 37950 });
  });

  it('hold なし(flat/armed/B)や exitStop=null/非有限は記録しない', () => {
    expect(buildExitStopRecord(null, fresh, 1)).toBeNull();
    expect(buildExitStopRecord({ ...hold, exitStop: null }, fresh, 1)).toBeNull();
    expect(buildExitStopRecord({ ...hold, exitStop: NaN }, fresh, 1)).toBeNull();
  });

  it('レンジ建玉(rangeTp あり)は phase="range"(固定LC)', () => {
    const rangeHold: SignalHold = { ...hold, rangeTp: 66000, tpTrigger: 65995 };
    expect(buildExitStopRecord(rangeHold, fresh, 1)?.phase).toBe('range');
  });
});

// ★v0.8.2: B は currentSignal/hold を一切露出しない。A の getter は B の存在に影響されない(実売買 A の不変性)。
describe('System B は currentSignal を露出しない / A は不変', () => {
  beforeEach(() => { _resetSignalEngine(); _resetSignalEngineB(); });
  it('getSignalTradeStateB は flat で signal/hold を持たない', () => {
    const sb = getSignalTradeStateB(123);
    expect(sb.phase).toBe('flat');
    expect(sb.signal).toBeUndefined();
    expect(sb.hold).toBeUndefined();
  });
  it('A の getter(currentSignal/hold/phase/state)は B を動かしても不変(初期=未ARM)', () => {
    // B を reset しても A の公開契約は初期状態のまま(相互干渉なし)。
    _resetSignalEngineB();
    expect(getCurrentSignal()).toBeNull();
    expect(getSignalHold()).toBeNull();
    expect(getSignalPhase()).toBe('flat');
    const sa = getSignalTradeState(123);
    expect(sa.phase).toBe('flat');
    expect(sa.signal).toBeUndefined();
  });
});

// ─── レンジ建玉のTP決済(固定LC損切り + 反対側節目手前の成行TP) ───
describe('rangeTpTrigger', () => {
  it('buy は rangeTp−5(節目手前で利食い)', () => {
    expect(rangeTpTrigger('buy', 66000)).toBe(65995);
    expect(RANGE_TP_OFFSET_YEN).toBe(5);
  });
  it('sell は rangeTp+5', () => {
    expect(rangeTpTrigger('sell', 65000)).toBe(65005);
  });
  it('offset は差し替え可能(既定=RANGE_TP_OFFSET_YEN)', () => {
    expect(rangeTpTrigger('buy', 66000, 10)).toBe(65990);
    expect(rangeTpTrigger('sell', 65000, 10)).toBe(65010);
  });
});

describe('advance: レンジ建玉のTP/固定LC決済(fade ストラドル)', () => {
  // fade(指値)両面: 下=買い指値65000(LC64900) / 上=売り指値66000(LC66100)。
  // 下レッグ約定(ロング)→ 反対=上節目66000 は利益側 → rangeTp=66000。
  const fadeStraddle: ArmedBracket = {
    direction: 'buy', rationale: 'range', at: 0, mode: 'range', range: {
      upper: { side: 'sell', type: 'limit', entry: 66000, stopLoss: 66100 },
      lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64900 },
    },
  };

  it('LONG: 下レッグ約定で rangeTp=反対上節目(66000)を据える', () => {
    const { next } = advance({ phase: 'armed', armed: fadeStraddle }, 64995, 1000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ direction: 'buy', entryPrice: 65000, initialStop: 64900, mode: 'range', rangeTp: 66000 });
  });

  it('LONG: TPトリガー手前(65994)では保有継続(65995=66000−5 未達)', () => {
    const filled = advance({ phase: 'armed', armed: fadeStraddle }, 64995, 1000).next;
    const r = advance(filled, 65994, 1100);
    expect(r.next.phase).toBe('filled');
    expect(r.recorded).toBeUndefined();
  });

  it('LONG: TPトリガー(65995)到達で成行決済(exit=現在値=65995・phase-exit 非経由)', () => {
    const filled = advance({ phase: 'armed', armed: fadeStraddle }, 64995, 1000).next;
    const r = advance(filled, 65995, 1200);
    expect(r.next.phase).toBe('flat');
    // TP は成行(現在値65995)だが不利−5円=65990 約定・pnl=65990−65000=990(ロング決済スリップ)。
    expect(r.recorded?.exitPrice).toBe(65990);
    expect(r.recorded?.pnl).toBe(990);
    expect(r.recorded?.mode).toBe('range');
    expect(r.next.lastExit).toEqual({ exitPrice: 65990, pnl: 990, at: 1200 });
  });

  it('LONG: TPトリガーより上に飛んでも成行=現在値で決済(66020)', () => {
    const filled = advance({ phase: 'armed', armed: fadeStraddle }, 64995, 1000).next;
    const r = advance(filled, 66020, 1300);
    // 成行(現在値66020)から不利−5円=66015 約定・pnl=66015−65000=1015。
    expect(r.recorded?.exitPrice).toBe(66015);
    expect(r.recorded?.pnl).toBe(1015);
  });

  it('LONG: 固定初期LC(64900)到達で損切り(ラチェットせず・exit=LC価格)', () => {
    // phase-exit を差し替えて「もし phase-exit を通れば別価格」の状況でも、range は固定LCで決済することを示す。
    _setExitImpl(() => 64950);   // これが使われたら exit=64950 になるはず(=使われない証明)。
    const filled = advance({ phase: 'armed', armed: fadeStraddle }, 64995, 1000).next;
    const r = advance(filled, 64900, 1400);
    expect(r.next.phase).toBe('flat');
    // 固定 initialStop=64900(phase-exit の 64950 ではない)だが成行決済で不利−5円=64895 約定・pnl=64895−65000=−105。
    expect(r.recorded?.exitPrice).toBe(64895);
    expect(r.recorded?.pnl).toBe(-105);
    expect(r.recorded?.mode).toBe('range');
  });

  it('SHORT: 上レッグ約定で rangeTp=反対下節目(65000)・トリガー65005で成行決済', () => {
    // 上レッグ(売り)約定(ショート)→ 反対=下節目65000 は利益側 → rangeTp=65000・trigger=65005。
    const filled = advance({ phase: 'armed', armed: fadeStraddle }, 66005, 2000).next;   // ★上レッグ指値66000を5円上抜けで約定
    expect(filled.position).toMatchObject({ direction: 'sell', entryPrice: 66000, initialStop: 66100, mode: 'range', rangeTp: 65000 });
    const hold = advance(filled, 65005, 2100);
    expect(hold.next.phase).toBe('flat');
    // ショート決済は成行(現在値65005)から不利+5円=65010 約定・pnl=66000−65010=990。
    expect(hold.recorded?.exitPrice).toBe(65010);
    expect(hold.recorded?.pnl).toBe(990);
  });
});

describe('advance: breakout ストラドルは反対節目=損側 → rangeTp を据えず phase-exit にフォールバック', () => {
  // breakout(逆指値)両面: 上=買い逆指値66000(LC65900) / 下=売り逆指値65000(LC65100)。
  // 上レッグ約定(ロング)→ 反対=下節目65000 は建値66000 より下=損側 → rangeTp を据えない。
  const breakoutStraddle: ArmedBracket = {
    direction: 'buy', rationale: 'range', at: 0, mode: 'range', range: {
      upper: { side: 'buy', type: 'stop', entry: 66000, stopLoss: 65900 },
      lower: { side: 'sell', type: 'stop', entry: 65000, stopLoss: 65100 },
    },
  };
  it('LONG(上抜け約定): rangeTp は据えない → 既存 phase-exit(下)へ落ちる', () => {
    const { next } = advance({ phase: 'armed', armed: breakoutStraddle }, 66000, 1000);   // ★逆指値レッグはタッチ(66000)で約定
    expect(next.phase).toBe('filled');
    // ★breakout(逆指値=stop)レッグは成行約定=建値も不利+5円(66000→66005)。
    expect(next.position?.entryPrice).toBe(66005);
    expect(next.position?.rangeTp).toBeUndefined();
    // phase-exit(簡易=初期LC 65900)で損切り=range TP 経路に入らない。成行決済で不利−5円=65895 約定。
    const r = advance(next, 65900, 1100);
    expect(r.next.phase).toBe('flat');
    expect(r.recorded?.exitPrice).toBe(65895);
    expect(r.recorded?.mode).toBe('range');   // タグは range 由来のまま
  });
});

describe('advance: 混在ストラドル(上=逆指値/下=指値)はレッグ type ごとの条件で約定', () => {
  // 上=買い逆指値66000(LC65900・breakout) / 下=買い指値65000(LC64900・fade)。
  const mixed: ArmedBracket = {
    direction: 'buy', rationale: 'range', at: 0, mode: 'range', range: {
      upper: { side: 'buy', type: 'stop', entry: 66000, stopLoss: 65900 },
      lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64900 },
    },
  };
  it('上(逆指値)はタッチ66000で filled: ★旧実装では 66005 まで armed のままだった', () => {
    const { next } = advance({ phase: 'armed', armed: mixed }, 66000, 1000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ direction: 'buy', entryPrice: 66005, initialStop: 65900, mode: 'range' });
  });
  it('下(指値)はタッチ65000では armed のまま・64995(5円下抜け)で filled', () => {
    expect(advance({ phase: 'armed', armed: mixed }, 65000, 1000).next.phase).toBe('armed');
    const { next } = advance({ phase: 'armed', armed: mixed }, 64995, 1000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ direction: 'buy', entryPrice: 65000, initialStop: 64900, mode: 'range' });
  });
});

describe('advance: 片レッグ range(反対レッグ無し)は rangeTp を据えず phase-exit', () => {
  it('下レッグのみの range → 反対無し → rangeTp 未設定・既存 phase-exit', () => {
    const single: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
      lower: { side: 'buy', type: 'limit', entry: 65000, stopLoss: 64900 },
    } };
    const { next } = advance({ phase: 'armed', armed: single }, 64995, 1000);   // ★下レッグ指値65000を5円下抜けで約定
    expect(next.phase).toBe('filled');
    expect(next.position?.rangeTp).toBeUndefined();
    const r = advance(next, 64900, 1100);   // 初期LC=phase-exit(簡易)で決済
    expect(r.next.phase).toBe('flat');
    // fade指値=建値65000(スリップ無し)・LC64900 だが成行決済で不利−5円=64895・pnl=64895−65000=−105。
    expect(r.recorded?.exitPrice).toBe(64895);
    expect(r.recorded?.pnl).toBe(-105);
  });
});

describe('computeHold: レンジ建玉は固定LC exitStop + rangeTp/tpTrigger を公開', () => {
  const sig: CurrentSignal = { signalId: 7, at: 5, direction: 'buy', rationale: 'r', mode: 'range' };
  it('range(rangeTp 設定済): exitStop=固定 initialStop・rangeTp/tpTrigger を付与', () => {
    // phase-exit を差し替えても range の exitStop は固定 initialStop(ラチェットしない)であることを示す。
    _setExitImpl(() => 64950);
    const st: EngineState = { phase: 'filled', position: {
      direction: 'buy', entryPrice: 65000, qty: 1, initialStop: 64900, peakProfit: 400, rationale: 'r', at: 7, mode: 'range', rangeTp: 66000,
    } };
    expect(computeHold(st, sig)).toEqual({
      signalId: 7, direction: 'buy', entryPrice: 65000, exitStop: 64900, at: 7, rangeTp: 66000, tpTrigger: 65995,
    });
  });
  it('SHORT range: tpTrigger=rangeTp+5', () => {
    const st: EngineState = { phase: 'filled', position: {
      direction: 'sell', entryPrice: 66000, qty: 1, initialStop: 66100, peakProfit: 0, rationale: 'r', at: 3, mode: 'range', rangeTp: 65000,
    } };
    expect(computeHold(st, sig)).toMatchObject({ exitStop: 66100, rangeTp: 65000, tpTrigger: 65005 });
  });
  it('range だが rangeTp 無し(片レッグ/breakout): 既存 phase-exit(exitStop=restingStopOf)・rangeTp 無し', () => {
    const pos: OpenPosition = { direction: 'buy', entryPrice: 65000, qty: 1, initialStop: 64900, peakProfit: 400, rationale: 'r', at: 7, mode: 'range' };
    const hold = computeHold({ phase: 'filled', position: pos }, sig)!;
    expect(hold.exitStop).toBe(restingStopOf(pos));   // = 簡易 phase-exit(初期LC)
    expect('rangeTp' in hold).toBe(false);
    expect('tpTrigger' in hold).toBe(false);
  });
});

// ★byte 互換保証: directional 建玉の advance/computeHold は range 変更後も従来と完全一致。
describe('directional は range 変更の影響を受けない(byte 互換)', () => {
  const sig: CurrentSignal = { signalId: 9, at: 3, direction: 'buy', rationale: 'r', limitEntry: 37950, stopLossForLimit: 37900 };
  it('advance(filled→逆指値決済)は従来どおり(mode/rangeTp 無し・phase-exit)', () => {
    const st: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500 } };
    const { next, recorded } = advance(st, 37950, 2000);
    expect(next.phase).toBe('flat');
    // 逆指値トリガ=37950・成行決済で不利−5円=37945 約定・pnl=37945−38000=−55(mode/rangeTp は付かない)。
    expect(next.lastExit).toEqual({ exitPrice: 37945, pnl: -55, at: 2000 });
    expect(recorded).toEqual({
      entryT: 500, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 37945, pnl: -55, qty: 1, rationale: 'r',
      // ★記録専用(決済パラメータ分析用): 必須3点。決済の判断・価格・タイミングは不変(mode/rangeTp は付かないまま)。
      exitReason: 'initial_stop', exitInitialStop: 37950, peakProfit: 0,
    });
    expect(recorded?.mode).toBeUndefined();
  });
  it('computeHold は従来どおり(exitStop=restingStopOf・rangeTp/tpTrigger 無し)', () => {
    const pos: OpenPosition = { direction: 'buy', entryPrice: 37950, qty: 1, initialStop: 37900, peakProfit: 400, rationale: 'r', at: 7 };
    const hold = computeHold({ phase: 'filled', position: pos }, sig)!;
    expect(hold).toEqual({ signalId: 9, direction: 'buy', entryPrice: 37950, exitStop: 37900, at: 7 });
    expect('rangeTp' in hold).toBe(false);
  });
});

// ★signalId 永続シード: 再起動を跨いで継続(1 に戻らない)/ reset() は 0 化するが start() が永続から復元 /
//   履歴消去(resetSignalEngineIdCounter)でのみ 0 化。APPDATA を temp に向けて実 DB(signal_meta)で検証する。
describe('SignalEngine signalId 永続シード(再起動継続・履歴消去でのみリセット)', () => {
  let dir: string;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-sigid-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;   // resolveDbPath は APPDATA を最優先 → temp DB を使う
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) 永続カウンタからシードして継続(seed=last・次の ARM は last+1・1 に戻らない)', async () => {
    const db = openDb(resolveDbPath());
    setSignalIdCounter(db, 'A', 5);   // 直前プロセスで 5 回 ARM した状態を永続。
    db.close();
    const eng = new SignalEngine(cfgA);
    await eng.start();   // 起動=永続からシード。
    expect(eng._peekSignalIdCounter()).toBe(5);   // 1 ではなく 5 → 次の採番は 6。
    eng.stop();
  });

  it('reset()(テスト用)は in-memory を 0 化するが、start() は永続から復元する', async () => {
    const db = openDb(resolveDbPath());
    setSignalIdCounter(db, 'A', 9);
    db.close();
    const eng = new SignalEngine(cfgA);
    eng.reset();
    expect(eng._peekSignalIdCounter()).toBe(0);   // in-memory 初期化
    await eng.start();
    expect(eng._peekSignalIdCounter()).toBe(9);   // 起動で永続値を復元(0 のままにしない)
    eng.stop();
  });

  it('起動でシードした in-memory を resetSignalIdCounter が 0 化する(履歴消去=次の ARM は 1 から)', async () => {
    const db = openDb(resolveDbPath());
    setSignalIdCounter(db, 'A', 4);
    db.close();
    const eng = new SignalEngine(cfgA);
    await eng.start();
    expect(eng._peekSignalIdCounter()).toBe(4);   // 永続からシード
    eng.resetSignalIdCounter();                    // 履歴消去に対応する in-memory 0 化
    expect(eng._peekSignalIdCounter()).toBe(0);    // 次の ARM は 1 から
    eng.stop();
    // 永続側は resetSignalIdCounter(in-memory)では変えない(clearSignalTrades が 0 化を担う)。
    const db2 = openDb(resolveDbPath());
    expect(getSignalIdCounter(db2, 'A')).toBe(4);
    db2.close();
    // module-level ラッパも例外なく呼べる(A singleton の in-memory を触るだけ)。
    resetSignalEngineIdCounter('A');
    resetSignalEngineIdCounter();
  });
});

// ═══ ドテン(反転): AI駆動の保有中反転 ═══════════════════════════════════════

describe('opposite(保有方向の反対)', () => {
  it('buy↔sell', () => {
    expect(opposite('buy')).toBe('sell');
    expect(opposite('sell')).toBe('buy');
  });
});

describe('shouldRequestHeldEval(held-eval 要求ゲート)', () => {
  const base = { dotenEnabled: true, planning: false, phase: 'filled' as const, inWindow: true, now: 100_000, lastHeldEvalAt: 0, intervalMs: 60_000 };
  it('全条件成立で true', () => { expect(shouldRequestHeldEval(base)).toBe(true); });
  it('dotenEnabled=false(既定OFF)は false=held-eval を走らせない', () => {
    expect(shouldRequestHeldEval({ ...base, dotenEnabled: false })).toBe(false);
  });
  it('planning(in-flight)は false=flat-plan と同時に AI を叩かない', () => {
    expect(shouldRequestHeldEval({ ...base, planning: true })).toBe(false);
  });
  it('非 filled は false', () => {
    expect(shouldRequestHeldEval({ ...base, phase: 'flat' })).toBe(false);
    expect(shouldRequestHeldEval({ ...base, phase: 'armed' })).toBe(false);
  });
  it('取引時間外(inWindow=false)は false', () => {
    expect(shouldRequestHeldEval({ ...base, inWindow: false })).toBe(false);
  });
  it('間隔未達は false・境界(=intervalMs)で true', () => {
    expect(shouldRequestHeldEval({ ...base, lastHeldEvalAt: 100_000 - 59_999 })).toBe(false);
    expect(shouldRequestHeldEval({ ...base, lastHeldEvalAt: 100_000 - 60_000 })).toBe(true);
  });
});

describe('sameHeldPosition(async 同一性再チェック)', () => {
  const id: HeldIdentity = { at: 500, direction: 'buy', signalId: 3 };
  it('まだ filled かつ同一(at+direction)なら true', () => {
    const st: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 500 } };
    expect(sameHeldPosition(st, id)).toBe(true);
  });
  it('flat/armed(=もう保有していない)は false=幽霊を反転させない', () => {
    expect(sameHeldPosition({ phase: 'flat' }, id)).toBe(false);
    expect(sameHeldPosition({ phase: 'armed', armed: { direction: 'buy', limitEntry: 1, stopLossForLimit: 1, rationale: 'r', at: 0 } }, id)).toBe(false);
  });
  it('別建玉(at 変化 / direction 変化)は false', () => {
    const diffAt: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 900 } };
    expect(sameHeldPosition(diffAt, id)).toBe(false);
    const diffDir: EngineState = { phase: 'filled', position: { direction: 'sell', entryPrice: 38000, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r', at: 500 } };
    expect(sameHeldPosition(diffDir, id)).toBe(false);
  });
});

describe('reverseToDoten(P を成行決済して反対ブラケットを arm・純関数)', () => {
  const heldBuy: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: 500 } };
  const sellPlan = { direction: 'sell' as const, limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転売り', refPrice: 38000 };

  it('buy保有 + sellプラン: P を現在値で成行決済(不利1tick)・反対ブラケット(doten)を armed に据える', () => {
    const rev = reverseToDoten(heldBuy, sellPlan, 38000, 2000, { vetoFired: false });
    expect(rev).not.toBeNull();
    // ① P の決済記録(doten:true・dir=buy・成行−5=37995・pnl=37995−38000=−5)。
    expect(rev!.recorded).toMatchObject({ entryT: 500, entryPrice: 38000, dir: 'buy', exitT: 2000, exitPrice: 37995, pnl: -5, doten: true });
    // ② 反対ブラケット(doten:true・direction=sell)を armed に。
    expect(rev!.next.phase).toBe('armed');
    expect(rev!.armed).toMatchObject({ direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, doten: true });
    expect(rev!.next.armed?.doten).toBe(true);
    expect(rev!.next.lastExit).toEqual({ exitPrice: 37995, pnl: -5, at: 2000 });
  });

  it('sell保有 + buyプラン: ショート決済は不利+1tick', () => {
    const heldSell: EngineState = { phase: 'filled', position: { direction: 'sell', entryPrice: 38000, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'o', at: 1 } };
    const buyPlan = { direction: 'buy' as const, limitEntry: 37950, stopLossForLimit: 37900, rationale: '反転買い', refPrice: 38000 };
    const rev = reverseToDoten(heldSell, buyPlan, 38000, 2)!;
    expect(rev.recorded).toMatchObject({ dir: 'sell', exitPrice: 38005, pnl: -5, doten: true });
    expect(rev.armed).toMatchObject({ direction: 'buy', doten: true });
  });

  it('planMeta/settings/mode を P の決済記録に引き継ぐ', () => {
    const held: EngineState = { phase: 'filled', position: { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'o', at: 1, mode: 'range', planMeta: { regime: 'trend_up' } } };
    const rev = reverseToDoten(held, sellPlan, 38000, 2)!;
    expect(rev.recorded.mode).toBe('range');
    expect(rev.recorded.planMeta).toEqual({ regime: 'trend_up' });
  });

  it('filled でない / plan が none・range になる 場合は null(ドテンしない)', () => {
    expect(reverseToDoten({ phase: 'flat' }, sellPlan, 38000, 1)).toBeNull();
    expect(reverseToDoten(heldBuy, { direction: 'none', rationale: 'x', refPrice: 38000 } as any, 38000, 1)).toBeNull();
    expect(reverseToDoten(heldBuy, { direction: 'range', rationale: 'x', refPrice: 38000, range: { upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 } } } as any, 38000, 1)).toBeNull();
  });

  it('約定→決済で doten が反対建玉の決済記録まで運ばれる(advance の持ち回り)', () => {
    const rev = reverseToDoten(heldBuy, sellPlan, 38000, 2000)!;
    // 反対ブラケット(sell 指値38050)が 5円上抜けで約定 → doten position。
    const filled = advance(rev.next, 38055, 3000);
    expect(filled.next.position?.doten).toBe(true);
    // 決済(初期LC 38100 ヒット)。RecordedTrade にも doten が乗る。
    const exited = advance(filled.next, 38100, 4000);
    expect(exited.recorded?.doten).toBe(true);
    expect(exited.recorded?.dir).toBe('sell');
  });
});

describe('toSignalTradeState doten(ADD-ONLY)', () => {
  it('signal.doten=true のとき s.signal.doten を露出', () => {
    const sig: CurrentSignal = { signalId: 3, at: 1, direction: 'sell', rationale: 'r', limitEntry: 38050, stopLossForLimit: 38100, doten: true };
    const s = toSignalTradeState({ phase: 'armed', armed: { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: 'r', at: 1, doten: true } }, 38000, 5, sig);
    expect(s.signal?.doten).toBe(true);
  });
  it('非 doten では s.signal.doten は欠落=既存 JSON 不変(dedupe/OFF byte 一致)', () => {
    const sig: CurrentSignal = { signalId: 3, at: 1, direction: 'sell', rationale: 'r', limitEntry: 38050, stopLossForLimit: 38100 };
    const s = toSignalTradeState({ phase: 'flat' }, 38000, 5, sig);
    expect('doten' in (s.signal ?? {})).toBe(false);
    expect(JSON.stringify(s)).not.toContain('doten');
  });
});

describe('armedToCurrentSignal doten(引き継ぎ)', () => {
  it('armed.doten を currentSignal.doten へ引き継ぐ / 無しは付与しない', () => {
    const a: ArmedBracket = { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: 'r', at: 1, doten: true };
    expect(armedToCurrentSignal(a, 2).doten).toBe(true);
    const b: ArmedBracket = { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: 'r', at: 1 };
    expect('doten' in armedToCurrentSignal(b, 2)).toBe(false);
  });
});

// ─── SignalEngine.applyHeldEvalResult(ドテン反映の統合) ───
describe('SignalEngine ドテン反映(applyHeldEvalResult)', () => {
  let dir: string;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
  const heldBuySig: CurrentSignal = { signalId: 1, at: 500, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900 };
  const heldBuyPos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: 500 };
  const id: HeldIdentity = { at: 500, direction: 'buy', signalId: 1 };
  const sellResult = { ok: true as const, plan: { direction: 'sell' as const, limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: 38000 } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-doten-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;   // persistTrade/persistSignalIdCounter を temp DB へ隔離。
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it('opposite 有効プラン → 紙は P を決済し反対ブラケット(doten:true・反対dir・新signalId)を arm', () => {
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    const r = eng.applyHeldEvalResult(sellResult, id, 2000, 38000);
    expect(r).toBe('doten');
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.direction).toBe('sell');       // 反対方向
    expect(sig.doten).toBe(true);             // doten フラグ
    expect(sig.signalId).toBe(2);             // 新 signalId(P=1 → 2)を1回だけ採番
    expect(sig.limitEntry).toBe(38050);
    // SSE state: 反対ブラケット(entry)+ P の決済(lastExit)+ doten シグナル。
    const s = eng.getState(2100);
    expect(s.signal?.doten).toBe(true);
    expect(s.lastExit).toEqual({ exitPrice: 37995, pnl: -5, at: 2000 });
    expect(s.lastExitedSignalId).toBe(1);     // P の signalId を露出
  });

  it('同方向プランは反転しない(reject・保有継続)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    const buyResult = { ok: true as const, plan: { direction: 'buy' as const, limitEntry: 37950, stopLossForLimit: 37900, rationale: 'x', refPrice: 38000 } };
    expect(eng.applyHeldEvalResult(buyResult, id, 2000, 38000)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);   // 不変
  });

  it('direction:none は反転しない(reject)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    const noneResult = { ok: true as const, plan: { direction: 'none' as const, rationale: '見送り', refPrice: 38000 } };
    expect(eng.applyHeldEvalResult(noneResult, id, 2000, 38000)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');
  });

  it('反対だがサニティ不通過(逆置き)は反転しない(reject)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // sell 指値が現在値の下(38000未満)=即約定=サニティNG。
    const badResult = { ok: true as const, plan: { direction: 'sell' as const, limitEntry: 37900, stopLossForLimit: 37950, rationale: 'x', refPrice: 38000 } };
    expect(eng.applyHeldEvalResult(badResult, id, 2000, 38000)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');
  });

  it('★async 同一性再チェック: 解決までに別建玉/決済済みなら破棄(stale)=幽霊を反転させない', () => {
    const eng = new SignalEngine(cfgA);
    // 解決時に flat(=もう保有していない)。
    const r1 = eng.applyHeldEvalResult(sellResult, id, 2000, 38000);
    expect(r1).toBe('stale');
    // 別建玉(at 変化)。
    eng._setFilledForTest({ ...heldBuyPos, at: 999 }, { ...heldBuySig, signalId: 5 });
    expect(eng.applyHeldEvalResult(sellResult, id, 2000, 38000)).toBe('stale');
    // signalId 不一致(currentSignal が入れ替わった)。
    eng._setFilledForTest(heldBuyPos, { ...heldBuySig, signalId: 9 });
    expect(eng.applyHeldEvalResult(sellResult, id, 2000, 38000)).toBe('stale');
  });

  it('result.ok=false(LLM失敗)は反転しない(reject)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    expect(eng.applyHeldEvalResult({ ok: false as const, error: 'x' }, id, 2000, 38000)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');
  });
});

// ─── buildSettingsSnapshot: dotenEnabled(ADD-ONLY) ───
describe('buildSettingsSnapshot dotenEnabled(委任状態・ADD-ONLY)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-doten-snap-'));
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
  it('既定(OFF)は dotenEnabled 欠落=既存 snapshot JSON と byte 一致', () => {
    const s = buildSettingsSnapshot();
    expect('dotenEnabled' in s).toBe(false);
  });
  it('dotenEnabled=true のとき snapshot に true を載せる', () => {
    writeConfig({ dotenEnabled: true });
    expect(buildSettingsSnapshot().dotenEnabled).toBe(true);
  });
});

// ═══ レンジ両指値が平均以上未約定 → ブレイク(両逆指値)再評価 ═══════════════════════

describe('レンジ再評価 定数', () => {
  it('既定値(factor/samples/min/default/cap)', () => {
    expect(REEVAL_FACTOR).toBe(1.5);
    expect(AVG_FILL_SAMPLES).toBe(20);
    expect(MIN_SAMPLES).toBe(5);
    expect(DEFAULT_AVG_FILL_MS).toBe(180_000);
    expect(REEVAL_CAP_MS).toBe(720_000);
  });
});

describe('computeAvgFillMs(移動平均約定所要)', () => {
  it('サンプルが min 未満はフォールバック既定', () => {
    expect(computeAvgFillMs([], { min: 5, def: 180_000 })).toBe(180_000);
    expect(computeAvgFillMs([100, 200, 300, 400], { min: 5, def: 180_000 })).toBe(180_000);   // 4<5
  });
  it('min 以上は与えられた全件の平均', () => {
    expect(computeAvgFillMs([100, 200, 300, 400, 500], { min: 5, def: 180_000 })).toBe(300);
    expect(computeAvgFillMs([120_000, 120_000, 120_000, 120_000, 120_000], { min: 5, def: 180_000 })).toBe(120_000);
  });
  it('境界(=min)で平均を使う', () => {
    expect(computeAvgFillMs([10, 20, 30, 40, 50], { min: 5, def: 999 })).toBe(30);
  });
});

describe('bothRangeLegsLimit(fade ストラドル判定)', () => {
  const leg = (side: 'buy' | 'sell', type: 'limit' | 'stop', entry: number, stopLoss: number) => ({ side, type, entry, stopLoss });
  it('両レッグ limit=true', () => {
    const a: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper: leg('sell', 'limit', 38400, 38450), lower: leg('buy', 'limit', 38100, 38050) } };
    expect(bothRangeLegsLimit(a)).toBe(true);
  });
  it('片レッグ欠落は false', () => {
    const a: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { lower: leg('buy', 'limit', 38100, 38050) } };
    expect(bothRangeLegsLimit(a)).toBe(false);
  });
  it('どちらかが stop(breakout)は false', () => {
    const a: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: { upper: leg('buy', 'stop', 38400, 38350), lower: leg('sell', 'stop', 38100, 38150) } };
    expect(bothRangeLegsLimit(a)).toBe(false);
  });
  it('directional(mode 無し)は false', () => {
    const a: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 0 };
    expect(bothRangeLegsLimit(a)).toBe(false);
  });
});

describe('shouldRangeReeval(再評価トリガ純関数)', () => {
  // avgFillMs=120s・factor=1.5 → 閾値=180s(cap 720s 未満)。armed後 181s で発火。
  const base = { enabled: true, phase: 'armed' as const, mode: 'range' as const, bothLegsLimit: true,
    armedAtMs: 0, nowMs: 181_000, avgFillMs: 120_000, factor: REEVAL_FACTOR, capMs: REEVAL_CAP_MS };
  it('fade + 閾値超過 → true', () => { expect(shouldRangeReeval(base)).toBe(true); });
  it('閾値未達(=境界ちょうど)→ false', () => {
    expect(shouldRangeReeval({ ...base, nowMs: 180_000 })).toBe(false);   // 180s ちょうどは超過でない
    expect(shouldRangeReeval({ ...base, nowMs: 179_000 })).toBe(false);
  });
  it('OFF は false', () => { expect(shouldRangeReeval({ ...base, enabled: false })).toBe(false); });
  it('非 armed は false', () => {
    expect(shouldRangeReeval({ ...base, phase: 'flat' })).toBe(false);
    expect(shouldRangeReeval({ ...base, phase: 'filled' })).toBe(false);
  });
  it('非 range(directional)は false', () => { expect(shouldRangeReeval({ ...base, mode: undefined })).toBe(false); });
  it('両レッグ limit でない(単一/breakout)は false', () => { expect(shouldRangeReeval({ ...base, bothLegsLimit: false })).toBe(false); });
  it('cap でクランプ: avg が大きくても cap 超過で発火する', () => {
    // avg=10分・factor1.5=15分だが cap=12分 → 閾値=12分。armed後 13分で発火(avg×factor では未発火のはず)。
    expect(shouldRangeReeval({ ...base, avgFillMs: 600_000, nowMs: 13 * 60_000 })).toBe(true);
    // cap 直下(12分ちょうど)は超過でない=false。
    expect(shouldRangeReeval({ ...base, avgFillMs: 600_000, nowMs: 12 * 60_000 })).toBe(false);
  });
});

describe('sameArmedBracket(async 同一性再チェック)', () => {
  const id: ArmedIdentity = { armedAt: 500, signalId: 3, mode: 'range' };
  const armed: ArmedBracket = { direction: 'buy', rationale: 'r', at: 500, mode: 'range', range: { lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } };
  it('まだ armed かつ同一(at+mode)なら true', () => {
    expect(sameArmedBracket({ phase: 'armed', armed }, id)).toBe(true);
  });
  it('flat/filled(=もう未約定 armed でない)は false', () => {
    expect(sameArmedBracket({ phase: 'flat' }, id)).toBe(false);
    expect(sameArmedBracket({ phase: 'filled', position: { direction: 'buy', entryPrice: 1, qty: 1, initialStop: 1, peakProfit: 0, rationale: 'r', at: 500 } }, id)).toBe(false);
  });
  it('別 armed(at 変化 / mode 変化)は false', () => {
    expect(sameArmedBracket({ phase: 'armed', armed: { ...armed, at: 900 } }, id)).toBe(false);
    expect(sameArmedBracket({ phase: 'armed', armed: { direction: 'buy', limitEntry: 1, stopLossForLimit: 1, rationale: 'r', at: 500 } }, id)).toBe(false);   // mode 無し ≠ 'range'
  });
});

describe('sameBracketShape(実質同一形の判定)', () => {
  const fade = (): ArmedBracket => ({ direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
    upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
    lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } });
  it('同一形は true(at/settings は無視)', () => {
    expect(sameBracketShape(fade(), { ...fade(), at: 9999 })).toBe(true);
  });
  it('レッグ種別が変わる(fade→breakout)は false', () => {
    const bo: ArmedBracket = { direction: 'buy', rationale: 'r', at: 0, mode: 'range', range: {
      upper: { side: 'buy', type: 'stop', entry: 38400, stopLoss: 38350 },
      lower: { side: 'sell', type: 'stop', entry: 38100, stopLoss: 38150 } } };
    expect(sameBracketShape(fade(), bo)).toBe(false);
  });
  it('directional vs range は false', () => {
    const dir: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 0 };
    expect(sameBracketShape(fade(), dir)).toBe(false);
  });
});

// ─── SignalEngine: 平均約定所要が約定ごとに更新される(feed の armed→filled) ───
describe('SignalEngine 平均約定所要(feed の fill で更新)', () => {
  let dir: string;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-avgfill-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });
  it('サンプル<5 は DEFAULT・約定を重ねると実測平均になる', async () => {
    const eng = new SignalEngine(cfgA);
    await eng.start();
    expect(eng._peekAvgFillMs()).toBe(DEFAULT_AVG_FILL_MS);   // サンプル0<5=フォールバック
    for (let i = 0; i < 5; i++) {
      const at = i * 1_000_000;
      eng._setArmedForTest({ direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at });
      eng.feed(37945, at + 120_000);   // 指値約定=armed→filled・所要120s を記録
      expect(eng.getPhase()).toBe('filled');
    }
    expect(eng._peekAvgFillMs()).toBe(120_000);   // 5件そろって実測平均
    eng.stop();
  });
});

// ─── SignalEngine.applyRangeReevalResult(再評価反映の統合) ───
describe('SignalEngine レンジ再評価反映(applyRangeReevalResult)', () => {
  let dir: string;
  let origAppData: string | undefined;
  const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
  // 現行 = レンジ両指値(fade)。上=売り指値38400 / 下=買い指値38100。現在値38250。signalId=1。
  const fadeArmed = (): ArmedBracket => ({ direction: 'buy', rationale: 'range-fade', at: 500, mode: 'range', range: {
    upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
    lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } });
  const fadeSignal = (): CurrentSignal => armedToCurrentSignal(fadeArmed(), 1);
  const id: ArmedIdentity = { armedAt: 500, signalId: 1, mode: 'range' };
  // ブレイク両逆指値(breakout): 上=買い逆指値38400 / 下=売り逆指値38100。checkRangeSanity 通過。
  const breakoutResult = { ok: true as const, plan: { direction: 'range' as const, rationale: 'breakout', refPrice: 38250, range: {
    upper: { side: 'buy' as const, type: 'stop' as const, entry: 38400, stopLoss: 38350 },
    lower: { side: 'sell' as const, type: 'stop' as const, entry: 38100, stopLoss: 38150 } } } };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-reeval-'));
    origAppData = process.env.APPDATA;
    process.env.APPDATA = dir;
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    rmSync(dir, { recursive: true, force: true });
  });

  it('妥当なブレイク(fade と異なる)→ armed を差替え(新 signalId・両レッグ type:stop)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setArmedForTest(fadeArmed(), fadeSignal());
    const r = eng.applyRangeReevalResult(breakoutResult, id, 800_000, 38250);
    expect(r).toBe('swap');
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.signalId).toBe(2);               // 新 signalId(1→2)を1回采番
    expect(sig.mode).toBe('range');
    expect(sig.range?.upper?.type).toBe('stop'); // fade(limit)→breakout(stop)
    expect(sig.range?.lower?.type).toBe('stop');
    // SSE state に新シグナル(両逆指値)が載る。
    const s = eng.getState(800_100);
    expect(s.signal?.signalId).toBe(2);
    expect(s.signal?.range?.upper?.type).toBe('stop');
  });

  it('direction:none → 未約定レンジを取消して FLAT(cancel)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setArmedForTest(fadeArmed(), fadeSignal());
    const noneResult = { ok: true as const, plan: { direction: 'none' as const, rationale: '崩れ', refPrice: 38250 } };
    expect(eng.applyRangeReevalResult(noneResult, id, 800_000, 38250)).toBe('cancel');
    expect(eng.getPhase()).toBe('flat');
    // ★取消でも lastExitedSignalId=旧signalId を露出する(trade2 が stale 両指値を取消追従できる・エバリュ HIGH 修正)。
    expect(eng.getState(800_100).lastExitedSignalId).toBe(1);
  });

  it('実質同じ fade を返す → 差替えない(keep・signalId 不変)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setArmedForTest(fadeArmed(), fadeSignal());
    const sameResult = { ok: true as const, plan: { direction: 'range' as const, rationale: '維持', refPrice: 38250, range: {
      upper: { side: 'sell' as const, type: 'limit' as const, entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy' as const, type: 'limit' as const, entry: 38100, stopLoss: 38050 } } } };
    expect(eng.applyRangeReevalResult(sameResult, id, 800_000, 38250)).toBe('keep');
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);   // 不変
  });

  it('★async 同一性再チェック: 差替え/約定済み(別 armed・signalId 不一致・非armed)なら破棄(stale)', () => {
    const eng = new SignalEngine(cfgA);
    // 解決時に flat(=もう未約定 armed でない)。
    expect(eng.applyRangeReevalResult(breakoutResult, id, 800_000, 38250)).toBe('stale');
    // 別 armed(at 変化)。
    eng._setArmedForTest({ ...fadeArmed(), at: 9999 }, { ...fadeSignal(), signalId: 5 });
    expect(eng.applyRangeReevalResult(breakoutResult, id, 800_000, 38250)).toBe('stale');
    // signalId 不一致(currentSignal が入れ替わった)。
    eng._setArmedForTest(fadeArmed(), { ...fadeSignal(), signalId: 9 });
    expect(eng.applyRangeReevalResult(breakoutResult, id, 800_000, 38250)).toBe('stale');
  });

  it('LLM 失敗 / サニティ不通過 は差替えない(reject・維持)', () => {
    const eng = new SignalEngine(cfgA);
    eng._setArmedForTest(fadeArmed(), fadeSignal());
    expect(eng.applyRangeReevalResult({ ok: false as const, error: 'x' }, id, 800_000, 38250)).toBe('reject');
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);
    // サニティ不通過: upper 逆指値が現在値の下(即約定)=checkRangeSanity NG。
    const bad = { ok: true as const, plan: { direction: 'range' as const, rationale: 'bad', refPrice: 38250, range: {
      upper: { side: 'buy' as const, type: 'stop' as const, entry: 38100, stopLoss: 38050 } } } };
    expect(eng.applyRangeReevalResult(bad, id, 800_000, 38250)).toBe('reject');
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);
  });
});

// ─── buildSettingsSnapshot: rangeReevalEnabled(レンジ使用時のみ・ADD-ONLY) ───
describe('buildSettingsSnapshot rangeReevalEnabled(ADD-ONLY・レンジ使用時のみ)', () => {
  let dir: string;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-reeval-snap-'));
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
  it('既定(レンジOFF)は rangeReevalEnabled 欠落=既存 snapshot JSON と byte 一致', () => {
    const s = buildSettingsSnapshot();
    expect('rangeReevalEnabled' in s).toBe(false);
  });
  it('レンジON のとき rangeReevalEnabled を載せる(既定=true)', () => {
    writeConfig({ scalpRangeEnabled: true });
    expect(buildSettingsSnapshot().rangeReevalEnabled).toBe(true);
  });
  it('レンジON かつ rangeReevalEnabled=false のとき false を載せる', () => {
    writeConfig({ scalpRangeEnabled: true, rangeReevalEnabled: false });
    expect(buildSettingsSnapshot().rangeReevalEnabled).toBe(false);
  });
});
