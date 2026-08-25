// ★「シグナル待機」の **理由** を SSE に載せる(画面が `（10:30までクールダウン）` を出せるようにする)。
//
// ■ なぜ要るか
//   engine は再計画を複数のゲートで止めている(取引時間外 / 決済後のクールダウン / 見送り後の節目クロス待ち)。
//   どれも console ログにしか出ておらず、画面からは「ただ待っている」ようにしか見えなかった。
//   ★無音の失敗と同じ構図: 止めている理由が画面に無いと、止まっているのか壊れているのか区別できない。
//
// ■ ★理由は「実際に止めているゲート」でなければ嘘になる(2026-08-17 の実測不具合)
//   maybeRequestPlan は `!inPollWindow(now)` で **クールダウンより前に** return する。ところが
//   planSuppressedAnchor をセッション境界で消す経路が無いため、引け後・週末もアンカーが残り
//   「節目クロス待ち」が出続けていた(stream.ts は接続時に state を返す=引け後にアプリを開くと必ず出る)。
//   → computeWaitReason は maybeRequestPlan の early return を **上から順に** 写す。
//
// ■ ADD-ONLY の不変条件
//   理由が無いときは **フィールドごと出さない**。これが崩れると既存 SSE JSON が変わり、旧クライアント互換が壊れる。
//   ※broadcast の dedupe(前回と同一 JSON なら送らない)は、toSignalTradeState が必ず `updatedAt: now` を
//     入れるので **実測で1度も効いていない**(1秒違いの2回で JSON 同値=false)。dedupe を根拠にした設計判断はしない。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';

let canned: ScalpPlanResult = { ok: false, error: 'unset' };
vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));
vi.mock('../sse/broker.js', () => ({ broadcast: () => { /* noop */ } }));

import { computeWaitReason, toSignalTradeState } from './decisions.js';
import { SignalEngine } from './engine.js';
import { setPrices } from '../cache.js';

/** 既定の入力(全ゲート素通り=理由なし)。各テストは1つだけ動かす。 */
const NOW = 1_000_000;
const base = {
  phase: 'flat' as const, planning: false, inPollWindow: true,
  cooldownUntilMs: null as number | null, planSuppressedAnchor: null as number | null,
  priceKnown: true, levelRearmReady: false, safetyValveElapsed: false, now: NOW,
};

