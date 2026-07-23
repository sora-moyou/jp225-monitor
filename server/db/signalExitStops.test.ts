import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSchema, insertSignalTrade, getSignalTrades,
  insertSignalExitStop, getSignalExitStops,
} from './store.js';
import { backupViaVacuum } from './mergeDb.js';

// ★検証用(monitor2⇔trade2 突合): signal_trades.signal_id 1級列 + signal_exit_stops 遷移履歴 + エクスポート同梱。
function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}

describe('signal_trades.signal_id 列(結合キー)', () => {
  it('ALTER で signal_id 列が存在する(idempotent)', () => {
    const db = memDb();
    initSchema(db);   // 2回目=冪等
    const cols = (db.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('signal_id');
  });

  it('signalId を渡すと signal_id 列に保存 / 未指定は NULL(後方互換)', () => {
    const db = memDb();
    insertSignalTrade(db, { entryT: 1, entryPrice: 38000, dir: 'buy', exitT: 2, exitPrice: 38050, pnl: 50, qty: 1, signalId: 42 });
    insertSignalTrade(db, { entryT: 3, entryPrice: 38000, dir: 'buy', exitT: 4, exitPrice: 38050, pnl: 50, qty: 1 });   // 未指定
    const rows = getSignalTrades(db);
    const ids = rows.map(r => r.signal_id).sort((a, b) => (a ?? -1) - (b ?? -1));
    expect(ids).toEqual([null, 42]);
  });
});

describe('signal_exit_stops(決済逆指値の遷移履歴)', () => {
  it('CREATE TABLE で存在する(idempotent)', () => {
    const db = memDb();
    initSchema(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toContain('signal_exit_stops');
  });

  it('insert→get 往復(signal_id/opened_at/direction/exit_stop/phase)', () => {
    const db = memDb();
    insertSignalExitStop(db, { t: 1000, signalId: 7, openedAt: 900, direction: 'buy', exitStop: 37900, phase: null });
    insertSignalExitStop(db, { t: 2000, signalId: 7, openedAt: 900, direction: 'buy', exitStop: 38030, phase: 'range' });
    const rows = getSignalExitStops(db);
    expect(rows).toHaveLength(2);
    // 新しい順(t DESC)。
    expect(rows[0]).toMatchObject({ t: 2000, signal_id: 7, opened_at: 900, direction: 'buy', exit_stop: 38030, phase: 'range' });
    expect(rows[1]).toMatchObject({ t: 1000, signal_id: 7, opened_at: 900, direction: 'buy', exit_stop: 37900, phase: null });
  });

  it('signalId 省略は signal_id=NULL(二次結合キー opened_at+direction は必須)', () => {
    const db = memDb();
    insertSignalExitStop(db, { t: 1, openedAt: 5, direction: 'sell', exitStop: 38150 });
    const r = getSignalExitStops(db)[0]!;
    expect(r.signal_id).toBeNull();
    expect(r.opened_at).toBe(5);
    expect(r.direction).toBe('sell');
  });
});

describe('エクスポート(VACUUM INTO)に新スキーマが同梱される', () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('backupViaVacuum のコピーに signal_exit_stops と signal_trades.signal_id が入る', () => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-export-'));
    // ライブ DB はファイルでないと VACUUM INTO できない。
    const livePath = join(dir, 'jp225.db');
    const live = new DatabaseSync(livePath);
    initSchema(live);
    insertSignalTrade(live, { entryT: 1, entryPrice: 38000, dir: 'buy', exitT: 2, exitPrice: 38050, pnl: 50, qty: 1, signalId: 99 });
    insertSignalExitStop(live, { t: 10, signalId: 99, openedAt: 5, direction: 'buy', exitStop: 37900 });

    const dest = join(dir, 'signals_export.db');
    backupViaVacuum(live, dest);
    live.close();

    const copy = new DatabaseSync(dest);
    const cols = (copy.prepare('PRAGMA table_info(signal_trades)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('signal_id');
    const trade = copy.prepare('SELECT signal_id FROM signal_trades').get() as { signal_id: number };
    expect(trade.signal_id).toBe(99);
    const es = getSignalExitStops(copy);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ signal_id: 99, opened_at: 5, direction: 'buy', exit_stop: 37900 });
    copy.close();
  });
});
