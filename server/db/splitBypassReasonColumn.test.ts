import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';

// ★段6続き: signal_plans.split_bypass_reason(実ファイル SQLite)。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマ(この列を持たない)に冪等 ALTER が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま
//   ③ 新しい行には実際に理由の文字列が入る
//   ④ ★複数該当時のカンマ区切りもそのまま保存される

let dir = '';
afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

/** split_bypass_reason **だけ**を持たない(この機能追加の直前)signal_plans を手で作る。
 *  ★他の全列(段6の missing_data までの57列)は insertSignalPlan の SQL が無条件に参照するため、
 *  ここに揃えておく必要がある。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-splitbypass-'));
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
      a_prompt_build TEXT, b_prompt_build TEXT, context_presence_json TEXT, missing_data TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction, none_reason) VALUES (?,?,?,?)')
    .run(1, 'A', 'none', 'ai');
  return db;
}

describe('signal_plans.split_bypass_reason(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    expect(cols(db, 'signal_plans')).not.toContain('split_bypass_reason');
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    expect(cols(db, 'signal_plans')).toContain('split_bypass_reason');
    db.close();
  });

  it('★新規DB(CREATE 経路)にも列がある(ALTER 経路と食い違わない)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-splitbypass-new-'));
    const db = new DatabaseSync(join(dir, 'fresh.db'));
    initSchema(db);
    expect(cols(db, 'signal_plans')).toContain('split_bypass_reason');
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には理由が入る', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 2, system: 'A', direction: 'buy', splitBypassReason: 'heldPosition' });
    const rows = db.prepare('SELECT split_bypass_reason FROM signal_plans ORDER BY id')
      .all() as Array<{ split_bypass_reason: string | null }>;
    expect(rows[0]!.split_bypass_reason).toBeNull();
    expect(rows[1]!.split_bypass_reason).toBe('heldPosition');
    db.close();
  });

  it('④ ★複数該当時のカンマ区切りもそのまま保存される', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 3, system: 'A', splitBypassReason: 'heldPosition,armedContext,promptVariant' });
    const r = db.prepare('SELECT split_bypass_reason FROM signal_plans WHERE t = 3').get() as { split_bypass_reason: string };
    expect(r.split_bypass_reason).toBe('heldPosition,armedContext,promptVariant');
    db.close();
  });

  it('★通常の分割ON(該当なし)・分割OFFの回は NULL のまま(捏造しない)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 4, system: 'A', direction: 'buy', aDirection: 'bull', bVariant: 'buy' });   // 分割ON・該当なし
    insertSignalPlan(db, { t: 5, system: 'A', direction: 'buy' });   // 分割OFF
    const rows = db.prepare('SELECT split_bypass_reason FROM signal_plans WHERE t >= 4 ORDER BY t')
      .all() as Array<{ split_bypass_reason: string | null }>;
    expect(rows.map(r => r.split_bypass_reason)).toEqual([null, null]);
    db.close();
  });

  it('★getSignalPlans(SELECT *)から読める(読み出し経路も通っている)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 9, system: 'A', splitBypassReason: 'promptVariant' });
    const [row] = getSignalPlans(db, 1, 'A');
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.split_bypass_reason).toBe('promptVariant');
    db.close();
  });
});
