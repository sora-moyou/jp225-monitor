import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, recordTick, getRecentTicks, pruneTicks } from './store.js';
import {
  ARCHIVED_SYMBOLS, initTickArchiveSchema, archiveTicks, getArchiveTicks,
  sessionDateRange, isSessionDateFinalized, EXPORT_SETTLE_MS,
  pendingExportDates, exportDailyTicks, dailyExportFileName, symbolLabel,
  runDailyTickExport, resolveTickExportDir, cleanPathInput,
  getArchiveMeta,
} from './tickArchive.js';
import type { Price } from '../types.js';

// ★このテストが守る契約(将来の分析のためのデータ蓄積・RECORD-ONLY):
//   ① ティックの長期保管は **共有DBとは別ファイル**(trade2 の 30分 `VACUUM INTO` を太らせない)。
//   ② 長期保管は **NIY=F だけ**。他3銘柄は共有DBで従来どおり3日 prune のまま。
//   ③ 長期保管側に **自動削除の規則を置かない**(3日→400日に置き換えるのは同じ地雷の先送り)。
//   ④ 確定済みの過去日だけを日次ファイルへ書き出す(append-only・冪等)。

const JST = 9 * 60 * 60_000;
/** JST 壁時計から epoch ms。 */
const jst = (y: number, m: number, d: number, hh: number, mm: number): number =>
  Date.UTC(y, m - 1, d, hh, mm) - JST;

function archiveDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initTickArchiveSchema(db);
  return db;
}
function mainDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}
function px(symbol: string, price: number, t: number, stale = false): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale } as unknown as Price;
}

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tickarch-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('保管対象は NIY=F だけ', () => {
  it('ARCHIVED_SYMBOLS は NIY=F のみ', () => {
    expect([...ARCHIVED_SYMBOLS]).toEqual(['NIY=F']);
  });

  it('4銘柄を流しても archive には NIY=F しか入らない', () => {
    const db = archiveDb();
    const t = jst(2026, 6, 3, 10, 0);
    const n = archiveTicks(db, [
      px('NIY=F', 38000, t), px('YM=F', 40000, t), px('NQ=F', 20000, t), px('JPY=X', 150, t),
    ]);
    expect(n).toBe(1);
    const all = db.prepare('SELECT DISTINCT symbol FROM ticks').all() as Array<{ symbol: string }>;
    expect(all.map(r => r.symbol)).toEqual(['NIY=F']);
  });

  it('stale / 場外 / 非有限価格は共有DBと同じ規則で捨てる', () => {
    const db = archiveDb();
    const inSession = jst(2026, 6, 3, 10, 0);
    const outSession = jst(2026, 6, 3, 16, 0);   // 15:45–17:00 の空白帯
    archiveTicks(db, [
      px('NIY=F', 38000, inSession, true),   // stale
      px('NIY=F', 38010, outSession),        // 場外
      px('NIY=F', 0, inSession + 1000),      // 非有限相当(<=0)
      px('NIY=F', 38020, inSession + 2000),  // 唯一の有効
    ]);
    expect(getArchiveTicks(db, 'NIY=F', 0, Number.MAX_SAFE_INTEGER).map(r => r.price)).toEqual([38020]);
  });
});

