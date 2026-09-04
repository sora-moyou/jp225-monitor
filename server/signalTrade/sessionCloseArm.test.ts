import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ★引けを跨いだ武装をしない / 引けで未約定ブラケットを取り消す、の検証。
//
// ─── 入力は実記録そのもの(2026-09-04 金・日中引け) ─────────────────────────
//   15:45:00.000  引け全決済が発火 → sig 1952 を決済 → FLAT
//   15:45:06.735  ★引けを過ぎているのに、次の計画(sig 1953)を作って武装した
//   15:45:01.392  ★sig 1953 の context_at(= **計画実行を開始した時刻**。ティックの時刻ではない)。
//                 要求 tick はそれ以前なので **引けの後にティックが来ていた**
//                 —— リーダーが signal_plans を照会した実測。用語と出所は core/session.ts の
//                    `inTradingSession` の doc(評価者によるティック表の実測も併記)
//   17:00:03      追従側(trade2)では同じブラケットが 75分前の価格で約定し、実損が出た
//
// ★★訂正(2026-09-05): このファイルは当初「15:45〜17:00 はティック0件」という前提で書いていたが、
//   **それは誤りだった**。`ticks` 表がその帯で 0件なのは collector が場外を捨てて書くからで、
//   priceLoop は inPollWindow でゲートするので **エンジンは 15:55:00.000 まで実ティックを受け取り続ける**。
//   → 引け後の武装は「放置されるだけ」では済まず、その帯で **約定し得る**。
//
// ★否定対照(直す前は通り、直したら通らない入力)は、この時刻をそのまま使う:
//   ・旧関門 inPollWindow(15:45:06.735) は **true**(引けの10分後まで開いている)= 通っていた
//   ・新関門 inTradingSession(15:45:06.735) は **false** = 止まる
//   さらに engine を実際に走らせ、同じ時刻で ARM しないことまで見る(関数単体の主張で終わらせない)。

vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { _setExitImpl } from './exit/index.js';
import {
  advance, computeWaitReason, armedToCurrentSignal,
  type EngineState, type ArmedBracket, type OpenPosition, type CurrentSignal, type HeldIdentity, type ArmedIdentity,
} from './decisions.js';
import { inPollWindow, inTradingSession, sameTradingSession } from '../../core/session.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

/** 2026-09-04(金)の JST 壁時計 → epoch ms。 */
const jst = (h: number, mi: number, s = 0, ms = 0): number => Date.UTC(2026, 8, 4, h - 9, mi, s, ms);

const T_1544_59 = jst(15, 44, 59);        // 引けの1秒前(場中)
const T_CLOSE = jst(15, 45, 0, 0);        // ★引け(15:45:00.000)= 全決済が発火した瞬間
const T_ARMED = jst(15, 45, 6, 735);      // ★実記録: 武装してしまった時刻
const T_1540 = jst(15, 40, 0);            // 引けの5分前(=既定の待ち時間15分は **まだ切れていない**)
/** 応答が返るまでの経過時間(このテストの仮定値)。実記録の武装は引けの 6.735秒後だった。
 *  ★「6.735秒 = LLM の往復レイテンシ」とは言えない: 起点の 15:45:00.000 は flattenAtSessionClose が
 *    `exitT: closeMs` で **合成した時刻** で、ティックの時刻ではない。言えるのは「往復は 6.735秒 以下」まで。
 *  ★ここで欲しいのは「解決が引けを跨いだ」ことだけなので、その範囲で最大の値を使う。 */
const LLM_LATENCY_MS = T_ARMED - T_1544_59;
const PRICE = 38000;

/** 健全な単レッグ buy(現値の 50円下に指値・LC はさらに 50円下)。サニティ/鮮度ゲートは全て通る。 */
const GOOD_PLAN: AiPlan = {
  direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: PRICE,
};

function newEngineA(): SignalEngine {
  return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
}

