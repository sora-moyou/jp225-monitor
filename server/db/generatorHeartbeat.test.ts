import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema, getMeta } from './store.js';
import { openGeneratorDb, insertProposal, type ProposalRow, type GeneratorLedgerStatus } from './generatorStore.js';
import {
  GENERATOR_HEARTBEAT_KEY, GENERATOR_STATUS_KEY, GENERATOR_QUIET_STALE_MS, GENERATOR_HEARTBEAT_FRESH_MS,
  buildGeneratorHeartbeat, formatGeneratorStatus, writeGeneratorHeartbeat, readGeneratorHeartbeat,
  measureGeneratorHeartbeat, describeGenerator,
  type GeneratorHaltState, type GeneratorGateState,
} from './generatorHeartbeat.js';

// ─── ★B2: 書き出しから「生成器がどうなっているか」を判別できるようにする ────────────
//
// 何が壊れていたか(実売買PCの実書き出し):
//   別PCへ届く書き出しを見ても、生成器が
//     ・設定で無効なのか / ・有効だが前提検証で止まったのか / ・そもそも起動していないのか
//   が区別できなかった。台帳DBが無い=「1行も書いていない」しか分からず、**無効のときは台帳自体が
//   作られない** ので遠隔から診断できない。「観測できない」を「異常なし」と読み替える典型。
//
// ★否定対照(修正前 = git show HEAD:server/index.ts / このファイル自体が HEAD に無い):
//   共有DB(jp225.db)の meta に generator_heartbeat / generator_status が **1つも書かれない**。
//   → 下の「meta に入る」「VACUUM INTO で複製される」「describeGenerator が missing を返す」が赤。
//   実証手順: git show HEAD:server/index.ts > /tmp/old-index.ts で差し替え、実プロセスを起動しても
//   meta にキーが現れないことを確認する(実証は scratchpad の実プロセス実行で行った)。

const JST = 9 * 60 * 60_000;
const jst = (y: number, m: number, d: number, hh: number, mm: number): number =>
  Date.UTC(y, m - 1, d, hh, mm) - JST;

// 2026-06-03(水)は平日・休場日でない。
const IN_SESSION = jst(2026, 6, 3, 10, 0);
const OUT_SESSION = jst(2026, 6, 3, 16, 0);   // 15:45–17:00 の空白帯(場外)

const LEDGER_OK: GeneratorLedgerStatus = {
  available: true, lastRecordAt: IN_SESSION - 60_000, ageMin: 1,
  planLastHour: 25, inSessionLastHour: 30, today: [], total: 1234,
};
const HALT_OFF: GeneratorHaltState = {
  active: false, remainingSec: 0, untilAt: 0, provider: null, sessionKey: null,
  skipped: 0, ignored: 0, lastIgnored: null,
};
const GATE: GeneratorGateState = {
  dayKey: '2026-06-03', sessionKey: '2026-06-03|Day', budget: 800, used: 42, inFlight: 0,
  skipped: { busy: 1, budget: 0, defaultQuota: 0, disabled: 0 },
};

function build(over: Partial<Parameters<typeof buildGeneratorHeartbeat>[0]> = {}) {
  return buildGeneratorHeartbeat({
    now: IN_SESSION, enabled: true, ledger: LEDGER_OK, halt: HALT_OFF, gate: GATE, ...over,
  });
}

