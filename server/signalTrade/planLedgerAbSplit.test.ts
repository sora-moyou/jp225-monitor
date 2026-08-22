// ★段5: A/B 分割の測定材料が **実ファイルの SQLite** に本当に入ることの実証。
//
// ■ なぜ要るか
//   buildSignalPlanInsert(純関数)のユニットテストは通っていても、実際に
//   SignalEngine → insertSignalPlan → 実ファイル DB まで届くかは別問題(メモリ上のオブジェクトの
//   組み立てだけを見て、DB 書込・列マイグレーション・読み出しは見ていない)。
//   このファイルは planLedgerProvenance.test.ts と同じ手法(runScalpPlanWithChart をモックし、
//   SignalEngine を実際に1サイクル走らせる)で、実ファイル DB に対して検証する。
//
// ■ ★否定対照
//   planLedger.ts の splitRecord 読み取りブロックを消せば §新しい列が実際に埋まる が赤くなる
//   (§旧経路 は無傷のまま=後方互換が壊れていないことも同時に確かめられる)。
//
// ■ ★実データではなく、このテストが作った合成データで検証する(実 LLM は呼ばない)。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';

let canned: ScalpPlanResult = { ok: false, error: 'unset' };

vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));
vi.mock('../sse/broker.js', () => ({ broadcast: () => { /* noop */ } }));

import { SignalEngine } from './engine.js';
import { openDb, resolveDbPath, getSignalPlans, type SignalPlanRow } from '../db/store.js';

const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);   // 取引時間内(2026-08-03 月曜 10:00 JST)
const REF = 38250;
const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

// ★ユーザーの実DBを絶対に触らない(planLedgerProvenance.test.ts と同じ隔離作法)。
const ROOT = mkdtempSync(join(tmpdir(), 'jp225-absplit-ledger-'));
const QUARANTINE = join(ROOT, 'quarantine');
mkdirSync(QUARANTINE, { recursive: true });
const ORIG_APPDATA = process.env.APPDATA;
process.env.APPDATA = QUARANTINE;

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = join(ROOT, `case-${++seq}`);
  mkdirSync(dir, { recursive: true });
  process.env.APPDATA = dir;
  vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});
afterEach(() => {
  process.env.APPDATA = QUARANTINE;
  vi.restoreAllMocks();
});
afterAll(() => {
  if (ORIG_APPDATA !== undefined) process.env.APPDATA = ORIG_APPDATA; else delete process.env.APPDATA;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

function readPlans(): SignalPlanRow[] {
  const db = openDb(resolveDbPath());
  try { return getSignalPlans(db); } finally { db.close(); }
}

/** SQL を実ファイル DB に対して直接走らせるための生アクセス(検算用)。 */
function count(sql: string): number {
  const db = openDb(resolveDbPath());
  try { return (db.prepare(`SELECT COUNT(*) c FROM signal_plans WHERE ${sql}`).get() as { c: number }).c; }
  finally { db.close(); }
}

async function runCycle(result: ScalpPlanResult, want = 1): Promise<SignalEngine> {
  canned = result;
  const eng = new SignalEngine(A_CFG);
  await eng.start();
  eng.feed(REF, NOW);
  await vi.waitFor(() => expect(readPlans().length).toBe(want), { timeout: 3000 });
  return eng;
}

describe('§旧経路(splitRecord 無し)= 実ファイルの新6+8列が NULL のまま', () => {
  it('見送り(none・trend)の回: 既存列は従来どおり埋まり、A/B 分割の新列は全て NULL', async () => {
    const eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '方向感が定まらず見送り', refPrice: REF },
      noneReason: 'trend',
    });
    const r = readPlans()[0]!;
    // ★実測: 件数と中身をここで1行報告する(規範どおり)。
    console.info(`[実測/旧経路] 行数=${readPlans().length} direction=${r.direction} none_reason=${r.none_reason}`);
    expect(r.direction).toBe('none');
    expect(r.none_reason).toBe('trend');
    for (const v of [
      r.a_direction, r.a_why, r.b_variant, r.squeeze_state, r.squeeze_unavailable,
      r.b_strategy, r.ai_why, r.tool_calls,
      r.a_provider, r.a_provider_model, r.b_provider, r.b_provider_model,
      r.a_prompt_build, r.b_prompt_build,
    ]) expect(v).toBeNull();
    eng.stop();
  });

  it('ARM(buy)の回: 既存4価格は従来どおり埋まり、新列は NULL', async () => {
    const eng = await runCycle({
      ok: true,
      plan: {
        direction: 'buy', rationale: '押し目買い', refPrice: REF,
        limitEntry: REF - 50, stopLossForLimit: REF - 100,
        stopEntry: REF + 50, stopLossForStop: REF,
      },
    });
    const r = readPlans()[0]!;
    expect(r.direction).toBe('buy');
    expect(r.limit_entry).toBe(REF - 50);
    expect(r.stop_entry).toBe(REF + 50);
    expect(r.a_direction).toBeNull();
    expect(r.b_variant).toBeNull();
    eng.stop();
  });
});

