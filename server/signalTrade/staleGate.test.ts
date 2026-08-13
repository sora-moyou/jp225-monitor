import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ★通過済みレッグの veto(stale plan veto)の統合検証。
//   monitor は ARM 前サニティを plan.refPrice(チャート撮影時の価格)に対して行う(=そこは設計判断として不変)。
//   画像生成+LLM 応答に数秒〜十数秒かかる間に価格が動くため、ARM 時点の live 価格では既にエントリーを
//   通過している計画が届き、武装すると次tickで即約定する(=現実には執行できない取引が紙の成績に混ざる)。
//   ここでは runScalpPlanWithChart を差し替え、live 価格(cache)を動かして
//     - 通過済みレッグは武装しない(片レッグだけ落ちる)
//     - 全レッグ通過済みなら ARM しない(=見送り・アンカー抑止)
//     - live 価格が取れなければ従来どおり ARM する
//   を検証する。engine は動的 import でランナーを読むため vi.mock で差し替える。
vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';
import { _setExitImpl } from './exit/index.js';
import { armedToCurrentSignal, type ArmedBracket, type CurrentSignal, type HeldIdentity, type ArmedIdentity, type OpenPosition } from './decisions.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

// 2026-07-16(木) 10:30 JST = Day セッション → inPollWindow=true。
const NOW = Date.UTC(2026, 6, 16, 1, 30, 0);
const REF = 38000;          // 計画の参照価格(チャート撮影時)。
const PLAN_INTERVAL_MS = 3 * 60_000;   // resolvePlanIntervalMs 既定。

function newEngineA(): SignalEngine {
  return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
}

/** live 価格(NIY=F)を cache に据える(engine は getPrices() から読む)。null で「取れない」状態にする。 */
function setLive(price: number | null): void {
  if (price == null) { setPrices([]); return; }
  setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW, stale: false }]);
}

/** ★フィード断: priceLoop は取得失敗時に「前回値を古い timestamp のまま stale:true で持ち越す」。
 *  この持ち越し価格でゲートを判定してはいけない(抑止漏れ/誤抑止の双方が起きる)。 */
function setStaleLive(price: number): void {
  setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW - 60_000, stale: true }]);
}