// ─────────────────────────────────────────────────────────
describe('★4つの状態が遠隔から判別できる(設定/プロセス/標本/従属停止)', () => {
  it('設定で無効 = disabled(「止まった」ではなく「止めてある」と読める)', () => {
    const hb = build({ enabled: false, ledger: { available: false, lastRecordAt: null, ageMin: null, today: [], total: 0 } });
    expect(hb.state).toBe('disabled');
    expect(hb.enabled).toBe(false);
    expect(hb.reason).toContain('無効');
  });

  it('★有効なのに台帳が無い = stalled(「無効」と区別できる。修正前はここが判別不能だった)', () => {
    const hb = build({ enabled: true, ledger: { available: false, lastRecordAt: null, ageMin: null, today: [], total: 0 } });
    expect(hb.state).toBe('stalled');
    expect(hb.enabled).toBe(true);
    expect(hb.reason).toContain('起動していない');
  });

  it('記録が10分以上途切れている = プロセスが居ない(見送りも2分ごとに記録されるはず)', () => {
    const hb = build({
      ledger: { ...LEDGER_OK, lastRecordAt: IN_SESSION - GENERATOR_QUIET_STALE_MS - 1 },
    });
    expect(hb.state).toBe('stalled');
    expect(hb.reason).toContain('沈黙');
  });

  it('前提検証で自ら停止した場合は台帳の理由がそのまま出る', () => {
    const hb = build({
      ledger: { ...LEDGER_OK, halt: { at: IN_SESSION, phase: 'preflight', reason: '生成器専用キーが未設定です' } },
    });
    expect(hb.state).toBe('stalled');
    expect(hb.reason).toContain('preflight');
    expect(hb.reason).toContain('専用キー');
  });

  it('★従属停止中は halted(残り時間と発火セッションまで読める)', () => {
    const hb = build({
      halt: {
        active: true, remainingSec: 1800, untilAt: IN_SESSION + 1_800_000, provider: 'gemini',
        sessionKey: '2026-06-03|Day', skipped: 12, ignored: 0, lastIgnored: null,
      },
    });
    expect(hb.state).toBe('halted');
    expect(hb.reason).toContain('1800秒');
    expect(hb.halt.skipped).toBe(12);
  });

  it('★専用キーで従属停止を見送っている状態が読める(なぜ止まっていないかを説明できる)', () => {
    const hb = build({
      halt: { ...HALT_OFF, ignored: 7, lastIgnored: { provider: 'gemini', source: 'own', at: IN_SESSION } },
    });
    expect(hb.state).toBe('ok');
    const line = formatGeneratorStatus(hb);
    expect(line).toContain('従属停止の見送り(専用キー)=7回');
    expect(line).toContain('出どころ=own');
  });

  it('取引時間外は idle(場外の0件を異常にしない=警告が読まれなくなるのを防ぐ)', () => {
    const hb = build({ now: OUT_SESSION, ledger: { ...LEDGER_OK, lastRecordAt: OUT_SESSION - 60_000, planLastHour: 0, inSessionLastHour: 0 } });
    expect(hb.state).toBe('idle');
    expect(hb.sessionOpen).toBe(false);
  });

  it('★取引時間内なのに直近1時間の標本が0件 = stalled(行が増えていても標本は溜まっていない)', () => {
    const hb = build({ ledger: { ...LEDGER_OK, planLastHour: 0, inSessionLastHour: 30 } });
    expect(hb.state).toBe('stalled');
    expect(hb.reason).toContain('0件');
  });

  it('正常に回っていれば ok(直近1時間の標本件数が出る)', () => {
    const hb = build();
    expect(hb.state).toBe('ok');
    expect(hb.reason).toContain('25');
  });

  it('人が読む1行に4点(設定/台帳の生死/標本/従属停止)が必ず載る', () => {
    const line = formatGeneratorStatus(build());
    expect(line).toContain('設定=有効');
    expect(line).toContain('台帳=有');
    expect(line).toContain('標本1h=25件');
    expect(line).toContain('従属停止=無し');
    // ★キーの値・決済の実数値は載らない。
    expect(line).not.toMatch(/AIza|sk-|gsk_/);
  });
});

