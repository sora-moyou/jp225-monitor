import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ★エンジン経路での実証(v0.9.59):
//   (a) 連続失効カウンタ … 約定のたびに 0 へ戻る。累計は増え続ける。
//   (b) 待機表示        … 「連続失効 15分2回 / 現在買い目線」の材料が SSE に載る。
//   (c) 可変待ち時間     … 低ボラ・遠距離では 15分を超えて待つ(実際に 15分では失効しない)。
//   (d) 失効後の再武装   … 同じ価格の計画をもう一度武装できる。ただし3回連続でブロックされる。
vi.mock('../llm/scalpPlanRunner.js', () => ({ runScalpPlanWithChart: vi.fn() }));

import { SignalEngine } from './engine.js';
import { runScalpPlanWithChart } from '../llm/scalpPlanRunner.js';
import { resetConfigCache } from '../configStore.js';
import { setPrices } from '../cache.js';
import { _setExitImpl } from './exit/index.js';
import { openDb, resolveDbPath, upsertBar, getSignalPlans } from '../db/store.js';
import { buildWaitMain } from '../../web/components/signalPanel.js';
import { ARM_REPEAT_LIMIT } from './armRepeat.js';
import type { AiPlan } from '../llm/openai.js';

const mockRunner = runScalpPlanWithChart as unknown as ReturnType<typeof vi.fn>;

// 2026-07-16(木) 10:30 JST = Day セッション → inPollWindow=true。
const NOW = Date.UTC(2026, 6, 16, 1, 30, 0);
const MIN = 60_000;

// 実データ sid=361 と同じ形: live=63960 → 逆指値63955 は通過済みで落ち、指値63805(155円下)だけが武装される。
const PLAN: AiPlan = {
  direction: 'buy', limitEntry: 63805, stopLossForLimit: 63750,
  stopEntry: 63955, stopLossForStop: 63900, rationale: 'r', refPrice: 63865,
} as AiPlan;

function newEngineA(): SignalEngine {
  return new SignalEngine({ profile: 'A', systemTag: null, broadcastType: 'signalTrade', maintainsCurrentSignal: true });
}
function setLive(price: number | null): void {
  if (price == null) { setPrices([]); return; }
  setPrices([{ symbol: 'NIY=F', price, changePercent: 0, timestamp: NOW, stale: false }]);
}

