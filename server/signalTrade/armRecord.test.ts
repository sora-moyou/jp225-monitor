import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ★記録専用(ADD-ONLY): ARM(武装)時刻と「ARM 時点で monitor が見ていた価格」を約定→決済→DB まで持ち回る。
//   ・armed.at / armed.armedPrice → OpenPosition(armedAt/armedPrice)→ RecordedTrade → signal_trades(armed_t/armed_price)
//   ・3つの ARM 経路すべてでセットされる: ①flat計画 ②ドテン反対建て ③レンジ再評価の差替え
//   ・★レンジ再評価で差し替えたら「新しい ARM の時刻/価格」になる(古い方を引き継がない)。
//   ★ARM 時刻だけでは足りない: 事後に prices_*.db の ticks で「武装時点の価格」を代用すると、collector が
//     別プロセス・別位相(+AJAXキャッシュ)で記録した価格列になり monitor が feed した価格と一致しない
//     (実測: 誤検出多数)。だから ARM 時点の live 価格を同時に記録する。
//   検知(アラート)・決済(phase-exit)・エントリー採否には一切触らない(記録の追加のみ)。
vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';
import { _setExitImpl } from './exit/index.js';
import {
  advance, planToArmed, reverseToDoten, armedToCurrentSignal,
  type ArmedBracket, type CurrentSignal, type HeldIdentity, type ArmedIdentity, type OpenPosition, type RecordedTrade,
} from './decisions.js';
import { buildSignalTradeInsert } from './persist.js';
import { openDb, resolveDbPath, getSignalTrades, type SignalTradeRow } from '../db/store.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

// 2026-07-16(木) 10:30 JST = Day セッション → inPollWindow=true。
const NOW = Date.UTC(2026, 6, 16, 1, 30, 0);
const REF = 38000;   // 計画の参照価格(チャート撮影時)。

// ─── 純関数の持ち回り(armed → position → recorded) ─────────────────────

describe('advance: ARM 時刻/価格を約定建玉へ持ち回る', () => {
  beforeEach(() => { _setExitImpl(null); });   // 公開の簡易フォールバック(初期LC固定)で決定論に。
  afterEach(() => { _setExitImpl(null); });

  it('directional の約定で position.armedAt / armedPrice を引き継ぐ(at=約定時刻とは別)', () => {
    const armed: ArmedBracket = {
      direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1_000, armedPrice: 38010,
    };
    const { next } = advance({ phase: 'armed', armed }, 37945, 5_000);
    expect(next.phase).toBe('filled');
    expect(next.position).toMatchObject({ at: 5_000, armedAt: 1_000, armedPrice: 38010 });
  });

  it('range の約定でも position.armedAt / armedPrice を引き継ぐ', () => {
    const armed: ArmedBracket = {
      direction: 'buy', rationale: 'range-fade', at: 1_000, mode: 'range', armedPrice: 38250, range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    };
    const { next } = advance({ phase: 'armed', armed }, 38095, 5_000);   // 下レッグ(指値)を5円行き過ぎ
    expect(next.position).toMatchObject({ at: 5_000, armedAt: 1_000, armedPrice: 38250 });
  });

  it('ARM 時点の価格が取れなかった(armedPrice 欠落)ときは armedAt だけ引き継ぐ', () => {
    const armed: ArmedBracket = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', at: 1_000 };
    const { next } = advance({ phase: 'armed', armed }, 37945, 5_000);
    expect(next.position?.armedAt).toBe(1_000);
    expect('armedPrice' in (next.position as OpenPosition)).toBe(false);
  });

  it('決済記録(RecordedTrade)へ armedAt / armedPrice を持ち回る(phase-exit 経路)', () => {
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 37950, qty: 1, initialStop: 37900, peakProfit: 0, rationale: 'r',
      at: 5_000, armedAt: 1_000, armedPrice: 38010,
    };
    const { recorded } = advance({ phase: 'filled', position }, 37890, 9_000);
    expect(recorded).toMatchObject({ entryT: 5_000, exitT: 9_000, armedAt: 1_000, armedPrice: 38010 });
  });

  it('決済記録へ持ち回る(レンジTP 経路=固定LC/成行TP)', () => {
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38100, qty: 1, initialStop: 38050, peakProfit: 0, rationale: 'r',
      at: 5_000, mode: 'range', rangeTp: 38400, armedAt: 1_000, armedPrice: 38250,
    };
    const { recorded } = advance({ phase: 'filled', position }, 38395, 9_000);   // TP トリガ(38400−5)
    expect(recorded).toMatchObject({ mode: 'range', armedAt: 1_000, armedPrice: 38250 });
  });
});

