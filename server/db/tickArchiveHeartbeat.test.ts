import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, getMeta } from './store.js';
import { initTickArchiveSchema, archiveTicks, runDailyTickExport } from './tickArchive.js';
import {
  TICK_ARCHIVE_HEARTBEAT_KEY, TICK_ARCHIVE_STATUS_KEY, TICK_ARCHIVE_HEARTBEAT_MS,
  TICK_ARCHIVE_STALE_LAG_MS, TICK_ARCHIVE_TOTAL_RECOUNT_MS, TICK_ARCHIVE_HEARTBEAT_FRESH_MS,
  readTickArchiveSymbolStats, buildTickArchiveHeartbeat, formatTickArchiveStatus,
  writeTickArchiveHeartbeat, readTickArchiveHeartbeat, describeTickArchive,
  type TickArchiveHeartbeat,
} from './tickArchiveHeartbeat.js';
import type { Price } from '../types.js';

// ★このテストが守る契約(ティック保管の**常時**健全性指標・RECORD-ONLY):
//   ① 保管の状態は **共有DB(jp225.db)の meta** に載る = 既存の 30分ごとの `VACUUM INTO` 書き出しに
//      そのまま乗る(専用DBは書き出しに含まれないので、状態だけを共有DB側に置く)。
//   ② 「止まっている」が **スナップショット1枚だけ** で分かる(場中の 0 件 = stalled / 場外 = idle)。
//   ③ 失敗は無音にしない(archive 書込・日次書出・保管DB読取のいずれの失敗も meta に残る)。
//   ④ ハートビート自体が止まったら、読み手が `at` の古さで検出する(OK のまま凍らせない)。

const JST = 9 * 60 * 60_000;
const jst = (y: number, m: number, d: number, hh: number, mm: number, ss = 0): number =>
  Date.UTC(y, m - 1, d, hh, mm, ss) - JST;

// 2026-06-03(水)は平日・休場日でない。10:00 JST = Day セッション中。
const IN_SESSION = jst(2026, 6, 3, 10, 0);
const OUT_SESSION = jst(2026, 6, 3, 16, 0);   // 15:45–17:00 の空白帯(場外)
const WEEKEND = jst(2026, 6, 7, 12, 0);       // 日曜

function archiveDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initTickArchiveSchema(db);
  return db;
}
function sharedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}
function px(price: number, t: number, symbol = 'NIY=F'): Price {
  return { symbol, price, changePercent: 0, timestamp: t, stale: false } as unknown as Price;
}
/** t から dt ごとに n 件のティックを保管する。 */
function feed(db: DatabaseSync, t: number, n: number, dt = 2000): void {
  archiveTicks(db, Array.from({ length: n }, (_, i) => px(38000 + i, t + i * dt)));
}

let tmp = '';
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tickhb-')); });
afterEach(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// ─────────────────────────────────────────────────────────
describe('★どこに載せるか: 共有DB(jp225.db)の meta = 既存の書き出しに乗る', () => {
  it('ハートビートは jp225.db の meta に JSON と1行サマリの2本で入る', () => {
    const main = sharedDb();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 30);
    writeTickArchiveHeartbeat(main, arch, { now: IN_SESSION + 60_000, exportDir: tmp });

    expect(getMeta(main, TICK_ARCHIVE_HEARTBEAT_KEY)).toBeTruthy();
    const status = getMeta(main, TICK_ARCHIVE_STATUS_KEY)!;
    expect(status).toContain('NIY=F');
    expect(status).toContain('最終保管=');
  });

  it('★`VACUUM INTO`(trade2 の 30分スナップショットと同じ操作)で meta ごと複製される', () => {
    // これが「既存の書き出し経路に載せた」の実証。専用DB(ticks_archive.db)は別ファイルなので
    // スナップショットに含まれないが、meta に置いた状態は複製先でそのまま読める。
    const srcPath = join(tmp, 'jp225.db');
    const snapPath = join(tmp, 'prices_test.db');
    const main = new DatabaseSync(srcPath);
    main.exec('PRAGMA journal_mode = WAL');
    initSchema(main);
    const arch = archiveDb();
    feed(arch, IN_SESSION, 30);
    const hb = writeTickArchiveHeartbeat(main, arch, { now: IN_SESSION + 60_000, exportDir: tmp });
    main.prepare('VACUUM INTO ?').run(snapPath);   // trade2 priceSnapshotWorker と同じ
    main.close();

    const snap = new DatabaseSync(snapPath);
    const copied = readTickArchiveHeartbeat(snap);
    expect(copied).not.toBeNull();
    expect(copied!.at).toBe(hb.at);
    expect(copied!.symbols[0]!.lastTickT).toBe(hb.symbols[0]!.lastTickT);
    expect(getMeta(snap, TICK_ARCHIVE_STATUS_KEY)).toBe(formatTickArchiveStatus(hb));
    snap.close();
  });
});

