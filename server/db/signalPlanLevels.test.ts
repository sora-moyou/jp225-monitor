import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';
import { buildSignalPlanInsert } from '../signalTrade/planLedger.js';
import { parseScalpPlan } from '../llm/scalpPlan.js';

// ★記録専用(ADD-ONLY・v0.9.87): signal_plans.limit_level / stop_level
//   = その価格の **根拠にした節目**(指値用 / ブレイク新規用)。
//
// ■ なぜ台帳に要るか(画面に出すだけでは目的の半分しか達成しない)
//   この仕組みの価格は必ず節目から導かれる契約(指値=節目の内側 / ブレイク新規=節目の外側)。
//   画面は「指値 ← 68,700 の 25円内側」と出すが、それは **AI の申告をそのまま** 表示している。
//   本当に節目から導いたのかは、後から数えないと分からない。この2列は limit_entry / stop_entry と
//   同じ行に並ぶので、|entry − level| を SQL 1本で数えれば契約が守られているかを実測できる。
//
// ■ 何を守るテストか
//   ① 新規DBに列が在る(冪等)/② 型が REAL
//   ③ ★列を持たない既存DBへ ALTER が走り、既存行が1バイトも壊れない
//   ④ ★実ファイル SQLite で AiPlan → 台帳 → 読み戻しが往復する(欠落は NULL)
//   ⑤ ★これが目的: |entry − level| を SQL で数えられる
// ★検知・採否・価格・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fileDb(): { db: DatabaseSync; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'jp225-plan-levels-'));
  const path = join(dir, 'jp225.db');
  return { db: new DatabaseSync(path), path };
}

const rawPlan = (extra: Record<string, unknown>) => JSON.stringify({
  direction: 'buy', limitEntry: 38200, stopEntry: 38350,
  lcWidthForLimit: 55, lcWidthForStop: 60,
  rationale: '押し目。指値レッグ: 38200-38145=55円。ブレイク新規レッグ: 38350-38290=60円。',
  refPrice: 38250, ...extra,
});

describe('signal_plans.limit_level / stop_level(価格の根拠にした節目)', () => {
  it('新規DBに両列が在る(initSchema を何回呼んでも冪等)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    initSchema(db);
    initSchema(db);
    const cols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('limit_level');
    expect(cols).toContain('stop_level');
    db.close();
  });

  it('両列とも REAL(価格なので数値列。文字列にすると |entry − level| が数えられない)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const info = db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string; type: string }>;
    expect(info.find(c => c.name === 'limit_level')?.type).toBe('REAL');
    expect(info.find(c => c.name === 'stop_level')?.type).toBe('REAL');
    db.close();
  });

  it('★実ファイル: 列を持たない既存DBへ後付け ALTER が走り、既存行は壊れない', () => {
    const { db, path } = fileDb();
    // 旧版のスキーマを手で作る(この2列を持たない signal_plans)。既存行も1件入れておく。
    db.exec(`
      CREATE TABLE signal_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL, system TEXT NOT NULL, signal_id INTEGER,
        direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
        regime TEXT, confidence REAL,
        limit_entry REAL, stop_entry REAL, stop_loss_for_limit REAL, stop_loss_for_stop REAL,
        leg_drops_json TEXT, settings_json TEXT, rationale TEXT, error TEXT,
        context_at INTEGER, prompt_fp TEXT, provider TEXT, provider_model TEXT,
        strategy TEXT, strategy_why TEXT
      );
    `);
    db.prepare(`INSERT INTO signal_plans (t, system, direction, ref_price, rationale, strategy)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(1000, 'A', 'buy', 38250, '旧版で記録した行', 'トレンド押し目・戻り');
    const before = db.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    db.close();

    // 新版で開き直す(= 起動時の initSchema)。
    const db2 = new DatabaseSync(path);
    initSchema(db2);
    const cols = (db2.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('limit_level');
    expect(cols).toContain('stop_level');

    // ★既存行は1バイトも壊れない(新列は NULL で埋まるだけ)。
    const after = db2.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(1);
    for (const [k, v] of Object.entries(before[0]!)) expect(after[0]![k]).toEqual(v);
    expect(after[0]!.limit_level).toBeNull();
    expect(after[0]!.stop_level).toBeNull();

    // ★冪等: もう一度 initSchema しても落ちない(duplicate column にならない)。
    initSchema(db2);
    expect((db2.prepare('SELECT COUNT(*) c FROM signal_plans').get() as { c: number }).c).toBe(1);
    db2.close();
  });

  it('★実ファイル SQLite: AI が申告した節目が列へ入り、読み戻せる(往復)', () => {
    const result = parseScalpPlan(rawPlan({ limitLevel: 38175, stopLevel: 38345 }), 38250);
    expect(result.ok && result.plan.limitLevel).toBe(38175);
    const insert = buildSignalPlanInsert({ t: 5000, system: 'A', result, signalId: 7 });
    expect(insert.limitLevel).toBe(38175);
    expect(insert.stopLevel).toBe(38345);
    const { db } = fileDb();
    initSchema(db);
    insertSignalPlan(db, insert);
    const row = getSignalPlans(db)[0]!;
    expect(row.limit_level).toBe(38175);
    expect(row.stop_level).toBe(38345);
    // 既存の列は不変(記録専用の追加が既存の写しを壊していない)。
    expect(row.direction).toBe('buy');
    expect(row.limit_entry).toBe(38200);
    expect(row.stop_entry).toBe(38350);
    db.close();
  });

  it('AI が書かなかった/壊れていた回は NULL(欠測が形から読める・計画は落ちない)', () => {
    for (const extra of [{}, { limitLevel: 'S1' }, { limitLevel: null }, { limitLevel: 0 }, { limitLevel: -5 }]) {
      const result = parseScalpPlan(rawPlan(extra), 38250);
      const insert = buildSignalPlanInsert({ t: 5002, system: 'A', result });
      expect(insert.limitLevel).toBeUndefined();
      const { db } = fileDb();
      initSchema(db);
      insertSignalPlan(db, insert);
      const row = getSignalPlans(db)[0]!;
      expect(row.limit_level).toBeNull();
      // ★計画そのものは落ちていない(記録+表示専用=採否に影響しない)。
      expect(row.direction).toBe('buy');
      expect(row.limit_entry).toBe(38200);
      db.close();
      rmSync(dir, { recursive: true, force: true });
      dir = '';
    }
  });

  it('★これが目的: 「本当に節目から導いたか」を SQL 1本で数えられる', () => {
    const { db } = fileDb();
    initSchema(db);
    // 契約どおり(内側5〜10円)の2件と、節目から遠すぎる1件。
    const rows: Array<[number, number, number]> = [
      [1, 38200, 38195],   // 5円内側
      [2, 38210, 38200],   // 10円内側
      [3, 38300, 38100],   // 200円 = 節目から導いたとは言えない
    ];
    for (const [signalId, limitEntry, limitLevel] of rows) {
      insertSignalPlan(db, {
        t: 1000 + signalId, system: 'A', signalId, direction: 'buy', refPrice: 38250,
        limitEntry, limitLevel,
      });
    }
    const far = db.prepare(`
      SELECT COUNT(*) c FROM signal_plans
       WHERE limit_level IS NOT NULL AND ABS(limit_entry - limit_level) > 10
    `).get() as { c: number };
    expect(far.c).toBe(1);
    db.close();
  });
});