// ─── 純関数: どのゲートが理由になるか(maybeRequestPlan と同じ順序) ───
describe('computeWaitReason(純関数)', () => {
  it('全ゲート素通りなら理由なし', () => {
    expect(computeWaitReason(base)).toBeNull();
  });

  it('★取引時間外はクールダウン/アンカーより先に来る(実際に最初に止めているのはこれ)', () => {
    expect(computeWaitReason({ ...base, inPollWindow: false })).toEqual({ kind: 'closed' });
    // 引け後にアンカーが残っていても「節目クロス待ち」とは言わない(これが 2026-08-17 の不具合)。
    expect(computeWaitReason({ ...base, inPollWindow: false, planSuppressedAnchor: 68700 })).toEqual({ kind: 'closed' });
    expect(computeWaitReason({ ...base, inPollWindow: false, cooldownUntilMs: NOW + 90_000 })).toEqual({ kind: 'closed' });
  });

  it('クールダウン中は解除時刻(絶対時刻)を返す', () => {
    expect(computeWaitReason({ ...base, cooldownUntilMs: NOW + 90_000 })).toEqual({ kind: 'cooldown', untilMs: NOW + 90_000 });
  });

  it('クールダウンが切れていれば理由にしない', () => {
    expect(computeWaitReason({ ...base, cooldownUntilMs: NOW - 1 })).toBeNull();
  });

  it('見送り後の抑止(アンカー在り)は節目クロス待ち', () => {
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700 })).toEqual({ kind: 'level' });
  });

  it('★クールダウンは節目クロス待ちより先(maybeRequestPlan と同じ順序)', () => {
    expect(computeWaitReason({ ...base, cooldownUntilMs: NOW + 90_000, planSuppressedAnchor: 68700 }))
      .toEqual({ kind: 'cooldown', untilMs: NOW + 90_000 });
  });

  it('★節目クロス済み / 安全弁経過 は「抑止していない」ので理由にしない', () => {
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, levelRearmReady: true })).toBeNull();
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, safetyValveElapsed: true })).toBeNull();
  });

  // ★価格が読めていなければ shouldRearmOnLevel を評価できていない=「節目クロス待ち」は確かめていないことの断定。
  //   過去にフィード無再接続で bot が盲目化して0取引になった事故があり、その最中にもっともらしい嘘を出すのが最悪。
  //   ★フィード断の新種別は作らない(接続状態は別の表示が担当)。理由を出さない=従来の「シグナル待機」に戻すだけ。
  it('★価格が読めなければ level を主張しない(場中でアンカーが据わっていても理由なし)', () => {
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, priceKnown: false })).toBeNull();
    // 価格が読めていれば従来どおり level(この1点だけの違いであることを固定する)。
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, priceKnown: true })).toEqual({ kind: 'level' });
    // ★時間外/クールダウンは価格に依らない事実なので、価格が無くても出す(消し過ぎない)。
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, priceKnown: false, inPollWindow: false }))
      .toEqual({ kind: 'closed' });
    expect(computeWaitReason({ ...base, planSuppressedAnchor: 68700, priceKnown: false, cooldownUntilMs: NOW + 90_000 }))
      .toEqual({ kind: 'cooldown', untilMs: NOW + 90_000 });
  });

  it('計画要求が飛行中 / flat 以外(武装中・保有中)は待機ではないので理由を出さない', () => {
    expect(computeWaitReason({ ...base, planning: true, planSuppressedAnchor: 68700 })).toBeNull();
    expect(computeWaitReason({ ...base, phase: 'armed', planSuppressedAnchor: 68700 })).toBeNull();
    expect(computeWaitReason({ ...base, phase: 'filled', cooldownUntilMs: NOW + 90_000 })).toBeNull();
    // ★時間外より前に来る(武装中は「待機」ではないので取引時間外とも言わない)。
    expect(computeWaitReason({ ...base, phase: 'armed', inPollWindow: false })).toBeNull();
  });
});

// ─── SSE state: ADD-ONLY(理由が無ければフィールドごと欠落) ───
describe('toSignalTradeState の waitReason は ADD-ONLY', () => {
  it('理由が無ければ JSON に現れない(既存 state と1バイトも変わらない)', () => {
    const b = toSignalTradeState({ phase: 'flat' }, 68700, 9);
    const withNull = toSignalTradeState({ phase: 'flat' }, 68700, 9, null, undefined, null, null);
    expect(JSON.stringify(withNull)).toBe(JSON.stringify(b));
    expect(withNull.waitReason).toBeUndefined();
  });

  it('理由が在れば載る', () => {
    const s = toSignalTradeState({ phase: 'flat' }, 68700, 9, null, undefined, null, { kind: 'cooldown', untilMs: 123 });
    expect(s.waitReason).toEqual({ kind: 'cooldown', untilMs: 123 });
  });
});