// ─────────────────────────────────────────────────────────
describe('★「増加数」の定義: 前回ハートビート時刻以降の実測件数', () => {
  it('前回ハートビート(prev.at)以降に入った件数を DB から数える', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);                       // 10:00:00 から 20秒ぶん(10件)
    const t1 = IN_SESSION + 60_000;
    const first = buildTickArchiveHeartbeat({ now: t1, prev: null, stats: readTickArchiveSymbolStats(arch, t1, null), exportDir: tmp });
    expect(first.symbols[0]!.delta).toBeNull();       // 初回は前回が無いので null
    expect(first.symbols[0]!.total).toBe(10);

    feed(arch, t1 + 1000, 7);                         // 次の窓で 7件
    const t2 = t1 + TICK_ARCHIVE_HEARTBEAT_MS;
    const second = buildTickArchiveHeartbeat({ now: t2, prev: first, stats: readTickArchiveSymbolStats(arch, t2, first), exportDir: tmp });
    expect(second.symbols[0]!.delta).toBe(7);
    expect(second.sinceMs).toBe(TICK_ARCHIVE_HEARTBEAT_MS);
  });

  it('カウンタの差ではなく実測なので、INSERT OR IGNORE で弾かれた重複は増加に数えない', () => {
    const arch = archiveDb();
    const t1 = IN_SESSION + 60_000;
    const first = buildTickArchiveHeartbeat({ now: t1, prev: null, stats: readTickArchiveSymbolStats(arch, t1, null), exportDir: tmp });
    // 同じ t を5回書く(archiveTicks の戻り値は 5 だが DB に入るのは 1 行)
    for (let i = 0; i < 5; i++) expect(archiveTicks(arch, [px(38000, t1 + 1000)])).toBe(1);
    const t2 = t1 + TICK_ARCHIVE_HEARTBEAT_MS;
    const second = buildTickArchiveHeartbeat({ now: t2, prev: first, stats: readTickArchiveSymbolStats(arch, t2, first), exportDir: tmp });
    expect(second.symbols[0]!.delta).toBe(1);   // 試行5回・実際に入ったのは1行
    // 累計は据え置き中(実測は1時間ごと)。実測し直せば 1 になる。
    const t3 = t1 + TICK_ARCHIVE_TOTAL_RECOUNT_MS;
    const third = buildTickArchiveHeartbeat({ now: t3, prev: second, stats: readTickArchiveSymbolStats(arch, t3, second), exportDir: tmp });
    expect(third.symbols[0]!.total).toBe(1);
  });

  it('当日累計(sessionRows)も併記する(日次書き出しの件数と突き合わせる用)', () => {
    const arch = archiveDb();
    feed(arch, jst(2026, 6, 2, 22, 0), 4);   // 前日のセッション
    feed(arch, IN_SESSION, 11);              // 当日
    const now = IN_SESSION + 60_000;
    const hb = buildTickArchiveHeartbeat({ now, prev: null, stats: readTickArchiveSymbolStats(arch, now, null), exportDir: tmp });
    expect(hb.sessionDate).toBe('2026-06-03');
    expect(hb.symbols[0]!.sessionRows).toBe(11);   // 当日ぶんだけ
    expect(hb.symbols[0]!.total).toBe(15);         // 累計は全部
  });
});