/** feed をトリガーにした fire-and-forget な計画要求(async)を待つ。 */
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(mockRunner).toHaveBeenCalled());
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let dir: string;
let origAppData: string | undefined;
let origHome: string | undefined;
let origUserProfile: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp225-stale-'));
  origAppData = process.env.APPDATA;
  origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
  process.env.APPDATA = dir;                                   // persistSignalIdCounter を temp DB へ隔離。
  process.env.HOME = dir; process.env.USERPROFILE = dir;       // config(ドテン許可など)を temp へ隔離。
  resetConfigCache();
  mockRunner.mockReset();
  setLive(null);
});
afterEach(() => {
  _setExitImpl(null);
  setPrices([]);
  if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
  if (origHome !== undefined) process.env.HOME = origHome; else delete process.env.HOME;
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile; else delete process.env.USERPROFILE;
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

/** temp HOME に config.json を書く(ドテン許可などの knob をテスト内で切り替える)。 */
function writeConfig(obj: Record<string, unknown>): void {
  mkdirSync(join(dir, '.jp225-monitor'), { recursive: true });
  writeFileSync(join(dir, '.jp225-monitor', 'config.json'), JSON.stringify(obj), 'utf-8');
  resetConfigCache();
}

// ─── ゲートに渡る live 価格は「新鮮値のみ」 ─────────────────────────────
describe('livePrice(ゲート入力): 新鮮値のみ・stale/欠落は null', () => {
  it('新鮮な NIY=F はその価格 / stale は null / 欠落は null / 別銘柄だけでも null', () => {
    const eng = newEngineA();
    setLive(38000);
    expect(eng._peekLivePrice()).toBe(38000);
    setStaleLive(38000);
    expect(eng._peekLivePrice()).toBeNull();          // ★持ち越された古い価格は使わない
    setPrices([]);
    expect(eng._peekLivePrice()).toBeNull();
    setPrices([{ symbol: 'JPY=X', price: 155, changePercent: 0, timestamp: NOW, stale: false }]);
    expect(eng._peekLivePrice()).toBeNull();
  });
});

describe('stale plan veto(A・flat→ARM): 通過済みレッグを武装しない', () => {
  // buy OCO: 指値37950(下・LC37900)/ 逆指値38100(上・LC38050)。refPrice=38000 に対しては正当(サニティ通過)。
  const buyOco: AiPlan = {
    direction: 'buy', limitEntry: 37950, stopEntry: 38100,
    stopLossForLimit: 37900, stopLossForStop: 38050, rationale: 'r', refPrice: REF,
  };

  it('live が指値を通過(37945)→ 指値レッグを落として 逆指値レッグだけ ARM', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: buyOco });
    setLive(37945);   // ★指値37950 を 5円 行き過ぎ=既に約定条件を満たす。
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.limitEntry).toBeUndefined();     // 通過済み=武装しない
    expect(sig.stopLossForLimit).toBeUndefined();
    expect(sig.stopEntry).toBe(38100);         // まだ通過していないレッグは従来どおり武装
    expect(sig.stopLossForStop).toBe(38050);
  });

  it('live が逆指値をタッチ(38100)→ 逆指値レッグを落として 指値レッグだけ ARM', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: buyOco });
    setLive(38100);   // ★逆指値はタッチで約定=既に約定条件を満たす。
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.stopEntry).toBeUndefined();
    expect(sig.limitEntry).toBe(37950);
  });

  it('あと1円(37946 / 38099)では従来どおり両レッグ ARM(境界)', async () => {
    for (const live of [37946, 38099]) {
      mockRunner.mockReset();
      mockRunner.mockResolvedValue({ ok: true, plan: buyOco });
      setLive(live);
      const eng = newEngineA();
      await eng.start();
      eng.feed(REF, NOW);
      await settle();
      const sig = eng.getCurrentSignal()!;
      expect({ live, limit: sig.limitEntry, stop: sig.stopEntry }).toEqual({ live, limit: 37950, stop: 38100 });
    }
  });

  it('単レッグ計画が通過済み(live=37945)→ ARM しない=見送り(アンカー抑止で再要求もしない)', async () => {
    const limitOnly: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: REF };
    mockRunner.mockResolvedValue({ ok: true, plan: limitOnly });
    setLive(37945);
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('flat');
    expect(eng.getCurrentSignal()).toBeNull();
    expect(mockRunner).toHaveBeenCalledTimes(1);
    // 見送り(none)と同じ扱い: アンカーが立つので間隔経過(節目未クロス)でも再要求しない。
    eng.feed(REF, NOW + PLAN_INTERVAL_MS + 1000);
    await Promise.resolve();
    expect(mockRunner).toHaveBeenCalledTimes(1);
  });

  it('★live 価格が取れない(cache 空)→ 従来どおり両レッグ ARM(新しい抑止で取引を止めない)', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: buyOco });
    setLive(null);
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.limitEntry).toBe(37950);
    expect(sig.stopEntry).toBe(38100);
  });

  it('★フィード断(stale:true の持ち越し価格)→ 判定せず従来どおり両レッグ ARM', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: buyOco });
    setStaleLive(37945);   // 新鮮なら指値レッグを落とす価格。だが stale=持ち越し=判定に使ってはいけない。
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.limitEntry).toBe(37950);   // ★古い価格でレッグを落とさない(誤抑止しない)
    expect(sig.stopEntry).toBe(38100);
  });

  it('★フィード断(stale)+単レッグ計画 → 見送りにせず従来どおり ARM(新しい抑止で取引を止めない)', async () => {
    const limitOnly: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: REF };
    mockRunner.mockResolvedValue({ ok: true, plan: limitOnly });
    setStaleLive(37945);
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.limitEntry).toBe(37950);
  });

  it('range 両指値: live が上レッグを通過(38105)→ 上を落として下レッグだけの片面 range を ARM', async () => {
    const rangePlan: AiPlan = {
      direction: 'range', rationale: 'r', refPrice: REF, range: {
        upper: { side: 'sell', type: 'limit', entry: 38100, stopLoss: 38150 },
        // ★下レッグは live(38105)から 200円以内 に置く。上が落ちて単レッグ化した後は
        //   ARM 時再検証(=trade2 と同じ MAX_ENTRY_DISTANCE_YEN=200円)が効くため、
        //   37900(=205円)では「脚が落ちる」以外の理由で落ちてしまい、このテストの意図(片面 range の ARM)を検証できない。
        lower: { side: 'buy', type: 'limit', entry: 37950, stopLoss: 37850 },
      },
    };
    mockRunner.mockResolvedValue({ ok: true, plan: rangePlan });
    setLive(38105);   // 上=売り指値38100 を 5円 行き過ぎ。
    const eng = newEngineA();
    await eng.start();
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const sig = eng.getCurrentSignal()!;
    expect(sig.mode).toBe('range');
    expect(sig.range?.upper).toBeUndefined();
    expect(sig.range?.lower).toMatchObject({ side: 'buy', entry: 37950 });
  });
});

