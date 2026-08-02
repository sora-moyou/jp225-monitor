import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ─── GET /api/status: 決済実装の「実態」を外から観測できる ─────────────────────
//
// 何を守っているか:
//   別プロセス(提案生成器)は monitor の中で決済仕様がどう解決されたかを知る手段が無かった。
//   private が不在なら変種のプロンプトは公開フォールバック(数値なし)になり、2本の生成器が
//   ほぼ同じ質問を投げる=実験は何も測っていないのに、記録には「候補仕様で生成した」と残る。
//   **測れていないことを外から確かめられる** ようにする。
//
// ★否定対照(修正前の routes/status.ts での結果): 応答は yahoo / llm / generator の3つだけで、
//   exit も generatorArms も存在しない → 本ファイルの主要テストが赤。
//   (実証手順: git show HEAD:server/routes/status.ts で旧版に差し替えて実行)
//
// ★このファイルは公開リポにも載る。決済の実数値は一切書かない・一切 assert しない。

vi.mock('../loops/priceLoop.js', () => ({ getYahooStatus: () => ({ fallback: false, skipUntil: 0 }) }));
vi.mock('../llm/openai.js', () => ({ getProviderStatus: () => [{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }] }));
vi.mock('../llm/generatorGate.js', () => ({
  generatorGateSnapshot: () => ({
    dayKey: '2026-06-01', sessionKey: '2026-06-01|Day', budget: 800, used: 3,
    haltedSessionKey: null, inFlight: 0, skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 },
  }),
  generatorArmUsage: () => ({ 'current': 2, 'candidate-a': 1 }),
}));
// DB は開かない(版は「未採番」= null として表示される経路を通す)。
vi.mock('../db/store.js', () => ({
  openDb: () => { throw new Error('no db in test'); },
  resolveDbPath: () => 'C:/nonexistent/test.db',
}));

const h = vi.hoisted(() => ({ kind: 'private' as 'private' | 'fallback' }));
vi.mock('../signalTrade/exitVariantImpl.js', () => ({ exitVariantImplKindAll: () => h.kind }));

import { statusHandler, exitStatus, _resetExitStatusCacheForTest } from './status.js';

interface MockRes extends Response { _json: unknown; }
function mockRes(): MockRes {
  const r = { _json: undefined as unknown, json(b: unknown) { r._json = b; return r; } };
  return r as unknown as MockRes;
}

describe('/api/status — 決済実装の実態', () => {
  beforeEach(() => {
    h.kind = 'private';
    _resetExitStatusCacheForTest();
  });

  it('既存フィールド(yahoo / llm / generator)は不変', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    const b = res._json as Record<string, unknown>;
    expect(b.yahoo).toEqual({ fallback: false, skipUntil: 0 });
    expect(b.llm).toEqual([{ name: 'gemini', enabled: true, paused: false, pausedUntil: 0 }]);
    expect((b.generator as { used: number }).used).toBe(3);
  });

  it('★exit に 実装種別 / 変種実装種別 / 版 / 指紋 が出る', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    const exit = (res._json as { exit: Record<string, unknown> }).exit;

    expect(['private', 'fallback']).toContain(exit.impl);
    expect(exit.variantImpl).toBe('private');
    expect(exit.configVersion).toBeNull();                 // DB 未解決 = 未採番として null
    expect(typeof exit.configHash).toBe('string');
    expect(exit.configHash as string).toMatch(/^[0-9a-f]{16}$/);   // 一方向ハッシュ(16桁hex)
  });

  it('★変種が公開フォールバックのままなら、それが実態として出る(黙って private を騙らない)', async () => {
    h.kind = 'fallback';
    const res = mockRes();
    await statusHandler({} as Request, res);
    expect(((res._json as { exit: Record<string, unknown> }).exit).variantImpl).toBe('fallback');
  });

  it('★腕ごとの消費が出る(合計だけではどの腕が枯れかけているか読めない)', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    expect((res._json as { generatorArms: unknown }).generatorArms).toEqual({ 'current': 2, 'candidate-a': 1 });
  });

  it('★応答に決済の実数値もキーも含まれない(出るのは種別・版・一方向ハッシュだけ)', async () => {
    const res = mockRes();
    await statusHandler({} as Request, res);
    const exit = (res._json as { exit: Record<string, unknown> }).exit;
    expect(Object.keys(exit).sort()).toEqual(['configHash', 'configVersion', 'impl', 'variantImpl']);
    expect(JSON.stringify(exit)).not.toMatch(/key|sk-|api[-_]?key/i);
  });

  it('DB が開けなくても /api/status は落ちない(診断表示のため)', async () => {
    await expect(exitStatus()).resolves.toMatchObject({ configVersion: null });
  });
});
