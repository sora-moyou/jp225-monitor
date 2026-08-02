import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── ★B1(死活)の通し実証: 実 DB → 実ハンドラ(/api/status) → 実描画 ────────────────
//
// 単体のモックだけだと「サーバは新しい数字を返しているのに画面は緑のまま」に気づけない。
// ここでは **従属停止中の生成器が実際に書く行**(2分ごとの status='skipped')を実ファイルの台帳に入れ、
// statusHandler を通し、その JSON をそのまま画面の描画関数に渡して **緑にならないこと** を見る。
//
// ★否定対照: git show HEAD:server/db/generatorStore.ts / HEAD:web/components/apiStatusPane.ts に
//   戻すと、この2件は 🟢 が返って赤になる(=修正前は「止まっているのに緑」だった)。

vi.mock('../loops/priceLoop.js', () => ({ getYahooStatus: () => ({ fallback: false, skipUntil: 0 }) }));
vi.mock('../llm/openai.js', () => ({ getProviderStatus: () => [] }));
vi.mock('../llm/generatorGate.js', () => ({
  generatorGateSnapshot: () => ({ dayKey: 'd', sessionKey: 's', budget: 800, used: 0, haltedSessionKey: 's', inFlight: 0, skipped: { busy: 0, budget: 0, defaultQuota: 30, disabled: 0 } }),
  generatorArmUsage: () => ({}),
}));
vi.mock('../db/store.js', () => ({
  openDb: () => { throw new Error('no db in test'); },
  resolveDbPath: () => 'C:/nonexistent/test.db',
}));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({ exitVariantImplKindAll: () => 'private' }));

import { statusHandler, _resetExitStatusCacheForTest } from './status.js';
import { openGeneratorDb, insertProposal, type ProposalRow } from '../db/generatorStore.js';
import { renderGeneratorDot } from '../../web/components/apiStatusPane.js';
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
  sessionDate: '2026-08-03', requestedAt: Date.now(), respondedAt: Date.now(), latencyMs: 1,
  status: 'plan', skipReason: null, httpStatus: 200, error: null,
  retried: 0, retryCount: 0, preRetryReason: null,
  direction: 'none', planJson: '{}', refPrice: 1, regime: null, confidence: null,
  noneReason: 'ai', noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
  shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: Date.now(),
  ...over,
});

/** /api/status を実際に叩いて generatorLedger を取り出す。 */
async function ledger(): Promise<Parameters<typeof renderGeneratorDot>[0]> {
  const res = mockRes();
  await statusHandler({} as Request, res);
  return (res._json as { generatorLedger: Parameters<typeof renderGeneratorDot>[0] }).generatorLedger;
}

describe('★停止中の生成器は画面で緑にならない(実DB→実ハンドラ→実描画)', () => {
  const savedVariant = process.env.MONITOR_VARIANT;
  const savedDb = process.env.JP225_GENERATOR_DB;
  let dir: string;

  beforeEach(() => {
    _resetExitStatusCacheForTest();
    dir = mkdtempSync(join(tmpdir(), 'jp225-genlivestatus-'));
    process.env.JP225_GENERATOR_DB = join(dir, 'generator_proposals.db');
    delete process.env.MONITOR_VARIANT;
  });
  afterEach(() => {
    if (savedVariant === undefined) delete process.env.MONITOR_VARIANT; else process.env.MONITOR_VARIANT = savedVariant;
    if (savedDb === undefined) delete process.env.JP225_GENERATOR_DB; else process.env.JP225_GENERATOR_DB = savedDb;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('★従属停止中(skipped を2分ごとに書き続けている)は 🟡 で「標本が溜まっていません」', async () => {
    const db = openGeneratorDb(process.env.JP225_GENERATOR_DB!);
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      insertProposal(db, row({
        cycleId: `halt-${i}`, requestedAt: now - i * 120_000,
        status: 'skipped', skipReason: 'default-quota', httpStatus: 429, planJson: null, direction: null,
      }));
    }
    db.close();

    const led = await ledger();
    expect(led!.available).toBe(true);
    expect(led!.ageMin).toBe(0);            // ← 旧指標は「生きている」と言う
    expect(led!.planLastHour).toBe(0);      // ★標本は1件も取れていない
    const html = renderGeneratorDot(led);
    expect(html).not.toContain('🟢');
    expect(html).toContain('標本が溜まっていません');
  });

  it('正常に回っていれば 🟢(誤検知しない)', async () => {
    const db = openGeneratorDb(process.env.JP225_GENERATOR_DB!);
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      insertProposal(db, row({ cycleId: `ok-${i}`, requestedAt: now - i * 120_000 }));
    }
    db.close();
    const html = renderGeneratorDot(await ledger());
    expect(html).toContain('🟢');
  });
});