/** feed して「新しい計画要求が1本走り、解決するまで」待つ。 */
async function feedPlan(eng: SignalEngine, price: number, now: number): Promise<void> {
  const before = mockRunner.mock.calls.length;
  vi.setSystemTime(now);
  eng.feed(price, now);
  await vi.waitFor(() => expect(mockRunner.mock.calls.length).toBe(before + 1));
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
/** feed だけ(計画要求は起きない想定)。 */
function feedOnly(eng: SignalEngine, price: number, now: number): void {
  vi.setSystemTime(now);
  eng.feed(price, now);
}

/** 現在武装中のブラケットの ARM 時刻。★engine は armed.at を Date.now() で刻むが、vi.waitFor は
 *  偽装時計を進めるため「テストが指定した時刻」とは数十秒ずれる。失効の判定は必ずこの実値を基準にする。 */
function armedAt(eng: SignalEngine): number {
  const at = eng.getState(Date.now()).entry?.at;
  expect(at).toBeTypeOf('number');
  return at as number;
}
/** 武装中のブラケットを「ARM から waitMin 分後」に進める(=失効させる)。 */
async function advanceToExpiry(eng: SignalEngine, price: number, waitMin = 15): Promise<number> {
  const t = armedAt(eng) + waitMin * MIN;
  await feedPlan(eng, price, t);
  return t;
}

let dir: string;
let orig: Record<string, string | undefined> = {};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jp225-armwait-'));
  orig = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.APPDATA = dir; process.env.HOME = dir; process.env.USERPROFILE = dir;
  resetConfigCache();
  mockRunner.mockReset();
  mockRunner.mockResolvedValue({ ok: true, plan: PLAN });
  setLive(63960);
  // ★Date だけを偽装する(engine は armed.at 等を Date.now() で刻むため、テストの論理時刻と一致させる)。
  //   setTimeout は本物のまま=vi.waitFor が動く。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  _setExitImpl(null);
  setPrices([]);
  for (const [k, v] of Object.entries(orig)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
  resetConfigCache();
  rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────
// (a) 連続失効カウンタ: 失効→失効→約定→失効 で 1→2→0→1 / 累計は 1→2→2→3
// ─────────────────────────────────────────────────────────────────────
describe('★(a) 連続失効カウンタ(約定でリセット)と 累計(消さない)', () => {
  it('失効→失効→約定→失効 で 連続 1→2→0→1 / 累計 1→2→2→3', async () => {
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(() => 63700);   // 約定後の決済逆指値(この価格を割ったら決済)。

    // ── ARM #1 ──
    await feedPlan(eng, 63960, NOW);
    expect(eng.getPhase()).toBe('armed');
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 0, streak: 0 });

    // ── 失効 #1(15分)。同じ tick で再計画が走り、同じ価格でもう一度武装する(=(d)) ──
    await advanceToExpiry(eng, 63960);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 1, streak: 1 });
    expect(eng.getPhase()).toBe('armed');

    // ── 失効 #2 ──
    await advanceToExpiry(eng, 63960);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 2, streak: 2 });
    expect(eng.getPhase()).toBe('armed');

    // ── 約定(指値63805 を 5円 行き過ぎ)→ 連続だけ 0 に戻る。累計は 2 のまま ──
    const fillT = armedAt(eng) + MIN;
    feedOnly(eng, 63795, fillT);
    expect(eng.getPhase()).toBe('filled');
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 2, streak: 0 });
    // ★永続側も連続だけ 0(累計は残る=無音の失敗を数える指標を壊さない)。
    {
      const db = openDb(resolveDbPath());
      try {
        const row = db.prepare('SELECT armed_timeouts, armed_timeout_streak FROM signal_meta WHERE system = ?').get('A') as
          { armed_timeouts: number; armed_timeout_streak: number };
        expect(row).toEqual({ armed_timeouts: 2, armed_timeout_streak: 0 });
      } finally { db.close(); }
    }

    // ── 決済 → FLAT(クールダウン既定90秒) ──
    feedOnly(eng, 63690, fillT + MIN);
    expect(eng.getPhase()).toBe('flat');

    // ── 再 ARM(#4)→ 失効 #3。連続は 1 から数え直し、累計は 3 へ ──
    await feedPlan(eng, 63960, fillT + 9 * MIN);
    expect(eng.getPhase()).toBe('armed');
    await advanceToExpiry(eng, 63960);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 3, streak: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// (b) 待機表示
// ─────────────────────────────────────────────────────────────────────
describe('★(b) 待機表示(連続失効 N分M回 / 現在○目線)', () => {
  it('SSE に streak / waitMin / bias が載り、パネルの文字列が組み上がる', async () => {
    const eng = newEngineA();
    await eng.start();
    await feedPlan(eng, 63960, NOW);
    await advanceToExpiry(eng, 63960);   // 失効 #1 → 同 tick で再武装
    const t2 = await advanceToExpiry(eng, 63960);   // 失効 #2

    const at = eng.getState(t2).armedTimeout;
    expect(at).toMatchObject({ count: 2, streak: 2, waitMin: 15, bias: 'buy' });
    // ★実際に組み立てた表示文字列(ユーザーの例と同じ形)。
    expect(buildWaitMain(at)).toBe('シグナル待機（連続失効 15分2回 / 現在買い目線）');
  });

  it('目線が無いときは縮退する(空括弧や「不明」を出さない)', () => {
    expect(buildWaitMain({ count: 9, streak: 2, lastAt: 1, waitMin: 15 }))
      .toBe('シグナル待機（連続失効 15分2回）');
    // 待ち時間も無ければ分数ごと出さない。
    expect(buildWaitMain({ count: 9, streak: 2, lastAt: 1 }))
      .toBe('シグナル待機（連続失効 2回）');
  });

  it('連続 0 回なら従来どおり「シグナル待機」(累計が積み上がっていても)', () => {
    expect(buildWaitMain(null)).toBe('シグナル待機');
    expect(buildWaitMain(undefined)).toBe('シグナル待機');
    expect(buildWaitMain({ count: 0, streak: 0, lastAt: 0 })).toBe('シグナル待機');
    expect(buildWaitMain({ count: 27, streak: 0, lastAt: 1, waitMin: 15, bias: 'buy' })).toBe('シグナル待機');
  });

  it('可変の待ち時間がそのまま表示に出る(固定文字列ではない)', () => {
    expect(buildWaitMain({ count: 1, streak: 1, lastAt: 1, waitMin: 27, bias: 'sell' }))
      .toBe('シグナル待機（連続失効 27分1回 / 現在売り目線）');
    expect(buildWaitMain({ count: 1, streak: 1, lastAt: 1, waitMin: 30, bias: 'range' }))
      .toBe('シグナル待機（連続失効 30分1回 / 現在レンジ目線）');
  });
});