describe('§分割 ON = 実ファイルに新列が実際に埋まる', () => {
  it('A=bull → B(buy) まで進んだ回: 8列 + プロバイダ2組 + プロンプト型2つが実ファイルに入る', async () => {
    const eng = await runCycle({
      ok: true,
      plan: {
        direction: 'buy', rationale: '押し目買い(A/B分割経由)', refPrice: REF,
        limitEntry: REF - 50, stopLossForLimit: REF - 100,
        stopEntry: REF + 50, stopLossForStop: REF,
      },
      splitRecord: {
        aDirection: 'bull', aWhy: '高値切り上げが3本続いている', bVariant: 'buy',
        squeezeState: 'squeeze', bStrategy: '押し目を節目手前で拾う', toolCalls: 2,
        aProvider: { name: 'gemini', model: 'gemini-flash' },
        bProvider: { name: 'groq', model: 'llama-70b' },
        aPromptBuild: 'pb1:1111111111111111', bPromptBuild: 'pb1:2222222222222222',
      },
    });
    const r = readPlans()[0]!;
    console.info(`[実測/分割ON] a_direction=${r.a_direction} b_variant=${r.b_variant} `
      + `a_provider=${r.a_provider} b_provider=${r.b_provider} `
      + `a_prompt_build=${r.a_prompt_build} b_prompt_build=${r.b_prompt_build}`);
    expect(r.a_direction).toBe('bull');
    expect(r.a_why).toBe('高値切り上げが3本続いている');
    expect(r.b_variant).toBe('buy');
    expect(r.squeeze_state).toBe('squeeze');
    expect(r.squeeze_unavailable).toBeNull();
    expect(r.b_strategy).toBe('押し目を節目手前で拾う');
    expect(r.tool_calls).toBe(2);
    // ★これが設計の芯: A と B が別プロバイダで答えても、片方に潰れず両方が実ファイルの別列に残る。
    expect(r.a_provider).toBe('gemini');
    expect(r.a_provider_model).toBe('gemini-flash');
    expect(r.b_provider).toBe('groq');
    expect(r.b_provider_model).toBe('llama-70b');
    expect(r.a_prompt_build).toBe('pb1:1111111111111111');
    expect(r.b_prompt_build).toBe('pb1:2222222222222222');
    eng.stop();
  });
});

describe('§設計の芯: ①②③④が SQL で別々に数えられる(実ファイル・複数サイクル)', () => {
  it('①A=range ②レンジ不許可で B 未呼出 ③理由つき見送り ④コードの検証で落ちた — が全部別カウントになる', async () => {
    // ① かつ ②: A が range、レンジ不許可のため B を呼ばなかった。
    let eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: 'レンジにつき見送り', refPrice: REF },
      noneReason: 'rangeDisabled',
      splitRecord: { aDirection: 'range', aWhy: '方向感なし', bVariant: 'none', squeezeState: null },
    }, 1);
    eng.stop();

    // ③ B が理由つきで見送った(ai_why が入る)。
    eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: 'B見送り', refPrice: REF }, noneReason: 'ai',
      splitRecord: {
        aDirection: 'bull', bVariant: 'buy', squeezeState: null,
        aiWhy: 'あ) 上に節目が無い / い) 下は遠すぎる',
      },
    }, 2);
    eng.stop();

    // ④ B は答えたがコードの検証(geometry)で落ちた。
    eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '検証で不採用', refPrice: REF }, noneReason: 'geometry',
      splitRecord: { aDirection: 'bear', bVariant: 'sell', squeezeState: 'bulge' },
    }, 3);
    eng.stop();

    // ①(別カウント用のもう1件): A=range だがレンジ許可で B(range-fade)まで進んだ回。
    eng = await runCycle({
      ok: true, plan: { direction: 'range', rationale: 'レンジ両指値', refPrice: REF },
      splitRecord: { aDirection: 'range', bVariant: 'range-fade', squeezeState: null },
    }, 4);
    eng.stop();

    // ★実測: 母集団を1行で報告してから検算に入る(規範どおり)。
    const all = readPlans();
    console.info(`[実測/設計の芯] 総行数=${all.length}`);
    expect(all).toHaveLength(4);

    const cReturn = count("a_direction = 'range'");                                                 // ①
    const cNoB = count("a_direction = 'range' AND b_variant = 'none'");                              // ②
    const cAiReason = count("none_reason = 'ai' AND ai_why IS NOT NULL");                            // ③
    const cCodeReject = count("none_reason IN ('geometry','lcWidthInvalid','stopSide','lc','lcFloor')"); // ④
    console.info(`[実測/SQL] ①range=${cReturn} ②B未呼出=${cNoB} ③理由つき見送り=${cAiReason} ④検証で落ちた=${cCodeReject}`);
    expect(cReturn).toBe(2);      // rangeDisabled回 + range-fade回
    expect(cNoB).toBe(1);         // rangeDisabled回のみ
    expect(cAiReason).toBe(1);    // ai_why つきの1件のみ
    expect(cCodeReject).toBe(1);  // geometry の1件のみ
    // ★4つとも重複せず・別々の値で切れている(設計の芯そのもの)。
    expect(cNoB).toBeLessThanOrEqual(cReturn);
  });
});
