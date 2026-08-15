import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { initSchema, recordTick, getRecentBars, getRecentTicks, getLatestTick, openDb, pruneTicks, getSessionOHLC, upsertBar, getMeta, setMeta, insertAlert, getRecentAlerts, getBarCloseAt, getBarCloseNear, getAlertsNeedingFollowup, updateAlertReturns, insertSignalTrade, getSignalTrades, upsertDailyClose, getDailyCloses } from './store.js';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  return db;
}
const M = 60_000;

describe('store', () => {
  it('bars_1m は (symbol, t) 主キーで t レンジ読みを賄う(session_date 索引には依存しない)', () => {
    const db = memDb();
    // getSessionOHLC は t 範囲を読んで JS 集計するため、主キー(symbol,t)があれば足りる。
    // 旧 idx_bars_session(session_date,session 索引)は読みに使われず撤去済み。
    const idx = (db.prepare('PRAGMA index_list(bars_1m)').all() as Array<{ name: string; origin: string }>);
    expect(idx.some(i => i.origin === 'pk')).toBe(true);          // 主キー自動索引あり
    expect(idx.map(i => i.name)).not.toContain('idx_bars_session'); // 死蔵索引は作らない
  });

  it('recordTick inserts a tick and creates a 1m bar (o=h=l=c on first tick of minute)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    expect(getRecentTicks(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', t: 10 * M + 1000, price: 67000 }]);
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([{ symbol: 'NIY=F', session_date: '2026-06-01', session: 'Day', t: 10 * M, o: 67000, h: 67000, l: 67000, c: 67000, src: 'live' }]);
  });

  it('recordTick updates the same minute bar h/l/c, keeps o', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 20000, 67080, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 40000, 66950, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 59000, 67010, '2026-06-01', 'Day');
    expect(getRecentBars(db, 'NIY=F', 0)).toEqual([
      { symbol: 'NIY=F', session_date: '2026-06-01', session: 'Day', t: 10 * M, o: 67000, h: 67080, l: 66950, c: 67010, src: 'live' },
    ]);
  });

  it('recordTick rolls to a new bar on minute change', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M + 1000, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 11 * M + 1000, 67100, '2026-06-01', 'Day');
    const bars = getRecentBars(db, 'NIY=F', 0);
    expect(bars.map(b => [b.t, b.c])).toEqual([[10 * M, 67000], [11 * M, 67100]]);
  });

  it('duplicate tick (same symbol+t) is ignored, no throw', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    expect(getRecentTicks(db, 'NIY=F', 0)).toHaveLength(1);
  });

  it('getRecentBars filters by sinceT and is per-symbol, ascending t', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 9 * M, 100, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M, 200, '2026-06-01', 'Day');
    recordTick(db, 'NQ=F', 10 * M, 300, '2026-06-01', 'Day');
    expect(getRecentBars(db, 'NIY=F', 10 * M).map(b => b.t)).toEqual([10 * M]);
    expect(getRecentBars(db, 'NQ=F', 0)).toHaveLength(1);
  });

  it('getLatestTick returns the newest tick or null', () => {
    const db = memDb();
    expect(getLatestTick(db, 'NIY=F')).toBeNull();
    recordTick(db, 'NIY=F', 10 * M, 100, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 11 * M, 200, '2026-06-01', 'Day');
    expect(getLatestTick(db, 'NIY=F')).toEqual({ symbol: 'NIY=F', t: 11 * M, price: 200 });
  });

  it('bar carries session_date + session from recordTick', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Night');
    const b = getRecentBars(db, 'NIY=F', 0)[0]!;
    expect(b.session_date).toBe('2026-06-01');
    expect(b.session).toBe('Night');
    expect(b.t).toBe(10 * M);
  });
});

describe('pruneTicks', () => {
  it('deletes ticks older than cutoff but keeps bars_1m', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 1 * 60_000, 100, '2026-06-01', 'Day');   // old
    recordTick(db, 'NIY=F', 100 * 60_000, 200, '2026-06-01', 'Day'); // recent
    pruneTicks(db, 50 * 60_000);
    expect(getRecentTicks(db, 'NIY=F', 0).map(t => t.t)).toEqual([100 * 60_000]);
    expect(getRecentBars(db, 'NIY=F', 0)).toHaveLength(2);  // bars 保持
  });
});

