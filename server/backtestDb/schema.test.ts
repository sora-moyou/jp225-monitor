import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ensureBacktestDbSchema, getDatasetInfo, loadSessionSpans, refreshDatasetStats } from './schema.js';

// バックテスト用DB のビューと dataset_info。メモリ上の DB(bars_1m は本物と同じ列)で確かめる。
function mem(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bars_1m ( symbol TEXT NOT NULL, session_date TEXT, session TEXT, t INTEGER NOT NULL,
    o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, volume INTEGER, src TEXT, PRIMARY KEY (symbol, t) )`);
  const ins = db.prepare('INSERT INTO bars_1m VALUES (?,?,?,?,?,?,?,?,?,?)');
  // 2026-01-05 Day 08:45〜08:47(JST)と、同日 Night 17:00 / 翌 00:30
  const t0 = Date.parse('2026-01-04T23:45:00Z');   // = 2026-01-05 08:45 JST
  ins.run('NIY=F', '2026-01-05', 'Day', t0, 100, 105, 99, 101, 10, null);
  ins.run('NIY=F', '2026-01-05', 'Day', t0 + 60_000, 101, 110, 100, 108, 0, null);
  ins.run('NIY=F', '2026-01-05', 'Day', t0 + 120_000, 108, 109, 95, 97, 5, 'base');
  const n0 = Date.parse('2026-01-05T08:00:00Z');   // = 17:00 JST
  ins.run('NIY=F', '2026-01-05', 'Night', n0, 97, 98, 96, 96, 1, null);
  ins.run('NIY=F', '2026-01-05', 'Night', Date.parse('2026-01-05T15:30:00Z'), 96, 120, 90, 111, 2, null);  // 00:30 JST 翌日
  return db;
}

describe('ensureBacktestDbSchema', () => {
  it('2回呼んでも壊れない(冪等)・bars_1m は変えない', () => {
    const db = mem();
    const cols = () => db.prepare('PRAGMA table_info(bars_1m)').all().map((r: any) => r.name);
    const before = cols();
    ensureBacktestDbSchema(db); ensureBacktestDbSchema(db);
    expect(cols()).toEqual(before);
    expect(getDatasetInfo(db).schema_version).toBe('1');
  });

  it('自分でトランザクションを張る / 呼び手のトランザクションの中では入れ子(SAVEPOINT)にする', () => {
    const db = mem();
    const inTx = () => (db as unknown as { isTransaction: boolean }).isTransaction;
    ensureBacktestDbSchema(db);
    expect(inTx()).toBe(false);                       // 自分で張って閉じた
    db.exec('DROP VIEW sessions; DROP VIEW bars_jst; DROP TABLE dataset_info');
    db.exec('BEGIN IMMEDIATE');
    ensureBacktestDbSchema(db);                       // 入れ子でも例外にならない
    expect(inTx()).toBe(true);                        // 呼び手のトランザクションは閉じない
    db.exec('ROLLBACK');                              // 呼び手が取り消せば一緒に消える
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('sessions','bars_jst','dataset_info')").get()).toEqual(expect.objectContaining({ n: 0 }));
  });

  it('途中で失敗したら全部取り消す(DROP したビューが中途半端に入れ替わらない)', () => {
    const db = mem();
    // 最後の upsert(dataset_info への書き込み)だけが失敗する形: CHECK で拒否する表を先に置く
    db.exec("CREATE TABLE dataset_info ( key TEXT PRIMARY KEY, value TEXT CHECK (value = 'never') )");
    db.exec("CREATE VIEW sessions AS SELECT 'old-definition' AS marker");
    expect(() => ensureBacktestDbSchema(db)).toThrow();
    expect((db as unknown as { isTransaction: boolean }).isTransaction).toBe(false);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as { sql: string }).sql;
    expect(sql).toContain('old-definition');         // 取り消されて古い定義のまま
    expect(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='bars_jst'").get()).toEqual(expect.objectContaining({ n: 0 }));
  });

  it('bars_jst は JST の文字列を足す(夜間 0:30 は暦日が翌日・session_date は前日のまま)', () => {
    const db = mem(); ensureBacktestDbSchema(db);
    const r = db.prepare("SELECT * FROM bars_jst WHERE session='Night' ORDER BY t").all() as any[];
    expect(r.map(x => [x.ts_jst, x.date_jst, x.time_jst, x.session_date])).toEqual([
      ['2026-01-05 17:00', '2026-01-05', '17:00', '2026-01-05'],
      ['2026-01-06 00:30', '2026-01-06', '00:30', '2026-01-05'],
    ]);
    expect(Object.keys(r[0])).toEqual(expect.arrayContaining(['symbol', 't', 'o', 'h', 'l', 'c', 'volume', 'src']));
  });

  it('sessions は open=最初の足の始値・close=最後の足の終値・高安・出来高・本数', () => {
    const db = mem(); ensureBacktestDbSchema(db);
    const r = db.prepare('SELECT * FROM sessions').all() as any[];
    expect(r.map(x => [x.session_date, x.session, x.open, x.high, x.low, x.close, x.volume, x.bars, x.start_jst, x.end_jst])).toEqual([
      ['2026-01-05', 'Day', 100, 110, 95, 97, 15, 3, '2026-01-05 08:45', '2026-01-05 08:47'],
      ['2026-01-05', 'Night', 97, 120, 90, 111, 3, 2, '2026-01-05 17:00', '2026-01-06 00:30'],
    ]);
  });

  it('refreshDatasetStats / loadSessionSpans は実際の件数を数える', () => {
    const db = mem(); ensureBacktestDbSchema(db);
    const st = refreshDatasetStats(db);
    expect(st).toMatchObject({ bars: 5, sessions: 2 });
    const info = getDatasetInfo(db);
    expect(info.bar_count).toBe('5');
    expect(info.first_bar_jst).toBe('2026-01-05 08:45');
    expect(info.last_bar_jst).toBe('2026-01-06 00:30');
    expect(loadSessionSpans(db).map(s => [s.sessionDate, s.session, s.bars])).toEqual([['2026-01-05', 'Day', 3], ['2026-01-05', 'Night', 2]]);
  });
});
