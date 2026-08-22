import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initSchema, insertSignalPlan, insertSignalTrade, setBuildIdentityMeta, getMeta,
  BUILD_IDENTITY_KEY, BUILD_IDENTITY_STATUS_KEY,
} from './store.js';
import { initGeneratorSchema, insertProposal, type ProposalRow } from './generatorStore.js';
import { APP_VERSION } from '../appVersion.js';
import { resetPromptBuildForTest, publishPromptBuilds } from '../buildIdentity.js';

// ★記録専用(ADD-ONLY・v0.9.93): app_version / prompt_build の2列。
//
// ■ なぜ要るか(実際に解析が誤った)
//   書き出しから「どの版のシグナルか」が分からず、collector_status_<host>.txt の起動ログの時刻や
//   「機能列(direction_why 等)がいつ初めて埋まったか」からの **間接推定** に頼るしかなかった。
//   切り分けの定数を2時間ずらして誤った結論を出しかけている。版が記録に無いことが解析の誤りに直結した。
//
// ■ 2列に分ける理由(片方では足りない)
//   app_version  … chore リリースでも上がる/開発中は上がらないことがある
//   prompt_build … 固定の合成コンテキストで描いた **文面** の指紋(pb1)。データでは動かず、
//                  文面が変われば必ず動き、腕ごとに違う値になる。
//
// ■ このテストが固定する不変条件
//   ① 旧スキーマ(列なし)に **冪等 ALTER** が通る(2回走らせても壊れない)
//   ② 旧行は NULL のまま(遡って捏造しない)
//   ③ 新しい行には **実際に値が入る**(呼び出し側が渡さなくても既定で埋まる)
//   ④ pb1 が未登録のプロセス(collector 等)では prompt_build は NULL(0 や '' を捏造しない)
//   ⑤ meta にも1行(台帳の行が1つも無い日でも版が読める)
// ★検知・採否・価格・決済には一切関与しない(列が増えるだけ)。

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
  resetPromptBuildForTest();
});
beforeEach(() => resetPromptBuildForTest());

