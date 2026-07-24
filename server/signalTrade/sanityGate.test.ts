import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ★正規シグナルのゲート(engine.maybeRequestPlan 内で checkSanity を先取り適用)の統合検証。
//   runScalpPlanWithChart を差し替え、返す AiPlan の構造に応じて
//     - サニティ不通過 → 抑止(ARM しない・currentSignal 更新しない・アンカー設定で再要求も抑止)
//     - 通過 → ARM + currentSignal 設定(従来どおり)
//   を検証する。engine は動的 import でランナーを読むため vi.mock で差し替える。
vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { _setExitImpl } from './exit/index.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

// 2026-07-16(木) 10:30 JST = Day セッション → inPollWindow=true。
const NOW = Date.UTC(2026, 6, 16, 1, 30, 0);
const PRICE = 38000;
const PLAN_INTERVAL_MS = 3 * 60_000;   // resolvePlanIntervalMs 既定。

function newEngineA(): SignalEngine {
  return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
}

/** feed をトリガーにした fire-and-forget な計画要求(async)を待つ。 */
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(mockRunner).toHaveBeenCalled());
  // 計画反映(state 遷移)まで microtask を数回流す。
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => { resetConfigCache(); mockRunner.mockReset(); });
afterEach(() => _setExitImpl(null));

describe('正規シグナルのゲート(A): サニティ不通過は抑止', () => {
  it('向き違い(buy 指値が現値の上)→ ARM せず currentSignal も設定しない', async () => {
    const bad: AiPlan = { direction: 'buy', limitEntry: 38050, stopLossForLimit: 38000, rationale: 'r', refPrice: PRICE };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
  });

  it('抑止後はアンカー設定により、間隔経過しても(節目未クロス)再要求しない', async () => {
    const bad: AiPlan = { direction: 'buy', limitEntry: 38050, stopLossForLimit: 38000, rationale: 'r', refPrice: PRICE };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(mockRunner).toHaveBeenCalledTimes(1);
    // 間隔(3分)経過・価格変わらず(節目未クロス)→ アンカー抑止で再要求されない。
    eng.feed(PRICE, NOW + PLAN_INTERVAL_MS + 1000);
    await Promise.resolve();
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });

  it('単レッグ距離>200 → 抑止', async () => {
    const bad: AiPlan = { direction: 'buy', limitEntry: 37700, stopLossForLimit: 37650, rationale: 'r', refPrice: PRICE };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
  });

  it('ブラケット幅>400 → 抑止', async () => {
    const bad: AiPlan = {
      direction: 'buy', limitEntry: 37700, stopEntry: 38200,
      stopLossForLimit: 37650, stopLossForStop: 38150, rationale: 'r', refPrice: PRICE,
    };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
  });

  it('レンジ違反(upper が現値の上にない)→ 抑止', async () => {
    const bad: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: PRICE,
      range: {
        upper: { side: 'sell', type: 'limit', entry: 37900, stopLoss: 37950 },
        lower: { side: 'buy', type: 'limit', entry: 37800, stopLoss: 37750 },
      },
    };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
  });
});

describe('正規シグナルのゲート(A): 検証は plan.refPrice 基準(要求時 anchorPrice ではない)', () => {
  // feed(price) の price が「要求時点の anchorPrice」になる。LLM レイテンシ中に価格がドリフトすると
  // plan.refPrice(計画ビルド時=各レッグが挟む基準)と anchorPrice が乖離する。ゲートは refPrice で判定すべき。

  it('refPrice を挟む正当な OCO は、古い anchorPrice の逆側でも PASS(過剰抑止しない)', async () => {
    // 要求時 anchor=38000。LLM 中に下落し refPrice=37600。計画は refPrice を挟む buy OCO(37550/37700)。
    // 旧実装(anchor 基準)は stopEntry 37700 < 38000 で「逆指値が現値の上にない」と誤判定=抑止していた。
    // 新実装(refPrice 基準)は 37550<37600<37700 で正当 → ARM。
    const good: AiPlan = {
      direction: 'buy', limitEntry: 37550, stopEntry: 37700,
      stopLossForLimit: 37500, stopLossForStop: 37650, rationale: 'r', refPrice: 37600,
    };
    mockRunner.mockResolvedValue({ ok: true, plan: good });
    const eng = newEngineA();
    await eng.start();
    eng.feed(38000, NOW);   // ★anchorPrice=38000(refPrice と乖離)。
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal();
    expect(sig?.direction).toBe('buy');
    expect(sig?.limitEntry).toBe(37550);
    expect(sig?.stopEntry).toBe(37700);
  });

  it('refPrice の逆側にある不正な計画は、anchorPrice では通っても抑止(乖離ガード)', async () => {
    // anchor=38000 なら buy 指値 37800<38000 かつ距離200 で通ってしまうが、refPrice=37600 の上(37800>37600)ゆえ不正。
    // 新実装は refPrice 基準で NG=抑止(trade2 も refPrice≒受信時価格で REJECT する構造)。
    const bad: AiPlan = {
      direction: 'buy', limitEntry: 37800, stopLossForLimit: 37750, rationale: 'r', refPrice: 37600,
    };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const eng = newEngineA();
    await eng.start();
    eng.feed(38000, NOW);   // ★anchorPrice=38000(これだと通ってしまう)。
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
  });
});

describe('正規シグナルのゲート(A): 通過は従来どおり ARM + currentSignal', () => {
  it('サニティ通過の buy OCO → ARM して currentSignal を設定', async () => {
    const good: AiPlan = {
      direction: 'buy', limitEntry: 37950, stopEntry: 38100,
      stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', refPrice: PRICE,
    };
    mockRunner.mockResolvedValue({ ok: true, plan: good });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal();
    expect(sig).not.toBeNull();
    expect(sig?.direction).toBe('buy');
    expect(sig?.limitEntry).toBe(37950);
    expect(sig?.stopEntry).toBe(38100);
  });
});

describe('正規シグナルのゲート(B): サニティは maintainsCurrentSignal に依らず適用', () => {
  it('B でもサニティ不通過は ARM しない(紙)', async () => {
    const bad: AiPlan = { direction: 'buy', limitEntry: 38050, stopLossForLimit: 38000, rationale: 'r', refPrice: PRICE };
    mockRunner.mockResolvedValue({ ok: true, plan: bad });
    const engB = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });
    await engB.start();
    engB.feed(PRICE, NOW);
    await settle();
    expect(engB.getPhase()).toBe('flat');
  });

  it('B でもサニティ通過は ARM(currentSignal は B の契約どおり露出しない)', async () => {
    const good: AiPlan = {
      direction: 'buy', limitEntry: 37950, stopEntry: 38100,
      stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', refPrice: PRICE,
    };
    mockRunner.mockResolvedValue({ ok: true, plan: good });
    const engB = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });
    await engB.start();
    engB.feed(PRICE, NOW);
    await settle();
    expect(engB.getPhase()).toBe('armed');
    expect(engB.getCurrentSignal()).toBeNull();   // B は露出しない。
  });
});