// ─────────────────────────────────────────────────────────
describe('★どこに載せるか: 共有DB(jp225.db)の meta = 既存の書き出しに乗る', () => {
  let tmp = '';
  const ORIG: Record<string, string | undefined> = {};
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'genhb-'));
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'JP225_GENERATOR_DB', 'MONITOR_VARIANT']) ORIG[k] = process.env[k];
    process.env.APPDATA = tmp; process.env.HOME = tmp; process.env.USERPROFILE = tmp;
    process.env.JP225_GENERATOR_DB = join(tmp, 'generator_proposals.db');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('meta に JSON と1行サマリの2本で入る(ティック保管・台帳書き出しと同じ2キー構成)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const hb = writeGeneratorHeartbeat(db, IN_SESSION);
    expect(getMeta(db, GENERATOR_HEARTBEAT_KEY)).toBeTruthy();
    expect(getMeta(db, GENERATOR_STATUS_KEY)).toBe(formatGeneratorStatus(hb));
    // 台帳が無い環境 = 「この PC で1行も書いていない」が状態として残る。
    expect(hb.ledger.available).toBe(false);
    db.close();
  });

  it('★`VACUUM INTO`(trade2 の 30分スナップショットと同じ操作)で meta ごと複製される', () => {
    const srcPath = join(tmp, 'jp225.db');
    const snapPath = join(tmp, 'prices_test.db');
    const main = new DatabaseSync(srcPath);
    main.exec('PRAGMA journal_mode = WAL');
    initSchema(main);
    const hb = writeGeneratorHeartbeat(main, IN_SESSION);
    main.prepare('VACUUM INTO ?').run(snapPath);   // trade2 priceSnapshotWorker と同じ
    main.close();

    const snap = new DatabaseSync(snapPath);
    const copied = readGeneratorHeartbeat(snap);
    expect(copied).not.toBeNull();
    expect(copied!.at).toBe(hb.at);
    expect(copied!.enabled).toBe(hb.enabled);
    expect(getMeta(snap, GENERATOR_STATUS_KEY)).toBe(formatGeneratorStatus(hb));
    snap.close();
  });

  it('実台帳(実ファイル)を読んで標本件数が状態に乗る', () => {
    const path = process.env.JP225_GENERATOR_DB!;
    const led = openGeneratorDb(path);
    const row = (over: Partial<ProposalRow>): ProposalRow => ({
      epoch: 'g1:abc', cycleId: 'c-1', arm: 'current', exitVariant: 'current', seq: 0,
      sessionDate: '2026-06-03', requestedAt: IN_SESSION - 60_000, respondedAt: IN_SESSION, latencyMs: 1,
      status: 'plan', skipReason: null, httpStatus: 200, error: null,
      retried: 0, retryCount: 0, preRetryReason: null,
      direction: 'none', planJson: '{}', refPrice: 1, regime: null, confidence: null,
      noneReason: 'ai', noneLegsJson: null, vetoFired: 0, rangeAnomalyJson: null,
      shotId: null, shotAgeMs: null, shotOrigin: null, createdAt: IN_SESSION,
      ...over,
    });
    for (let i = 0; i < 5; i++) insertProposal(led, row({ cycleId: `c-${i}`, requestedAt: IN_SESSION - i * 120_000 }));
    led.close();

    const hb = measureGeneratorHeartbeat(IN_SESSION);
    expect(hb.ledger.available).toBe(true);
    expect(hb.ledger.planLastHour).toBe(5);
    expect(hb.quietMs).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────
describe('★読み手側: 「値が更新されない」を「正常」と誤読させない', () => {
  it('ハートビートが無い = missing(=修正前の状態。0件と観測不能を混同しない)', () => {
    const v = describeGenerator(null, IN_SESSION);
    expect(v.state).toBe('missing');
    expect(v.text).toContain('MISSING');
  });

  it('ハートビートが古い = stalled(monitor が動いていない疑い)', () => {
    const hb = build();
    const v = describeGenerator(hb, IN_SESSION + GENERATOR_HEARTBEAT_FRESH_MS + 1);
    expect(v.state).toBe('stalled');
    expect(v.text).toContain('monitor');
  });

  it('新しいハートビートはそのままの状態を返す', () => {
    const hb = build();
    expect(describeGenerator(hb, IN_SESSION + 1_000).state).toBe('ok');
  });

  it('壊れた JSON は「無い」扱い(次のハートビートで上書きされる)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run(GENERATOR_HEARTBEAT_KEY, '{壊れ');
    expect(readGeneratorHeartbeat(db)).toBeNull();
    db.close();
  });
});