// ─────────────────────────────────────────────────────────
describe('★「止まっている」が一目で分かる', () => {
  /** 直前のハートビートを1つ作るヘルパ(prev として使う)。 */
  function hbAt(arch: DatabaseSync, now: number, prev: TickArchiveHeartbeat | null, exportDir = tmp): TickArchiveHeartbeat {
    return buildTickArchiveHeartbeat({ now, prev, stats: readTickArchiveSymbolStats(arch, now, prev), exportDir });
  }

  it('場中に増えていれば ok', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const a = hbAt(arch, IN_SESSION + 30_000, null);
    feed(arch, IN_SESSION + 31_000, 15);
    const b = hbAt(arch, IN_SESSION + 90_000, a);
    expect(b.state).toBe('ok');
    expect(b.reason).toContain('+15件');
  });

  it('★場中なのに1件も増えていなければ stalled(これが本題)', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const a = hbAt(arch, IN_SESSION + 30_000, null);
    const b = hbAt(arch, IN_SESSION + 90_000, a);   // 何も足さない = 書き込みが止まった
    expect(b.state).toBe('stalled');
    expect(b.reason).toContain('0件');
    expect(formatTickArchiveStatus(b).startsWith('STALLED')).toBe(true);
  });

  it('★場外の0件は idle(正常)= 週末に毎回「異常」を出して指標を殺さない', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const a = hbAt(arch, OUT_SESSION, null);
    expect(a.state).toBe('idle');
    expect(a.sessionOpen).toBe(false);
    const b = hbAt(arch, WEEKEND, a);
    expect(b.state).toBe('idle');
    expect(b.symbols[0]!.delta).toBe(0);   // 0件だが場外なので異常ではない
  });

  it('増えていても最終保管が古すぎれば stalled(古い足を書き続ける壊れ方も捕まえる)', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 5);
    const a = hbAt(arch, IN_SESSION + 30_000, null);
    // 前回ハートビート以降に「入った」が、tick の t は遥かに古い…という形にはならないので、
    // ここは「増加はある窓の直後に、最新tickがラグ超過」を直接組んで判定を確かめる。
    const stats = [{
      symbol: 'NIY=F', lastTickT: IN_SESSION - TICK_ARCHIVE_STALE_LAG_MS - 1_000,
      total: 5, totalAt: IN_SESSION, delta: 3, sessionRows: 5, pendingExports: 0,
    }];
    const b = buildTickArchiveHeartbeat({ now: IN_SESSION + 60_000, prev: a, stats, exportDir: tmp });
    expect(b.state).toBe('stalled');
    expect(b.reason).toContain('最終保管が');
  });

  it('保管が空(1件も入っていない)なら場中は stalled', () => {
    const arch = archiveDb();
    const a = hbAt(arch, IN_SESSION + 60_000, null);
    expect(a.state).toBe('stalled');
    expect(a.reason).toContain('空');
    expect(a.symbols[0]!.lastTickT).toBeNull();
  });

  it('起動直後(前回が無い)は ok にするが「増加数は次回から」と明示する', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const a = hbAt(arch, IN_SESSION + 30_000, null);
    expect(a.state).toBe('ok');
    expect(a.reason).toContain('起動直後');
  });

  it('1行サマリだけで最終保管時刻・増加数・当日/累計件数・書き出し・エラーが読める', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const a = hbAt(arch, IN_SESSION + 30_000, null);
    feed(arch, IN_SESSION + 31_000, 5);
    const line = formatTickArchiveStatus(hbAt(arch, IN_SESSION + 90_000, a));
    for (const frag of ['最終保管=', '増加=+5件', '当日=', '累計=', '未書出=', '最終書出=', 'エラー無し']) {
      expect(line).toContain(frag);
    }
  });
});

