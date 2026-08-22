import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan } from './store.js';
import { buildSignalPlanInsert } from '../signalTrade/planLedger.js';

// ★記録専用(ADD-ONLY・v0.9.96): signal_plans の drift_yen / stale_legs。
//
// ■ なぜ要るか(A/B 分割の前提条件)
//   計画サイクルを A(目線)と B(注文)の2回に分けると応答が直列になり、
//   「文脈を組んだ時刻 → ARM」の間が伸びる。その結果 checkRefDrift(上限200円)と
//   stale plan veto に掛かる回が増える。★いまこの2つは **console ログにしか出ない** ので、
//   増えたことに台帳から気づけない。分割を入れる **前** に数えられる形を作る。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない) / ② 旧行は NULL のまま
//   ③ 値が実際に入る / ④ ★閾値を超えたときだけでなく **測れたら必ず** 入る(分布が見たい)
//   ⑤ ★測れなかった回は NULL(0 と混ぜない=「ドリフト0」と「測れなかった」を区別する)
// ★検知・採否・価格・veto・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ''; });
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

/** v0.9.95 相当(= 新列を持たない)signal_plans を手で作る。 */
function oldDb(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'jp225-armgate-'));
  const db = new DatabaseSync(join(dir, 'jp225.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
      regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
      stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT, settings_json TEXT,
      rationale TEXT, error TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction) VALUES (?,?,?)').run(1, 'A', 'buy');
  return db;
}

describe('signal_plans: drift_yen / stale_legs(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldDb();
    expect(cols(db, 'signal_plans')).not.toContain('drift_yen');
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    expect(cols(db, 'signal_plans')).toContain('drift_yen');
    expect(cols(db, 'signal_plans')).toContain('stale_legs');
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には実際に値が入る', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 2, system: 'A', direction: 'buy', driftYen: 37.5, staleLegs: 1 });
    const rows = db.prepare('SELECT drift_yen, stale_legs FROM signal_plans ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ drift_yen: null, stale_legs: null });
    expect(rows[1]).toEqual({ drift_yen: 37.5, stale_legs: 1 });
    db.close();
  });

  it('④ ★閾値(200円)を超えていなくても入る(分布が見たいので常に記録する)', () => {
    const db = oldDb();
    initSchema(db);
    for (const d of [0, 5, 199, 255]) insertSignalPlan(db, { t: 3, system: 'A', driftYen: d, staleLegs: 0 });
    const v = (db.prepare('SELECT drift_yen FROM signal_plans WHERE drift_yen IS NOT NULL ORDER BY drift_yen').all() as Array<{ drift_yen: number }>).map(r => r.drift_yen);
    expect(v).toEqual([0, 5, 199, 255]);
    db.close();
  });

  it('⑤ ★測れなかった回は NULL(「ドリフト0」と混ぜない)', () => {
    const db = oldDb();
    initSchema(db);
    insertSignalPlan(db, { t: 4, system: 'A' });                                   // 未指定
    insertSignalPlan(db, { t: 5, system: 'A', driftYen: Number.NaN, staleLegs: Number.NaN }); // 非有限
    insertSignalPlan(db, { t: 6, system: 'A', driftYen: 0, staleLegs: 0 });        // ★0 は 0 として入る
    const rows = db.prepare('SELECT drift_yen, stale_legs FROM signal_plans WHERE t >= 4 ORDER BY t').all() as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ drift_yen: null, stale_legs: null });
    expect(rows[1]).toEqual({ drift_yen: null, stale_legs: null });
    expect(rows[2]).toEqual({ drift_yen: 0, stale_legs: 0 });
    db.close();
  });

  it('★buildSignalPlanInsert が入力をそのまま写す(engine → 台帳の経路)', () => {
    const row = buildSignalPlanInsert({
      t: 1, system: 'A', result: { ok: false, error: 'chart-not-generated' },
      driftYen: 42, staleLegs: 2,
    });
    expect(row.driftYen).toBe(42);
    expect(row.staleLegs).toBe(2);
    // ★計画が得られなかった回(ok:false)にも載る = 「計画は出たが drift で落ちた」が残る。
    expect(row.error).toBe('chart-not-generated');
  });

  it('★未指定なら載せない(値が無いことを捏造しない)', () => {
    const row = buildSignalPlanInsert({ t: 1, system: 'A', result: { ok: false, error: 'x' } });
    expect(Object.prototype.hasOwnProperty.call(row, 'driftYen')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'staleLegs')).toBe(false);
  });
});