describe('openDb', () => {
  it('opens a file db with WAL and persists across reopen', () => {
    const path = join(tmpdir(), `jp225-test-${process.pid}.db`);
    rmSync(path, { force: true });
    const db1 = openDb(path);
    recordTick(db1, 'NIY=F', 10 * 60_000, 67000, '2026-06-01', 'Day');
    db1.close();
    const db2 = openDb(path);
    expect(getRecentBars(db2, 'NIY=F', 0)).toHaveLength(1);
    db2.close();
    rmSync(path, { force: true });
    rmSync(path + '-wal', { force: true });
    rmSync(path + '-shm', { force: true });
  });
});

describe('getSessionOHLC', () => {
  // JST 壁時計(2026-06-day jh:jm)→ UTC epoch。session_date は意図的に null で入れ、
  // getSessionOHLC が「保存列に依存せず t から分類」することを検証(古い collector の null 対策)。
  const J = (day: number, jh: number, jm = 0): number => Date.UTC(2026, 5, day, jh - 9, jm);
  function seedBar(db: DatabaseSync, t: number, o: number, h: number, l: number, c: number) {
    db.prepare(
      'INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)'
    ).run('NIY=F', null, null, t, o, h, l, c);   // session 列は null
  }

  it('保存session_dateがnullでも t から分類して O/H/L/C・high_t/low_t を集計、新しい順', () => {
    const db = memDb();
    seedBar(db, J(1, 9, 0), 67000, 67100, 66950, 67050);   // 6-01(月) Day 09:00
    seedBar(db, J(1, 9, 1), 67050, 67300, 67000, 67200);
    seedBar(db, J(1, 9, 2), 67200, 67250, 66800, 66850);
    seedBar(db, J(1, 17, 0), 66850, 66900, 66700, 66750);  // 6-01 Night 17:00

    const out = getSessionOHLC(db, 'NIY=F', 10);
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({
      sessionDate: '2026-06-01', session: 'Night',
      open: 66850, high: 66900, low: 66700, close: 66750, highT: J(1, 17, 0), lowT: J(1, 17, 0), openT: J(1, 17, 0),
    });
    expect(out[1]).toEqual({
      sessionDate: '2026-06-01', session: 'Day',
      open: 67000, high: 67300, low: 66800, close: 66850, highT: J(1, 9, 1), lowT: J(1, 9, 2), openT: J(1, 9, 0),
    });
    db.close();
  });

  it('limit を尊重する', () => {
    const db = memDb();
    seedBar(db, J(1, 9), 1, 2, 0.5, 1.5);   // 6-01(月) Day
    seedBar(db, J(2, 9), 1, 2, 0.5, 1.5);   // 6-02(火) Day
    seedBar(db, J(3, 9), 1, 2, 0.5, 1.5);   // 6-03(水) Day
    expect(getSessionOHLC(db, 'NIY=F', 2).length).toBe(2);
    db.close();
  });
});

describe('getMeta/setMeta', () => {
  it('未設定は null、setMeta で書いて読める、上書きできる', () => {
    const db = openDb(':memory:');
    expect(getMeta(db, 'k')).toBeNull();
    setMeta(db, 'k', 'v1');
    expect(getMeta(db, 'k')).toBe('v1');
    setMeta(db, 'k', 'v2');
    expect(getMeta(db, 'k')).toBe('v2');
    db.close();
  });
});

describe('upsertBar', () => {
  it('同 (symbol,t) は OHLCV を全上書き、別 t は併存、削除しない', () => {
    const db = openDb(':memory:');
    upsertBar(db, 'NIY=F', 60000, 100, 110, 90, 105, null, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 120000, 200, 210, 190, 205, null, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 60000, 101, 111, 91, 99, 2086, '2026-06-01', 'Day');
    const rows = db.prepare('SELECT t,o,h,l,c,volume FROM bars_1m WHERE symbol=? ORDER BY t').all('NIY=F') as any[];
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({ t: 60000, o: 101, h: 111, l: 91, c: 99, volume: 2086 });
    expect(rows[1].t).toBe(120000);
    db.close();
  });
});

