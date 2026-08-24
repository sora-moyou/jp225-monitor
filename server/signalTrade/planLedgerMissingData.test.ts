// ★段6: B が「判断に必要なデータが足りなかった」と自己申告した自由文(missing_data)が
//   **実ファイルの SQLite** に本当に入り、①(context_presence_json)と同じ行で突き合わせられることの実証。
//
// ■ ★否定対照
//   planLedger.ts の `if (sr.missingData !== undefined) row.missingData = sr.missingData;` を消せば
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

const ROOT = mkdtempSync(join(tmpdir(), 'jp225-missingdata-ledger-'));
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

describe('§実ファイルの台帳に missing_data が入る', () => {
  it('★B が「足りなかったデータ」を申告した回、実ファイルに残る(ai_why とは別列)', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'none', rationale: '見送り', refPrice: REF },
      noneReason: 'ai',
      splitRecord: {
        aDirection: 'buy', bVariant: 'buy', squeezeState: null,
        aiWhy: 'あ) 上に節目が無い / い) 下は遠すぎる',
        missingData: 'ATRが算出できず、節目データも0件でした',
      },
    });
    const r = readPlans()[0]!;
    console.info(`[実測/missing_data] ai_why=${r.ai_why} missing_data=${r.missing_data}`);
    expect(r.ai_why).toBe('あ) 上に節目が無い / い) 下は遠すぎる');
    expect(r.missing_data).toBe('ATRが算出できず、節目データも0件でした');
    eng.stop();
  });

  it('★申告が無い回は NULL のまま(捏造しない)', async () => {
    const eng = await runCycle({
      ok: true,
      plan: { direction: 'buy', rationale: '押し目買い', refPrice: REF, limitEntry: REF - 50, stopLossForLimit: REF - 100 },
      splitRecord: { bVariant: 'buy', squeezeState: 'squeeze' },
    });
    const r = readPlans()[0]!;
    expect(r.missing_data).toBeNull();
    eng.stop();
  });

  it('★①(context_presence_json)と同じ行で JOIN 無しに突き合わせられる(設計の目的)', async () => {
    // AI が「節目が無い」と missing_data に書いた回で、実際に levels ブロックが消えていたケース。
    let eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '見送り', refPrice: REF }, noneReason: 'ai',
      splitRecord: {
        bVariant: 'buy', squeezeState: null, aiWhy: '上に節目が無い', missingData: '節目データが取得できませんでした',
      },
      contextPresence: {
        atr: true, sessionHighLow: true, levels: false, bb: true, swing: true,
        longHorizon: true, alerts: true, dailyBand: true, basedata: true, news: false,
      },
    }, 1);
    eng.stop();
    // 対照: AI が「節目が無い」と書いたが、実際には levels ブロックがあった(自己申告と実測が食い違う)ケース。
    eng = await runCycle({
      ok: true, plan: { direction: 'none', rationale: '見送り', refPrice: REF }, noneReason: 'ai',
      splitRecord: {
        bVariant: 'buy', squeezeState: null, aiWhy: '上に節目が無い', missingData: '節目データが取得できませんでした',
      },
      contextPresence: {
        atr: true, sessionHighLow: true, levels: true, bb: true, swing: true,
        longHorizon: true, alerts: true, dailyBand: true, basedata: true, news: false,
      },
    }, 2);
    eng.stop();

    const db = openDb(resolveDbPath());
    // 「節目が無いと申告」かつ「実際に levels ブロックが消えていた」回だけを数える。
    const confirmed = (db.prepare(
      `SELECT COUNT(*) c FROM signal_plans
       WHERE missing_data LIKE '%節目%'
         AND context_presence_json LIKE '%"levels":false%'`,
    ).get() as { c: number }).c;
    const claimed = (db.prepare("SELECT COUNT(*) c FROM signal_plans WHERE missing_data LIKE '%節目%'").get() as { c: number }).c;
    db.close();
    console.info(`[実測/照合] 「節目が無い」と申告=${claimed}件 うち実際に levels=false=${confirmed}件`);
    expect(claimed).toBe(2);
    expect(confirmed).toBe(1);   // ★自己申告と実測が食い違う回を区別できる
  });
});