// ─── エンジン実機: 場中 / 引け後 / 週末 の3点 ───
describe('SignalEngine: 見送り後の state に載る待機理由(場中/引け後/週末)', () => {
  // 2026-08-03 は月曜。JST = UTC+9。
  const DAY = Date.UTC(2026, 7, 3, 1, 0, 0);      // 月 JST 10:00 …… 日中セッション中(inPollWindow=true)
  const AFTER_CLOSE = Date.UTC(2026, 7, 3, 7, 0, 0);  // 月 JST 16:00 …… 引け後(日中終了+10分〜ナイト開始5分前の谷間)
  const WEEKEND = Date.UTC(2026, 7, 8, 5, 0, 0);      // 土 JST 14:00 …… 週末
  const REF = 38250;
  const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };
  const NONE: ScalpPlanResult = {
    ok: true,
    plan: { direction: 'none', rationale: '方向感が定まらず見送り', refPrice: REF, regime: 'unclear', confidence: 25 },
    vetoFired: true, noneReason: 'trend',
  };

  /** 価格キャッシュに NIY=F を1本置く(getState はここから現在値を読む)。[] = 価格が読めない状態。 */
  const putPrice = (v: number | null): void => {
    setPrices(v == null ? [] : [{ symbol: 'NIY=F', price: v, changePercent: 0, timestamp: DAY, stale: false }]);
  };

  let dir: string;
  let origAppData: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-waitreason-'));
    origAppData = process.env.APPDATA;   // 実DBには触らない(temp の実ファイルへ隔離)
    process.env.APPDATA = dir;
    putPrice(REF);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    if (origAppData !== undefined) process.env.APPDATA = origAppData; else delete process.env.APPDATA;
    putPrice(null);   // 他のテストへ漏らさない
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('★場中=節目クロス待ち / 引け後=取引時間外 / 週末=取引時間外(アンカーは残ったまま)', async () => {
    canned = NONE;
    const eng = new SignalEngine(A_CFG);
    await eng.start();
    expect(eng.getState(DAY).waitReason).toBeUndefined();   // まだ何も抑止していない
    eng.feed(REF, DAY);
    // 見送りが返るとアンカーが据わる=場中は「節目クロス待ち」。
    // ★2026-08-25(ユーザー指示): 「○円以上、または○円以下になるまで待機」を出すため、
    //   level には **再武装の価格** が載る。この試験は節目スナップショットが無いので
    //   levelGate の ±50円フォールバックがそのまま出る(=判定に使う値と同じもの)。
    await vi.waitFor(() => expect(eng.getState(DAY).waitReason)
      .toEqual({ kind: 'level', upperTrigger: REF + 50, lowerTrigger: REF - 50 }), { timeout: 3000 });
    // ★同じアンカーのまま時計だけ進める。実際に止めているのは「取引時間外」なので、そう出なければ嘘になる。
    expect(eng.getState(AFTER_CLOSE).waitReason).toEqual({ kind: 'closed' });
    expect(eng.getState(WEEKEND).waitReason).toEqual({ kind: 'closed' });
    expect(eng.getPhase()).toBe('flat');
    eng.stop();
  });

  // ★フィード断(価格が取れない)で「節目クロス待ち」を出さない。
  //   getState() は tick と違って価格未取得でも呼ばれる(stream.ts の接続時送出がまさにこれ)。
  //   過去にフィード無再接続で bot が盲目化して0取引になった事故があり、その最中にもっともらしい嘘を
  //   出すのが最悪の形。★フィード断用の新種別は作らない=理由なし(従来の「シグナル待機」)に戻すだけ。
  it('★場中でアンカーが据わっていても、価格が読めなければ level を出さない', async () => {
    canned = NONE;
    const eng = new SignalEngine(A_CFG);
    await eng.start();
    eng.feed(REF, DAY);
    const LEVEL = { kind: 'level', upperTrigger: REF + 50, lowerTrigger: REF - 50 };
    await vi.waitFor(() => expect(eng.getState(DAY).waitReason).toEqual(LEVEL), { timeout: 3000 });
    putPrice(null);                                             // ★フィードが落ちた
    expect(eng.getState(DAY).waitReason).toBeUndefined();        // 嘘をつかない(理由を出さない)
    expect(eng.getState(AFTER_CLOSE).waitReason).toEqual({ kind: 'closed' });   // 時間外は価格に依らない事実
    putPrice(REF);                                              // 復旧したら元に戻る
    expect(eng.getState(DAY).waitReason).toEqual(LEVEL);
    eng.stop();
  });
});
