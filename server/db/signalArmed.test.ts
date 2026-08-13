import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, insertSignalTrade, getSignalTrades } from './store.js';
import { backupViaVacuum } from './mergeDb.js';

// ★記録専用(ADD-ONLY): signal_trades の ARM(武装)時刻 armed_t と「ARM 時点で monitor が見ていた価格」armed_price。
//   過去の各仮想取引について「武装から約定までの経過(entry_t − armed_t)」と「武装時点の状況」を遡って解析する
//   ための2列。★armed_price が要る理由: 事後に prices_*.db の ticks で代用すると collector が別プロセス・別位相
//   (+AJAXキャッシュ)で記録した価格列になり、monitor が実際に feed した価格と一致しない(実測で誤検出多数)。
//   検知/決済/エントリー採否には一切触らない(列が増えるだけ)。
function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

describe('signal_trades.armed_t / armed_price 列(ARM 時刻と ARM 時点価格)', () => {
  it('ALTER で両列が存在する(initSchema を何回呼んでも冪等)', () => {
    const db = memDb();
    initSchema(db);   // 2回目
    initSchema(db);   // 3回目=冪等
    const cols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('armed_t');
    expect(cols).toContain('armed_price');
  });

  it('列の型は armed_t=INTEGER / armed_price=REAL(時刻=epoch ms / 価格=実数)', () => {
    const db = memDb();
    const info = db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string; type: string }>;
    expect(info.find(c => c.name === 'armed_t')?.type).toBe('INTEGER');
    expect(info.find(c => c.name === 'armed_price')?.type).toBe('REAL');
  });

  it('armedT/armedPrice を渡すと保存 / 未指定は NULL(後方互換)', () => {
    const db = memDb();
    insertSignalTrade(db, {
      entryT: 2_000, entryPrice: 38000, dir: 'buy', exitT: 3_000, exitPrice: 38050, pnl: 50, qty: 1,
      armedT: 1_000, armedPrice: 37990,
    });
    insertSignalTrade(db, { entryT: 4_000, entryPrice: 38000, dir: 'buy', exitT: 5_000, exitPrice: 38050, pnl: 50, qty: 1 });
    const rows = getSignalTrades(db).sort((a, b) => a.entry_t - b.entry_t);
    expect(rows[0]).toMatchObject({ armed_t: 1_000, armed_price: 37990 });
    expect(rows[1]!.armed_t).toBeNull();
    expect(rows[1]!.armed_price).toBeNull();
  });

  it('ARM 時点で価格が取れない/stale(=null)なら armed_price だけ NULL(armed_t は残る)', () => {
    const db = memDb();
    insertSignalTrade(db, {
      entryT: 2_000, entryPrice: 38000, dir: 'buy', exitT: 3_000, exitPrice: 38050, pnl: 50, qty: 1,
      armedT: 1_000, armedPrice: null,
    });
    const r = getSignalTrades(db)[0]!;
    expect(r.armed_t).toBe(1_000);
    expect(r.armed_price).toBeNull();
  });

  it('entry_t − armed_t で ARM→約定の経過が計算できる', () => {
    const db = memDb();
    insertSignalTrade(db, {
      entryT: 1_000_000 + 90_000, entryPrice: 38000, dir: 'buy',
      exitT: 1_000_000 + 300_000, exitPrice: 38050, pnl: 50, qty: 1,
      armedT: 1_000_000, armedPrice: 37960,
    });
    const r = getSignalTrades(db)[0]!;
    expect(r.entry_t - (r.armed_t as number)).toBe(90_000);   // 武装から90秒で約定
  });

  // ★既存DB(列追加前)に対する後付け ALTER: 既存行は無傷で、新列は NULL として読める。
  it('旧スキーマの既存DBへ後付けしても既存行は無傷・新列は NULL(2回3回でも壊れない)', () => {
    const db = new DatabaseSync(':memory:');
    // v0.7.51 以前の signal_trades(mode/system/signal_id/armed_* が無い)を手で作る。
    db.exec(`
      CREATE TABLE signal_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, dir TEXT NOT NULL,
        exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
        qty INTEGER NOT NULL, rationale TEXT, meta TEXT
      );
    `);
    db.prepare(`INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty, rationale, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(111, 37800, 'sell', 222, 37750, 50, 1, '旧行', '{"ctxV":"rich"}');
    initSchema(db);
    initSchema(db);
    initSchema(db);
    const rows = getSignalTrades(db);
    expect(rows).toHaveLength(1);
    // 既存の値は1つも変わらない。
    expect(rows[0]).toMatchObject({
      entry_t: 111, entry_price: 37800, dir: 'sell', exit_t: 222, exit_price: 37750,
      pnl: 50, qty: 1, rationale: '旧行', meta: '{"ctxV":"rich"}',
    });
    // 新列は NULL として読める。
    expect(rows[0]!.armed_t).toBeNull();
    expect(rows[0]!.armed_price).toBeNull();
    db.close();
  });
});

describe('エクスポート(VACUUM INTO)に armed_t/armed_price が同梱される', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('backupViaVacuum のコピーで ARM 時刻/価格が読める', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-armed-'));
    const livePath = join(dir, 'jp225.db');
    const live = new DatabaseSync(livePath);
    initSchema(live);
    insertSignalTrade(live, {
      entryT: 2_000, entryPrice: 38000, dir: 'buy', exitT: 3_000, exitPrice: 38050, pnl: 50, qty: 1,
      signalId: 7, armedT: 1_000, armedPrice: 37985,
    });
    const dest = join(dir, 'signals_export.db');
    backupViaVacuum(live, dest);
    live.close();

    const copy = new DatabaseSync(dest);
    const cols = (copy.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('armed_t');
    expect(cols).toContain('armed_price');
    expect(getSignalTrades(copy)[0]).toMatchObject({ signal_id: 7, armed_t: 1_000, armed_price: 37985 });
    copy.close();
  });
});