/** feed が投げた fire-and-forget な計画要求(async)の解決を待つ。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => { resetConfigCache(); mockRunner.mockReset(); });
afterEach(() => { _setExitImpl(null); vi.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
describe('★否定対照: 15:45:06.735 を通していたのは inPollWindow の後ろマージン', () => {
  it('旧関門(inPollWindow)は通す / 新関門(inTradingSession)は通さない', () => {
    // 直す前に効いていた唯一の時間ゲートは inPollWindow だった。それはこの時刻を通す。
    expect(inPollWindow(T_ARMED)).toBe(true);
    expect(inPollWindow(T_CLOSE)).toBe(true);
    // 新しい関門は引けのちょうどその瞬間から false。
    expect(inTradingSession(T_CLOSE)).toBe(false);
    expect(inTradingSession(T_ARMED)).toBe(false);
    // ★直しすぎていないこと: 引けの1秒前(場中)は通す。
    expect(inTradingSession(T_1544_59)).toBe(true);
    expect(inPollWindow(T_1544_59)).toBe(true);
  });

  // ★「T_CLOSE が core/session.ts の引けと一致する」検証はここには置かない:
  //   sessionClose.test.ts:60/70 が同じことを既に検証しており、完全な重複だった(**評価者の指摘**で削除)。
});

// ═══════════════════════════════════════════════════════════════════════════
describe('★engine: 引けを過ぎたら計画を要求しない(課金も止める)', () => {
  it('引けちょうどのティック(=全決済したのと同じティック)では計画を要求しない', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: GOOD_PLAN });
    const eng = newEngineA();
    await eng.start();
    eng.feed(PRICE, T_CLOSE);
    await flush();
    // ★直す前は inPollWindow(T_CLOSE)=true だけを見ていたので、ここで要求が飛んでいた。
    expect(mockRunner).not.toHaveBeenCalled();
    expect(eng.getPhase()).toBe('flat');
  });

  it('★対照: 引けの1秒前(場中)なら従来どおり要求して武装する', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: GOOD_PLAN });
    const eng = newEngineA();
    await eng.start();
    // レイテンシを足さない(=応答も 15:44:59 相当)ので、従来どおり武装する。
    eng.feed(PRICE, T_1544_59);
    await flush();
    expect(mockRunner).toHaveBeenCalledTimes(1);
    expect(eng.getPhase()).toBe('armed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('★engine: 場中に要求した計画でも、応答が引けを過ぎたら武装しない(本命)', () => {
  it('要求 15:44:59(場中)→ 応答 15:45:06.735(引け後)= ARM しない', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: GOOD_PLAN });
    const eng = newEngineA();
    await eng.start();
    // ★要求は場中(feed の now = 15:44:59)。武装の可否は **応答が返った時点** で決まる。
    //   実時計を 6.735秒 進めて「解決が引けを跨いだ」状況を再現する(6.735秒の意味は LLM_LATENCY_MS の doc)
    //   (エンジンは tick の時計に実測レイテンシを足して判断する = 15:45:06.735 = 引けの後)。
    const wall0 = Date.now();
    eng.feed(PRICE, T_1544_59);
    vi.spyOn(Date, 'now').mockReturnValue(wall0 + LLM_LATENCY_MS);
    await flush();
    expect(mockRunner).toHaveBeenCalledTimes(1);   // 要求そのものは飛んでいる(場中だった)
    expect(eng.getPhase()).toBe('flat');           // ★武装していない
    expect(eng.getCurrentSignal()).toBeNull();
  });

  it('その帯の待機理由は既存の語「取引時間外」(新しい語彙を作らない)', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: GOOD_PLAN });
    const eng = newEngineA();
    await eng.start();
    const wall0 = Date.now();
    eng.feed(PRICE, T_1544_59);
    vi.spyOn(Date, 'now').mockReturnValue(wall0 + LLM_LATENCY_MS);
    await flush();
    expect(eng.getState(T_ARMED).waitReason).toEqual({ kind: 'closed' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('computeWaitReason: inSession', () => {
  const base = {
    phase: 'flat' as const, planning: false, inPollWindow: true, inSession: true,
    cooldownUntilMs: null, planSuppressedAnchor: null, priceKnown: true,
    levelRearmReady: false, safetyValveElapsed: false, now: T_ARMED,
  };
  it('inSession=false は closed(=既存の語)。inPollWindow が true でも出す', () => {
    expect(computeWaitReason({ ...base, inSession: false })).toEqual({ kind: 'closed' });
    // クールダウンや見送り抑止より先に出す(実際に止めているのは市場が無いこと)。
    expect(computeWaitReason({ ...base, inSession: false, cooldownUntilMs: T_ARMED + 90_000 }))
      .toEqual({ kind: 'closed' });
  });
  it('省略時は従来と完全に同じ(理由なし)', () => {
    const { inSession: _drop, ...noField } = base;
    expect(computeWaitReason(noField)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('★advance: 引けを跨いだ未約定ブラケットは取り消す(約定させない)', () => {
  /** 引けの5分前(15:40)に武装した buy 指値@37950。★待ち時間(既定15分)は引けの時点でまだ切れていない
   *  =ここで取り消せるのは「引け」だけ(タイムアウトの陰に隠れない条件を選んでいる)。 */
  const armedAt1540 = (waitMs?: number): EngineState => ({
    phase: 'armed',
    armed: {
      direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: T_1540,
      ...(waitMs != null ? { waitMs } : {}),
    },
  });

  it('★否定対照: 約定する価格でも、引けちょうどのティックでは約定せず取消になる', () => {
    // 37945 = 指値 37950 の 5円下 = detectFill が「約定」と判定する価格(engine.test.ts の規約)。
    // ★直す前は phase='filled' になっていた。
    const r = advance(armedAt1540(), 37945, T_CLOSE);
    expect(r.next.phase).toBe('flat');
    expect(r.armedTimedOut).toBe(true);
    expect(r.armedCancelReason).toBe('sessionClose');
    expect(r.recorded).toBeUndefined();          // 取消は決済ではない(台帳に行を作らない)
    expect(r.next.lastExit).toBeUndefined();
  });

  it('★対照: 引けの1秒前なら同じ価格で従来どおり約定する(直しすぎていない)', () => {
    const r = advance(armedAt1540(), 37945, T_1544_59);
    expect(r.next.phase).toBe('filled');
    expect(r.next.position?.entryPrice).toBe(37950);
    expect(r.armedTimedOut).toBeUndefined();
  });

  it('引け後の遅れたティック(夜間の寄り)でも約定しない', () => {
    // 待ち時間を 3時間に伸ばした架空のブラケット(= タイムアウトでは救われない条件)。
    // これが無いと「引けの取消」は待ち時間の陰に隠れて一度も効かない。
    const r = advance(armedAt1540(3 * 60 * 60_000), 37945, jst(17, 0, 3));
    expect(r.next.phase).toBe('flat');
    expect(r.armedCancelReason).toBe('sessionClose');
  });

  it('引けを跨いでいない未約定ブラケットは従来どおり armed のまま', () => {
    const r = advance(armedAt1540(), 38000, T_1544_59);   // 38000 は指値に未達
    expect(r.next.phase).toBe('armed');
    expect(r.armedTimedOut).toBeUndefined();
    expect(r.armedCancelReason).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('★advance の順序が不変であること(タイムアウト → 約定)', () => {
  // ★この順序が monitor の唯一の防波堤。17:00 の最初のティックで「75分前の価格で約定」しなかったのは
  //   タイムアウトを約定より先に見ているから(追従側の trade2 にはこの順序が無く、実損が出た)。
  //   ★既存テスト(engine.test.ts『armed が ARMED_TIMEOUT_MS 超で未約定 → 取消して flat』)は
  //     **約定しない価格**(38000)で確認しており、順序そのものは守っていなかった。ここで守る。
  it('待ち時間を超えたブラケットは、約定する価格が来ていても取消(=約定させない)', () => {
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1000 },
    };
    const r = advance(st, 37945, 1000 + 15 * 60_000);   // 37945 = 約定価格。だが時間切れ。
    expect(r.next.phase).toBe('flat');
    expect(r.armedTimedOut).toBe(true);
    expect(r.recorded).toBeUndefined();
  });

  it('引けの取消はタイムアウトの **後** に見る(既存の理由を書き換えない)', () => {
    // 15:00 武装・待ち15分 → 15:15 に時間切れ。ティックが来たのは引けの後(17:00)。
    // 両方成立するが、先に成立していたのはタイムアウトなので理由は 'timeout' のまま。
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: jst(15, 0, 0) },
    };
    const r = advance(st, 37945, jst(17, 0, 3));
    expect(r.armedTimedOut).toBe(true);
    expect(r.armedCancelReason).toBe('timeout');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★**評価者**が advance() を直接呼んで「保護ゼロ」を実証した入力そのもの。
//   事故が実際に生んだのは **引けの後に武装した** ブラケット(sig 1953 = 15:45:06.735)。
//   旧判定 `now >= nextSessionCloseMs(armed.at)` は、armed.at が引けの後だと「次の引け」が
//   翌 06:00 になるため、この形を1件も捕まえられなかった。
describe('★advance: 引けの「後」に武装したブラケットも取り消す(評価者の入力)', () => {
  const armedAfterClose = (waitMs?: number): EngineState => ({
    phase: 'armed',
    armed: {
      direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: T_ARMED,
      ...(waitMs != null ? { waitMs } : {}),
    },
  });

  it('★否定対照: at=15:45:06.735 / now=15:50:00 / 約定価格 → 取消(旧判定では filled だった)', () => {
    const r = advance(armedAfterClose(), 37945, jst(15, 50, 0));
    expect(r.next.phase).toBe('flat');
    expect(r.armedCancelReason).toBe('sessionClose');
    expect(r.recorded).toBeUndefined();
  });

  it('★否定対照: at=15:45:06.735 / now=17:00:03(夜間の寄り)/ 待ち時間3時間 → 取消', () => {
    // ★待ち時間を長くして未約定タイムアウトを無効化する。ここが取り消せないと、安全が
    //   「待ち時間の上限30分 < 引けから寄りまで75分」という **別の定数の偶然** に依存してしまう。
    const r = advance(armedAfterClose(3 * 60 * 60_000), 37945, jst(17, 0, 3));
    expect(r.next.phase).toBe('flat');
    expect(r.armedCancelReason).toBe('sessionClose');
  });

  it('夜間セッションは日付を跨いでも同一セッション扱い(取り消さない)', () => {
    // 22:00 武装 → 翌 02:00。どちらも 2026-09-04 の Night。日付比較で書くとここが壊れる。
    const st: EngineState = {
      phase: 'armed',
      armed: { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r',
        at: jst(22, 0, 0), waitMs: 8 * 60 * 60_000 },
    };
    const nextDay02 = Date.UTC(2026, 8, 5, 2 - 9, 0, 0);   // JST 2026-09-05 02:00 = 09-04 の Night
    expect(sameTradingSession(jst(22, 0, 0), nextDay02)).toBe(true);
    expect(advance(st, 38000, nextDay02).next.phase).toBe('armed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ★ARM 経路②(ドテン)/ ③(レンジ再評価)。どちらも武装後に broadcastSignalState() で trade2 へ配信するので、
//   経路①だけ塞いでも損失経路が残る。★②はこの環境で実際に ON(事故当日 sig 1950/1951 が doten 決済)。
describe('★ARM 経路②(ドテン): 引け後は反転しない', () => {
  const heldBuySig: CurrentSignal = { signalId: 1, at: T_1544_59 - 60_000, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900 };
  const heldBuyPos: OpenPosition = { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig', at: T_1544_59 - 60_000 };
  const id: HeldIdentity = { at: T_1544_59 - 60_000, direction: 'buy', signalId: 1 };
  const sellOco = { ok: true as const, plan: {
    direction: 'sell' as const, limitEntry: 38050, stopEntry: 37950,
    stopLossForLimit: 38100, stopLossForStop: 38000, rationale: '反転', refPrice: PRICE } };

  it('★否定対照: 解決が 15:45:06.735(引け後)→ reject(反転しない・建玉も決済しない)', () => {
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    expect(eng.applyHeldEvalResult(sellOco, id, T_ARMED, 38055, null)).toBe('reject');
    expect(eng.getPhase()).toBe('filled');                 // 建玉は保有のまま(引け全決済は advance が行う)
    expect(eng.getCurrentSignal()?.signalId).toBe(1);      // 采番も currentSignal も不変
  });

  it('★対照: 解決が 15:44:59(場中)なら従来どおり反転する', () => {
    const eng = newEngineA();
    eng._setFilledForTest(heldBuyPos, heldBuySig);
    expect(eng.applyHeldEvalResult(sellOco, id, T_1544_59, 38055, null)).toBe('doten');
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.signalId).toBe(2);
  });
});

describe('★ARM 経路③(レンジ再評価): 引け後は差替えない', () => {
  const fadeArmed = (): ArmedBracket => ({
    direction: 'buy', rationale: 'r', at: T_1544_59 - 60_000, mode: 'range',
    range: {
      upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
    },
  });
  const id = (): ArmedIdentity => ({ armedAt: T_1544_59 - 60_000, signalId: 1, mode: 'range' });
  const RANGE_REF = 38250;   // ★レンジの中(38100〜38400)。refPrice が帯の外だと checkSanity が別理由で落ちる。
  const breakout = { ok: true as const, plan: {
    direction: 'range' as const, rationale: 'ブレイク', refPrice: RANGE_REF,
    range: {
      upper: { side: 'sell' as const, type: 'stop' as const, entry: 38420, stopLoss: 38470 },
      lower: { side: 'buy' as const, type: 'stop' as const, entry: 38080, stopLoss: 38030 },
    } } };

  it('★否定対照: 解決が 15:45:06.735(引け後)→ reject(新しいブラケットを武装しない)', () => {
    const eng = newEngineA();
    eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
    expect(eng.applyRangeReevalResult(breakout, id(), T_ARMED, null)).toBe('reject');
    expect(eng.getCurrentSignal()?.range?.upper?.type).toBe('limit');   // 差替わっていない
    expect(eng.getCurrentSignal()?.signalId).toBe(1);
  });

  it('★対照: 解決が 15:44:59(場中)なら従来どおり差替える', () => {
    const eng = newEngineA();
    eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
    expect(eng.applyRangeReevalResult(breakout, id(), T_1544_59, null)).toBe('swap');
    expect(eng.getCurrentSignal()?.range?.upper?.type).toBe('stop');
    expect(eng.getCurrentSignal()?.signalId).toBe(2);
  });

  it('★取消(direction:none)は引け後でも通す(止めるのは新規武装だけ)', () => {
    const none = { ok: true as const, plan: { direction: 'none' as const, rationale: '場面崩れ', refPrice: RANGE_REF } };
    const eng = newEngineA();
    eng._setArmedForTest(fadeArmed(), armedToCurrentSignal(fadeArmed(), 1));
    expect(eng.applyRangeReevalResult(none, id(), T_ARMED, null)).toBe('cancel');
    expect(eng.getPhase()).toBe('flat');
  });
});
