// ★申告 LC幅と実出力の食い違いが「AI の応答 → 計画 → 台帳の列 → SELECT」まで一続きで残ることの実証。
//
// ■ 何を守っているか(実測 2026-08-07)
//   AI は根拠文に「LC幅=55円」と正しく書きながら、損切りには建値の隣(±5円)を入れることがある。
//   その回は enforce の下限(lcFloor)でレッグごと落ちるので、**採用されたレッグを見ても故障は見えない**
//   (実台帳: 落ちたレッグ 41.7% / 採用レッグ 2.0%)。純関数の単体テストだけでは
//   「parse で作った lcAudit が最終結果まで運ばれるか」「台帳の列に届くか」が保証できないので、
//   LLM だけをモックして buildScalpPlan の実経路を通し、実 SQLite に書いて読み戻す。
//
// ■ ★測るだけ(判定には使わない)
//   同じテストで「採否・価格・legDrops が食い違いの有無に一切左右されない」ことも固定する。
//
// ■ ★否定対照(この実装前のコード)
//   git show HEAD:server/llm/scalpPlan.ts には lcAudit が無く、
//   git show HEAD:server/db/store.ts の signal_plans には lc_audit_json 列が無い。
//   よって「結果に載る」「列に届く」テストは赤(SQLite は no such column で落ちる)。
//   一方、同じファイル内の「採否・価格・legDrops」の期待値は旧版でも緑 = 足したのは記録だけ、の対照。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Price } from '../types.js';

const createMock = vi.fn();

// LLM プロバイダ: callWithFallback は task を1回だけ呼び、その戻りを返す実装に置き換える(外部 LLM は呼ばない)。
vi.mock('./providers.js', () => ({
  isLLMEnabled: () => true,
  isVisionCapableProvider: () => false,
  callWithFallback: async (task: (p: unknown) => Promise<string>) =>
    task({ client: { chat: { completions: { create: createMock } } }, config: { name: 'test', chatModel: 'test-model' } }),
}));
vi.mock('./webSearch.js', () => ({ isWebSearchEnabled: () => false, webSearch: async () => '' }));
vi.mock('./dataTools.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  buildMonitorContext: () => '',
}));
// 設定は実ユーザー環境に依存させない(LC下限=55円手動・上限65・veto/bias 無効)。
vi.mock('../configStore.js', async (orig) => ({
  ...(await orig() as Record<string, unknown>),
  resolveScalpLcFloorDirective: () => ({ mode: 'manual', value: 55 }),
  resolveScalpLcCeilingDirective: () => ({ mode: 'manual', value: 65 }),
  resolveScalpTrendVetoDirective: () => ({ mode: 'manual', value: 100 }),
  resolveScalpCooldownDirective: () => ({ mode: 'manual', value: 90 }),
  resolveScalpBiasDirective: () => ({ mode: 'manual', value: 'none' }),
  resolveScalpRangeDirective: () => ({ mode: 'manual', value: false }),
  resolveScalpLcHardMax: () => ({ enabled: false, value: 150 }),
  resolveScalpAiTechnicalEnabled: () => false,
}));

const { buildScalpPlan } = await import('./scalpPlan.js');
const { buildSignalPlanInsert } = await import('../signalTrade/planLedger.js');
const { initSchema, insertSignalPlan, getSignalPlans } = await import('../db/store.js');

const REF = 38250;
const PRICES: Price[] = [
  { symbol: 'NIY=F', price: REF, changePercent: 0, timestamp: Date.now(), stale: false } as Price,
];

/** LLM が raw を返すようにして buildScalpPlan を1回走らせる。 */
async function planFrom(raw: string) {
  createMock.mockReset();
  createMock.mockResolvedValue({ choices: [{ message: { content: raw } }] });
  const r = await buildScalpPlan({ symbol: 'NIY=F', prices: PRICES, news: [] });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r;
}

/** ★実データの故障そのもの(売り): 指値は申告どおり55円 / ブレイク新規は申告55円なのに実際は5円。
 *  ブレイク新規レッグは下限(55円)未満なので enforce で落ちる=故障は「落ちたレッグ」にだけ残る。 */
const FAULTY_SELL = JSON.stringify({
  direction: 'sell', refPrice: 1,
  rationale: '戻り売り。指値レッグ LC=55円 で38300に設定。ブレイク新規レッグ LC=55円 で38200に設定した。',
  limitEntry: 38300, stopLossForLimit: 38355,
  stopEntry: 38200, stopLossForStop: 38205,
});

