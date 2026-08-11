// ★「省略した」と述べつつ有効な価格対を出す形を、コードが **記録だけ** することの実証(v0.9.66)。
//
// ■ 何を守っているか(実測 2026-08-08 / 運用機の台帳 6,042件)
//   AI は根拠文に「ブレイク新規は下限に届かないので省略した」と書きながら、下限を満たす **有効な
//   価格対** を出すことがある。この場合コードは何も落とさない(落ちるのは lcFloor/stopSide に掛かった
//   ときだけ)ので、そのレッグはそのまま発注される = **意図と注文が食い違ったまま素通り** する。
//   実台帳での実測は 表明70件・矛盾1件。まず頻度を測るための配管を固定する。
//
// ■ ★判定には使わない
//   同じテストで「採否・価格・legDrops・noneReason が表明の有無に一切左右されない」ことを固定する
//   (落とせば機会損失が増え、直せば『AI が直ったのか、コードが隠しているだけか』が分からなくなる)。
//
// ■ ★不変条件: 機械生成の脱落注記は表明として読まれない
//   突き合わせは **最終プランの根拠文**(末尾に脱落注記が付く)に対して行う。注記が表明の語を含むと
//   コード自身の文が「AI の表明」に化ける。注記の文言が変わってもここで気付けるようにする。
//
// ■ ★否定対照: git show HEAD:server/llm/scalpPlan.ts に omissionAudit は無く、
//   git show HEAD:server/db/store.ts の signal_plans に omission_audit_json 列も無い
//   (= このファイルの「結果に載る」「列に届く」テストは旧版では赤)。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Price } from '../types.js';

const createMock = vi.fn();

