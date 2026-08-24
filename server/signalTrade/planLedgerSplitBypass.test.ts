// ★段6続き: 「分割ON設定なのに、この回だけ旧経路へ落とした」ことが **実ファイルの SQLite** に
//   本当に記録されることの実証(planLedgerMissingData.test.ts と同じ手法)。
//
// ■ ★否定対照
//   planLedger.ts の `if (result.splitBypassReason) row.splitBypassReason = ...` を消せば
//   このファイルの全テストが赤になる。

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

const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);
const REF = 38250;
const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

const ROOT = mkdtempSync(join(tmpdir(), 'jp225-splitbypass-ledger-'));
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

async function runCycle(result: ScalpPlanResult, want = 1): Promise<SignalEngine> {
  canned = result;
  const eng = new SignalEngine(A_CFG);
  await eng.start();
  eng.feed(REF, NOW);
  await vi.waitFor(() => expect(readPlans().length).toBe(want), { timeout: 3000 });
  return eng;
}

describe('§実ファイルの台帳に split_bypass_reason が入る', () => {
  it('★heldPosition が理由で旧経路へ落ちた回、実ファイルに残る', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '押し目買い(ドテン評価・旧経路)', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitBypassReason: 'heldPosition',
    });
    const r = readPlans()[0]!;
    console.info(`[実測/split_bypass_reason] split_bypass_reason=${r.split_bypass_reason} direction=${r.direction}`);
    expect(r.split_bypass_reason).toBe('heldPosition');
    expect(r.direction).toBe('buy');
    eng.stop();
  });

  it('★複数該当のカンマ区切りも実ファイルに残る', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'none', rationale: '見送り', refPrice: REF },
      splitBypassReason: 'heldPosition,promptVariant',
    });
    const r = readPlans()[0]!;
    expect(r.split_bypass_reason).toBe('heldPosition,promptVariant');
    eng.stop();
  });

  it('★該当なし(通常の分割ON/分割OFF)の回は NULL のまま(捏造しない)', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '通常の押し目買い', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitRecord: { aDirection: 'buy', bVariant: 'buy', squeezeState: null },
    });
    const r = readPlans()[0]!;
    expect(r.split_bypass_reason).toBeNull();
    expect(r.b_variant).toBe('buy');   // 通常の分割ONは splitRecord がそのまま記録される
    eng.stop();
  });

  it('★フォールバックの頻度をSQLで測れる(設計の目的)', async () => {
    let eng = await runCycle({
      ok: true, plan: { direction: 'buy', rationale: 'x', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitBypassReason: 'heldPosition',
    }, 1);
    eng.stop();
    eng = await runCycle({
      ok: true, plan: { direction: 'buy', rationale: 'y', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitRecord: { aDirection: 'buy', bVariant: 'buy', squeezeState: null },
    }, 2);
    eng.stop();

    const db = openDb(resolveDbPath());
    const total = (db.prepare('SELECT COUNT(*) c FROM signal_plans').get() as { c: number }).c;
    const bypassed = (db.prepare("SELECT COUNT(*) c FROM signal_plans WHERE split_bypass_reason IS NOT NULL").get() as { c: number }).c;
    db.close();
    console.info(`[実測/頻度] 総行数=${total} うちフォールバック=${bypassed}`);
    expect(total).toBe(2);
    expect(bypassed).toBe(1);
  });
});

describe('§実ファイルの台帳に caller/exitVariant/emptyTrendContext のフォールバック理由が入る', () => {
  it("★分析用(caller='generator')が理由で旧経路へ落ちた回、実ファイルに残る", async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '分析用の候補腕(旧経路)', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitBypassReason: 'caller',
    });
    const r = readPlans()[0]!;
    console.info(`[実測/caller] split_bypass_reason=${r.split_bypass_reason}`);
    expect(r.split_bypass_reason).toBe('caller');
    eng.stop();
  });

  it('★exitVariant が理由で旧経路へ落ちた回、実ファイルに残る', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'sell', rationale: '決済仕様の候補腕(旧経路)', refPrice: REF, limitEntry: REF + 50, stopLossForLimit: REF + 100 },
      splitBypassReason: 'exitVariant',
    });
    const r = readPlans()[0]!;
    expect(r.split_bypass_reason).toBe('exitVariant');
    eng.stop();
  });

  it('★emptyTrendContext(文脈構築の失敗)が理由で旧経路へ落ちた回、実ファイルに残る', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '文脈空・旧経路にフォールバック', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitBypassReason: 'emptyTrendContext',
    });
    const r = readPlans()[0]!;
    expect(r.split_bypass_reason).toBe('emptyTrendContext');
    expect(r.direction).toBe('buy');   // ★全見送りにならず計画が出ている
    eng.stop();
  });

  it('★複数該当(promptVariant,caller)も実ファイルに残る(分析用の候補腕の実例)', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'none', rationale: '見送り', refPrice: REF },
      splitBypassReason: 'promptVariant,caller',
    });
    const r = readPlans()[0]!;
    expect(r.split_bypass_reason).toBe('promptVariant,caller');
    eng.stop();
  });
});
