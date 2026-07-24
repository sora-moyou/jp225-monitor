import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  initSchema, insertSignalTrade, getSignalTrades, clearSignalTrades,
  getSignalIdCounter, setSignalIdCounter, resetSignalIdCounter,
} from './store.js';

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

// ★signalId 永続カウンタ(signal_meta): 再起動を跨いで継続・履歴消去でのみ 0 化・A/B 独立。
describe('signal_meta signalId 永続カウンタ', () => {
  it('signal_meta 列が存在する(idempotent)', () => {
    const db = memDb();
    initSchema(db);   // 2回目=冪等
    const cols = (db.prepare('PRAGMA table_info(signal_meta)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['system', 'last_signal_id']));
  });

  it('未設定は 0(=最初の ARM は 1 から)', () => {
    const db = memDb();
    expect(getSignalIdCounter(db, 'A')).toBe(0);
    expect(getSignalIdCounter(db, 'B')).toBe(0);
  });

  it('(a) セット後に読み直すと継続する(再起動シード=last → 次の ARM は last+1・1 に戻らない)', () => {
    const db = memDb();
    // ARM が 5 回まで進んだ状態を永続(最後に採番した signalId=5)。
    for (let i = 1; i <= 5; i++) setSignalIdCounter(db, 'A', i);
    // 別プロセス(=再起動)の fresh read。
    const seed = getSignalIdCounter(db, 'A');
    expect(seed).toBe(5);
    // 次の採番は seed+1=6(engine は signalIdCounter+=1 で使う)。決して 1 へは戻らない。
    expect(seed + 1).toBe(6);
  });

  it('(b) clearSignalTrades でカウンタが 0 にリセット(次の ARM は 1 から)', () => {
    const db = memDb();
    setSignalIdCounter(db, 'A', 12);
    clearSignalTrades(db, 'A');
    expect(getSignalIdCounter(db, 'A')).toBe(0);
    expect(getSignalIdCounter(db, 'A') + 1).toBe(1);   // 次の ARM = 1
  });

  it('(c) A/B は独立(A の消去は B を変えない)', () => {
    const db = memDb();
    setSignalIdCounter(db, 'A', 7);
    setSignalIdCounter(db, 'B', 3);
    expect(getSignalIdCounter(db, 'A')).toBe(7);
    expect(getSignalIdCounter(db, 'B')).toBe(3);
    clearSignalTrades(db, 'A');                 // A のみ消去
    expect(getSignalIdCounter(db, 'A')).toBe(0);
    expect(getSignalIdCounter(db, 'B')).toBe(3);   // B は不変
  });

  it('clearSignalTrades(undefined=全件)は全系統をリセット', () => {
    const db = memDb();
    setSignalIdCounter(db, 'A', 7);
    setSignalIdCounter(db, 'B', 3);
    clearSignalTrades(db);   // system 未指定 = 全件
    expect(getSignalIdCounter(db, 'A')).toBe(0);
    expect(getSignalIdCounter(db, 'B')).toBe(0);
  });

  it('resetSignalIdCounter(system) は指定系統のみ 0 化', () => {
    const db = memDb();
    setSignalIdCounter(db, 'A', 9);
    setSignalIdCounter(db, 'B', 4);
    resetSignalIdCounter(db, 'B');
    expect(getSignalIdCounter(db, 'A')).toBe(9);
    expect(getSignalIdCounter(db, 'B')).toBe(0);
  });
});