describe('reverseToDoten: P の決済記録は P 自身の ARM 値 / 反対ブラケットは新しい ARM 時刻', () => {
  it('recorded は保有 P の armedAt/armedPrice・新 armed.at は now(反転=新しい ARM)', () => {
    const position: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig',
      at: 500, armedAt: 100, armedPrice: 37980,
    };
    const plan: AiPlan = { direction: 'sell', limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: REF };
    const rev = reverseToDoten({ phase: 'filled', position }, plan, 38000, 2_000)!;
    expect(rev.recorded).toMatchObject({ armedAt: 100, armedPrice: 37980, doten: true });
    expect(rev.armed.at).toBe(2_000);          // 反対建ては新しい ARM
    expect(rev.armed.armedPrice).toBeUndefined();   // ARM 時点価格は engine(呼び出し側)が据える
  });
});

describe('planToArmed: ARM 時点価格は載せない(engine が live 価格を据える)', () => {
  it('生成直後の armed に armedPrice は無い(at だけ)', () => {
    const a = planToArmed({ direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r' }, 1_234)!;
    expect(a.at).toBe(1_234);
    expect('armedPrice' in a).toBe(false);
  });
});

describe('buildSignalTradeInsert: armedT / armedPrice を挿入行へ', () => {
  const base: RecordedTrade = {
    entryT: 2_000, entryPrice: 38000, dir: 'buy', exitT: 3_000, exitPrice: 38050, pnl: 50, qty: 1, rationale: 'r',
    // ★決済記録の必須3点(記録専用)。この describe の検証対象は armed_t/armed_price なので固定値。
    exitReason: 'initial_stop', exitInitialStop: 37950, peakProfit: 0,
  };
  it('在れば載せる', () => {
    const ins = buildSignalTradeInsert({ ...base, armedAt: 1_000, armedPrice: 37990 }, null, 5);
    expect(ins).toMatchObject({ armedT: 1_000, armedPrice: 37990, signalId: 5 });
  });
  it('欠落なら未指定(=既存 INSERT と同じ NULL)', () => {
    const ins = buildSignalTradeInsert(base, null);
    expect('armedT' in ins).toBe(false);
    expect('armedPrice' in ins).toBe(false);
  });
  it('ARM 時点価格だけ取れない(armedPrice 欠落)ときは armedT だけ載せる', () => {
    const ins = buildSignalTradeInsert({ ...base, armedAt: 1_000 }, null);
    expect(ins.armedT).toBe(1_000);
    expect('armedPrice' in ins).toBe(false);
  });
});

// ─── 3つの ARM 経路すべてで DB に記録される(E2E: ARM→約定→決済→signal_trades) ───

describe('3つの ARM 経路すべてで armed_t / armed_price が記録される', () => {
  let dir: string;
  let origAppData: string | undefined;
  let origHome: string | undefined;
  let origUserProfile: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-armrec-'));
    origAppData = process.env.APPDATA;
    origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
    process.env.APPDATA = dir;                                  // persistTrade を temp DB へ隔離(実DBを触らない)。
    process.env.HOME = dir; process.env.USERPROFILE = dir;       // config を temp へ隔離。
    resetConfigCache();
    mockRunner.mockReset();
    setPrices([]);
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

  function newEngineA(): SignalEngine {
    return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
  }
  /** live 価格(NIY=F)を cache に据える(engine は getPrices() から読む)。 */
  function setLive(price: number): void {
    setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW, stale: false }]);
  }
  /** フィード断: 前回値の stale 持ち越し(=ARM 時点価格として使ってはいけない)。 */
  function setStaleLive(price: number): void {
    setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW - 60_000, stale: true }]);
  }
  /** feed をトリガーにした fire-and-forget な計画要求(async)を待つ。 */
  async function settle(): Promise<void> {
    await vi.waitFor(() => expect(mockRunner).toHaveBeenCalled());
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  /** temp DB(隔離済み)の signal_trades を exit_t 昇順で読む。 */
  function rows(): SignalTradeRow[] {
    const db = openDb(resolveDbPath());
    try { return getSignalTrades(db).sort((a, b) => a.exit_t - b.exit_t); } finally { db.close(); }
  }

  // ① flat 計画 → ARM。armed_t=ARM 時刻(=currentSignal.at)・armed_price=ARM 時点の live 価格。
  it('①flat計画: ARM 時刻と ARM 時点価格を記録し、entry_t − armed_t で経過が出る', async () => {
    const buyLimit: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: REF };
    mockRunner.mockResolvedValue({ ok: true, plan: buyLimit });
    setLive(38000);   // ★ARM 時点で monitor が見ていた価格。
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(null);   // 非公開 phase-exit ではなく公開の簡易版(初期LC固定)で決定論に。
    eng.feed(REF, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    const armedT = eng.getCurrentSignal()!.at;   // ARM 時刻(engine は Date.now() で武装する)

    eng.feed(37945, armedT + 60_000);    // 指値約定(5円行き過ぎ)= ARM から60秒
    expect(eng.getPhase()).toBe('filled');
    eng.feed(37890, armedT + 120_000);   // 初期LC 37900 到達 → 決済して1行記録
    expect(eng.getPhase()).toBe('flat');

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.armed_t).toBe(armedT);
    expect(r[0]!.armed_price).toBe(38000);
    expect(r[0]!.entry_t).toBe(armedT + 60_000);
    expect(r[0]!.entry_t - (r[0]!.armed_t as number)).toBe(60_000);   // ★ARM→約定の経過
    eng.stop();
  });

  it('①flat計画: live が stale/欠落なら armed_price は NULL(armed_t は残る)', async () => {
    const buyLimit: AiPlan = { direction: 'buy', limitEntry: 37950, stopLossForLimit: 37900, rationale: 'r', refPrice: REF };
    mockRunner.mockResolvedValue({ ok: true, plan: buyLimit });
    setStaleLive(38000);   // ★持ち越しの古い価格は「ARM 時点で見ていた価格」ではない → 記録しない。
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(null);
    eng.feed(REF, NOW);
    await settle();
    const armedT = eng.getCurrentSignal()!.at;
    eng.feed(37945, armedT + 60_000);
    eng.feed(37890, armedT + 120_000);
    const r = rows();
    expect(r[0]!.armed_t).toBe(armedT);
    expect(r[0]!.armed_price).toBeNull();
    eng.stop();
  });

  // ② ドテン(反対建て)= 新しい ARM として扱う。P の行は P 自身の ARM 値のまま。
  it('②ドテン: 反対建ては新しい ARM 時刻/価格・P の行は P 自身の ARM 値', async () => {
    const heldSig: CurrentSignal = { signalId: 1, at: 500, direction: 'buy', rationale: 'orig', limitEntry: 37950, stopLossForLimit: 37900 };
    const heldPos: OpenPosition = {
      direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'orig',
      at: 500, armedAt: 100, armedPrice: 37980,   // P 自身の ARM(古い方)
    };
    const id: HeldIdentity = { at: 500, direction: 'buy', signalId: 1 };
    const sellLimit = { ok: true as const, plan: { direction: 'sell' as const, limitEntry: 38050, stopLossForLimit: 38100, rationale: '反転', refPrice: REF } };
    const DOTEN_T = NOW;
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(null);
    eng._setFilledForTest(heldPos, heldSig);
    // 第4引数=P の成行決済価格 / 第5引数=ゲート & ARM 時点価格に使う「新鮮な」live 価格。
    expect(eng.applyHeldEvalResult(sellLimit, id, DOTEN_T, 38000, 38000)).toBe('doten');
    expect(eng.getCurrentSignal()!.at).toBe(DOTEN_T);   // 新しい ARM 時刻

    eng.feed(38055, DOTEN_T + 60_000);    // 売り指値38050 を5円行き過ぎ=約定
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38105, DOTEN_T + 120_000);   // 初期LC 38100 到達 → 決済
    expect(eng.getPhase()).toBe('flat');

    const r = rows();
    expect(r).toHaveLength(2);
    // 1行目= P の決済(ドテンで成行クローズ)。P 自身の ARM 値のまま(新しい方を混ぜない)。
    expect(r[0]).toMatchObject({ armed_t: 100, armed_price: 37980, entry_t: 500 });
    // 2行目= 反対建て(doten)の決済。ARM 時刻/価格は反転時点のもの。
    expect(r[1]!.armed_t).toBe(DOTEN_T);
    expect(r[1]!.armed_price).toBe(38000);
    expect(r[1]!.entry_t - (r[1]!.armed_t as number)).toBe(60_000);
    eng.stop();
  });

  // ③ レンジ再評価の差替え → 新しい ARM(★古い armed の時刻/価格を引き継がない)。
  it('③レンジ再評価(swap): 差替え後の新しい ARM 時刻/価格になる(古い方を引き継がない)', async () => {
    const OLD_ARMED_AT = 500;
    const OLD_ARMED_PRICE = 38200;
    const fade = (): ArmedBracket => ({
      direction: 'buy', rationale: 'range-fade', at: OLD_ARMED_AT, mode: 'range', armedPrice: OLD_ARMED_PRICE, range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const id: ArmedIdentity = { armedAt: OLD_ARMED_AT, signalId: 1, mode: 'range' };
    const breakout = { ok: true as const, plan: { direction: 'range' as const, rationale: 'breakout', refPrice: 38250, range: {
      upper: { side: 'buy' as const, type: 'stop' as const, entry: 38400, stopLoss: 38350 },
      lower: { side: 'sell' as const, type: 'stop' as const, entry: 38100, stopLoss: 38150 },
    } } };
    const SWAP_T = NOW;
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(null);
    eng._setArmedForTest(fade(), armedToCurrentSignal(fade(), 1));
    expect(eng.applyRangeReevalResult(breakout, id, SWAP_T, 38250)).toBe('swap');
    expect(eng.getCurrentSignal()!.at).toBe(SWAP_T);

    eng.feed(38400, SWAP_T + 60_000);    // 上=買い逆指値38400 タッチ=約定(建値38405/初期LC38350)
    expect(eng.getPhase()).toBe('filled');
    eng.feed(38340, SWAP_T + 120_000);   // 初期LC 38350 到達 → 決済
    expect(eng.getPhase()).toBe('flat');

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.armed_t).toBe(SWAP_T);           // ★古い 500 ではない
    expect(r[0]!.armed_price).toBe(38250);        // ★古い 38200 ではない
    expect(r[0]!.entry_t - (r[0]!.armed_t as number)).toBe(60_000);
    eng.stop();
  });

  it('③レンジ再評価(keep=差替えない): 現行 armed の ARM 時刻/価格が保たれる', async () => {
    const OLD_ARMED_AT = NOW - 10 * 60_000;   // ARM から10分(未約定タイムアウト15分より手前)
    const fade = (): ArmedBracket => ({
      direction: 'buy', rationale: 'range-fade', at: OLD_ARMED_AT, mode: 'range', armedPrice: 38200, range: {
        upper: { side: 'sell', type: 'limit', entry: 38400, stopLoss: 38450 },
        lower: { side: 'buy', type: 'limit', entry: 38100, stopLoss: 38050 },
      },
    });
    const id: ArmedIdentity = { armedAt: OLD_ARMED_AT, signalId: 1, mode: 'range' };
    const same = { ok: true as const, plan: { direction: 'range' as const, rationale: '維持', refPrice: 38250, range: {
      upper: { side: 'sell' as const, type: 'limit' as const, entry: 38400, stopLoss: 38450 },
      lower: { side: 'buy' as const, type: 'limit' as const, entry: 38100, stopLoss: 38050 },
    } } };
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(null);
    eng._setArmedForTest(fade(), armedToCurrentSignal(fade(), 1));
    expect(eng.applyRangeReevalResult(same, id, NOW, 38250)).toBe('keep');
    eng.feed(38095, NOW + 60_000);    // 下=買い指値38100 を5円行き過ぎ=約定
    eng.feed(38045, NOW + 120_000);   // 初期LC 38050 到達 → 決済
    const r = rows();
    expect(r[0]!.armed_t).toBe(OLD_ARMED_AT);   // 維持=元の ARM のまま
    expect(r[0]!.armed_price).toBe(38200);
    eng.stop();
  });
});