// ─── 出所(src)と衝突解決: 「基礎データがあるなら基礎データを優先する」を DB 側で固定する ───
// 判定規則そのものは core/barSource.ts:shouldOverwriteBar(表は core/barSource.test.ts)。
// ここでは **SQL の実挙動が同じ表に従っている** ことを実 SQLite で確かめる(規則とSQLの乖離を防ぐ)。
describe('bars_1m の出所(src)と衝突解決', () => {
  const srcOf = (db: DatabaseSync, t: number): string | null =>
    (db.prepare('SELECT src FROM bars_1m WHERE symbol=? AND t=?').get('NIY=F', t) as { src: string | null }).src;
  const barOf = (db: DatabaseSync, t: number) =>
    db.prepare('SELECT o,h,l,c,volume,src FROM bars_1m WHERE symbol=? AND t=?').get('NIY=F', t) as any;

  it('列 src が存在する(既存 DB へも冪等 ALTER で後付けされる)', () => {
    const db = memDb();
    const cols = (db.prepare('PRAGMA table_info(bars_1m)').all() as Array<{ name: string }>).map(c => c.name);
    expect(cols).toContain('src');
    // src 列が無い旧 DB を作って initSchema を再実行しても壊れず、既存行は NULL(出所不明)のまま。
    const old = new DatabaseSync(':memory:');
    old.exec(`CREATE TABLE bars_1m (symbol TEXT NOT NULL, session_date TEXT, session TEXT, t INTEGER NOT NULL,
      o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, PRIMARY KEY (symbol, t))`);
    old.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', null, null, 60000, 1, 1, 1, 1);
    initSchema(old);
    initSchema(old);   // 冪等
    expect(srcOf(old, 60000)).toBeNull();
    old.close();
  });

  it('recordTick は src=live を刻む / upsertBar(基礎データ)は src=base を刻む', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 20 * M, 100, 110, 90, 105, 7, '2026-06-01', 'Day');
    expect(srcOf(db, 10 * M)).toBe('live');
    expect(srcOf(db, 20 * M)).toBe('base');
  });

  it('★既存=base に live が来ても上書きしない(基礎データ優先)', () => {
    const db = memDb();
    upsertBar(db, 'NIY=F', 10 * M, 100, 110, 90, 105, 7, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 30_000, 999, '2026-06-01', 'Day');
    expect(barOf(db, 10 * M)).toEqual({ o: 100, h: 110, l: 90, c: 105, volume: 7, src: 'base' });
    // tick そのものは残る(ticks はライブの生記録で、基礎データとは別の表)
    expect(getRecentTicks(db, 'NIY=F', 0).map(t => t.price)).toEqual([999]);
  });

  it('既存=live に base が来たら上書きする(基礎データが正)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 10 * M, 100, 110, 90, 105, 7, '2026-06-01', 'Day');
    expect(barOf(db, 10 * M)).toEqual({ o: 100, h: 110, l: 90, c: 105, volume: 7, src: 'base' });
  });

  it('既存=NULL(出所不明・既存環境の全行)に live が来たら従来どおり上書きする', () => {
    const db = memDb();
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 10 * M, 100, 110, 90, 105);
    recordTick(db, 'NIY=F', 10 * M + 30_000, 120, '2026-06-01', 'Day');
    // 従来の合成規則: h=max, l=min, c=最新, o は据え置き
    expect(barOf(db, 10 * M)).toEqual({ o: 100, h: 120, l: 90, c: 120, volume: null, src: 'live' });
  });

  it('既存=live に live が来たら従来どおり(h=max/l=min/c=最新)', () => {
    const db = memDb();
    recordTick(db, 'NIY=F', 10 * M, 67000, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 20_000, 67080, '2026-06-01', 'Day');
    recordTick(db, 'NIY=F', 10 * M + 40_000, 66950, '2026-06-01', 'Day');
    expect(barOf(db, 10 * M)).toEqual({ o: 67000, h: 67080, l: 66950, c: 66950, volume: null, src: 'live' });
  });

  it('既存=base に base が来たら上書きする(基礎データの再取込は最新版が勝つ)', () => {
    const db = memDb();
    upsertBar(db, 'NIY=F', 10 * M, 100, 110, 90, 105, 7, '2026-06-01', 'Day');
    upsertBar(db, 'NIY=F', 10 * M, 101, 111, 91, 99, 8, '2026-06-01', 'Day');
    expect(barOf(db, 10 * M)).toEqual({ o: 101, h: 111, l: 91, c: 99, volume: 8, src: 'base' });
  });
});