describe('★自動削除の規則を置かない(長期保管)', () => {
  it('モジュールは prune/delete 系の関数を公開しない', async () => {
    const mod = await import('./tickArchive.js') as Record<string, unknown>;
    const names = Object.keys(mod).filter(k => /prune|delete|purge|retention|cleanup|expire/i.test(k));
    expect(names).toEqual([]);
  });

  it('共有DBは4銘柄とも3日で消えるが、archive の NIY=F は10日前でも残る', () => {
    const main = mainDb();
    const arch = archiveDb();
    const now = jst(2026, 6, 15, 12, 0);
    const old = jst(2026, 6, 3, 10, 0);         // 12日前(=3日より古い)
    const prices = [
      px('NIY=F', 38000, old), px('YM=F', 40000, old), px('NQ=F', 20000, old), px('JPY=X', 150, old),
    ];
    for (const p of prices) recordTick(main, p.symbol, p.timestamp, p.price, '2026-06-03', 'Day');
    archiveTicks(arch, prices);

    pruneTicks(main, now - 3 * 24 * 60 * 60 * 1000);   // collector と同じ保持方針(変更なし)

    // 共有DB: 4銘柄とも消える(従来どおり)
    for (const s of ['NIY=F', 'YM=F', 'NQ=F', 'JPY=X']) {
      expect(getRecentTicks(main, s, 0)).toEqual([]);
    }
    // archive: NIY=F だけが残る(他3銘柄はそもそも書かれていない)
    expect(getArchiveTicks(arch, 'NIY=F', 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    for (const s of ['YM=F', 'NQ=F', 'JPY=X']) {
      expect(getArchiveTicks(arch, s, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    }
  });
});

describe('sessionDateRange(セッション日 → 実時刻レンジ)', () => {
  it('D 08:45 JST 〜 D+1 06:00 JST(過不足なく D のティックだけを含む)', () => {
    const { start, end } = sessionDateRange('2026-06-03');
    expect(start).toBe(jst(2026, 6, 3, 8, 45));
    expect(end).toBe(jst(2026, 6, 4, 6, 0));
  });

  it('Day の寄り/引け・Night の翌朝終端が全部レンジ内に入る', () => {
    const { start, end } = sessionDateRange('2026-06-03');
    for (const t of [jst(2026, 6, 3, 8, 45), jst(2026, 6, 3, 15, 44), jst(2026, 6, 3, 17, 0), jst(2026, 6, 4, 5, 59)]) {
      expect(t >= start && t < end).toBe(true);
    }
    // 前日の夜間(翌朝 05:00)は D のレンジに入らない
    expect(jst(2026, 6, 3, 5, 0) >= start).toBe(false);
  });

  it('確定判定は D+1 06:00 + 猶予', () => {
    const end = sessionDateRange('2026-06-03').end;
    expect(isSessionDateFinalized('2026-06-03', end + EXPORT_SETTLE_MS - 1)).toBe(false);
    expect(isSessionDateFinalized('2026-06-03', end + EXPORT_SETTLE_MS)).toBe(true);
  });
});

describe('pendingExportDates(確定済みの過去日だけ)', () => {
  function seedDays(db: DatabaseSync, days: Array<[number, number, number]>): void {
    for (const [y, m, d] of days) {
      archiveTicks(db, [px('NIY=F', 38000, jst(y, m, d, 10, 0)), px('NIY=F', 38010, jst(y, m, d, 22, 0))]);
    }
  }

  it('進行中の日は返さない / 確定済みは古い順に返す', () => {
    const db = archiveDb();
    seedDays(db, [[2026, 6, 3], [2026, 6, 4], [2026, 6, 5]]);
    // 6/5 の Night はまだ続いている(6/5 22:00 JST)
    expect(pendingExportDates(db, 'NIY=F', jst(2026, 6, 5, 22, 30))).toEqual(['2026-06-03', '2026-06-04']);
    // 6/6 08:00 JST = 6/5 の終端(6/6 06:00)+猶予1h を満たす
    expect(pendingExportDates(db, 'NIY=F', jst(2026, 6, 6, 8, 0))).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);
  });

  it('カーソル以降だけを返す(書き出し済みは二度と対象にしない)', () => {
    const db = archiveDb();
    seedDays(db, [[2026, 6, 3], [2026, 6, 4]]);
    runDailyTickExport(db, jst(2026, 6, 5, 8, 0), tmp);
    expect(getArchiveMeta(db, 'export:lastSessionDate:NIY=F')).toBe('2026-06-04');
    expect(pendingExportDates(db, 'NIY=F', jst(2026, 6, 5, 8, 0))).toEqual([]);
  });
});

describe('日次書き出し(append-only・冪等)', () => {
  it('ファイル名は ticks_NIY_YYYY-MM-DD.db', () => {
    expect(symbolLabel('NIY=F')).toBe('NIY');
    expect(dailyExportFileName('NIY=F', '2026-06-03')).toBe('ticks_NIY_2026-06-03.db');
  });

  it('その日のティックだけを持つ単独DBを作る(前後の日は混ざらない)', () => {
    const db = archiveDb();
    archiveTicks(db, [
      px('NIY=F', 1, jst(2026, 6, 2, 22, 0)),    // 前日 Night(sessionDate=6/2)
      px('NIY=F', 2, jst(2026, 6, 3, 9, 0)),     // 6/3 Day
      px('NIY=F', 3, jst(2026, 6, 4, 5, 0)),     // 6/3 Night の翌朝(sessionDate=6/3)
      px('NIY=F', 4, jst(2026, 6, 4, 9, 0)),     // 6/4 Day
    ]);
    const r = exportDailyTicks(db, 'NIY=F', '2026-06-03', tmp);
    expect(r).not.toBeNull();
    expect(r!.rows).toBe(2);
    expect(r!.skipped).toBe(false);

    const out = new DatabaseSync(r!.file);
    const rows = out.prepare('SELECT symbol, t, price FROM ticks ORDER BY t').all() as Array<{ price: number }>;
    expect(rows.map(x => x.price)).toEqual([2, 3]);
    const meta = Object.fromEntries((out.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>)
      .map(m => [m.key, m.value]));
    expect(meta.symbol).toBe('NIY=F');
    expect(meta.session_date).toBe('2026-06-03');
    expect(meta.rows).toBe('2');
    out.close();
  });

  it('既存ファイルは書き換えない(冪等・append-only)', () => {
    const db = archiveDb();
    archiveTicks(db, [px('NIY=F', 1, jst(2026, 6, 3, 9, 0))]);
    const a = exportDailyTicks(db, 'NIY=F', '2026-06-03', tmp)!;
    expect(a.skipped).toBe(false);
    // 後からティックが増えても、既に出したファイルは触らない
    archiveTicks(db, [px('NIY=F', 2, jst(2026, 6, 3, 10, 0))]);
    const b = exportDailyTicks(db, 'NIY=F', '2026-06-03', tmp)!;
    expect(b.skipped).toBe(true);
    const out = new DatabaseSync(a.file);
    expect((out.prepare('SELECT COUNT(*) AS n FROM ticks').get() as { n: number }).n).toBe(1);
    out.close();
  });

  it('データが無い日はファイルを作らない', () => {
    const db = archiveDb();
    expect(exportDailyTicks(db, 'NIY=F', '2026-06-03', tmp)).toBeNull();
    expect(existsSync(join(tmp, 'ticks_NIY_2026-06-03.db'))).toBe(false);
  });

  it('一時ファイル(.tmp)を残さない', () => {
    const db = archiveDb();
    archiveTicks(db, [px('NIY=F', 1, jst(2026, 6, 3, 9, 0))]);
    exportDailyTicks(db, 'NIY=F', '2026-06-03', tmp);
    expect(readdirSync(tmp).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });

  it('runDailyTickExport は確定済みの全日を出し、カーソルを進める', () => {
    const db = archiveDb();
    for (const d of [3, 4]) archiveTicks(db, [px('NIY=F', 100 + d, jst(2026, 6, d, 9, 0))]);
    const done = runDailyTickExport(db, jst(2026, 6, 5, 8, 0), tmp);
    expect(done.map(r => r.file.split(/[\\/]/).pop())).toEqual(['ticks_NIY_2026-06-03.db', 'ticks_NIY_2026-06-04.db']);
    // 2回目は何も出ない(冪等)
    expect(runDailyTickExport(db, jst(2026, 6, 5, 8, 0), tmp)).toEqual([]);
  });

  it('宛先未設定なら何もしない(カーソルも進めない=設定後に遡って出せる)', () => {
    const db = archiveDb();
    archiveTicks(db, [px('NIY=F', 1, jst(2026, 6, 3, 9, 0))]);
    expect(runDailyTickExport(db, jst(2026, 6, 5, 8, 0), '')).toEqual([]);
    expect(getArchiveMeta(db, 'export:lastSessionDate:NIY=F')).toBeNull();
    expect(pendingExportDates(db, 'NIY=F', jst(2026, 6, 5, 8, 0))).toEqual(['2026-06-03']);
  });
});

describe('書き出し先の解決(trade2 の書き出し設定に相乗り)', () => {
  const saved = { APPDATA: process.env.APPDATA, DIR: process.env.JP225_TICK_EXPORT_DIR };
  afterEach(() => {
    if (saved.APPDATA === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved.APPDATA;
    if (saved.DIR === undefined) delete process.env.JP225_TICK_EXPORT_DIR; else process.env.JP225_TICK_EXPORT_DIR = saved.DIR;
  });

  it('trade2 の %APPDATA%/jp225-trade/export.json の exportDir を読む', () => {
    delete process.env.JP225_TICK_EXPORT_DIR;
    process.env.APPDATA = tmp;
    mkdirSync(join(tmp, 'jp225-trade'), { recursive: true });
    const dir = join(tmp, 'sync');
    writeFileSync(join(tmp, 'jp225-trade', 'export.json'), JSON.stringify({ exportDir: dir }), 'utf-8');
    expect(resolveTickExportDir()).toBe(dir);
  });

  it('未設定(export.json なし)は空文字=書き出さない', () => {
    delete process.env.JP225_TICK_EXPORT_DIR;
    process.env.APPDATA = tmp;
    expect(resolveTickExportDir()).toBe('');
  });

  it('「パスのコピー」由来の引用符を剥がす / 相対パスは拒否する', () => {
    expect(cleanPathInput('"C:\\Users\\me\\Documents\\trade"')).toBe('C:\\Users\\me\\Documents\\trade');
    delete process.env.JP225_TICK_EXPORT_DIR;
    process.env.APPDATA = tmp;
    mkdirSync(join(tmp, 'jp225-trade'), { recursive: true });
    writeFileSync(join(tmp, 'jp225-trade', 'export.json'), JSON.stringify({ exportDir: 'trade' }), 'utf-8');
    expect(resolveTickExportDir()).toBe('');   // 相対パス=AppData 配下へ誤書き込みする事故を拒否
  });

  it('環境変数が最優先(隔離テスト/上書き用)', () => {
    process.env.APPDATA = tmp;
    process.env.JP225_TICK_EXPORT_DIR = join(tmp, 'override');
    expect(resolveTickExportDir()).toBe(join(tmp, 'override'));
  });
});