describe('stale plan veto(B・仮想取引専用)も同じ規約で適用される', () => {
  it('B でも通過済みレッグは武装しない(単レッグなら ARM しない)', async () => {
    const limitOnly: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: REF };
    mockRunner.mockResolvedValue({ ok: true, plan: limitOnly });
    setLive(37945);
    const engB = new SignalEngine({ profile: 'B', systemTag: 'B', broadcastType: 'signalTradeB', maintainsCurrentSignal: false });
    await engB.start();
    engB.feed(REF, NOW);
    await settle();
    expect(engB.getPhase()).toBe('flat');
  });
});

describe('stale plan veto(ドテン反転の反対ブラケット)', () => {
  const heldBuySig: CurrentSignal = { signalId: 1, at: 500, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900 };
  const heldBuyPos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: 500 };
  const id: HeldIdentity = { at: 500, direction: 'buy', signalId: 1 };

  it('反対ブラケットの唯一のレッグが通過済み → 反転しない(reject・P も決済しない)', () => {
    const sellLimitOnly = { ok: true as const, plan: { direction: 'sell' as const, limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: REF } };
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // 第4引数=P の成行決済価格 / 第5引数=ゲート用 live(★既定 null=素通し なので明示的に渡す)。
    // live=38055 → 売り指値38050 を 5円 行き過ぎ=即約定。
    expect(eng.applyHeldEvalResult(sellLimitOnly, id, 2000, 38055, 38055)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);   // 采番も currentSignal も不変
  });

  it('反対 OCO の片レッグだけ通過済み → 生き残ったレッグで反転する', () => {
    const sellOco = { ok: true as const, plan: {
      direction: 'sell' as const, limitEntry: 38050, stopEntry: 37950,
      stopLossForLimit: 38100, stopLossForStop: 38000, rationale: '反転', refPrice: REF } };
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // ★ゲートを効かせるには live を明示的に渡す(既定 null=素通し)。
    expect(eng.applyHeldEvalResult(sellOco, id, 2000, 38055, 38055)).toBe('doten');
    const sig = eng.getCurrentSignal()!;
    expect(sig.signalId).toBe(2);
    expect(sig.doten).toBe(true);
    expect(sig.limitEntry).toBeUndefined();   // 通過済みの指値は武装しない
    expect(sig.stopEntry).toBe(37950);
  });

  it('live=null(取得不能/stale・★既定値でもある)なら判定せず従来どおり両レッグで反転する', () => {
    const sellOco = { ok: true as const, plan: {
      direction: 'sell' as const, limitEntry: 38050, stopEntry: 37950,
      stopLossForLimit: 38100, stopLossForStop: 38000, rationale: '反転', refPrice: REF } };
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // 第4引数=P の成行決済価格(38055)/ 第5引数=ゲート用 live(null=素通し)。
    expect(eng.applyHeldEvalResult(sellOco, id, 2000, 38055, null)).toBe('doten');
    const sig = eng.getCurrentSignal()!;
    expect(sig.limitEntry).toBe(38050);   // ★落とさない
    expect(sig.stopEntry).toBe(37950);
  });

  it('★live 省略(渡し忘れ)は fail-safe に素通し=決済価格でゲート判定しない', () => {
    const sellOco = { ok: true as const, plan: {
      direction: 'sell' as const, limitEntry: 38050, stopEntry: 37950,
      stopLossForLimit: 38100, stopLossForStop: 38000, rationale: '反転', refPrice: REF } };
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    // 決済価格 38055 は「指値38050 を 5円 行き過ぎ」だが、live 未指定なら判定しない(既定=null)。
    // ★既定が price だと、渡し忘れた呼び出し元が静かに旧挙動(決済価格でレッグを落とす)へ戻ってしまう。
    expect(eng.applyHeldEvalResult(sellOco, id, 2000, 38055)).toBe('doten');
    const sig = eng.getCurrentSignal()!;
    expect(sig.limitEntry).toBe(38050);
    expect(sig.stopEntry).toBe(37950);
  });

  // ★呼び出し元(engine の held-eval 経路)が「新鮮値のみ」を渡していることの検証。
  //   同じキャッシュ価格 38055 でも stale=true なら veto は働かない(=古い持ち越し価格で落とさない)。
  describe('呼び出し元が渡す live は新鮮値のみ(feed からの実経路)', () => {
    const sellOco: AiPlan = {
      direction: 'sell', limitEntry: 38050, stopEntry: 37950,
      stopLossForLimit: 38100, stopLossForStop: 38000, rationale: '反転', refPrice: REF,
    };
    /** ドテン許可ONで filled 状態の A エンジンを作り、feed で held-eval を1回走らせる。 */
    async function runHeldEval(): Promise<SignalEngine> {
      writeConfig({ dotenEnabled: true });
      mockRunner.mockResolvedValue({ ok: true, plan: sellOco });
      const eng = newEngineA();
      await eng.start();
      eng._setFilledForTest(heldBuyPos, heldBuySig);
      eng.feed(38055, NOW);      // 保有中(LC37950 未達)→ held-eval を要求
      await settle();
      return eng;
    }
    it('新鮮な 38055 → 通過済みの指値レッグを落として反転', async () => {
      setLive(38055);
      const eng = await runHeldEval();
      expect(eng.getCurrentSignal()?.limitEntry).toBeUndefined();
      expect(eng.getCurrentSignal()?.stopEntry).toBe(37950);
    });
    it('★stale な 38055(フィード断の持ち越し)→ 判定せず両レッグで反転', async () => {
      setStaleLive(38055);
      const eng = await runHeldEval();
      expect(eng.getCurrentSignal()?.limitEntry).toBe(38050);
      expect(eng.getCurrentSignal()?.stopEntry).toBe(37950);
    });
  });
});

