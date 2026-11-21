import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initSchema, getDailyCloses, openDb } from './db/store.js';
import { rowToBar, rowsToBars, parseNdjsonLine, importBars, type BaseRow } from './basedata.js';

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

describe('rowsToBars (夜間の実日付 = データ内で1つ前に現れるラベル)', () => {
  const toSerial = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / 86400_000) + 25569;
  const jstHHMM = (t: number) => new Date(t + 9 * 3600_000).toISOString().slice(0, 16);
  // ラベル(y,m,d)の1取引日ぶん: 夕方17:00・早朝02:00(=夜間・前の取引日の夜)+ 日中10:00。
  const day = (y: number, m: number, d: number, withDay = true): BaseRow[] => {
    const s = toSerial(y, m, d);
    const r = (tf: number): BaseRow => ({ serialDate: s, timeFrac: tf, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 });
    return withDay ? [r(17 / 24), r(2 / 24), r(10 / 24)] : [r(17 / 24), r(2 / 24)];
  };
  const times = (rows: BaseRow[]) => rowsToBars(rows).bars.map(b => jstHHMM(b.t));

  it('休業祝日の前夜: 2026-11-20(金)夜はラベル 11-24(11/23 は BCP テストで休業) → 実 11-20 夕方 / 11-21 未明', () => {
    // 実ファイル N225minif_2026.xlsx で確認した形(11-24 ラベルは夜間だけでファイル末尾)。
    expect(times([...day(2026, 11, 19), ...day(2026, 11, 20), ...day(2026, 11, 24, false)])).toEqual([
      '2026-11-18T17:00', '2026-11-19T02:00', '2026-11-19T10:00',   // 先頭ラベル(近似フォールバック)
      '2026-11-19T17:00', '2026-11-20T02:00', '2026-11-20T10:00',
      '2026-11-20T17:00', '2026-11-21T02:00',                       // ★11-23 夜ではない
    ]);
  });

  it('休業祝日の前夜(将来): 2027-09-17(金)夜はラベル 09-21(09-20 は休業予定) → 実 09-17 夕方 / 09-18 未明', () => {
    const t = times([...day(2027, 9, 17), ...day(2027, 9, 21)]);
    expect(t.slice(3)).toEqual(['2027-09-17T17:00', '2027-09-18T02:00', '2027-09-21T10:00']);
  });

  it('年末年始: 2026-01-05 ラベルの夜間は 2025-12-30(大納会)の夜 → 実 12-30 夕方 / 12-31 未明', () => {
    const t = times([...day(2025, 12, 30), ...day(2026, 1, 5)]);
    expect(t.slice(3)).toEqual(['2025-12-30T17:00', '2025-12-31T02:00', '2026-01-05T10:00']);
  });

  it('週末: 月曜ラベルの夜間は金曜の夜(従来と同じ)', () => {
    const t = times([...day(2026, 6, 5), ...day(2026, 6, 8)]);
    expect(t.slice(3)).toEqual(['2026-06-05T17:00', '2026-06-06T02:00', '2026-06-08T10:00']);
  });

  it('通常の平日: 木曜ラベルの夜間は水曜の夜(従来と同じ)。祝日取引日(11-03)もラベルがあればその夜', () => {
    expect(times([...day(2026, 6, 10), ...day(2026, 6, 11)]).slice(3))
      .toEqual(['2026-06-10T17:00', '2026-06-11T02:00', '2026-06-11T10:00']);
    expect(times([...day(2026, 11, 2), ...day(2026, 11, 3), ...day(2026, 11, 4)]).slice(6))
      .toEqual(['2026-11-03T17:00', '2026-11-04T02:00', '2026-11-04T10:00']);
  });

  it('ファイル先頭のラベルの夜間は前ラベルが無い → 土日近似にフォールバックし、件数と警告を返す', () => {
    const r = rowsToBars([...day(2026, 1, 5), ...day(2026, 1, 6)]);
    // 近似 = 土日だけ飛ばす前営業日(01-02 金)。祝日を知らないので実際(12-30 の夜)とは違う=だから警告する。
    expect(r.bars.slice(0, 2).map(b => jstHHMM(b.t))).toEqual(['2026-01-02T17:00', '2026-01-03T02:00']);
    expect(r.fallbackRows).toBe(2);              // 夜間の2行だけ(日中行は数えない)
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/先頭ラベル 2026-01-05/);
  });

  it('複数ファイルを連結すれば年初の夜間も前年ファイルのラベルから決まる(フォールバック無し=先頭だけ)', () => {
    const r = rowsToBars([...day(2025, 12, 29), ...day(2025, 12, 30), ...day(2026, 1, 5)]);
    expect(jstHHMM(r.bars[6]!.t)).toBe('2025-12-30T17:00');
    expect(r.fallbackRows).toBe(2);              // 先頭(12-29)の夜間だけ
  });

  it('行の並び順に依存しない(ラベル列は値の昇順で作る)', () => {
    const rows = [...day(2026, 11, 19), ...day(2026, 11, 20), ...day(2026, 11, 24, false)];
    const fwd = rowsToBars(rows).bars.map(b => b.t).sort((a, b) => a - b);
    const rev = rowsToBars([...rows].reverse()).bars.map(b => b.t).sort((a, b) => a - b);
    expect(rev).toEqual(fwd);
  });

  it('ラベル間隔が14日を超えたらデータ欠落の疑いとして警告する', () => {
    const r = rowsToBars([...day(2026, 6, 1), ...day(2026, 6, 22)]);
    expect(r.warnings.some(w => /間隔が 21 日/.test(w))).toBe(true);
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
  it('session を付与し upsert、既存の別時刻データは削除しない', async () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 9_999_999_999_000, 1, 1, 1, 1);
    const t10 = Date.UTC(2026, 5, 1, 1, 0); // 10:00 JST Monday
    const bars = [
      { t: t10, o: 100, h: 110, l: 90, c: 105, v: 5 },
      { t: t10 + 60_000, o: 105, h: 115, l: 95, c: 110, v: 6 },
    ];
    const r = await importBars(db, bars);
    expect(r.inserted + r.updated).toBe(2);
    const cnt = (db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
    expect(cnt).toBe(3);
    const tagged = db.prepare('SELECT session FROM bars_1m WHERE t=?').get(t10) as any;
    expect(tagged.session).toBe('Day');
    db.close();
  });

  it('休場/場外(session=null)のバーはスキップ', async () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const tHoliday = Date.UTC(2026, 0, 1, 1, 0); // 2026-01-01 10:00 JST (元日 休場)
    const r = await importBars(db, [{ t: tHoliday, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(r.inserted + r.updated).toBe(0);
    db.close();
  });

  it('未来日時のバーは DB に入れない(黙殺せずドロップ)', async () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const future = Date.now() + 24 * 3600_000;   // 1日先
    const r = await importBars(db, [{ t: future, o: 1, h: 1, l: 1, c: 1, v: 1 }]);
    expect(r.inserted + r.updated).toBe(0);
    const cnt = (db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
    expect(cnt).toBe(0);
    db.close();
  });

  it('取り込み時に各取引日(Dayセッション)終値を daily_closes に保存する(15:45欠損時は最終bar代替)', async () => {
    const db = new DatabaseSync(':memory:'); initSchema(db);
    const J = (day: number, jh: number, jm = 0): number => Date.UTC(2026, 5, day, jh - 9, jm);
    const bar = (t: number, c: number) => ({ t, o: c, h: c, l: c, c, v: 1 });
    const bars = [
      // 6-01(月) Day: 最終 bar = 15:44(=15:45クローズ相当)→ 38150 が終値
      bar(J(1, 9, 0), 38000), bar(J(1, 12, 0), 38100), bar(J(1, 15, 44), 38150),
      // 6-02(火) Day: 15:44 が欠損 → Day セッション最終 bar(15:00)を代替終値に → 38250
      bar(J(2, 9, 0), 38200), bar(J(2, 15, 0), 38250),
      // 夜間 bar は Day 終値に使わない(session=Night)
      bar(J(1, 17, 0), 37900),
    ];
    await importBars(db, bars);
    const rows = getDailyCloses(db, 'NIY=F', 10);
    expect(rows.map(r => [r.session_date, r.close])).toEqual([
      ['2026-06-01', 38150],
      ['2026-06-02', 38250],
    ]);
    db.close();
  });

  // ★2026-10-27/28 の実事故の再発防止: 1つの BEGIN..COMMIT で全件を書くと、その間 **別の接続(collector)が
  //   書けない**(busy_timeout 5秒を超えて database is locked で落ちた)。分割して間で譲れば、取り込みの
  //   途中でも別の接続が書ける。
  //   ★「取り込み中に」書けたことを件数で確かめる: 書けた瞬間の bars_1m 件数が全件より少ない =
  //     取り込みが終わる前にロックが空いていた。全件を1トランザクションで書く実装(=変更前)に戻すと、
  //     取り込みは await の前に同期で終わってしまうので、最初に書けた時点で全件そろっている → 赤。
  it('★分割コミット: 取り込みの途中で別の接続が(待たずに)書ける', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jp225-import-'));
    const path = join(dir, 'jp225.db');
    const db = openDb(path);
    const other = new DatabaseSync(path);
    other.exec('PRAGMA busy_timeout = 0');   // 待たない=ロック中なら即 SQLITE_BUSY
    try {
      // 2026-06-01(月) 09:00 JST から Day セッション内の連続 1 分足 360 本。
      const t0 = Date.UTC(2026, 5, 1, 0, 0);
      const bars = Array.from({ length: 360 }, (_, i) => ({ t: t0 + i * 60_000, o: 1, h: 1, l: 1, c: 1, v: 1 }));
      const holds: number[] = [];
      let done = false;
      const p = importBars(db, bars, { chunkRows: 50, yieldMs: 5, onTxn: ms => holds.push(ms) })
        .finally(() => { done = true; });
      let countAtFirstWrite: number | null = null;
      while (!done && countAtFirstWrite === null) {
        try {
          other.prepare("INSERT INTO meta(key,value) VALUES('probe','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
          countAtFirstWrite = (other.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n;
        } catch { /* ロック中 */ }
        await new Promise(r => setTimeout(r, 1));
      }
      const r = await p;
      expect(r.inserted).toBe(360);
      expect(countAtFirstWrite).not.toBeNull();
      expect(countAtFirstWrite!).toBeLessThan(360);
      // 360 本 / 50 = 8 トランザクション + daily_closes の 1 回。
      expect(holds.length).toBe(9);
      // 全件反映・daily_closes も従来どおり(Day の最終 bar = 360 本目)。
      expect((db.prepare('SELECT COUNT(*) n FROM bars_1m').get() as any).n).toBe(360);
      expect(getDailyCloses(db, 'NIY=F', 10).map(x => x.session_date)).toEqual(['2026-06-01']);
    } finally {
      other.close(); db.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