// ─────────────────────────────────────────────────────────────────────
// (c) 可変待ち時間(エンジン経路)
// ─────────────────────────────────────────────────────────────────────
describe('★(c) エントリーまでの距離とボラで待ち時間が変わる', () => {
  /** 直近30分の1分足を DB に置く(step=1分あたりの終値変化幅[円] → σ ≒ step)。 */
  function seedBars(step: number, endT: number): void {
    const db = openDb(resolveDbPath());
    try {
      for (let i = 30; i >= 0; i--) {
        const t = endT - i * MIN;
        const c = 63960 + (i % 2 === 0 ? step : -step) / 2;
        upsertBar(db, 'NIY=F', t, c, c + 1, c - 1, c, null, '2026-07-16', 'day');
      }
    } finally { db.close(); }
  }

  it('低ボラ×遠距離(155円/σ≒20)は 15分では失効せず、30分(上限)まで待つ', async () => {
    const eng = newEngineA();
    await eng.start();
    seedBars(20, NOW);   // σ≒20円/分 → (155/20)²=60分 ×K3 → 上限30分
    await feedPlan(eng, 63960, NOW);
    expect(eng.getPhase()).toBe('armed');

    // ① 15分ではまだ失効しない(従来ならここで失効していた)。
    const a0 = armedAt(eng);
    feedOnly(eng, 63960, a0 + 15 * MIN);
    expect(eng.getPhase()).toBe('armed');
    expect(eng._peekArmedTimeouts().count).toBe(0);
    // ② 29分59秒でもまだ armed。
    feedOnly(eng, 63960, a0 + 30 * MIN - 1000);
    expect(eng.getPhase()).toBe('armed');
    // ③ 30分で失効し、表示用の待ち時間も 30分 になる。
    const t = await advanceToExpiry(eng, 63960, 30);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 1, streak: 1 });
    expect(eng.getState(t).armedTimeout).toMatchObject({ waitMin: 30 });
  });

  it('高ボラなら同じ距離でも 15分のまま(=大多数の武装は挙動不変)', async () => {
    const eng = newEngineA();
    await eng.start();
    seedBars(120, NOW);   // σ≒120円/分 → (155/120)²=1.7分 ×K3=5分 → 下限15分
    await feedPlan(eng, 63960, NOW);
    expect(eng.getPhase()).toBe('armed');
    const t = await advanceToExpiry(eng, 63960);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 1, streak: 1 });
    expect(eng.getState(t).armedTimeout).toMatchObject({ waitMin: 15 });
  });

  it('★足が無い(σ が測れない)なら必ず下限15分=従来と同じ(fail-safe)', async () => {
    const eng = newEngineA();
    await eng.start();
    await feedPlan(eng, 63960, NOW);   // bars を撒かない
    await advanceToExpiry(eng, 63960);
    expect(eng._peekArmedTimeouts()).toMatchObject({ count: 1, streak: 1 });
  });

  it('★台帳(signal_plans)に「なぜこの待ち時間か」の材料が残る', async () => {
    const eng = newEngineA();
    await eng.start();
    seedBars(20, NOW);
    await feedPlan(eng, 63960, NOW);
    const db = openDb(resolveDbPath());
    try {
      const rows = getSignalPlans(db, 10, 'A');
      const armed = rows.find(r => r.signal_id != null);
      expect(armed).toBeTruthy();
      expect(armed!.arm_wait_ms).toBe(30 * MIN);
      expect(armed!.arm_wait_distance).toBe(155);        // |63960 − 63805|
      expect(armed!.arm_wait_sigma).toBeGreaterThan(0);
      expect(armed!.arm_wait_reason).toBe('cap');
    } finally { db.close(); }
  });

  it('★ログに決定内訳が1行残る(距離/σ/推定/採用値)', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    try {
      const eng = newEngineA();
      await eng.start();
      seedBars(20, NOW);
      await feedPlan(eng, 63960, NOW);
    } finally { spy.mockRestore(); }
    const line = logs.find(l => l.includes('arm-wait'));
    expect(line).toBeTruthy();
    expect(line).toContain('距離=155円');
    expect(line).toContain('σ=');
    expect(line).toContain('wait=30分');
  });
});

