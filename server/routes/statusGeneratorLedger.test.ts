import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── GET /api/status: 「生成器 最終記録 N分前」を出す ──────────────────────────────
//
// 何を守っているか:
//   1年かけて溜める実験の最悪の失敗形は「1年後に、実は3か月動いていなかった」。
//   生成器側だけの死活監視は生成器が死んだら一緒に死ぬので、**ユーザーが見る画面** が読む
//   /api/status に出す。専用DBを **readOnly** で読むだけ(台帳を作らない・書かない)。
//
// ★否定対照(修正前の routes/status.ts): generatorLedger を返さない → 下の2件が赤。
//   isAnalysisEnabled() のゲートを外すと「lite では返さない」が赤。
//   実証手順: git show HEAD:server/routes/status.ts で差し替えて実行。

vi.mock('../loops/priceLoop.js', () => ({ getYahooStatus: () => ({ fallback: false, skipUntil: 0 }) }));
vi.mock('../llm/openai.js', () => ({ getProviderStatus: () => [] }));
vi.mock('../llm/generatorGate.js', () => ({
  generatorGateSnapshot: () => ({ dayKey: 'd', sessionKey: 's', budget: 800, used: 0, haltedSessionKey: null, inFlight: 0, skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 } }),
  generatorArmUsage: () => ({}),
}));
vi.mock('../db/store.js', () => ({
  openDb: () => { throw new Error('no db in test'); },
  resolveDbPath: () => 'C:/nonexistent/test.db',
}));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({ exitVariantImplKindAll: () => 'private' }));

import { statusHandler, _resetExitStatusCacheForTest } from './status.js';
import { openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

interface MockRes extends Response { _json: unknown; }
function mockRes(): MockRes {
  const r = { _json: undefined as unknown, json(b: unknown) { r._json = b; return r; } };
  return r as unknown as MockRes;
}

const row = (over: Partial<ProposalRow> = {}): ProposalRow => ({
  epoch: 'g1:abc', cycleId: 'c-1', arm: 'current', exitVariant: 'current', seq: 0,
  sessionDate: '2026-08-03', requestedAt: Date.now() - 3 * 60_000, respondedAt: Date.now(), latencyMs: 1,
  status: 'plan', skipReason: null, httpStatus: 200, error: null,
  retried: 0, retryCount: 0, preRetryReason: null,
  direction: 'none', planJson: '{}', refPrice: 1, regime: null, confidence: null,
  noneReason: 'ai', noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
  shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: Date.now(),
  ...over,
});

describe('/api/status — 生成器の台帳の死活', () => {
  const savedVariant = process.env.MONITOR_VARIANT;
  const savedDb = process.env.JP225_GENERATOR_DB;
  let dir: string;

  beforeEach(() => {
    _resetExitStatusCacheForTest();
    dir = mkdtempSync(join(tmpdir(), 'jp225-genstatus-'));
    process.env.JP225_GENERATOR_DB = join(dir, 'generator_proposals.db');
    delete process.env.MONITOR_VARIANT;
  });
  afterEach(() => {
    if (savedVariant === undefined) delete process.env.MONITOR_VARIANT; else process.env.MONITOR_VARIANT = savedVariant;
    if (savedDb === undefined) delete process.env.JP225_GENERATOR_DB; else process.env.JP225_GENERATOR_DB = savedDb;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★台帳が無い環境でも 500 にせず available:false を返す', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    expect((res._json as Record<string, unknown>).generatorLedger).toEqual({
      available: false, lastRecordAt: null, ageMin: null, today: [], total: 0,
    });
  });

  it('★記録があれば「最終記録 N分前」を返す(腕別の当日件数つき)', async () => {
    const db = openGeneratorDb(process.env.JP225_GENERATOR_DB!);
    insertProposal(db, row({ arm: 'current' }));
    insertProposal(db, row({ arm: 'candidate-a', exitVariant: 'candidate-a' }));
    db.close();
    const res = mockRes();
    await statusHandler({} as Request, res);
    const led = (res._json as { generatorLedger: { available: boolean; ageMin: number; total: number; today: unknown[] } }).generatorLedger;
    expect(led.available).toBe(true);
    expect(led.ageMin).toBe(3);
    expect(led.total).toBe(2);
    expect(led.today).toHaveLength(2);
  });

  it('★公開版(lite)では generatorLedger を返さない(存在しない機構の状態を出さない)', async () => {
    process.env.MONITOR_VARIANT = 'lite';
    const res = mockRes();
    await statusHandler({} as Request, res);
    expect(Object.prototype.hasOwnProperty.call(res._json, 'generatorLedger')).toBe(false);
  });
});
