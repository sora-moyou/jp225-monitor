// ★記録が「生成器の台帳の列」まで届くことの実証(応答 → ProposalRow → proposals.leg_drops_json)。
//
// ■ 何を守っているか
//   片レッグだけ落ちた理由(legDrops)を scalpPlan.ts で作っても、
//     ① /api/scalp-plan の応答に載らない  ② 台帳の列に写されない
//   のどちらかで落ちれば、A系統/B系統の実験は結局また測れない。だから
//   **HTTP 応答 → 生成器の行 → SQLite の列 → SELECT で読み出す** まで一続きで確認する。
//
// ■ ★否定対照(この修正前のコードでの結果)
//   git show HEAD:server/routes/scalpPlan.ts > <tmp> の planDiagnostics は legDrops を透過しないため
//   「応答に載る」テストが赤 → 連鎖して「列に届く」テストも赤。
//   git show HEAD:server/db/generatorStore.ts の INSERT には leg_drops_json 列が無いため、
//   列の読み出しが赤(SQLite が no such column で落ちる)。
//   ★レガシー経路(caller/exitVariant 省略)のバイト一致は旧版でも新版でも緑=記録だけを足した対照。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const buildScalpPlanMock = vi.fn();
vi.mock('../llm/openai.js', () => ({
  buildScalpPlan: (...a: unknown[]) => buildScalpPlanMock(...a),
  firstAvailableVisionProvider: () => null,
  resolveEffectiveRangeEnabled: () => false,
}));
vi.mock('../cache.js', () => ({
  getPrices: () => [{ symbol: 'NIY=F', price: 38250 }],
  getNews: () => [],
}));
vi.mock('../chatContext.js', () => ({ buildNikkeiTechnical: () => 'tech' }));
vi.mock('../chart/chartShot.js', () => ({ captureChartPngCached: vi.fn() }));
vi.mock('../feedBars.js', () => ({ getRealtimeOHLCBars: () => [] }));
vi.mock('../configStore.js', () => ({
  resolvePort: () => 3000,
  resolveScalpTrendVetoYen: () => 100,
  resolveScalpChartFallbackText: () => true,
  // ★v0.9.70: チャート画像は既定 off(送らない・撮影もしない)。このテストは画像の有無を対象にしない。
  resolveScalpChartVisionMode: () => 'off' as const,

  resolveIndicatorsEnabled: () => true,
  resolveGeneratorDailyBudget: () => 1000,
}));

import { scalpPlanHandler } from './scalpPlan.js';
import { resetGeneratorGateForTest } from '../llm/generatorGate.js';
import { classifyAttempt, toProposalRow, type ArmOutcome, type ArmRequest } from '../generator/cycle.js';
import { openGeneratorDb, insertProposal } from '../db/generatorStore.js';

interface MockRes extends Response { _json: unknown; _status: number; }
function mockRes(): MockRes {
  const r = {
    _json: undefined as unknown,
    _status: 200,
    status(code: number) { r._status = code; return r; },
    json(body: unknown) { r._json = body; return r; },
  };
  return r as unknown as MockRes;
}
const reqOf = (body: Record<string, unknown> = {}) => ({ body, query: {} }) as unknown as Request;

/** 片レッグだけ落ちた回(逆指値だけが向き違反で消え、指値は採用された)の生の結果。 */
const ONE_LEG_DROPPED = {
  ok: true,
  plan: { direction: 'buy', rationale: '押し目買い', refPrice: 38250, limitEntry: 38200, stopLossForLimit: 38150 },
  vetoFired: false,
  legDrops: [{ name: 'stop', reason: 'stopSide', entry: 38350, stopLoss: 38400 }],
};

const tmpDirs: string[] = [];
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'jp225-legdrop-'));
  tmpDirs.push(d);
  return join(d, 'generator_proposals.db');
}
afterEach(() => {
  while (tmpDirs.length) { try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('/api/scalp-plan — 片レッグ脱落の理由が応答に載る', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(ONE_LEG_DROPPED);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it("caller:'generator' の応答は legDrops を載せる(見送りでなくても)", async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const body = res._json as Record<string, unknown>;
    expect(res._status).toBe(200);
    // 見送りではない(採用されたレッグがある)回でも記録が届く=ここが従来の穴だった。
    expect((body.plan as { direction: string }).direction).toBe('buy');
    expect(body.legDrops).toEqual(ONE_LEG_DROPPED.legDrops);
    expect('noneReason' in body).toBe(false);   // 見送りではないので従来どおり付かない
  });

  it('legDrops を持たない結果ではフィールドを付けない', async () => {
    buildScalpPlanMock.mockResolvedValue({ ok: true, plan: { direction: 'buy' } });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    expect('legDrops' in (res._json as Record<string, unknown>)).toBe(false);
  });

  it('★レガシー経路(caller 省略 かつ exitVariant 省略)は応答バイト一致(legDrops も足さない)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({}), res);
    expect(JSON.stringify(res._json)).toBe(
      '{"ok":true,"plan":{"direction":"buy","rationale":"押し目買い","refPrice":38250,"limitEntry":38200,"stopLossForLimit":38150}}',
    );
  });

  it('応答に決済ラダーの実数値やキーは混ざらない(載るのは AI が出したレッグ価格と理由だけ)', async () => {
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    // ★記録専用の出所2列は数値の走査から外し、**形だけ** を固定する(理由は scalpPlanDiagnostics.test.ts と同じ:
    //   contextAt は時計の読み・promptFp は一方向ハッシュで、hex 中の数字列の一致は偶然でしかない)。
    const { contextAt, promptFp, ...rest } = res._json as Record<string, unknown>;
    expect(typeof contextAt).toBe('number');
    expect(promptFp === undefined || /^sp1:[0-9a-f]{16}$/.test(String(promptFp))).toBe(true);
    const s = JSON.stringify(rest);
    expect(s).not.toMatch(/key|sk-|api[-_]?key/i);
    const nums = (s.match(/\d+/g) ?? []).map(Number);
    expect(nums.every(n => [38250, 38200, 38150, 38350, 38400].includes(n))).toBe(true);
  });
});

