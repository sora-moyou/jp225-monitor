import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db/store.js';
import { rowToBar, parseNdjsonLine, importBars } from './basedata.js';

describe('rowToBar (Excel serial+fraction → JST epoch)', () => {
  it('Excelシリアル46021@17:00 を JST 2025-12-30 17:00 に変換、分床へ丸める', () => {
    // 標準の Excel 1900日付系: serial 25569 = 1970-01-01。serial 46021 = 2025-12-30。
    const b = rowToBar(46021, 17 / 24, 50450, 50465, 50415, 50420, 2086);
    const jst = new Date(b.t + 9 * 3600_000);
    expect(jst.toISOString().slice(0, 16)).toBe('2025-12-30T17:00');
    expect(b.t % 60_000).toBe(0);
    expect(b).toMatchObject({ o: 50450, h: 50465, l: 50415, c: 50420, v: 2086 });
  });

  it('日付列は実カレンダー日付なので時刻シフト補正なし(早朝も同シリアル日のまま)', () => {
    // A列は実日付。早朝(夜間立会の翌朝)のバーは xlsx 上で既に翌日のシリアルを持つため、
    // serial 46021 @ 02:00 はそのまま 2025-12-30 02:00(+1日しない)。Night帰属は classifySession が処理。
    const morning = rowToBar(46021, 2 / 24, 1, 2, 0.5, 1.5, 10);
    expect(new Date(morning.t + 9 * 3600_000).toISOString().slice(0, 16)).toBe('2025-12-30T02:00');
    const evening = rowToBar(46021, 17 / 24, 1, 2, 0.5, 1.5, 10);
    expect(new Date(evening.t + 9 * 3600_000).toISOString().slice(0, 16)).toBe('2025-12-30T17:00');
  });
});

describe('parseNdjsonLine', () => {
  it('正常行を bar に、空/不正は null', () => {
    expect(parseNdjsonLine('{"t":60000,"o":1,"h":2,"l":0.5,"c":1.5,"v":10}'))
      .toEqual({ t: 60000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    expect(parseNdjsonLine('')).toBeNull();
    expect(parseNdjsonLine('not json')).toBeNull();
    expect(parseNdjsonLine('{"t":"x"}')).toBeNull();
  });
});

describe('importBars', () => {
  it('session を付与し upsert、既存の別時刻データは削除しない', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 9_999_999_999_000, 1, 1, 1, 1);
    const t10 = Date.UTC(2026, 5, 1, 1, 0); // 10:00 JST Monday
    const bars = [
      { t: t10, o: 100, h: 110, l: 90, c: 105, v: 5 },
      { t: t10 + 60_000, o: 105, h: 115, l: 95, c: 110, v: 6 },
    ];
    const r = importBars(db, bars);
    expect(r.inserted + r.updated).toBe(2);
    const cnt = (db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
    expect(cnt).toBe(3);
    const tagged = db.prepare('SELECT session FROM bars_1m WHERE t=?').get(t10) as any;
    expect(tagged.session).toBe('Day');
    db.close();
  });

  it('休場/場外(session=null)のバーはスキップ', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const tHoliday = Date.UTC(2026, 0, 1, 1, 0); // 2026-01-01 10:00 JST (元日 休場)
    const r = importBars(db, [{ t: tHoliday, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(r.inserted + r.updated).toBe(0);
    db.close();
  });
});
