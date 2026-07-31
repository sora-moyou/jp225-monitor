import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, clearSignalTrades, getArmedTimeoutStats, bumpArmedTimeout, setSignalIdCounter, getSignalIdCounter } from './store.js';

// ★未約定失効(armed-timeout)の永続カウンタ。
//   「monitor が武装 → trade2 が受信後ずっと拒否 → 15分で黙って失効」の終着点。実測 sid=361(2026-07-30)は
//   trade2 が6秒おきに147回拒否したのに、monitor 側には件数がどこにも残らなかった(=無音の失敗)。
//   signal_meta に系統別(A/B)で持ち、再起動を跨いで継続し、履歴消去でのみ 0 に戻る。

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

describe('signal_meta: 未約定失効カウンタ', () => {
  it('列が存在する(initSchema は冪等)', () => {
    const db = memDb();
    initSchema(db);   // 2回目
    const cols = (db.prepare('PRAGMA table_info(signal_meta)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toEqual(expect.arrayContaining(['armed_timeouts', 'last_armed_timeout_at']));
  });

  it('未発生は {count:0, lastAt:null}', () => {
    const db = memDb();
    expect(getArmedTimeoutStats(db, 'A')).toEqual({ count: 0, lastAt: null });
    expect(getArmedTimeoutStats(db, 'B')).toEqual({ count: 0, lastAt: null });
  });

  it('加算されて最終発生時刻が残る(再起動を跨いで読み直せる)', () => {
    const db = memDb();
    expect(bumpArmedTimeout(db, 'A', 1000)).toEqual({ count: 1, lastAt: 1000 });
    expect(bumpArmedTimeout(db, 'A', 2000)).toEqual({ count: 2, lastAt: 2000 });
    expect(getArmedTimeoutStats(db, 'A')).toEqual({ count: 2, lastAt: 2000 });
  });

  it('A / B は独立に数える', () => {
    const db = memDb();
    bumpArmedTimeout(db, 'A', 1000);
    bumpArmedTimeout(db, 'B', 1100);
    bumpArmedTimeout(db, 'B', 1200);
    expect(getArmedTimeoutStats(db, 'A').count).toBe(1);
    expect(getArmedTimeoutStats(db, 'B').count).toBe(2);
  });

  it('signalId カウンタと同居しても互いを壊さない(先に signalId → 後から失効)', () => {
    const db = memDb();
    setSignalIdCounter(db, 'A', 361);
    bumpArmedTimeout(db, 'A', 1785455141000);
    expect(getSignalIdCounter(db, 'A')).toBe(361);
    expect(getArmedTimeoutStats(db, 'A')).toEqual({ count: 1, lastAt: 1785455141000 });
    // 逆順(先に失効 → 後から signalId)でも同じ。
    bumpArmedTimeout(db, 'B', 5);
    setSignalIdCounter(db, 'B', 7);
    expect(getSignalIdCounter(db, 'B')).toBe(7);
    expect(getArmedTimeoutStats(db, 'B').count).toBe(1);
  });

  it('履歴消去(clearSignalTrades)で 0 に戻る=履歴と件数が食い違わない', () => {
    const db = memDb();
    bumpArmedTimeout(db, 'A', 1000);
    bumpArmedTimeout(db, 'A', 2000);
    clearSignalTrades(db, 'A');
    expect(getArmedTimeoutStats(db, 'A')).toEqual({ count: 0, lastAt: null });
  });
});
