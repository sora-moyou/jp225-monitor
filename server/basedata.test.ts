import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { initSchema } from './db/store.js';
import { rowToBar, parseNdjsonLine, importBars } from './basedata.js';

describe('rowToBar (xlsx A=セッション日付 → 実時刻 epoch)', () => {
  // A列=セッション日付(夜間=翌営業日ラベル)。実時刻へ逆変換: 夕方→前営業日 / 早朝→前営業日+1暦日 / 日中→D。
  const toSerial = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / 86400_000) + 25569;
  const jstHHMM = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 16);

  it('日中(08:45–15:45)は A の当日。OHLCV を保持し分床へ丸める', () => {
    const b = rowToBar(toSerial(2025, 12, 30), 10 / 24, 50450, 50465, 50415, 50420, 2086); // 火 10:00
    expect(jstHHMM(b.t)).toBe('2025-12-30T10:00');
    expect(b.t % 60_000).toBe(0);
    expect(b).toMatchObject({ o: 50450, h: 50465, l: 50415, c: 50420, v: 2086 });
  });

  it('夜間の夕方(17:00〜)は A の前営業日(=実際の寄付夕方)', () => {
    // A=火12-30 の夜間 17:00 は実際には 月12-29 夕方(前営業日)。
    const b = rowToBar(toSerial(2025, 12, 30), 17 / 24, 1, 2, 0.5, 1.5, 10);
    expect(jstHHMM(b.t)).toBe('2025-12-29T17:00');
  });

  it('夜間の早朝(〜6:00)は A の前営業日+1暦日(=実際の翌朝)', () => {
    // A=火12-30 の早朝 02:00 は実際には 火12-30 未明(前営業日 月12-29 の翌暦日)。
    const b = rowToBar(toSerial(2025, 12, 30), 2 / 24, 1, 2, 0.5, 1.5, 10);
    expect(jstHHMM(b.t)).toBe('2025-12-30T02:00');
  });

  it('金曜夜は週末を跨いで前営業日(金)へ: A=月の夜間 → 実 金夕方 / 土未明', () => {
    const mon = toSerial(2026, 6, 8); // 月06-08
    expect(jstHHMM(rowToBar(mon, 17 / 24, 1, 2, 0.5, 1.5, 10).t)).toBe('2026-06-05T17:00'); // 金 夕方
    expect(jstHHMM(rowToBar(mon, 2 / 24, 1, 2, 0.5, 1.5, 10).t)).toBe('2026-06-06T02:00');  // 土 未明
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

  it('未来日時のバーは DB に入れない(黙殺せずドロップ)', () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const future = Date.now() + 24 * 3600_000;   // 1日先
    const r = importBars(db, [{ t: future, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(r.inserted + r.updated).toBe(0);
    const cnt = (db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
    expect(cnt).toBe(0);
    db.close();
  });
});
