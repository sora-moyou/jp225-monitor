import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { insertAlert, recordTick, getRecentAlerts, getRecentTicks, openDb, upsertBar } from './store.js';
import { mergeFrom, replaceFrom } from './mergeDb.js';

const tmp: string[] = [];
function fileDb(): { db: DatabaseSync; path: string } {
  const path = join(tmpdir(), `mtest-${Math.random().toString(36).slice(2)}.db`);
  tmp.push(path);
  return { db: openDb(path), path };
}
afterEach(() => { for (const p of tmp.splice(0)) { try { rmSync(p); } catch { /* ignore */ } try { rmSync(p + '-wal'); } catch { /* ignore */ } try { rmSync(p + '-shm'); } catch { /* ignore */ } } });

const A = { symbol: 'NIY=F', triggeredAt: 1000, direction: 'down', detectionKind: 'break', windowSeconds: 60, changePercent: 0, price: 67000, sessionDate: '2026-06-05', session: 'Day', referenceKind: null as string | null, referencePrice: null as number | null };

describe('mergeFrom', () => {
  it('alerts は OR IGNORE で重複せず統合(完全一致は無視・別は追加)', () => {
    const m = fileDb(); const o = fileDb();
    insertAlert(m.db, A);
    insertAlert(o.db, A);                       // 完全一致(無視される)
    insertAlert(o.db, { ...A, triggeredAt: 2000 });  // 別(追加)
    const res = mergeFrom(m.db, o.path);
    expect(getRecentAlerts(m.db, 10).length).toBe(2);
    expect(res.alerts).toBe(1);                 // 追加できたのは1
  });
  it('別水準(reference_price 違い)は保持される', () => {
    const m = fileDb(); const o = fileDb();
    insertAlert(o.db, { ...A, referenceKind: 'level', referencePrice: 67100 });
    insertAlert(o.db, { ...A, referenceKind: 'level', referencePrice: 67200 });
    mergeFrom(m.db, o.path);
    expect(getRecentAlerts(m.db, 10).length).toBe(2);
  });
  it('ticks は PK(symbol,t)で OR IGNORE', () => {
    const m = fileDb(); const o = fileDb();
    recordTick(m.db, 'NIY=F', 60_000, 67000, '2026-06-05', 'Day');
    recordTick(o.db, 'NIY=F', 60_000, 67000, '2026-06-05', 'Day');   // 同一 PK
    recordTick(o.db, 'NIY=F', 120_000, 67010, '2026-06-05', 'Day');  // 別
    const res = mergeFrom(m.db, o.path);
    expect(getRecentTicks(m.db, 'NIY=F', 0).length).toBe(2);
    expect(res.ticks).toBe(1);
  });
  it('bars_1m の出所(src)は統合先へそのまま運ばれる(基礎データの印が消えない)', () => {
    const m = fileDb(); const o = fileDb();
    upsertBar(o.db, 'NIY=F', 60_000, 100, 110, 90, 105, 7, '2026-06-05', 'Day');   // 基礎データ
    recordTick(o.db, 'NIY=F', 120_000, 67010, '2026-06-05', 'Day');                // ライブ
    mergeFrom(m.db, o.path);
    const rows = m.db.prepare('SELECT t, src FROM bars_1m ORDER BY t').all() as Array<{ t: number; src: string | null }>;
    expect(rows).toEqual([{ t: 60_000, src: 'base' }, { t: 120_000, src: 'live' }]);
  });
  it('src 列を持たない旧版 DB からでも統合できる(共通列だけ移送する)', () => {
    const m = fileDb();
    // 旧版の DB を手で作る(bars_1m に src 列が無い)
    const oldPath = join(tmpdir(), `mtest-old-${Math.random().toString(36).slice(2)}.db`);
    tmp.push(oldPath);
    const old = new DatabaseSync(oldPath);
    old.exec(`CREATE TABLE bars_1m (symbol TEXT NOT NULL, session_date TEXT, session TEXT, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, PRIMARY KEY (symbol, t));
      CREATE TABLE ticks (symbol TEXT NOT NULL, t INTEGER NOT NULL, price REAL NOT NULL, PRIMARY KEY (symbol, t));
      CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, triggered_at INTEGER NOT NULL);`);
    old.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-05', 'Day', 60_000, 1, 2, 0, 1);
    old.close();
    expect(() => mergeFrom(m.db, oldPath)).not.toThrow();
    const row = m.db.prepare('SELECT t, src FROM bars_1m').get() as { t: number; src: string | null };
    expect(row).toEqual({ t: 60_000, src: null });   // 出所不明として入る(嘘をつかない)
  });
});

describe('replaceFrom', () => {
  it('main の中身をソースと完全一致に置き換える(既存は消える・ソース分だけ残る)', () => {
    const m = fileDb(); const o = fileDb();
    // main: 既存の独自データ
    insertAlert(m.db, { ...A, triggeredAt: 9000 });
    recordTick(m.db, 'NIY=F', 9_000_000, 60000, '2026-06-05', 'Day');
    // source: 別の2件
    insertAlert(o.db, A);
    insertAlert(o.db, { ...A, triggeredAt: 2000 });
    recordTick(o.db, 'NIY=F', 60_000, 67000, '2026-06-05', 'Day');

    const res = replaceFrom(m.db, o.path);

    const alerts = getRecentAlerts(m.db, 10);
    expect(alerts.length).toBe(2);                                  // main の独自9000は消え、source の2件
    expect(alerts.some(a => a.triggered_at === 9000)).toBe(false);  // 既存は消えた
    expect(alerts.map(a => a.triggered_at).sort()).toEqual([1000, 2000]);
    expect(getRecentTicks(m.db, 'NIY=F', 0).map(t => t.t)).toEqual([60_000]);  // main の独自tickも消えてsourceのみ
    expect(res.alerts).toBe(2);
    expect(res.ticks).toBe(1);
  });
});
