import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ★ARM 直前ゲート(armGate.ts)の検証。**すべて実データの数値** で書いてある。
//   出典:
//     - serverlog_kabu.txt(UTC・別PC kabu の monitor サーバログ)の `plan-stale` 行 = 欠陥の稼働全期間の全18件。
//       各行に「計画時価格 ref」と「ARM 時 live 価格 live」、各レッグの生値と通過済みフラグが残っている。
//     - forward_kabu.db(trade2)の entry_decisions = 受信後の拒否理由と拒否回数。
//     - prices_kabu.db の bars_1m = その時刻の実勢価格。
vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';
import { _setExitImpl } from './exit/index.js';
import { checkRefDrift, recheckArmedSanity, armedToPlan, MAX_REF_DRIFT_YEN } from './armGate.js';
import { checkSanity } from './sanity.js';
import { ARMED_TIMEOUT_MS, planToArmed, toSignalTradeState, type ArmedBracket } from './decisions.js';
import { openDb, resolveDbPath, getArmedTimeoutStats } from '../db/store.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

// 2026-07-16(木) 10:30 JST = Day セッション → inPollWindow=true。
const NOW = Date.UTC(2026, 6, 16, 1, 30, 0);

function newEngineA(): SignalEngine {
  return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
}
function setLive(price: number | null): void {
  if (price == null) { setPrices([]); return; }
  setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW, stale: false }]);
}
async function settle(): Promise<void> {
  await vi.waitFor(() => expect(mockRunner).toHaveBeenCalled());
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let dir: string;
let origAppData: string | undefined;
let origHome: string | undefined;
let origUserProfile: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp225-armgate-'));
  origAppData = process.env.APPDATA;
  origHome = process.env.HOME; origUserProfile = process.env.USERPROFILE;
  process.env.APPDATA = dir;
  process.env.HOME = dir; process.env.USERPROFILE = dir;
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

// ─────────────────────────────────────────────────────────────────────
// 作業1: 単レッグ化したプランの再検証
// ─────────────────────────────────────────────────────────────────────

/** serverlog_kabu.txt の `plan-stale` 行(欠陥の稼働全期間=2026-07-30T09:35Z〜07-31T03:20Z の全18件)。
 *  `2レッグ→単レッグ` になった行だけを、生き残るレッグ付きで写したもの(全レッグ落ちは ARM しないので対象外)。
 *  survivor = checkStaleLegs 後に残るレッグ。dir/kind はその生き残りレッグの種類。 */
const PLAN_STALE_SINGLE_LEGGED: Array<{
  at: string; dir: 'buy' | 'sell'; ref: number; live: number;
  survivor: { kind: 'limit' | 'stop'; entry: number }; note?: string;
}> = [
  { at: '2026-07-30T10:16:36Z', dir: 'sell', ref: 61950, live: 61900, survivor: { kind: 'limit', entry: 62005 } },
  { at: '2026-07-30T12:30:20Z', dir: 'buy',  ref: 62675, live: 62775, survivor: { kind: 'limit', entry: 62630 } },
  { at: '2026-07-30T14:02:23Z', dir: 'buy',  ref: 62940, live: 63010, survivor: { kind: 'limit', entry: 62810 }, note: '距離ちょうど200円の境界' },
  { at: '2026-07-30T23:45:41Z', dir: 'buy',  ref: 63865, live: 64120, survivor: { kind: 'limit', entry: 63805 }, note: '★sid=361: trade2 が147回拒否し15分の armed-timeout で失効' },
  { at: '2026-07-31T00:04:43Z', dir: 'buy',  ref: 64580, live: 64640, survivor: { kind: 'limit', entry: 64570 } },
  { at: '2026-07-31T01:23:57Z', dir: 'buy',  ref: 65470, live: 65425, survivor: { kind: 'stop',  entry: 65510 } },
  { at: '2026-07-31T01:39:18Z', dir: 'sell', ref: 65270, live: 65290, survivor: { kind: 'stop',  entry: 65240 } },
  { at: '2026-07-31T01:56:42Z', dir: 'buy',  ref: 65185, live: 65230, survivor: { kind: 'limit', entry: 65080 } },
  { at: '2026-07-31T02:56:24Z', dir: 'sell', ref: 64600, live: 64550, survivor: { kind: 'limit', entry: 64680 } },
  { at: '2026-07-31T03:20:58Z', dir: 'sell', ref: 64395, live: 64340, survivor: { kind: 'limit', entry: 64500 } },
];

/** 単レッグ化した後の ArmedBracket を組む(損切りは向き規約を満たす任意値=判定に使わない)。 */
function singleLegArmed(row: typeof PLAN_STALE_SINGLE_LEGGED[number]): ArmedBracket {
  const { dir, survivor } = row;
  const sl = dir === 'buy' ? survivor.entry - 50 : survivor.entry + 50;
  const a: ArmedBracket = { direction: dir, rationale: 'r', at: 0 };
  if (survivor.kind === 'limit') { a.limitEntry = survivor.entry; a.stopLossForLimit = sl; }
  else { a.stopEntry = survivor.entry; a.stopLossForStop = sl; }
  return a;
}

describe('作業1: 単レッグ化したプランの再検証(判定基準は ARM 時 live 価格)', () => {
  it('★refPrice 基準で再検証しても 0件 しか落ちない(=refPrice では意味がない)', () => {
    const rejected = PLAN_STALE_SINGLE_LEGGED
      .filter(r => !recheckArmedSanity(singleLegArmed(r), r.ref, r.ref).ok)
      .map(r => r.at);
    expect(rejected).toEqual([]);
  });

  it('★ARM 時 live 価格 基準なら ちょうど1件 落ちる(=sid=361 の実害ケース)', () => {
    const rejected = PLAN_STALE_SINGLE_LEGGED
      .filter(r => !recheckArmedSanity(singleLegArmed(r), r.ref, r.live).ok)
      .map(r => r.at);
    expect(rejected).toEqual(['2026-07-30T23:45:41Z']);
  });

  it('落ちた理由が「単レッグの距離上限超」であることを文言で固定する(記録が残る)', () => {
    const row = PLAN_STALE_SINGLE_LEGGED.find(r => r.at === '2026-07-30T23:45:41Z')!;
    const r = recheckArmedSanity(singleLegArmed(row), row.ref, row.live);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    // trade2 が実際に出した拒否理由と同じ規約:
    //   `sanity:buy: 単レッグ(指値のみ)の指値(63805)が現在値(64025)から220円離れており上限200円超`
    expect(r.reason).toContain('単レッグ');
    expect(r.reason).toContain('63805');
    expect(r.reason).toContain('64120');
    expect(r.reason).toContain('315');
  });

  it('★境界(距離ちょうど200円)は通す=200円を超えたぶんだけ落とす', () => {
    const row = PLAN_STALE_SINGLE_LEGGED.find(r => r.note?.includes('境界'))!;
    expect(Math.abs(row.survivor.entry - row.live)).toBe(200);
    expect(recheckArmedSanity(singleLegArmed(row), row.ref, row.live).ok).toBe(true);
    // 1円だけ遠ざけると落ちる(閾値がここに在ることの否定対照)。
    expect(recheckArmedSanity(singleLegArmed(row), row.ref, row.live + 1).ok).toBe(false);
  });

  it('★2レッグのまま(=距離上限が課されない)なら、同じ計画でも従来どおり通る', () => {
    // sid=361 の計画を「片脚が落ちる前」の形で再現: buy 指値63805 + 逆指値63955。
    const both: ArmedBracket = {
      direction: 'buy', limitEntry: 63805, stopLossForLimit: 63750,
      stopEntry: 63955, stopLossForStop: 63900, rationale: 'r', at: 0,
    };
    // ref(63865)は2つのレッグの間にあり、幅150円 ≤ 400円 → 合格(=当時 checkSanity を通った理由)。
    expect(checkSanity(armedToPlan(both, 63865), 63865).ok).toBe(true);
  });

  it('live が取れない/非有限なら判定しない(fail-safe: 新しい抑止で取引を止めない)', () => {
    const row = PLAN_STALE_SINGLE_LEGGED.find(r => r.at === '2026-07-30T23:45:41Z')!;
    for (const live of [null, undefined, NaN, Infinity]) {
      expect(recheckArmedSanity(singleLegArmed(row), row.ref, live).ok).toBe(true);
    }
  });

  it('armedToPlan: range の単レッグも同じ規約で距離上限が効く', () => {
    const a: ArmedBracket = {
      direction: 'buy', rationale: 'r', at: 0, mode: 'range',
      range: { lower: { side: 'buy', type: 'limit', entry: 63805, stopLoss: 63750 } },
    };
    expect(recheckArmedSanity(a, 63865, 64120).ok).toBe(false);   // 315円
    expect(recheckArmedSanity(a, 63865, 63970).ok).toBe(true);    // 165円
  });
});

describe('作業1(engine 実経路): 単レッグ化した計画は武装されない', () => {
  // sid=361 と同じ形。ARM 時 live を 64060(乖離195円 ≤ 200円=refPrice 鮮度ゲートは通る)にして、
  // 「単レッグ化の再検証」だけが効いていることを分離して確かめる(実データの距離 255円 は上限超のまま)。
  const plan361: AiPlan = {
    direction: 'buy', limitEntry: 63805, stopLossForLimit: 63750,
    stopEntry: 63955, stopLossForStop: 63900, rationale: '押し目買い', refPrice: 63865,
  };

  it('片脚が通過済み→残った単レッグが live から200円超 → ARM しない(=trade2 へ出さない)', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      mockRunner.mockResolvedValue({ ok: true, plan: plan361 });
      setLive(64060);   // 逆指値63955 はタッチ済み(通過)/ 指値63805 は 255円 下。
      const eng = newEngineA();
      await eng.start();
      eng.feed(64060, NOW);
      await settle();
      expect(eng.getPhase()).toBe('flat');
      expect(eng.getCurrentSignal()).toBeNull();
    } finally { spy.mockRestore(); }
    // ★無音にしない: 落とした理由が必ずログに残る。
    const line = logs.find(l => l.includes('reason=recheck'));
    expect(line).toBeTruthy();
    expect(line).toContain('単レッグ');
    expect(line).toContain('255');
  });

  it('残った単レッグが200円以内なら従来どおり ARM する(過剰抑止しない)', async () => {
    mockRunner.mockResolvedValue({ ok: true, plan: plan361 });
    setLive(63960);   // 逆指値63955 タッチ済み / 指値63805 は 155円 下 → 通す。
    const eng = newEngineA();
    await eng.start();
    eng.feed(63960, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    expect(eng.getCurrentSignal()?.limitEntry).toBe(63805);
    expect(eng.getCurrentSignal()?.stopEntry).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 作業2: refPrice の鮮度上限
// ─────────────────────────────────────────────────────────────────────

/** serverlog / bars_1m から復元した 2026-07-23 の実測2件。
 *  ref は当時ログに残っていないが、単レッグ sell 指値が checkSanity(refPrice基準)を通っている以上
 *  「指値の 200円以内・かつ指値より下」= [entry-200, entry) に在ったことが確定する。ここでは
 *  その区間の内側(指値の25円下)を採って再現する。 */
const JULY23 = [
  { at: '21:42:01→21:56:52', limitEntry: 66725, ref: 66700, live: 65795, rejects: 131, lastTouched: '同日14:45' },
  { at: '22:44:35→22:59:30', limitEntry: 66990, ref: 66965, live: 65995, rejects: 130, lastTouched: '同日10:16' },
];

describe('作業2: refPrice の鮮度上限(計画時価格と ARM 時 live 価格の乖離)', () => {
  it('★2026-07-23 の2件(乖離930円 / 995円)はどちらも止まる', () => {
    for (const c of JULY23) {
      // 当時の実装が武装できた理由: refPrice 基準の checkSanity は通ってしまう。
      const plan: AiPlan = {
        direction: 'sell', limitEntry: c.limitEntry, stopLossForLimit: c.limitEntry + 60,
        rationale: 'r', refPrice: c.ref,
      };
      expect(checkSanity(plan, c.ref).ok).toBe(true);
      // 鮮度ゲート: ARM 時の live 価格との乖離で止める。
      const r = checkRefDrift(c.ref, c.live);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('unreachable');
      expect(r.reason).toContain('refPrice 鮮度');
      expect(r.reason).toContain(String(Math.abs(c.ref - c.live)));
    }
  });

  it('実測の乖離分布(全18件)のうち、健全な17件は通り 外れ値1件(255円)だけ落ちる', () => {
    // serverlog の plan-stale 全18行の |ref−live|。ここが唯一の直接観測サンプル。
    const drifts = [15, 15, 15, 15, 15, 20, 20, 45, 45, 50, 50, 55, 60, 65, 65, 70, 100, 255];
    const blocked = drifts.filter(d => !checkRefDrift(60000, 60000 + d).ok);
    expect(blocked).toEqual([255]);
    expect(MAX_REF_DRIFT_YEN).toBe(200);
  });

  it('境界: ちょうど200円は通し、201円で落ちる', () => {
    expect(checkRefDrift(63865, 63865 + 200).ok).toBe(true);
    expect(checkRefDrift(63865, 63865 + 201).ok).toBe(false);
    expect(checkRefDrift(63865, 63865 - 201).ok).toBe(false);
  });

  it('live が取れない/非有限なら判定しない / refPrice が非有限なら落とす', () => {
    for (const live of [null, undefined, NaN]) expect(checkRefDrift(63865, live).ok).toBe(true);
    expect(checkRefDrift(NaN, 63865).ok).toBe(false);
    expect(checkRefDrift(0, 63865).ok).toBe(false);   // 旧実装の `?? 0` が作っていた値。
  });

  it('★engine 実経路: 古い refPrice の計画は武装されず、理由がログに残る', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      const c = JULY23[0]!;
      mockRunner.mockResolvedValue({
        ok: true,
        plan: { direction: 'sell', limitEntry: c.limitEntry, stopLossForLimit: c.limitEntry + 60, rationale: 'r', refPrice: c.ref } as AiPlan,
      });
      setLive(c.live);
      const eng = newEngineA();
      await eng.start();
      eng.feed(c.live, NOW);
      await settle();
      expect(eng.getPhase()).toBe('flat');
      expect(eng.getCurrentSignal()).toBeNull();
    } finally { spy.mockRestore(); }
    const line = logs.find(l => l.includes('reason=refstale'));
    expect(line).toBeTruthy();
    expect(line).toContain('905');   // |66700 − 65795|
  });
});

// ─────────────────────────────────────────────────────────────────────
// 作業3: 「武装したが約定せず失効した」の記録・可視化
// ─────────────────────────────────────────────────────────────────────

describe('作業3: 未約定失効(armed-timeout)の記録', () => {
  /** ARM 済みの A エンジンを作る(実経路の ARM を通す)。 */
  async function armedEngine(): Promise<SignalEngine> {
    // live=63960 → 逆指値63955 は通過済みで落ち、指値63805(155円下)だけが武装される
    // = 実データ sid=361 と同じ「単レッグ化して武装 → 一度も約定せず失効」の形。
    mockRunner.mockResolvedValue({
      ok: true,
      plan: { direction: 'buy', limitEntry: 63805, stopLossForLimit: 63750, stopEntry: 63955, stopLossForStop: 63900, rationale: 'r', refPrice: 63865 } as AiPlan,
    });
    setLive(63960);
    const eng = newEngineA();
    await eng.start();
    eng.feed(63960, NOW);
    await settle();
    expect(eng.getPhase()).toBe('armed');
    return eng;
  }

  it('★15分未約定で失効 → 件数が加算され、DB に永続し、SSE に載り、理由がログに残る', async () => {
    const eng = await armedEngine();
    expect(eng._peekArmedTimeouts().count).toBe(0);
    // 失効前は SSE に出ない(既存 JSON 不変)。
    expect(eng.getState(NOW).armedTimeout).toBeUndefined();

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    // ★武装時刻は engine が Date.now() で刻む(テストの NOW ではない)ので、SSE state から実値を採る。
    const armedAt = eng.getState(NOW).entry!.at;
    const timedOutAt = armedAt + ARMED_TIMEOUT_MS;
    try {
      eng.feed(63960, timedOutAt);
    } finally { spy.mockRestore(); }

    expect(eng.getPhase()).toBe('flat');
    // ① in-memory カウンタ(★v0.9.59: 累計 count と 連続 streak の両方が立つ)
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 1, streak: 1, lastAt: timedOutAt });
    // ② 永続(signal_meta)
    const db = openDb(resolveDbPath());
    try { expect(getArmedTimeoutStats(db, 'A')).toEqual({ count: 1, streak: 1, lastAt: timedOutAt }); } finally { db.close(); }
    // ③ SSE(可視化の供給源)
    expect(eng.getState(timedOutAt).armedTimeout).toMatchObject({ count: 1, streak: 1, lastAt: timedOutAt });
    // ④ ログ: 「なぜ約定しなかったか」= 各レッグが現在値からどれだけ離れていたか
    const line = logs.find(l => l.includes('armed-timeout'));
    expect(line).toBeTruthy();
    expect(line).toContain('signalId=1');
    expect(line).toContain('limit=63805(現値差155円)');
    expect(line).toContain('累計未約定失効=1回');
    expect(line).toContain('連続未約定失効=1回');
  });

  it('約定してから決済した場合は加算されない(失効だけを数える)', async () => {
    const eng = await armedEngine();
    eng.feed(63795, NOW + 60_000);   // 指値63805 を 5円 行き過ぎ → 約定
    expect(eng.getPhase()).toBe('filled');
    eng.feed(63795, NOW + ARMED_TIMEOUT_MS + 60_000);
    expect(eng._peekArmedTimeouts().count).toBe(0);
  });

  it('件数0では SSE に付与しない(既存 JSON 不変=broadcast dedupe を壊さない)', () => {
    const s0 = toSignalTradeState({ phase: 'flat' }, 63865, NOW, null, undefined, { count: 0, streak: 0, lastAt: null });
    expect('armedTimeout' in s0).toBe(false);
    const s1 = toSignalTradeState({ phase: 'flat' }, 63865, NOW, null, undefined, { count: 3, streak: 2, lastAt: 123 });
    expect(s1.armedTimeout).toEqual({ count: 3, streak: 2, lastAt: 123 });
  });

  it('planToArmed→armedToPlan は往復で同じ形になる(再検証の対象が「実際に発注される形」であること)', () => {
    const plan: AiPlan = {
      direction: 'sell', limitEntry: 62005, stopLossForLimit: 62060, rationale: 'r', refPrice: 61950,
    };
    const armed = planToArmed(plan, 0)!;
    const back = armedToPlan(armed, plan.refPrice);
    expect(back).toMatchObject({ direction: 'sell', limitEntry: 62005, stopLossForLimit: 62060, refPrice: 61950 });
    expect(back.stopEntry).toBeUndefined();
  });
});