describe('lcAudit: 申告 LC幅と実出力の突き合わせが最終結果まで残る', () => {
  it('★落ちたレッグの食い違い(申告55/実際5)と、採用レッグの一致(55/55)が同じ配列に並ぶ', async () => {
    const r = await planFrom(FAULTY_SELL);
    expect(r.lcAudit?.map(a => [a.leg, a.declaredYen, a.actualYen, a.status])).toEqual([
      ['limit', 55, 55, 'match'],
      ['stop', 55, 5, 'mismatch'],
    ]);
  });

  it('★採否・価格・legDrops は食い違いに一切左右されない(足したのは記録だけ)', async () => {
    const r = await planFrom(FAULTY_SELL);
    expect(r.plan.direction).toBe('sell');
    expect(r.plan.limitEntry).toBe(38300);
    expect(r.plan.stopLossForLimit).toBe(38355);
    // 食い違ったレッグは **食い違いを理由には落ちない**。落ちた理由は従来どおり LC下限(lcFloor)。
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.plan.stopLossForStop).toBeUndefined();
    expect(r.legDrops?.map(d => [d.name, d.reason, d.entry, d.stopLoss])).toEqual([
      ['stop', 'lcFloor', 38200, 38205],
    ]);
    expect(r.noneReason).toBeUndefined();
  });

  it('★申告が無い根拠文は undeclared(「一致」に化けない)', async () => {
    const r = await planFrom(JSON.stringify({
      direction: 'sell', refPrice: 1,
      rationale: '戻り売り。損切りはレジスタンスの外側に置いた。',
      limitEntry: 38300, stopLossForLimit: 38355,
    }));
    expect(r.lcAudit).toEqual([
      { leg: 'limit', entry: 38300, stopLoss: 38355, actualYen: 55, declaredYen: null, status: 'undeclared' },
    ]);
  });

  it('両レッグとも落ちて見送り(none)になった回にも残る(=故障の主戦場が消えない)', async () => {
    // sell の両レッグとも幅5円=下限未満 → enforce で両方落ちて none。
    const r = await planFrom(JSON.stringify({
      direction: 'sell', refPrice: 1,
      rationale: '戻り売り。指値レッグ LC=55円。ブレイク新規レッグ LC=55円。',
      limitEntry: 38300, stopLossForLimit: 38305,
      stopEntry: 38200, stopLossForStop: 38205,
    }));
    expect(r.plan.direction).toBe('none');
    expect(r.noneReason).toBe('lcFloor');
    expect(r.lcAudit?.map(a => a.status)).toEqual(['mismatch', 'mismatch']);
  });
});

describe('lcAudit: 台帳(signal_plans.lc_audit_json)まで届く', () => {
  let dir = '';
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lcaudit-'));
    db = new DatabaseSync(join(dir, 'test.db'));
    initSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★AI 応答 → 計画 → 行 → 列 → SELECT の一続きで読み戻せる', async () => {
    const r = await planFrom(FAULTY_SELL);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 1000, system: 'A', result: r }));
    const row = getSignalPlans(db)[0]!;
    // 既存の列は従来どおり(採用レッグの価格・落ちたレッグの理由)。
    expect(row.limit_entry).toBe(38300);
    expect(row.stop_entry).toBeNull();
    expect(JSON.parse(row.leg_drops_json!)).toEqual([{ name: 'stop', reason: 'lcFloor', entry: 38200, stopLoss: 38205 }]);
    // ★新しい列: 落ちたレッグの食い違いが数値で残る。
    const audit = JSON.parse(row.lc_audit_json!);
    expect(audit).toEqual([
      { leg: 'limit', entry: 38300, stopLoss: 38355, actualYen: 55, declaredYen: 55, status: 'match', source: 'width' },
      { leg: 'stop', entry: 38200, stopLoss: 38205, actualYen: 5, declaredYen: 55, status: 'mismatch', source: 'width' },
    ]);
  });

  it('突き合わせが1件も無い結果は列ごと NULL(空配列を書かない)', () => {
    insertSignalPlan(db, buildSignalPlanInsert({
      t: 2000, system: 'B',
      result: { ok: true, plan: { direction: 'none', rationale: '様子見', refPrice: REF }, noneReason: 'ai' },
    }));
    expect(getSignalPlans(db)[0]!.lc_audit_json).toBeNull();
  });

  it('★冪等な後付け: 列を持たない旧DBに initSchema を当てても既存行は保持され、旧行は NULL のまま', () => {
    // 旧版のスキーマを模す: 新しい列だけを落とした表を作り、行を1つ入れてから initSchema を再適用する。
    const legacyDir = mkdtempSync(join(tmpdir(), 'lcaudit-legacy-'));
    const legacy = new DatabaseSync(join(legacyDir, 'old.db'));
    legacy.exec(`
      CREATE TABLE signal_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
        signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
        regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
        stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT,
        settings_json TEXT, rationale TEXT, error TEXT
      );
    `);
    legacy.prepare("INSERT INTO signal_plans (t, system, direction, rationale) VALUES (1, 'A', 'buy', '旧行')").run();
    initSchema(legacy);
    initSchema(legacy);   // 2回目=冪等(ALTER が二度走って落ちない)
    const cols = (legacy.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('lc_audit_json');
    const rows = getSignalPlans(legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rationale).toBe('旧行');       // 既存行は壊れない
    expect(rows[0]!.lc_audit_json).toBeNull();      // 旧行は NULL のまま
    legacy.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
