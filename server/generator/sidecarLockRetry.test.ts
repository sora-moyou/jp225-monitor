import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireGeneratorPidLock, describePidLockBlocked, PID_LOCK_RETRY_MS, GENERATOR_PID_FILE,
} from './sidecarRun.js';
import {
  installGeneratorFileLog, resolveGeneratorLogPath, _resetGeneratorFileLogForTest,
  GENERATOR_LOG_MAX_BYTES, GENERATOR_LOG_NAME, GENERATOR_LOG_TAG,
} from './sidecarLog.js';
import {
  resolveProcessLogPath, PROCESS_LOG_MAX_BYTES, processLogPath, _resetProcessFileLogForTest,
} from '../processLog.js';
import { ownImageName, type PidLockHolder } from '../pidLock.js';
import { GENERATOR_PID_LOCK_BLOCKED_MARK } from '../spawnLog.js';
import {
  pidLockBlockedFromSpawn, buildGeneratorHeartbeat, formatGeneratorStatus,
  type GeneratorHaltState, type GeneratorGateState,
} from '../db/generatorHeartbeat.js';
import type { GeneratorLedgerStatus } from '../db/generatorStore.js';

// ─── ★A-1: 規約を2か所に分けない ────────────────────────────────────────────────
//
// 何が壊れていたか: server/processLog.ts(コレクタ用)は「unhandledRejection に listener を
// 付けると Node 15+ の既定(=落ちる)が止まる。記録だけして生き残らせると『プロセスは生きているのに
// 何もしない』という、いちばん分かりにくい状態をこちらが作ってしまう」と書いたうえで exit(1) している。
// ところが同じリリースの server/generator/sidecarLog.ts は **その listener を付けて exit していなかった**。
// 生成器の名乗りは setInterval なので、本体の promise 連鎖が死んでも心拍だけ打ち続け、
// 共有DBは「生きている」と言い続ける = このリリースが解こうとしている誤診断そのものを製造できた。
//
// ★実プロセスでの実証(このユニットテストとは別に実施):
//   ・修正後 … unhandledRejection → 終了コード 1 で即死(心拍は1度も打たれない)
//   ・修正前 … 生き残って心拍を打ち続ける(3秒後も生存)
//   否定対照は「修正前の sidecarLog.ts をそのまま別ファイルとして置いて実行」で取った
//   (このファイル群は未コミットなので `git show HEAD:` では取れない)。

describe('★A-1 生成器のログは processLog の薄い包み(規約が1か所)', () => {
  let dir = '';
  const ORIG: Record<string, string | undefined> = {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'genlog-'));
    for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'JP225_TICK_EXPORT_DIR']) ORIG[k] = process.env[k];
    process.env.APPDATA = dir; process.env.HOME = dir; process.env.USERPROFILE = dir;
    delete process.env.JP225_TICK_EXPORT_DIR;
    _resetGeneratorFileLogForTest();
  });
  afterEach(() => {
    _resetProcessFileLogForTest();
    for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('置き場所も上限も一般形と同一(2つの規則が別々に育たない)', () => {
    expect(resolveGeneratorLogPath()).toBe(resolveProcessLogPath(GENERATOR_LOG_NAME));
    expect(GENERATOR_LOG_MAX_BYTES).toBe(PROCESS_LOG_MAX_BYTES);
  });

  it('★unhandledRejection の listener を「付けたら落とす」規約ごと引き継ぐ', () => {
    const before = process.listenerCount('unhandledRejection');
    const r = installGeneratorFileLog();
    expect(r.ok).toBe(true);
    // 一般形が付ける listener がそのまま付く(= exit(1) する実装が使われている)。
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    const added = process.listeners('unhandledRejection').at(-1)!;
    expect(String(added)).toContain('process.exit(1)');
    process.off('unhandledRejection', added as never);
    // 冪等: 状態も一般形と共有している(2重に横取りしない)。
    expect(processLogPath()).toBe(r.path);
    _resetGeneratorFileLogForTest();
    expect(processLogPath()).toBeNull();
  });

  it('名札は生成器のもの(コレクタと取り違えない)', () => {
    expect(GENERATOR_LOG_TAG).toBe('generator-sidecar');
  });
});

// ─── ★A-2: ロックが取れなくても終端しない ──────────────────────────────────────
//
// 何が壊れていたか: 取れないと `return` = **恒久終了**。しかも失敗は名乗り
// (startSidecarHeartbeat)より前に起きるので meta に何も残らず、別PCからは
// 「起動していない疑い」としか読めなかった。
// ★ロックの目的(2本走らせない)は緩めない: 取れるまで **待つ** だけで走り出しはしない。

const holder = (over: Partial<PidLockHolder> = {}): PidLockHolder => ({
  path: 'C:/x/generator.pid', pid: 1234,
  probe: { ok: true, image: 'jp225-generator.exe' },
  expectedImage: 'jp225-generator.exe', ...over,
});

