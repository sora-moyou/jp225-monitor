import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';

// ★段6: signal_plans.missing_data(実ファイル SQLite)。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマ(この列を持たない)に冪等 ALTER が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま
//   ③ 新しい行には実際に自由文が入る(改行も保つ)
//   ④ ★ai_why とは別列であること(混ぜていないこと)

let dir = '';
afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

/** missing_data **だけ**を持たない(この機能追加の直前)signal_plans を手で作る。
 *  ★他の全列(段5+context_presence_json までの56列)は insertSignalPlan の SQL が無条件に
 *  参照するため、ここに揃えておく必要がある。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-missingdata-'));
  const db = new DatabaseSync(join(dir, 'jp225.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
      regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
      stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT, settings_json TEXT,
      rationale TEXT, error TEXT,
      arm_wait_ms INTEGER, arm_wait_distance REAL, arm_wait_sigma REAL, arm_wait_reason TEXT,
      context_at INTEGER, prompt_fp TEXT, lc_audit_json TEXT, omission_audit_json TEXT,
      provider TEXT, provider_model TEXT, strategy TEXT, strategy_why TEXT,
      limit_level REAL, stop_level REAL,
      direction_why TEXT, entry_why_for_limit TEXT, entry_why_for_stop TEXT,
      lc_why_for_limit TEXT, lc_why_for_stop TEXT, trend_dir TEXT,
      app_version TEXT, prompt_build TEXT, drift_yen REAL, stale_legs INTEGER,
      a_direction TEXT, a_why TEXT, b_variant TEXT, squeeze_state TEXT, squeeze_unavailable TEXT,
      b_strategy TEXT, ai_why TEXT, tool_calls INTEGER,
      a_provider TEXT, a_provider_model TEXT, b_provider TEXT, b_provider_model TEXT,
      a_prompt_build TEXT, b_prompt_build TEXT, context_presence_json TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction, none_reason) VALUES (?,?,?,?)')
    .run(1, 'A', 'none', 'ai');
  return db;
}

describe('signal_plans.missing_data(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    expect(cols(db, 'signal_plans')).not.toContain('missing_data');
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    expect(cols(db, 'signal_plans')).toContain('missing_data');
    db.close();
  });

  it('★新規DB(CREATE 経路)にも列がある(ALTER 経路と食い違わない)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-missingdata-new-'));
    const db = new DatabaseSync(join(dir, 'fresh.db'));
    initSchema(db);
    expect(cols(db, 'signal_plans')).toContain('missing_data');
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には自由文が入る(改行も保つ)', () => {
    const db = oldDb();
    initSchema(db);
    const text = 'ATRが算出できず\n節目データも0件でした';
    insertSignalPlan(db, {
      t: 2, system: 'A', direction: 'buy', missingData: text,
    });
    const rows = db.prepare('SELECT missing_data FROM signal_plans ORDER BY id')
      .all() as Array<{ missing_data: string | null }>;
    expect(rows[0]!.missing_data).toBeNull();
    expect(rows[1]!.missing_data).toBe(text);
    db.close();
  });

  it('④ ★ai_why とは別列(片方だけ入っても混ざらない)', () => {
    const db = oldDb();
    initSchema(db);
    // ai_why のみ(見送り理由)。
    insertSignalPlan(db, { t: 2, system: 'A', direction: 'none', noneReason: 'ai', aiWhy: '価格が置けない' });
    // missing_data のみ(見送りではない・片脚成立)。
    insertSignalPlan(db, { t: 3, system: 'A', direction: 'buy', missingData: '節目が古い可能性' });
    const rows = db.prepare('SELECT t, ai_why, missing_data FROM signal_plans WHERE t >= 2 ORDER BY t')
      .all() as Array<{ t: number; ai_why: string | null; missing_data: string | null }>;
    expect(rows[0]).toEqual({ t: 2, ai_why: '価格が置けない', missing_data: null });
    expect(rows[1]).toEqual({ t: 3, ai_why: null, missing_data: '節目が古い可能性' });
    db.close();
  });

  it('★getSignalPlans(SELECT *)から読める(読み出し経路も通っている)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 9, system: 'A', missingData: '本日高安が取得できなかった' });
    const [row] = getSignalPlans(db, 1, 'A');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.missing_data).toBe('本日高安が取得できなかった');
    db.close();
  });
});