// ─────────────────────────────────────────────────────────
describe('★失敗を無音にしない', () => {
  it('渡された失敗は state=error になり、meta に理由が残る', () => {
    const main = sharedDb();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const now = IN_SESSION + 60_000;
    const hb = writeTickArchiveHeartbeat(main, arch, {
      now, exportDir: tmp,
      lastError: { at: now - 1000, where: 'archive', message: 'SQLITE_BUSY: database is locked' },
    });
    expect(hb.state).toBe('error');
    expect(getMeta(main, TICK_ARCHIVE_STATUS_KEY)).toContain('SQLITE_BUSY');
  });

  it('失敗は次の窓で state から降りるが、記録(lastError)は消えない', () => {
    const main = sharedDb();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const t1 = IN_SESSION + 60_000;
    writeTickArchiveHeartbeat(main, arch, { now: t1, exportDir: tmp, lastError: { at: t1 - 1000, where: 'export', message: 'ENOENT' } });
    feed(arch, t1 + 1000, 5);
    const t2 = t1 + TICK_ARCHIVE_HEARTBEAT_MS;
    const hb2 = writeTickArchiveHeartbeat(main, arch, { now: t2, exportDir: tmp });
    expect(hb2.state).toBe('ok');
    expect(hb2.lastError).not.toBeNull();               // 事実は残る
    expect(hb2.lastError!.message).toBe('ENOENT');
    expect(getMeta(main, TICK_ARCHIVE_STATUS_KEY)).toContain('最終エラー=');
  });

  it('★保管DBが読めなくても共有DBには必ず書く(更新が止まるだけ=無音、にしない)', () => {
    const main = sharedDb();
    const arch = archiveDb();
    arch.close();   // 保管DBが壊れた/閉じられた状況
    const hb = writeTickArchiveHeartbeat(main, arch, { now: IN_SESSION + 60_000, exportDir: tmp });
    expect(hb.state).toBe('error');
    expect(hb.lastError!.where).toBe('archive-read');
    expect(getMeta(main, TICK_ARCHIVE_HEARTBEAT_KEY)).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────
describe('日次書き出しの状態(いつ・どのファイル・何件)', () => {
  it('最後に成功した書き出しが載り、次のハートビートに引き継がれる', () => {
    const main = sharedDb();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 3);
    const done = runDailyTickExport(arch, jst(2026, 6, 4, 8, 0), tmp);
    expect(done).toHaveLength(1);
    expect(done[0]!.sessionDate).toBe('2026-06-03');   // 書き出し結果がセッション日を持つ

    const t1 = jst(2026, 6, 4, 9, 0);
    const hb1 = writeTickArchiveHeartbeat(main, arch, {
      now: t1, exportDir: tmp,
      lastExport: { at: t1 - 1000, sessionDate: done[0]!.sessionDate, file: done[0]!.file, rows: done[0]!.rows },
    });
    expect(hb1.lastExport!.rows).toBe(3);
    expect(hb1.symbols[0]!.pendingExports).toBe(0);

    // 次の窓では lastExport を渡さない → 前回から引き継ぐ(消えない)
    const hb2 = writeTickArchiveHeartbeat(main, arch, { now: t1 + TICK_ARCHIVE_HEARTBEAT_MS, exportDir: tmp });
    expect(hb2.lastExport).toEqual(hb1.lastExport);
    expect(getMeta(main, TICK_ARCHIVE_STATUS_KEY)).toContain('最終書出=2026-06-03 3件');
  });

  it('書き出しが滞ると未書出日数が増え exportBehind が立つ', () => {
    const arch = archiveDb();
    for (const d of [1, 2, 3]) feed(arch, jst(2026, 6, d, 10, 0), 2);
    const now = jst(2026, 6, 4, 9, 0);
    const hb = buildTickArchiveHeartbeat({ now, prev: null, stats: readTickArchiveSymbolStats(arch, now, null), exportDir: tmp });
    expect(hb.symbols[0]!.pendingExports).toBe(3);
    expect(hb.exportBehind).toBe(true);
    expect(formatTickArchiveStatus(hb)).toContain('★書き出しが滞留');
  });

  it('書き出し先が未設定なら「未設定」と明示する(保管は続くので error にはしない)', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 3);
    const now = IN_SESSION + 60_000;
    const hb = buildTickArchiveHeartbeat({ now, prev: null, stats: readTickArchiveSymbolStats(arch, now, null), exportDir: '' });
    expect(hb.exportEnabled).toBe(false);
    expect(hb.exportBehind).toBe(false);
    expect(hb.state).toBe('ok');
    expect(formatTickArchiveStatus(hb)).toContain('書出先=未設定');
  });
});

// ─────────────────────────────────────────────────────────
describe('累計件数は「実測値+実測時刻」(推定で埋めない)', () => {
  it('1時間は据え置き、実測時刻を添える。1時間を超えたら測り直す', () => {
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const t1 = IN_SESSION + 60_000;
    const a = buildTickArchiveHeartbeat({ now: t1, prev: null, stats: readTickArchiveSymbolStats(arch, t1, null), exportDir: tmp });
    expect(a.symbols[0]!.total).toBe(10);
    expect(a.symbols[0]!.totalAt).toBe(t1);

    feed(arch, t1 + 1000, 20);
    const t2 = t1 + TICK_ARCHIVE_HEARTBEAT_MS;
    const b = buildTickArchiveHeartbeat({ now: t2, prev: a, stats: readTickArchiveSymbolStats(arch, t2, a), exportDir: tmp });
    expect(b.symbols[0]!.total).toBe(10);          // 据え置き
    expect(b.symbols[0]!.totalAt).toBe(t1);        // ★いつの値かが分かる
    expect(b.symbols[0]!.delta).toBe(20);          // 増加は毎回実測

    const t3 = t1 + TICK_ARCHIVE_TOTAL_RECOUNT_MS;
    const c = buildTickArchiveHeartbeat({ now: t3, prev: b, stats: readTickArchiveSymbolStats(arch, t3, b), exportDir: tmp });
    expect(c.symbols[0]!.total).toBe(30);
    expect(c.symbols[0]!.totalAt).toBe(t3);
  });
});

// ─────────────────────────────────────────────────────────
describe('★読み手側: ハートビート自体が止まったのを見逃さない', () => {
  it('ハートビートが無ければ missing', () => {
    const v = describeTickArchive(null, IN_SESSION);
    expect(v.state).toBe('missing');
    expect(v.text).toContain('MISSING');
  });

  it('最後の値が ok でも、古ければ stalled(collector 停止)として読む', () => {
    const main = sharedDb();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 10);
    const hb = writeTickArchiveHeartbeat(main, arch, { now: IN_SESSION + 30_000, exportDir: tmp });
    expect(hb.state).toBe('ok');

    const fresh = describeTickArchive(hb, hb.at + TICK_ARCHIVE_HEARTBEAT_FRESH_MS - 1);
    expect(fresh.state).toBe('ok');

    const stale = describeTickArchive(hb, hb.at + TICK_ARCHIVE_HEARTBEAT_FRESH_MS + 1);
    expect(stale.state).toBe('stalled');
    expect(stale.text).toContain('ハートビートが');
    expect(stale.text).toContain('collector');
  });

  it('meta の値が壊れていても落ちない(次のハートビートで直る)', () => {
    const main = sharedDb();
    main.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(TICK_ARCHIVE_HEARTBEAT_KEY, 'not json');
    expect(readTickArchiveHeartbeat(main)).toBeNull();
    const arch = archiveDb();
    feed(arch, IN_SESSION, 3);
    expect(() => writeTickArchiveHeartbeat(main, arch, { now: IN_SESSION + 60_000, exportDir: tmp })).not.toThrow();
    expect(readTickArchiveHeartbeat(main)).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
describe('取引経路に触らない(RECORD-ONLY の担保)', () => {
  it('ハートビートを書くのは collector だけで、signalTrade / feed 経路からは呼ばれない', () => {
    const root = join(import.meta.dirname, '..', '..');
    const files = [
      'server/signalTrade/engine.ts', 'server/signalTrade/persist.ts',
      'server/loops/priceLoop.ts', 'server/index.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(root, f), 'utf-8');
      expect(src, `${f} は取引/フィード経路。ティック保管の同期書き込みを足してはいけない`)
        .not.toContain('tickArchive');
    }
    // collector 側からは実際に **呼ばれている**(import があるだけでは記録は動かない)。
    const col = readFileSync(join(root, 'collector', 'index.ts'), 'utf-8');
    expect(col).toContain('writeTickArchiveHeartbeat(db, archiveDb, {');
  });
});
