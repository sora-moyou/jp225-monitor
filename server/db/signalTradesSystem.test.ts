import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, insertSignalTrade, getSignalTrades, clearSignalTrades } from './store.js';

// ★v0.8.2: signal_trades の system 列(A/B タグ)。NULL は 'A' 扱い(後方互換)。
function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

function ins(db: DatabaseSync, over: Partial<Parameters<typeof insertSignalTrade>[1]>): void {
  insertSignalTrade(db, {
    entryT: 1000, entryPrice: 38000, dir: 'buy',
    exitT: 2000, exitPrice: 38050, pnl: 50, qty: 1, ...over,
  });
}

describe('signal_trades system 列', () => {
  it('ALTER で system 列が存在する(idempotent)', () => {
    const db = memDb();
    initSchema(db);   // 2回目=冪等
    const cols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('system');
  });

  it('system 未指定は NULL 保存 / B は "B" 保存', () => {
    const db = memDb();
    ins(db, {});                         // A(system 省略)→ NULL
    ins(db, { system: 'B' });
    const rows = getSignalTrades(db);
    const systems = rows.map(r => r.system);
    expect(systems).toHaveLength(2);
    expect(systems).toContain(null);   // A(未指定)は NULL
    expect(systems).toContain('B');
  });

  it('getSignalTrades({system:A}) は NULL 行(=既存/A)を含み B を除外', () => {
    const db = memDb();
    ins(db, { entryT: 1 });              // A(NULL)
    ins(db, { entryT: 2, system: 'B' }); // B
    ins(db, { entryT: 3, system: 'A' }); // 明示 A
    const a = getSignalTrades(db, 500, 'A');
    expect(a).toHaveLength(2);                       // NULL + 明示A
    expect(a.every(r => r.system === null || r.system === 'A')).toBe(true);
    const b = getSignalTrades(db, 500, 'B');
    expect(b).toHaveLength(1);
    expect(b[0]!.system).toBe('B');
  });

  it('clearSignalTrades は系統別に消せる(A は NULL 行も消す・B は残す)', () => {
    const db = memDb();
    ins(db, { entryT: 1 });              // A(NULL)
    ins(db, { entryT: 2, system: 'B' }); // B
    ins(db, { entryT: 3, system: 'A' }); // 明示 A
    const clearedA = clearSignalTrades(db, 'A');
    expect(clearedA).toBe(2);                         // NULL + 明示A
    expect(getSignalTrades(db)).toHaveLength(1);      // B のみ残る
    expect(getSignalTrades(db)[0]!.system).toBe('B');
    const clearedB = clearSignalTrades(db, 'B');
    expect(clearedB).toBe(1);
    expect(getSignalTrades(db)).toHaveLength(0);
  });
});