describe('★応答 → 台帳の列(proposals.leg_drops_json)まで届く', () => {
  beforeEach(() => {
    buildScalpPlanMock.mockReset().mockResolvedValue(ONE_LEG_DROPPED);
    resetGeneratorGateForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('HTTP 応答をそのまま生成器の1行にして書き込むと、列から読み出せる', async () => {
    // ① 実際のハンドラを叩いて応答本体を得る(手で JSON を書かない=経路を跨ぐ変換を実物で確かめる)。
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator', exitVariant: 'current' }), res);

    // ② 生成器の分類 → 台帳の行(cycle.ts の純関数をそのまま使う)。
    const attempt = classifyAttempt(200, res._json);
    expect(attempt.status).toBe('plan');
    const req: ArmRequest = { arm: 'current', exitVariant: 'current', seq: 0 };
    const outcome: ArmOutcome = {
      attempt, requestedAt: 1_700_000_000_000, respondedAt: 1_700_000_001_000,
      retryCount: 0, preRetryReason: null,
    };
    const row = toProposalRow('g1:test', 'c-1', req, outcome);
    expect(row.legDropsJson).toBe(JSON.stringify(ONE_LEG_DROPPED.legDrops));

    // ③ 実際に SQLite へ書いて、列から読み戻す。
    const db = openGeneratorDb(tmpDb());
    try {
      expect(insertProposal(db, row)).toBe(true);
      const got = db.prepare('SELECT direction, none_reason, none_legs_json, leg_drops_json FROM proposals')
        .get() as { direction: string; none_reason: string | null; none_legs_json: string | null; leg_drops_json: string | null };
      expect(got.direction).toBe('buy');
      // ★「見送りではない」のに脱落理由が読める= 79%/5.9% の取り違えを二度と起こさないための列。
      expect(got.none_reason).toBeNull();
      expect(got.none_legs_json).toBeNull();
      expect(JSON.parse(got.leg_drops_json!)).toEqual([
        { name: 'stop', reason: 'stopSide', entry: 38350, stopLoss: 38400 },
      ]);
    } finally {
      db.close();
    }
  });

  it('legDrops が無い応答は NULL で入る(捏造しない)', async () => {
    buildScalpPlanMock.mockResolvedValue({ ok: true, plan: { direction: 'buy', refPrice: 38250 } });
    const res = mockRes();
    await scalpPlanHandler(reqOf({ caller: 'generator' }), res);
    const row = toProposalRow('g1:test', 'c-2',
      { arm: 'current', exitVariant: 'current', seq: 0 },
      {
        attempt: classifyAttempt(200, res._json), requestedAt: 1, respondedAt: 2,
        retryCount: 0, preRetryReason: null,
      });
    expect(row.legDropsJson).toBeNull();
    const db = openGeneratorDb(tmpDb());
    try {
      insertProposal(db, row);
      const got = db.prepare('SELECT leg_drops_json FROM proposals').get() as { leg_drops_json: string | null };
      expect(got.leg_drops_json).toBeNull();
    } finally {
      db.close();
    }
  });

  it('★旧台帳(列が無い DB)にも冪等に列を足して記録が止まらない', () => {
    const path = tmpDb();
    // 旧スキーマ(leg_drops_json 無し)を手で作ってから開き直す=実売買PCの既存台帳と同じ状況。
    const first = openGeneratorDb(path);
    first.exec('ALTER TABLE proposals DROP COLUMN leg_drops_json');
    first.close();
    const db = openGeneratorDb(path);   // initGeneratorSchema の ALTER が効くはず
    try {
      const cols = (db.prepare('PRAGMA table_info(proposals)').all() as unknown as Array<{ name: string }>).map(c => c.name);
      expect(cols).toContain('leg_drops_json');
    } finally {
      db.close();
    }
  });
});