describe('★A-2 ロックが取れないときの振る舞い', () => {
  it('取れるまで待ち、取れたら走り出す(恒久終了しない)', async () => {
    let attempts = 0;
    const lines: string[] = [];
    const tries = await acquireGeneratorPidLock({
      acquire: () => { attempts += 1; return attempts > 3; },
      inspect: () => holder(),
      retryMs: 1,
      report: l => lines.push(l),
      wait: async () => { /* 即座に次の判定へ */ },
    });
    expect(tries).toBe(3);
    expect(attempts).toBe(4);
    // ★共用ログは最初の1回 + 復帰の1回だけ(毎分積み上げて他プロセスの記録を押し流さない)。
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(GENERATOR_PID_LOCK_BLOCKED_MARK);
    expect(lines[1]).toContain('起動を再開しました');
  });

  it('最初から取れたら1行も書かない(雑音を出さない)', async () => {
    const lines: string[] = [];
    const tries = await acquireGeneratorPidLock({
      acquire: () => true, inspect: () => holder(), report: l => lines.push(l), wait: async () => {},
    });
    expect(tries).toBe(0);
    expect(lines).toEqual([]);
  });

  it('理由に「誰が保持しているか」「イメージ名を照合できたか」が入る', () => {
    const line = describePidLockBlocked(holder(), PID_LOCK_RETRY_MS);
    expect(line).toContain('pid=1234');
    expect(line).toContain('イメージ=jp225-generator.exe');
    expect(line).toContain('終了はしません');
  });

  it('★イメージ名を照合できなかったことも隠さない(判定材料が無いと分かる)', () => {
    const line = describePidLockBlocked(holder({ probe: { ok: false, error: 'tasklist は Windows のみ' } }));
    expect(line).toContain('イメージ照合=できず');
    expect(line).toContain('kill(pid,0)');
  });

  it('照合対象は自分自身の実行ファイル名(同じバイナリだけが自分のロックを持ちうる)', () => {
    expect(describePidLockBlocked(holder({ expectedImage: ownImageName() })))
      .toContain(`照合対象=${ownImageName()}`);
  });

  it('pid ファイル名は collector と同じ流儀の単純名', () => {
    expect(GENERATOR_PID_FILE).toBe('generator.pid');
  });
});

// ─── ★A-2: 理由が meta に載る(別PCから読める) ────────────────────────────────
//
// ロック待ちの生成器は共有DBに **名乗らない**(名乗ると実際に走っている本体の名乗りを30秒ごとに
// 上書きし、pid が交互に入れ替わって遠隔からはかえって読めなくなる)。
// 代わりに、Rust が spawn の成否を書いている共用ログへ1行出す。それは monitor が既に
// meta(generator_heartbeat.spawn / generator_status)へ運んでいる = 新しい配管を作らない。

describe('★A-2 保留の理由が monitor 側の状態として読める', () => {
  const LEDGER_NONE: GeneratorLedgerStatus = { available: false, lastRecordAt: null, ageMin: null, today: [], total: 0 };
  const HALT: GeneratorHaltState = {
    active: false, remainingSec: 0, untilAt: 0, provider: null, sessionKey: null,
    skipped: 0, ignored: 0, lastIgnored: null,
  };
  const GATE: GeneratorGateState = {
    dayKey: 'd', sessionKey: 's', budget: 800, used: 0, inFlight: 0,
    skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 },
  };
  const NOW = Date.UTC(2026, 5, 3, 1, 0);
  const hb = (lines: string[]) => buildGeneratorHeartbeat({
    now: NOW, enabled: true, ledger: LEDGER_NONE, halt: HALT, gate: GATE,
    spawn: { path: 'C:/x/sidecar-spawn.log', lines },
  });

  it('保留中は「起動していない疑い」ではなく「起動を保留中」と言い分ける', () => {
    const h = hb([
      '1 [generator] spawned pid=99',
      `2 [generator] ★${GENERATOR_PID_LOCK_BLOCKED_MARK}: 保持者 pid=1234`,
    ]);
    expect(h.state).toBe('stalled');
    expect(h.reason).toContain('起動を保留中');
    expect(formatGeneratorStatus(h)).toContain(GENERATOR_PID_LOCK_BLOCKED_MARK);
  });

  it('★復帰すると自動的に「保留中」ではなくなる(古い行が残っていても誤報にしない)', () => {
    const h = hb([
      `1 [generator] ★${GENERATOR_PID_LOCK_BLOCKED_MARK}: 保持者 pid=1234`,
      '2 [generator] 起動を再開しました: pid ロックを取得(保留 3 回)',
    ]);
    expect(h.reason).not.toContain('起動を保留中');
    expect(h.reason).toContain('起動していない');
  });

  it('生成器以外の行(collector など)には引きずられない', () => {
    expect(pidLockBlockedFromSpawn([
      `1 [generator] ★${GENERATOR_PID_LOCK_BLOCKED_MARK}`,
      '2 [collector] spawned pid=7',
    ])).not.toBeNull();
    expect(pidLockBlockedFromSpawn(['1 [collector] spawned pid=7'])).toBeNull();
    expect(pidLockBlockedFromSpawn([])).toBeNull();
  });
});

// ★ロックファイルの中身は従来どおり(既存の読み手を巻き添えにしない)ことは
//   server/pidLockImage.test.ts で固定している。
describe('参考: ロックの置き場所', () => {
  it('pid ファイルの置き場は collector と同じフォルダ', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genlock-'));
    const saved = process.env.APPDATA;
    process.env.APPDATA = dir;
    try {
      writeFileSync(join(dir, 'dummy'), 'x');
      expect(GENERATOR_PID_FILE.endsWith('.pid')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