function tmpFile(name: string): string {
  if (!dir) dir = mkdtempSync(join(tmpdir(), 'jp225-build-id-'));
  return join(dir, name);
}
const cols = (db: DatabaseSync, t: string): string[] =>
  (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(c => c.name);

/** v0.9.92 相当(= 新列を持たない)共有DBを手で作る。 */
function oldSharedDb(): DatabaseSync {
  const db = new DatabaseSync(tmpFile('jp225-old.db'));
  db.exec(`
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, system TEXT NOT NULL,
      signal_id INTEGER, direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
      regime TEXT, confidence REAL, limit_entry REAL, stop_entry REAL,
      stop_loss_for_limit REAL, stop_loss_for_stop REAL, leg_drops_json TEXT, settings_json TEXT,
      rationale TEXT, error TEXT
    );
    CREATE TABLE signal_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, entry_t INTEGER NOT NULL, entry_price REAL NOT NULL,
      dir TEXT NOT NULL, exit_t INTEGER NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL,
      qty INTEGER NOT NULL, rationale TEXT, meta TEXT
    );
  `);
  db.prepare('INSERT INTO signal_plans (t, system, direction) VALUES (?,?,?)').run(1, 'A', 'buy');
  db.prepare('INSERT INTO signal_trades (entry_t, entry_price, dir, exit_t, exit_price, pnl, qty) VALUES (?,?,?,?,?,?,?)')
    .run(1, 100, 'buy', 2, 110, 10, 1);
  return db;
}

describe('signal_plans / signal_trades: app_version / prompt_build(実ファイル SQLite)', () => {
  it('① 旧スキーマに冪等 ALTER が通る(2回走らせても壊れない)', () => {
    const db = oldSharedDb();
    expect(cols(db, 'signal_plans')).not.toContain('app_version');
    expect(cols(db, 'signal_trades')).not.toContain('app_version');
    initSchema(db);
    initSchema(db);   // ★2回目=冪等
    for (const t of ['signal_plans', 'signal_trades']) {
      expect(cols(db, t), `${t} に app_version が無い`).toContain('app_version');
      expect(cols(db, t), `${t} に prompt_build が無い`).toContain('prompt_build');
    }
    db.close();
  });

  it('②③ 旧行は NULL のまま / 新しい行には実際に値が入る', () => {
    const db = oldSharedDb();
    initSchema(db);
    publishPromptBuilds({ v1: 'pb1:0123456789abcdef' }, 'v1');
    insertSignalPlan(db, { t: 3, system: 'A', direction: 'buy' });
    insertSignalTrade(db, { entryT: 3, entryPrice: 100, dir: 'buy', exitT: 4, exitPrice: 120, pnl: 20, qty: 1 });
    for (const t of ['signal_plans', 'signal_trades']) {
      const rows = db.prepare(`SELECT app_version, prompt_build FROM ${t} ORDER BY id`).all() as Array<Record<string, unknown>>;
      expect(rows, `${t} は2行`).toHaveLength(2);
      expect(rows[0], `${t}: 旧行は NULL のまま`).toEqual({ app_version: null, prompt_build: null });
      expect(rows[1]).toEqual({ app_version: APP_VERSION, prompt_build: 'pb1:0123456789abcdef' });
    }
    db.close();
  });

  it('④ pb1 が未登録のプロセスでは prompt_build は NULL(捏造しない)。版は入る', () => {
    const db = oldSharedDb();
    initSchema(db);
    // publish しない = collector など「プロンプトを組まない側」のプロセス。
    insertSignalPlan(db, { t: 3, system: 'A' });
    insertSignalTrade(db, { entryT: 3, entryPrice: 100, dir: 'buy', exitT: 4, exitPrice: 120, pnl: 20, qty: 1 });
    for (const t of ['signal_plans', 'signal_trades']) {
      const r = db.prepare(`SELECT app_version, prompt_build FROM ${t} ORDER BY id DESC LIMIT 1`).get() as Record<string, unknown>;
      expect(r.app_version, `${t}: 版は常に入る`).toBe(APP_VERSION);
      expect(r.prompt_build, `${t}: 未登録なら NULL`).toBeNull();
    }
    db.close();
  });

  it('★呼び出し側が明示した値が優先される(既定で上書きしない)', () => {
    const db = oldSharedDb();
    initSchema(db);
    publishPromptBuilds({ v1: 'pb1:aaaaaaaaaaaaaaaa' }, 'v1');
    insertSignalPlan(db, { t: 5, system: 'A', appVersion: '9.9.9', promptBuild: 'pb1:bbbbbbbbbbbbbbbb' });
    const r = db.prepare('SELECT app_version, prompt_build FROM signal_plans ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
    expect(r).toEqual({ app_version: '9.9.9', prompt_build: 'pb1:bbbbbbbbbbbbbbbb' });
    db.close();
  });

  it('⑤ meta にも1行(行が1つも無くても版が読める)', () => {
    const db = new DatabaseSync(tmpFile('jp225-meta.db'));
    initSchema(db);
    setBuildIdentityMeta(db, {
      appVersion: '1.2.3',
      promptBuilds: { v1: 'pb1:1111111111111111', v1f: 'pb1:2222222222222222' },
      at: Date.parse('2026-08-20T00:00:00Z'),
    });
    expect(JSON.parse(getMeta(db, BUILD_IDENTITY_KEY) ?? '{}')).toEqual({
      appVersion: '1.2.3',
      promptBuilds: { v1: 'pb1:1111111111111111', v1f: 'pb1:2222222222222222' },
      at: Date.parse('2026-08-20T00:00:00Z'),
    });
    const line = getMeta(db, BUILD_IDENTITY_STATUS_KEY) ?? '';
    expect(line).toContain('v1.2.3');
    expect(line).toContain('v1=pb1:1111111111111111');
    expect(line).toContain('v1f=pb1:2222222222222222');
    db.close();
  });

  // ★段5: A/B 分割の実行時状態(measurement discontinuity)を meta に載せる。
  it('★段5: planSplit(A/B 分割の実行時状態)が meta の JSON と人が読む1行の両方に載る', () => {
    const db = new DatabaseSync(tmpFile('jp225-meta-split.db'));
    initSchema(db);
    setBuildIdentityMeta(db, {
      appVersion: '1.2.3',
      promptBuilds: { v1: 'pb1:1111111111111111' },
      at: Date.parse('2026-08-22T00:00:00Z'),
      planSplit: {
        enabled: true,
        aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa',
        bPromptBuilds: { buy: 'pb1:bbbbbbbbbbbbbbbb', sell: 'pb1:cccccccccccccccc' },
      },
    });
    expect(JSON.parse(getMeta(db, BUILD_IDENTITY_KEY) ?? '{}')).toMatchObject({
      planSplit: {
        enabled: true, aPromptBuild: 'pb1:aaaaaaaaaaaaaaaa',
        bPromptBuilds: { buy: 'pb1:bbbbbbbbbbbbbbbb', sell: 'pb1:cccccccccccccccc' },
      },
    });
    expect(getMeta(db, BUILD_IDENTITY_STATUS_KEY) ?? '').toContain('planSplit=on');
    db.close();
  });

  it('★段5: planSplit を渡さない既存呼び出しは JSON にキーが増えない(後方互換)', () => {
    const db = new DatabaseSync(tmpFile('jp225-meta-nosplit.db'));
    initSchema(db);
    setBuildIdentityMeta(db, {
      appVersion: '1.2.3', promptBuilds: { v1: 'pb1:1111111111111111' },
      at: Date.parse('2026-08-22T00:00:00Z'),
    });
    const parsed = JSON.parse(getMeta(db, BUILD_IDENTITY_KEY) ?? '{}');
    expect(Object.keys(parsed).sort()).toEqual(['appVersion', 'at', 'promptBuilds']);
    expect(getMeta(db, BUILD_IDENTITY_STATUS_KEY) ?? '').not.toContain('planSplit');
    db.close();
  });
});

describe('proposals: app_version / prompt_build(実ファイル SQLite)', () => {
  /** v0.9.92 相当(= 新列を持たない)分析用DBを手で作る。 */
  function oldGenDb(): DatabaseSync {
    const db = new DatabaseSync(tmpFile('gen-old.db'));
    db.exec(`
      CREATE TABLE proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, epoch TEXT NOT NULL, cycle_id TEXT NOT NULL,
        arm TEXT NOT NULL, exit_variant TEXT NOT NULL, seq INTEGER NOT NULL, session_date TEXT,
        requested_at INTEGER NOT NULL, responded_at INTEGER, latency_ms INTEGER, status TEXT NOT NULL,
        skip_reason TEXT, http_status INTEGER, error TEXT, retried INTEGER NOT NULL,
        retry_count INTEGER NOT NULL, pre_retry_reason TEXT, direction TEXT, plan_json TEXT,
        ref_price REAL, regime TEXT, confidence REAL, none_reason TEXT, none_legs_json TEXT,
        veto_fired INTEGER, range_anomaly_json TEXT, shot_id TEXT, shot_age_ms INTEGER,
        shot_origin TEXT, created_at INTEGER NOT NULL,
        UNIQUE (epoch, cycle_id, arm)
      );
    `);
    db.prepare('INSERT INTO proposals (epoch,cycle_id,arm,exit_variant,seq,requested_at,status,retried,retry_count,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('e0', 'c0', 'current', 'current', 0, 1, 'plan', 0, 0, 1);
    return db;
  }

  const row = (over: Partial<ProposalRow>): ProposalRow => ({
    epoch: 'e1', cycleId: 'c1', arm: 'prompt-v1f', exitVariant: 'current', promptVariant: 'v1f', seq: 1,
    sessionDate: '2026-08-20', requestedAt: 10, respondedAt: 11, latencyMs: 1, status: 'plan',
    skipReason: null, httpStatus: 200, error: null, retried: 0, retryCount: 0, preRetryReason: null,
    direction: 'buy', planJson: '{}', refPrice: 1, regime: null, confidence: null,
    noneReason: null, noneLegsJson: null, vetoFired: null, rangeAnomalyJson: null,
    shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: 12, ...over,
  } as ProposalRow);

  it('① 旧スキーマに冪等 ALTER が通る / ② 旧行は NULL のまま / ③ 新しい行に値が入る', () => {
    const db = oldGenDb();
    expect(cols(db, 'proposals')).not.toContain('app_version');
    initGeneratorSchema(db);
    initGeneratorSchema(db);   // ★2回目=冪等
    expect(cols(db, 'proposals')).toContain('app_version');
    expect(cols(db, 'proposals')).toContain('prompt_build');

    insertProposal(db, row({ appVersion: '0.9.93', promptBuild: 'pb1:cddacd2e3148880c' }));
    const rows = db.prepare('SELECT arm, app_version, prompt_build FROM proposals ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({ arm: 'current', app_version: null, prompt_build: null });
    expect(rows[1]).toEqual({ arm: 'prompt-v1f', app_version: '0.9.93', prompt_build: 'pb1:cddacd2e3148880c' });
    db.close();
  });

  it('★monitor がエコーしなかった回は NULL(分析用プロセス自身の版で埋めない)', () => {
    const db = oldGenDb();
    initGeneratorSchema(db);
    // ★ここが要点: proposals.app_version は **monitor の版**。エコーが無ければ「分からない」を残す。
    insertProposal(db, row({ cycleId: 'c2', appVersion: null, promptBuild: null }));
    const r = db.prepare("SELECT app_version, prompt_build FROM proposals WHERE cycle_id='c2'").get() as Record<string, unknown>;
    expect(r).toEqual({ app_version: null, prompt_build: null });
    db.close();
  });
});