describe('alerts store', () => {
  function mkAlert(over: Partial<any> = {}) {
    return { symbol: 'NIY=F', triggeredAt: 1000, direction: 'up', detectionKind: 'slope',
      windowSeconds: 60, changePercent: 0.3, price: 67000, sessionDate: '2026-06-01', session: 'Day', ...over };
  }
  it('insertAlert → getRecentAlerts (新しい順)、ret は初期 null', () => {
    const db = openDb(':memory:');
    insertAlert(db, mkAlert({ triggeredAt: 1000 }));
    insertAlert(db, mkAlert({ triggeredAt: 2000 }));
    const rows = getRecentAlerts(db, 10);
    expect(rows.length).toBe(2);
    expect(rows[0]!.triggered_at).toBe(2000);          // 新しい順
    expect(rows[0]!.price).toBe(67000);
    expect(rows[0]!.ret5).toBeNull();
    db.close();
  });

  it('getBarCloseAt: t 以下で最新の bar.close を返す、無ければ null', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 60000, 1, 1, 1, 100);
    db.prepare('INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', 120000, 1, 1, 1, 110);
    expect(getBarCloseAt(db, 'NIY=F', 120000)).toBe(110);
    expect(getBarCloseAt(db, 'NIY=F', 90000)).toBe(100);   // 90000以下の最新=60000の100
    expect(getBarCloseAt(db, 'NIY=F', 30000)).toBeNull();  // それ以前は無し
    db.close();
  });

  it('getBarCloseNear: target±許容内の最新 close。範囲外(遠い古い足)へは張り付かず null', () => {
    const db = openDb(':memory:');
    const ins = (t: number, c: number) => db.prepare(
      'INSERT INTO bars_1m(symbol,session_date,session,t,o,h,l,c) VALUES(?,?,?,?,?,?,?,?)')
      .run('NIY=F', '2026-06-01', 'Day', t, 1, 1, 1, c);
    ins(1_000_000, 100);                  // 発火足相当(遠い過去)
    ins(1_000_000 + 5 * 60_000, 105);     // +5分の足
    const tol = 3 * 60_000;
    // target=+5分: ちょうどの足を取得
    expect(getBarCloseNear(db, 'NIY=F', 1_000_000 + 5 * 60_000, tol)).toBe(105);
    // target=+15分: 近傍(±3分)に足が無い → null(遠い 100/105 へフォールバックしない)
    expect(getBarCloseNear(db, 'NIY=F', 1_000_000 + 15 * 60_000, tol)).toBeNull();
    db.close();
  });

  it('updateAlertReturns で ret を埋める / getAlertsNeedingFollowup', () => {
    const db = openDb(':memory:');
    insertAlert(db, mkAlert({ triggeredAt: 1000 }));
    const id = getRecentAlerts(db, 1)[0]!.id;
    // now が triggered+30分超なら followup 対象
    const now = 1000 + 31 * 60_000;
    expect(getAlertsNeedingFollowup(db, now).length).toBe(1);
    updateAlertReturns(db, id, 0.1, 0.2, 0.3);
    const r = getRecentAlerts(db, 1)[0]!;
    expect([r.ret5, r.ret15, r.ret30]).toEqual([0.1, 0.2, 0.3]);
    expect(getAlertsNeedingFollowup(db, now).length).toBe(0);   // ret30 が埋まったので対象外
    db.close();
  });
});