// LLM プロバイダ: callWithFallback は task を1回だけ呼び、その戻りを返す(外部 LLM は呼ばない)。
vi.mock('./providers.js', () => ({
  // ★providers.js の実物が持つエラー型。scalpPlan.ts が import するのでモックにも要る
  //   (無いと `extends undefined` で読み込みに失敗する)。検証の強さには関与しない。
  NoFallbackError: class NoFallbackError extends Error {},
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

const { buildScalpPlan, buildLegNote, rangeDropNote } = await import('./scalpPlan.js');
const { parseOmissionClaims } = await import('./rationaleOmission.js');
const { buildSignalPlanInsert } = await import('../signalTrade/planLedger.js');
const { initSchema, insertSignalPlan, getSignalPlans } = await import('../db/store.js');
const NONE_REASONS = ['ai', 'geometry', 'stopSide', 'lc', 'lcFloor', 'bias', 'trend', 'rangeDisabled', 'missing', 'stale'] as const;

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

/** 売りの2レッグ(どちらも幾何・幅とも合法 = コードは1本も落とさない)。 */
function sell(rationale: string): string {
  return JSON.stringify({
    direction: 'sell', refPrice: 1, rationale,
    limitEntry: 38300, stopLossForLimit: 38355,
    stopEntry: 38200, stopLossForStop: 38255,
  });
}

/** ★実データの故障そのもの: 「指値は省略します」と述べながら、指値レッグは合法な価格対で出ている。 */
const CONTRADICTION = sell('売り方針。両方とも幅を満たしていないため、指値は省略します。ブレイク新規は38200円に設定。');
/** 同じ価格・同じ採否で、表明だけが無い対照。 */
const NO_CLAIM = sell('売り方針。指値は38300円、ブレイク新規は38200円に設定。');

describe('omissionAudit: 「出さない」と述べたのに発注されるレッグを記録する', () => {
  it('★矛盾が最終結果に載る(表明=指値 / 実際に発注される=指値)', async () => {
    const r = await planFrom(CONTRADICTION);
    expect(r.omissionAudit).toEqual([
      { leg: 'limit', word: '省略', present: true, status: 'contradiction' },
    ]);
  });

  it('★判定には使わない: 採否・価格・legDrops・noneReason が表明の有無で変わらない', async () => {
    const withClaim = await planFrom(CONTRADICTION);
    const without = await planFrom(NO_CLAIM);
    const shape = (p: { plan: import('./scalpPlan.js').AiPlan }) => ({
      direction: p.plan.direction, limitEntry: p.plan.limitEntry, stopEntry: p.plan.stopEntry,
      stopLossForLimit: p.plan.stopLossForLimit, stopLossForStop: p.plan.stopLossForStop,
    });
    expect(shape(withClaim)).toEqual(shape(without));
    expect(shape(withClaim)).toEqual({
      direction: 'sell', limitEntry: 38300, stopEntry: 38200,
      stopLossForLimit: 38355, stopLossForStop: 38255,
    });
    expect(withClaim.legDrops).toBeUndefined();
    expect(without.legDrops).toBeUndefined();
    expect(withClaim.noneReason).toBeUndefined();
    // 表明が無い回は列に何も載らない(「観測できた」と「0件」を混ぜない)。
    expect(without.omissionAudit).toBeUndefined();
  });

  it('表明どおりコードが落とした回は consistent(=素通りしていない)', async () => {
    // ブレイク新規の幅を5円にする → lcFloor で落ちる。根拠文はその省略を述べている。
    const r = await planFrom(JSON.stringify({
      direction: 'sell', refPrice: 1,
      rationale: '売り方針。ブレイク新規レッグは下限に届かないため省略。指値は38300円。',
      limitEntry: 38300, stopLossForLimit: 38355,
      stopEntry: 38200, stopLossForStop: 38205,
    }));
    expect(r.plan.stopEntry).toBeUndefined();
    expect(r.omissionAudit).toEqual([
      { leg: 'stop', word: '省略', present: false, status: 'consistent' },
    ]);
    // 落ちた理由は従来どおり(表明は理由に一切影響しない)。
    expect(r.legDrops?.map(d => [d.name, d.reason])).toEqual([['stop', 'lcFloor']]);
  });

  it('★不変条件: コードが足す脱落注記は「表明」として読まれない(自分の文を AI の表明にしない)', () => {
    for (const reason of NONE_REASONS) {
      for (const note of [
        buildLegNote({ hasLimit: false, hasStop: true, drops: [{ name: 'limit', reason }] }),
        buildLegNote({ hasLimit: true, hasStop: false, drops: [{ name: 'stop', reason }] }),
        rangeDropNote('上部', 'sell', reason),
        rangeDropNote('下部', 'buy', reason),
      ]) {
        expect(parseOmissionClaims(note), `注記が表明として読まれた: ${note}`).toEqual([]);
      }
    }
  });
});

describe('omissionAudit: 台帳(signal_plans.omission_audit_json)まで届く', () => {
  let dir = '';
  let db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omission-'));
    db = new DatabaseSync(join(dir, 'test.db'));
    initSchema(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('★AI 応答 → 計画 → 行 → 列 → SELECT の一続きで読み戻せる', async () => {
    const r = await planFrom(CONTRADICTION);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 1000, system: 'A', result: r }));
    const row = getSignalPlans(db)[0]!;
    // 既存の列は従来どおり(両レッグとも発注される)。
    expect(row.limit_entry).toBe(38300);
    expect(row.stop_entry).toBe(38200);
    expect(row.leg_drops_json).toBeNull();
    expect(JSON.parse(row.omission_audit_json!)).toEqual([
      { leg: 'limit', word: '省略', present: true, status: 'contradiction' },
    ]);
  });

  it('表明が1件も無い結果は列ごと NULL(空配列を書かない)', async () => {
    const r = await planFrom(NO_CLAIM);
    insertSignalPlan(db, buildSignalPlanInsert({ t: 2000, system: 'B', result: r }));
    expect(getSignalPlans(db)[0]!.omission_audit_json).toBeNull();
  });

  it('★冪等な後付け: 列を持たない旧DBに initSchema を当てても既存行は保持され、旧行は NULL のまま', () => {
    const legacyDir = mkdtempSync(join(tmpdir(), 'omission-legacy-'));
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
    expect(cols).toContain('omission_audit_json');
    const rows = getSignalPlans(legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rationale).toBe('旧行');
    expect(rows[0]!.omission_audit_json).toBeNull();
    legacy.close();
    rmSync(legacyDir, { recursive: true, force: true });
  });
});
