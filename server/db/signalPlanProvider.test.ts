import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalPlan, getSignalPlans } from './store.js';

// ★記録専用(ADD-ONLY・v0.9.70): signal_plans.provider / provider_model =
//   **その計画の答えを返した** LLM プロバイダ名とチャットモデル名。
//
// ■ なぜ要るか(チャート画像 A/B の交絡)
//   画像を送る回は必ずビジョン対応(gemini/openai)へ行き、送らない回は groq/kimi でも通る。
//   つまり「画像あり/なし」は **モデルの違いと完全に絡む**。この2列が無いと ab で貯めた標本は
//   後から層別できない=「測れないデータを貯める」という無言の失敗になる。
//
// ■ 何を守るテストか
//   ① 新規DBに列が在る(冪等)
//   ② ★**列を持たない既存DB** に対して ALTER が走り、**既存行が1バイトも壊れない**
//   ③ 値の往復(NULL 可)
// ★検知・採否・価格・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fileDb(): { db: DatabaseSync; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'jp225-plan-provider-'));
  const path = join(dir, 'jp225.db');
  return { db: new DatabaseSync(path), path };
}

describe('signal_plans.provider / provider_model(答えたプロバイダ)', () => {
  it('新規DBに両列が在る(initSchema を何回呼んでも冪等)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    initSchema(db);   // 2回目
    initSchema(db);   // 3回目=冪等
    const cols = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('provider');
    expect(cols).toContain('provider_model');
    db.close();
  });

  it('両列とも TEXT(名前をそのまま入れる。数値化も列分割もしない)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const info = db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string; type: string }>;
    expect(info.find(c => c.name === 'provider')?.type).toBe('TEXT');
    expect(info.find(c => c.name === 'provider_model')?.type).toBe('TEXT');
    db.close();
  });

  it('★実ファイル: 列を持たない既存DBへ後付け ALTER が走り、既存行は壊れない', () => {
    const { db, path } = fileDb();
    // ── 旧版のスキーマを手で作る(この2列を持たない signal_plans)。既存行も1件入れておく。
    db.exec(`
      CREATE TABLE signal_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL, system TEXT NOT NULL, signal_id INTEGER,
        direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
        regime TEXT, confidence REAL,
        limit_entry REAL, stop_entry REAL, stop_loss_for_limit REAL, stop_loss_for_stop REAL,
        leg_drops_json TEXT, settings_json TEXT, rationale TEXT, error TEXT,
        context_at INTEGER, prompt_fp TEXT
      );
    `);
    db.prepare(`INSERT INTO signal_plans (t, system, direction, ref_price, rationale, prompt_fp)
                VALUES (?, ?, ?, ?, ?, ?)`)
      .run(1000, 'A', 'buy', 38250, '旧版で記録した行', 'sp1:0123456789abcdef');
    const before = db.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    db.close();

    // ── 新版で開き直す(= 起動時の initSchema)。
    const db2 = new DatabaseSync(path);
    initSchema(db2);
    const cols = (db2.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('provider');
    expect(cols).toContain('provider_model');

    // ★既存行は1バイトも壊れない(新列は NULL で埋まるだけ)。
    const after = db2.prepare('SELECT * FROM signal_plans').all() as Array<Record<string, unknown>>;
    expect(after).toHaveLength(1);
    for (const [k, v] of Object.entries(before[0]!)) expect(after[0]![k]).toEqual(v);
    expect(after[0]!.provider).toBeNull();
    expect(after[0]!.provider_model).toBeNull();

    // ★冪等: もう一度 initSchema しても落ちない(duplicate column にならない)。
    initSchema(db2);
    expect((db2.prepare('SELECT COUNT(*) c FROM signal_plans').get() as { c: number }).c).toBe(1);

    // 新しい行は新列に値が入る=旧行と新行が同じ表で共存できる。
    insertSignalPlan(db2, {
      t: 2000, system: 'A', direction: 'sell', refPrice: 38300,
      provider: 'openai', providerModel: 'gpt-4o-mini',
    });
    const rows = getSignalPlans(db2);
    expect(rows.find(r => r.t === 2000)!.provider).toBe('openai');
    expect(rows.find(r => r.t === 2000)!.provider_model).toBe('gpt-4o-mini');
    expect(rows.find(r => r.t === 1000)!.provider).toBeNull();
    db2.close();
  });

  it('未指定は NULL(答えが得られなかった回=誰も答えなかったことが形から読める)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    insertSignalPlan(db, { t: 1, system: 'A', error: 'LLM未設定' });
    const row = getSignalPlans(db)[0]!;
    expect(row.provider).toBeNull();
    expect(row.provider_model).toBeNull();
    expect(row.error).toBe('LLM未設定');
    db.close();
  });
});
