import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, resolveDbPath, insertSignalTrade, insertSignalExitStop,
  setSignalIdCounter, getSignalIdCounter, getSignalIdSeed,
  clearSignalTradesAudited, getSignalTradesClears,
} from './store.js';
import { signalTradesClearHandler } from '../routes/signalTrades.js';
import { SignalEngine } from '../signalTrade/engine.js';

// ★履歴消去(POST /api/signal-trades/clear)が分析基盤を壊さないことの検証。
//   実データ(運用機)では、この口が signal_id カウンタを 0 化していたため signal_exit_stops が 6 エポックに割れ、
//   signal_id=1 が 5 建玉・両方向に存在した(=signal_id 単独では結合キーにならない)。さらに削除の痕跡が
//   どこにも残らず「いつ・何件」が事後に判定不能だった。ここでは
//     (1) 消去しても採番が巻き戻らない(番号を再利用しない)
//     (2) 永続値が壊れても既存記録の MAX から復元する
//     (3) 消去のたびに監査行が1行残る(実 DB ファイル/後付け ALTER 込み)
//   を、実 SQLite ファイル + 実ルートハンドラで通しで確認する。

const ORIG = { APPDATA: process.env.APPDATA, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let dir: string;

function mockRes() {
  const out: { code: number; body: unknown } = { code: 200, body: null };
  return {
    out,
    status(c: number) { out.code = c; return this; },
    json(b: unknown) { out.body = b; return this; },
  };
}

/** 実運用の ARM 1回ぶんの永続効果を再現する: signalId を1つ進めて永続し、その番号でトレードを記録する。
 *  A は決済逆指値の遷移も1行記録する(B は hold を露出しないので exit-stop を書かない=実装どおり)。 */
function armAndRecord(signalId: number, system?: 'A' | 'B'): void {
  const db = openDb(resolveDbPath());
  try {
    setSignalIdCounter(db, system ?? 'A', signalId);
    insertSignalTrade(db, {
      entryT: 1000 * signalId, entryPrice: 38000, dir: signalId % 2 ? 'buy' : 'sell',
      exitT: 1000 * signalId + 500, exitPrice: 38010, pnl: 10, qty: 1,
      system: system ?? null, signalId,
    });
    if (system !== 'B') {
      insertSignalExitStop(db, {
        t: 1000 * signalId + 100, signalId, openedAt: 1000 * signalId,
        direction: signalId % 2 ? 'buy' : 'sell', exitStop: 37900,
      });
    }
  } finally { db.close(); }
}

const cfgA = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

describe('履歴消去: signalId は単調増加(番号を再利用しない)', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jp225-sigclear-'));
    process.env.APPDATA = dir; process.env.HOME = dir; process.env.USERPROFILE = dir;
  });
  afterEach(() => {
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE'] as const) {
      if (ORIG[k] !== undefined) process.env[k] = ORIG[k]; else delete process.env[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('(1) 通し: シグナル3件 → クリア → さらに採番 で、クリア後の signalId がクリア前の最大より大きい', async () => {
    // ① 起動(ゼロからのシード)。
    const eng = new SignalEngine(cfgA);
    await eng.start();
    expect(eng._peekSignalIdCounter()).toBe(0);
    // ② ARM を3回(=signal_id 1,2,3 が signal_trades / signal_exit_stops に残る)。
    for (const id of [1, 2, 3]) armAndRecord(id);
    // 稼働中エンジンの in-memory も「3 まで採番して保有中」に合わせる(ARM は AI 応答が要るので状態を直接置く)。
    eng._setFilledForTest(
      { direction: 'buy', entryPrice: 38000, qty: 1, initialStop: 37950, peakProfit: 0, rationale: 'r', at: 3000 },
      { signalId: 3, at: 3000, direction: 'buy', rationale: 'r', limitEntry: 38000, stopLossForLimit: 37950 },
    );
    const dbBefore = openDb(resolveDbPath());
    const maxBefore = (dbBefore.prepare('SELECT MAX(signal_id) AS m FROM signal_trades').get() as { m: number }).m;
    dbBefore.close();
    expect(maxBefore).toBe(3);

    // ③ 実ルートで履歴消去(素の POST=system 未指定 → A 全消去)。
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesClearHandler({ query: {} } as any, res as any);
    const body = res.out.body as { ok: boolean; cleared: number; orphanExitStops: number; maxSignalIdBefore: number | null };
    expect(body.ok).toBe(true);
    expect(body.cleared).toBe(3);
    expect(body.orphanExitStops).toBe(3);          // exit-stop 3行は消えず、裏付けだけ失う(孤児)。
    expect(body.maxSignalIdBefore).toBe(3);

    // ④ 稼働中のエンジン(再起動なし)の採番も、永続カウンタも巻き戻っていない。
    //    (ルートが呼ぶ in-memory フックが signalId を触らないことは engine.test.ts 側でも直接検証している)
    expect(eng._peekSignalIdCounter()).toBe(3);
    eng.stop();
    const dbAfter = openDb(resolveDbPath());
    expect(getSignalIdCounter(dbAfter, 'A')).toBe(3);   // ★旧実装はここが 0 になった
    dbAfter.close();

    // ⑤ 再起動しても同じ(永続 + 記録 MAX からシード)。次の ARM は 4 = クリア前の最大より大きい。
    const eng2 = new SignalEngine(cfgA);
    await eng2.start();
    const nextId = eng2._peekSignalIdCounter() + 1;
    expect(nextId).toBeGreaterThan(maxBefore);     // ★旧実装ではここが 1 になり maxBefore=3 を下回った。
    eng2.stop();

    // ⑥ クリア後の ARM が既存の孤児 exit-stop と衝突しない(signal_id が一意のまま)。
    armAndRecord(nextId);
    const db = openDb(resolveDbPath());
    try {
      const dup = db.prepare(
        'SELECT signal_id, COUNT(DISTINCT opened_at) AS n FROM signal_exit_stops WHERE signal_id IS NOT NULL GROUP BY signal_id HAVING n > 1',
      ).all() as unknown[];
      expect(dup).toEqual([]);                     // ★実データで起きた「signal_id=1 が複数建玉」が発生しない。
    } finally { db.close(); }
  });

  it('(2) 永続値が 0 に潰れても、起動シードは signal_trades / signal_exit_stops の MAX から復元する', async () => {
    // 永続に失敗した(=console.warn だけで続行した)状況を再現: 記録は残っているが last_signal_id が 0。
    const db = openDb(resolveDbPath());
    insertSignalTrade(db, {
      entryT: 1, entryPrice: 38000, dir: 'buy', exitT: 2, exitPrice: 38010, pnl: 10, qty: 1, signalId: 42,
    });
    insertSignalExitStop(db, { t: 3, signalId: 57, openedAt: 2, direction: 'buy', exitStop: 37900 });
    setSignalIdCounter(db, 'A', 0);
    expect(getSignalIdCounter(db, 'A')).toBe(0);
    expect(getSignalIdSeed(db, 'A')).toBe(57);   // trades=42 / exit_stops=57 → 床は 57。
    db.close();

    const eng = new SignalEngine(cfgA);
    await eng.start();
    expect(eng._peekSignalIdCounter()).toBe(57);  // 0 ではなく 57 → 次の ARM は 58(既存記録を下回らない)。
    eng.stop();
  });

  // ★実データ(同期フォルダの signals_kabu.db: 804行・signal_id は 518 まで進んでいるのに last_signal_id=0)で
  //   見つかった穴: 床の根拠が「これから消す行」しか無い場合、消去と一緒に床も消えて 1 から採番し直してしまう。
  //   そのため消去は「消す前に永続カウンタを今の床まで引き上げる(ラチェット)」を行う。
  it('(2c) 永続値が 0 のまま全消去しても床は残る(消す前に永続へ焼き付ける)', () => {
    const db = openDb(resolveDbPath());
    try {
      for (const id of [1, 2, 518]) {
        insertSignalTrade(db, { entryT: id, entryPrice: 1, dir: 'buy', exitT: id + 1, exitPrice: 1, pnl: 0, qty: 1, signalId: id });
      }
      setSignalIdCounter(db, 'A', 0);            // 永続が壊れている/古い書き出し
      expect(getSignalIdSeed(db, 'A')).toBe(518);
      const r = clearSignalTradesAudited(db, { system: 'A' });
      expect(r.deleted).toBe(3);
      expect(getSignalIdCounter(db, 'A')).toBe(518);   // ★消去後も床が残る
      expect(getSignalIdSeed(db, 'A')).toBe(518);      // 次の採番は 519(1 に戻らない)
    } finally { db.close(); }
  });

  it('(2b) B 系統のシードは B のトレードのみを床にする(exit-stops は A だけが書くため巻き込まない)', () => {
    const db = openDb(resolveDbPath());
    try {
      insertSignalTrade(db, { entryT: 1, entryPrice: 1, dir: 'buy', exitT: 2, exitPrice: 1, pnl: 0, qty: 1, signalId: 900 });
      insertSignalExitStop(db, { t: 3, signalId: 950, openedAt: 2, direction: 'buy', exitStop: 1 });
      insertSignalTrade(db, { entryT: 1, entryPrice: 1, dir: 'buy', exitT: 2, exitPrice: 1, pnl: 0, qty: 1, system: 'B', signalId: 4 });
      expect(getSignalIdSeed(db, 'B')).toBe(4);
      expect(getSignalIdSeed(db, 'A')).toBe(950);
    } finally { db.close(); }
  });

  it('(3) 監査行が実 DB ファイルに残る(要求値=正規化前/後の両方・削除件数=実 changes・孤児件数)', () => {
    for (const id of [1, 2]) armAndRecord(id);
    armAndRecord(9, 'B');

    // 素の POST(system 未指定 → 'A' に正規化 → A 全消去)。
    const res = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesClearHandler({ query: {} } as any, res as any);

    const db = openDb(resolveDbPath());
    try {
      const rows = getSignalTradesClears(db);
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.system_requested).toBe(null);       // ★素の POST だったことが後から読める
      expect(r.system_effective).toBe('A');        // ★正規化後(=A 全消去だった)
      expect(r.deleted_trades).toBe(2);
      expect(r.max_signal_id_before).toBe(2);      // エポック境界
      expect(r.orphan_exit_stops).toBe(2);
      expect(r.t).toBeGreaterThan(0);
      // B は消えていない。
      expect((db.prepare('SELECT COUNT(*) AS n FROM signal_trades').get() as { n: number }).n).toBe(1);
    } finally { db.close(); }

    // 明示 ?system=B のクリアも別の1行として残る。
    const res2 = mockRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    signalTradesClearHandler({ query: { system: 'B' } } as any, res2 as any);
    const db2 = openDb(resolveDbPath());
    try {
      const rows = getSignalTradesClears(db2);
      expect(rows).toHaveLength(2);
      const b = rows.find(x => x.system_effective === 'B')!;
      expect(b.system_requested).toBe('B');
      expect(b.deleted_trades).toBe(1);
      expect(b.orphan_exit_stops).toBe(0);         // B は exit-stop を書かない
    } finally { db2.close(); }
  });

  it('(3b) 空の系統を消しても監査行は残る(0件の削除も「消した事実」として読める)', () => {
    const db = openDb(resolveDbPath());
    try {
      const r = clearSignalTradesAudited(db, { system: 'B', systemRequested: 'b', t: 1700000000000 });
      expect(r).toEqual({ deleted: 0, orphanExitStops: 0, maxSignalIdBefore: null });
      const rows = getSignalTradesClears(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.system_requested).toBe('b');
      expect(rows[0]!.system_effective).toBe('B');
      expect(rows[0]!.t).toBe(1700000000000);
    } finally { db.close(); }
  });

  it('(4) 監査テーブルが無い古いDBを開いても落ちず、後付けで作られて書ける(既存行は保持)', () => {
    // 監査テーブルを持たない旧スキーマの DB ファイルを手で作る(初期スキーマ相当)。
    mkdirSync(join(dir, 'jp225-monitor'), { recursive: true });
    const path = join(dir, 'jp225-monitor', 'jp225.db');
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE signal_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_t INTEGER NOT NULL, entry_price REAL NOT NULL, dir TEXT NOT NULL,
        exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
        qty INTEGER NOT NULL, rationale TEXT, meta TEXT
      );
      CREATE TABLE signal_exit_stops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t INTEGER NOT NULL, signal_id INTEGER, opened_at INTEGER NOT NULL,
        direction TEXT NOT NULL, exit_stop REAL NOT NULL, phase TEXT
      );
      CREATE TABLE signal_meta ( system TEXT PRIMARY KEY, last_signal_id INTEGER NOT NULL );
      INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty)
        VALUES (1, 38000, 'buy', 2, 38010, 10, 1);
    `);
    expect((old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='signal_trades_clears'").get() as { n: number }).n).toBe(0);
    old.close();

    // openDb(=initSchema)で後付け ALTER/CREATE。既存行は保持される。
    const db = openDb(path);
    try {
      expect((db.prepare('SELECT COUNT(*) AS n FROM signal_trades').get() as { n: number }).n).toBe(1);
      const r = clearSignalTradesAudited(db, { system: 'A', systemRequested: 'A' });
      expect(r.deleted).toBe(1);
      const rows = getSignalTradesClears(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.deleted_trades).toBe(1);
    } finally { db.close(); }
    // 2回目の open(=冪等)でも落ちず、監査行が残っている。
    const db2 = openDb(path);
    try { expect(getSignalTradesClears(db2)).toHaveLength(1); } finally { db2.close(); }
  });
});