// ─── daily_closes(取引日15:45終値の永続化) ───
describe('daily_closes upsert/get', () => {
  it('upsert して古い→新しい順で取り出せる', () => {
    const db = memDb();
    upsertDailyClose(db, 'NIY=F', '2026-06-03', 38300, 3000);
    upsertDailyClose(db, 'NIY=F', '2026-06-01', 38100, 1000);
    upsertDailyClose(db, 'NIY=F', '2026-06-02', 38200, 2000);
    const rows = getDailyCloses(db, 'NIY=F', 10);
    expect(rows.map(r => r.session_date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(rows.map(r => r.close)).toEqual([38100, 38200, 38300]);
    db.close();
  });

  it('同 session_date は close/t を上書き(基礎=正)', () => {
    const db = memDb();
    upsertDailyClose(db, 'NIY=F', '2026-06-01', 38100, 1000);
    upsertDailyClose(db, 'NIY=F', '2026-06-01', 38150, 1500);
    const rows = getDailyCloses(db, 'NIY=F', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_date: '2026-06-01', close: 38150, t: 1500 });
    db.close();
  });

  it('limit は直近ぶんを返す(古い→新しい順)', () => {
    const db = memDb();
    for (let i = 1; i <= 5; i++) upsertDailyClose(db, 'NIY=F', `2026-06-0${i}`, 38000 + i, i * 1000);
    const rows = getDailyCloses(db, 'NIY=F', 3);
    expect(rows.map(r => r.session_date)).toEqual(['2026-06-03', '2026-06-04', '2026-06-05']);
    db.close();
  });

  it('symbol ごとに独立、close≤0 は無視', () => {
    const db = memDb();
    upsertDailyClose(db, 'NIY=F', '2026-06-01', 38100, 1000);
    upsertDailyClose(db, 'NQ=F', '2026-06-01', 20000, 1000);
    upsertDailyClose(db, 'NIY=F', '2026-06-02', 0, 2000);      // close≤0 は保存しない
    expect(getDailyCloses(db, 'NIY=F', 10).map(r => r.session_date)).toEqual(['2026-06-01']);
    expect(getDailyCloses(db, 'NQ=F', 10)).toHaveLength(1);
    db.close();
  });
});

// ─── signal_trades の mode タグ(レンジ両面を別枠集計) ───
describe('signal_trades mode タグ', () => {
  function stBase() {
    return { entryT: 1000, entryPrice: 38000, dir: 'buy' as const, exitT: 2000, exitPrice: 38050, pnl: 50, qty: 1 };
  }
  it("mode='range' を保存し getSignalTrades で取り出せる", () => {
    const db = memDb();
    insertSignalTrade(db, { ...stBase(), rationale: 'range', mode: 'range' });
    const rows = getSignalTrades(db);
    expect(rows.length).toBe(1);
    expect(rows[0]!.mode).toBe('range');
    db.close();
  });
  it("mode='directional' を保存できる", () => {
    const db = memDb();
    insertSignalTrade(db, { ...stBase(), rationale: 'dir', mode: 'directional' });
    expect(getSignalTrades(db)[0]!.mode).toBe('directional');
    db.close();
  });
  it('mode 未指定は NULL(後方互換=directional 扱い)', () => {
    const db = memDb();
    insertSignalTrade(db, { ...stBase(), rationale: 'x' });
    expect(getSignalTrades(db)[0]!.mode).toBeNull();
    db.close();
  });
  it("mode='range' だけを絞り込み集計できる(別枠計測)", () => {
    const db = memDb();
    insertSignalTrade(db, { ...stBase(), rationale: 'r1', mode: 'range' });
    insertSignalTrade(db, { ...stBase(), entryT: 3000, exitT: 4000, rationale: 'd1', mode: 'directional' });
    const rangeOnly = getSignalTrades(db).filter(r => r.mode === 'range');
    expect(rangeOnly.length).toBe(1);
    expect(rangeOnly[0]!.rationale).toBe('r1');
    db.close();
  });
});
