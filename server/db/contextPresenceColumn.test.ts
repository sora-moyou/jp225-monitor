import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';

// ★段5続き: signal_plans.context_presence_json(実ファイル SQLite)。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマ(この列を持たない)に冪等 ALTER が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま
//   ③ 新しい行には実際に値(JSON文字列)が入る
//   ④ ★同じ行の none_reason / b_variant と結合不要で SQL 突き合わせできる(設計の目的そのもの)

let dir = '';
afterEach(() => {
  if (dir) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* 無害 */ } }
  dir = '';
});
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

/** context_presence_json **だけ**を持たない(この機能追加の直前)signal_plans を手で作る。
 *  ★他の全列(段5までの55列)は insertSignalPlan の SQL が無条件に参照するため、ここに揃えておく
 *  必要がある(initSchema の ALTER は「まだ無い列を足す」だけで、signal_id 等の基礎列は
 *  最初の CREATE TABLE 時にしか作られない=このテーブルが既存なら ALTER されない)。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-ctxpresence-'));
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
      a_prompt_build TEXT, b_prompt_build TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction, none_reason) VALUES (?,?,?,?)')
    .run(1, 'A', 'none', 'ai');
  return db;
}

describe('signal_plans.context_presence_json(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    expect(cols(db, 'signal_plans')).not.toContain('context_presence_json');
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    expect(cols(db, 'signal_plans')).toContain('context_presence_json');
    db.close();
  });

  it('★新規DB(CREATE 経路)にも列がある(ALTER 経路と食い違わない)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-ctxpresence-new-'));
    const db = new DatabaseSync(join(dir, 'fresh.db'));
    initSchema(db);
    expect(cols(db, 'signal_plans')).toContain('context_presence_json');
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には実際の JSON が入る', () => {
    const db = oldDb();
    initSchema(db);
    const presence = {
      atr: true, sessionHighLow: true, levels: false, bb: true, swing: false,
      longHorizon: true, alerts: false, dailyBand: false, basedata: true, news: false,
    };
    insertSignalPlan(db, {
      t: 2, system: 'A', direction: 'none', noneReason: 'ai',
      contextPresenceJson: JSON.stringify(presence),
    });
    const rows = db.prepare('SELECT context_presence_json FROM signal_plans ORDER BY id')
      .all() as Array<{ context_presence_json: string | null }>;
    expect(rows[0]!.context_presence_json).toBeNull();
    expect(JSON.parse(rows[1]!.context_presence_json!)).toEqual(presence);
    db.close();
  });

  it('④ ★同じ行にあるので JOIN 不要で none_reason / b_variant と突き合わせられる(設計の目的)', () => {
    const db = oldDb();
    initSchema(db);
    const bare = {
      atr: false, sessionHighLow: false, levels: false, bb: false, swing: false,
      longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
    };
    const rich = { ...bare, atr: true, levels: true };
    // ①「本当に帯しか無かった」回(全部 false)+ none_reason='ai' + b_variant='buy'。
    insertSignalPlan(db, {
      t: 2, system: 'A', direction: 'none', noneReason: 'ai', bVariant: 'buy',
      contextPresenceJson: JSON.stringify(bare),
    });
    // ② 材料はあった回。
    insertSignalPlan(db, {
      t: 3, system: 'A', direction: 'buy', bVariant: 'buy',
      contextPresenceJson: JSON.stringify(rich),
    });
    // ★JOIN 無しで「none_reason='ai' かつ ATR も節目も消えていた」回を数える。
    const n = (db.prepare(
      `SELECT COUNT(*) c FROM signal_plans
       WHERE none_reason = 'ai'
         AND context_presence_json LIKE '%"atr":false%'
         AND context_presence_json LIKE '%"levels":false%'`,
    ).get() as { c: number }).c;
    expect(n).toBe(1);
    db.close();
  });

  it('★getSignalPlans(SELECT *)から読める(読み出し経路も通っている)', () => {
    const db = oldDb();
    initSchema(db);
    const presence = {
      atr: true, sessionHighLow: false, levels: false, bb: false, swing: false,
      longHorizon: false, alerts: false, dailyBand: false, basedata: false, news: false,
    };
    insertSignalPlan(db, { t: 9, system: 'A', contextPresenceJson: JSON.stringify(presence) });
    const [row] = getSignalPlans(db, 1, 'A');
    expect(row).toBeDefined();
    if (!row) return;
    expect(JSON.parse(row.context_presence_json!)).toEqual(presence);
    db.close();
  });
});