// ─────────────────────────────────────────────────────────────────────
// (d) 失効後の再武装 と 歯止め
// ─────────────────────────────────────────────────────────────────────
describe('★(d) 失効後に同じ価格を出し直せる / ただし無限には繰り返さない', () => {
  it('失効直後の再計画で同じ価格の計画がもう一度武装できる', async () => {
    const eng = newEngineA();
    await eng.start();
    await feedPlan(eng, 63960, NOW);
    const first = eng.getCurrentSignal();
    expect(first?.limitEntry).toBe(63805);

    await advanceToExpiry(eng, 63960);   // 失効 → 同 tick で再計画 → 再武装
    expect(eng.getPhase()).toBe('armed');
    const second = eng.getCurrentSignal();
    expect(second?.limitEntry).toBe(63805);            // ★同じ価格
    expect(second!.signalId).toBeGreaterThan(first!.signalId);   // 別のシグナルとして採番される
  });

  it(`★歯止め: 同じ価格が ${ARM_REPEAT_LIMIT} 回連続で失効したら、その価格は武装されなくなる`, async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const eng = newEngineA();
    let blockedAt = 0;
    try {
      await eng.start();
      await feedPlan(eng, 63960, NOW);
      // 失効1・2 は再武装される。
      await advanceToExpiry(eng, 63960);
      expect(eng.getPhase()).toBe('armed');
      await advanceToExpiry(eng, 63960);
      expect(eng.getPhase()).toBe('armed');
      // 3回目の失効でブロック → 同 tick の再計画は武装しない。
      blockedAt = await advanceToExpiry(eng, 63960);
      expect(eng.getPhase()).toBe('flat');
    } finally { spy.mockRestore(); }

    expect(eng._peekArmRepeat().streak).toBe(ARM_REPEAT_LIMIT);
    expect(eng._peekArmRepeat().blockedUntil).toBeGreaterThan(blockedAt);
    const line = logs.find(l => l.includes('arm-repeat-block'));
    expect(line).toBeTruthy();
    expect(line).toContain(`${ARM_REPEAT_LIMIT}回連続`);
  });

  it('★無限ループにならない: ブロック後は何度 tick しても武装されない(期限つき)', async () => {
    const eng = newEngineA();
    await eng.start();
    await feedPlan(eng, 63960, NOW);
    let last = 0;
    for (let i = 0; i < ARM_REPEAT_LIMIT; i++) last = await advanceToExpiry(eng, 63960);
    expect(eng.getPhase()).toBe('flat');

    // 以降 30分ぶん tick を回しても armed に戻らない。
    for (let m = 1; m <= 30; m++) {
      const t = last + m * MIN;
      vi.setSystemTime(t);
      eng.feed(63960, t);
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(eng.getPhase()).toBe('flat');
    }
    // ブロックは永久ではない(1時間で期限切れ)。
    expect(eng._peekArmRepeat().blockedUntil).toBeLessThanOrEqual(last + 60 * MIN + MIN);
  });

  it('約定したら歯止めはクリアされる(その価格帯は到達すると実証された)', async () => {
    const eng = newEngineA();
    await eng.start();
    _setExitImpl(() => 63700);
    await feedPlan(eng, 63960, NOW);
    await advanceToExpiry(eng, 63960);
    await advanceToExpiry(eng, 63960);
    expect(eng._peekArmRepeat().streak).toBe(2);
    feedOnly(eng, 63795, armedAt(eng) + MIN);   // 約定
    expect(eng.getPhase()).toBe('filled');
    expect(eng._peekArmRepeat().streak).toBe(0);
    expect(eng._peekArmRepeat().signature).toBeNull();
  });
});