describe('stale plan veto(レンジ再評価の差替え先)', () => {
  const fadeArmed = (): ArmedBracket => ({ direction: 'buy', rationale: 'range-fade', at: 500, mode: 'range', range: {
    upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
    lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 } } });
  const id: ArmedIdentity = { armedAt: 500, signalId: 1, mode: 'range' };
  // ★下レッグは live(38400)から 200円以内 に置く。上が落ちて単レッグ化した後は ARM 時再検証
  //   (=trade2 と同じ MAX_ENTRY_DISTANCE_YEN=200円)が効くため、38100(=300円)では「脚が落ちる」以外の
  //   理由で差替えが拒否され、このテストの意図(生き残ったレッグだけで差替える)を検証できない。
  const breakoutResult = { ok: true as const, plan: { direction: 'range' as const, rationale: 'breakout', refPrice: 38250, range: {
    upper: { side: 'buy' as const, type: 'stop' as const, entry: 38400, stopLoss: 38350 },
    lower: { side: 'sell' as const, type: 'stop' as const, entry: 38230, stopLoss: 38280 } } } };

  it('差替え先の片レッグが通過済み(live=38400 タッチ)→ 生き残ったレッグだけで差替え', () => {
    const eng = newEngineA();
    eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
    expect(eng.applyRangeReevalResult(breakoutResult, id, 800_000, 38400)).toBe('swap');
    const sig = eng.getCurrentSignal()!;
    expect(sig.signalId).toBe(2);
    expect(sig.range?.upper).toBeUndefined();
    expect(sig.range?.lower).toMatchObject({ type: 'stop', entry: 38230 });
  });

  it('差替え先の唯一のレッグが通過済み → 差替えない(reject・現状維持)', () => {
    const lowerOnly = { ok: true as const, plan: { direction: 'range' as const, rationale: 'breakout', refPrice: 38250, range: {
      lower: { side: 'sell' as const, type: 'stop' as const, entry: 38100, stopLoss: 38150 } } } };
    const eng = newEngineA();
    eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
    expect(eng.applyRangeReevalResult(lowerOnly, id, 800_000, 38100)).toBe('reject');
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.signalId).toBe(1);            // 采番不変
    expect(eng.getCurrentSignal()?.range?.upper?.type).toBe('limit');   // 現行 fade のまま
  });

  it('live 価格が非有限(NaN)/取得不能(null)→ 従来どおり差替える', () => {
    for (const live of [NaN, null]) {
      const eng = newEngineA();
      eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
      expect(eng.applyRangeReevalResult(breakoutResult, id, 800_000, live)).toBe('swap');
      const sig = eng.getCurrentSignal()!;
      expect(sig.range?.upper?.type).toBe('stop');
      expect(sig.range?.lower?.type).toBe('stop');
    }
  });

  // ★呼び出し元(engine の range-reeval 経路)が「新鮮値のみ」を渡していることの検証。
  //   要求時価格へのフォールバック(?? price)は撤去済み=stale/欠落なら素通し。
  describe('呼び出し元が渡す live は新鮮値のみ(feed からの実経路)', () => {
    const REEVAL_NOW = NOW + 30 * 60_000;              // 十分に間隔が空いた時刻。
    const ARMED_AT = REEVAL_NOW - 10 * 60_000;         // ARM から10分(閾値4.5分超・タイムアウト15分未満)。
    const fade = (): ArmedBracket => ({ ...fadeArmed(), at: ARMED_AT });
    /** ARMED(レンジ両指値)の A エンジンを作り、feed で range-reeval を1回走らせる。 */
    async function runReeval(): Promise<SignalEngine> {
      mockRunner.mockResolvedValue(breakoutResult);
      const eng = newEngineA();
      await eng.start();
      eng._setArmedForTest(fade(), armedToCurrentSignal(fade(), 1));
      eng.feed(38250, REEVAL_NOW);   // レンジ内(未約定)→ 再評価を要求
      await settle();
      return eng;
    }
    it('新鮮な 38400 → 通過済みの上レッグを落として差替え', async () => {
      setLive(38400);
      const eng = await runReeval();
      expect(eng.getCurrentSignal()?.range?.upper).toBeUndefined();
      expect(eng.getCurrentSignal()?.range?.lower).toMatchObject({ type: 'stop', entry: 38230 });
    });
    it('★stale な 38400(フィード断の持ち越し)→ 判定せず両レッグで差替え', async () => {
      setStaleLive(38400);
      const eng = await runReeval();
      expect(eng.getCurrentSignal()?.range?.upper).toMatchObject({ type: 'stop', entry: 38400 });
      expect(eng.getCurrentSignal()?.range?.lower).toMatchObject({ type: 'stop', entry: 38230 });
    });
  });
});
