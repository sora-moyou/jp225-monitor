// ★段5続き: contextPresence(文脈のどのブロックが実際に入ったか)が **実ファイルの SQLite** に
//   本当に入ることの実証(planLedgerAbSplit.test.ts / planLedgerProvenance.test.ts と同じ手法)。
//
// ■ ★否定対照
//   planLedger.ts の `if (result.contextPresence) row.contextPresenceJson = ...` を消せば
//   §分割 ON/OFF どちらも 赤になる(旧経路は「無条件で記録される」ことを守るテストなので、
//   分割の有無に関係なく赤くなる=この機能が split 専用ではないことの裏付け)。

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

const ROOT = mkdtempSync(join(tmpdir(), 'jp225-ctxpresence-ledger-'));
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

describe('§実ファイルの台帳に contextPresence が入る(A/B 分割の有無に関係なく無条件)', () => {
  it('★分割 OFF(splitRecord 無し)の回にも contextPresence は入る(旧経路でも記録される)', async () => {
    const presence = {
      atr: true, sessionHighLow: true, levels: false, bb: true, swing: false,
      longHorizon: true, alerts: false, dailyBand: true, basedata: true, news: false,
    };
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '押し目買い(分割 OFF)', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      contextPresence: presence,
      // ★splitRecord は無し(=分割 OFF)。これが「旧経路でも記録される」の実証点。
    });
    const r = readPlans()[0]!;
    console.info(`[実測/分割OFF] context_presence_json=${r.context_presence_json} a_direction=${r.a_direction}`);
    expect(r.a_direction).toBeNull();          // ★分割の列は従来どおり NULL
    expect(r.b_variant).toBeNull();
    expect(JSON.parse(r.context_presence_json!)).toEqual(presence);
    eng.stop();
  });

  it('★分割 ON(splitRecord あり)の回にも contextPresence が同じ行に入り、SQL で突き合わせられる', async () => {
    const presence = {
      atr: false, sessionHighLow: false, levels: false, bb: false, swing: false,
      longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
    };
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'none', rationale: 'B見送り', refPrice: REF },
      noneReason: 'ai',
      splitRecord: { aDirection: 'buy', bVariant: 'buy', squeezeState: null, aiWhy: '節目が無い' },
      contextPresence: presence,
    });
    const r = readPlans()[0]!;
    console.info(`[実測/分割ON・帯のみ] context_presence_json=${r.context_presence_json} `
      + `none_reason=${r.none_reason} b_variant=${r.b_variant}`);
    expect(r.b_variant).toBe('buy');
    expect(JSON.parse(r.context_presence_json!)).toEqual(presence);
    eng.stop();
  });

  it('★「本当に帯しか無かった回」を JOIN 無しで SQL 集計できる(設計の目的そのもの)', async () => {
    // ① ATR も節目も消えていて、none_reason='ai' の回。
    let eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '帯のみ', refPrice: REF }, noneReason: 'ai',
      contextPresence: {
        atr: false, sessionHighLow: false, levels: false, bb: false, swing: false,
        longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
      },
    }, 1);
    eng.stop();
    // ② 材料は十分にあったが、none_reason='ai' だった回(対照)。
    eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '材料はあった', refPrice: REF }, noneReason: 'ai',
      contextPresence: {
        atr: true, sessionHighLow: true, levels: true, bb: true, swing: true,
        longHorizon: true, alerts: true, dailyBand: true, basedata: true, news: false,
      },
    }, 2);
    eng.stop();

    const db = openDb(resolveDbPath());
    const n = (db.prepare(
      `SELECT COUNT(*) c FROM signal_plans
       WHERE none_reason = 'ai'
         AND context_presence_json LIKE '%"atr":false%'
         AND context_presence_json LIKE '%"levels":false%'`,
    ).get() as { c: number }).c;
    const total = (db.prepare("SELECT COUNT(*) c FROM signal_plans WHERE none_reason = 'ai'").get() as { c: number }).c;
    db.close();
    console.info(`[実測/母集団] none_reason='ai' 総数=${total} うち本当に帯しか無かった回=${n}`);
    expect(total).toBe(2);
    expect(n).toBe(1);
  });
});
