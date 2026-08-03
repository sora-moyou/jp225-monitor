import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initSchema } from '../db/store.js';
import {
  installGeneratorFileLog, resolveGeneratorLogPath, appendGeneratorLog, rotateGeneratorLog,
  generatorLogPath, _resetGeneratorFileLogForTest, GENERATOR_LOG_MAX_BYTES,
} from './sidecarLog.js';
import { isRetryableHalt } from './sidecarRun.js';
import { readSpawnLogTail, resolveSpawnLogPath } from '../spawnLog.js';
import {
  writeGeneratorSidecarState, readGeneratorSidecarState, viewGeneratorSidecar,
  buildGeneratorHeartbeat, formatGeneratorStatus, GENERATOR_SIDECAR_FRESH_MS,
  type GeneratorSidecarState, type GeneratorHaltState, type GeneratorGateState,
} from '../db/generatorHeartbeat.js';
import type { GeneratorLedgerStatus } from '../db/generatorStore.js';

// ─── ★バグ究明のための書き出し(生成器が「なぜ動いていないか」を別PCから読む) ────────
//
// 何が行き詰まっていたか(実売買PC・monitor2 full v0.9.53):
//   ・「提案生成器を動かす」は有効・専用キーも4プロバイダ設定済み
//   ・それでも台帳(generator_proposals.db)が1行も作られていない
//   ・生成器の出力は Rust のコンソール止まりで、同期フォルダには1行も届かない
//   → 「動いていない」ことしか分からず、「なぜ」を見る手段がゼロだった。
//
// ★否定対照(修正前 = git show HEAD:server/generator/sidecar.ts / HEAD:src-tauri/src/lib.rs):
//   ファイルログもサイドカーの名乗りも spawn 記録も **存在しない**(このファイルの import が解決しない)。
//   実証は「HEAD の sidecar.ts に差し替えて実プロセスを起動 → ログファイルが作られない」で行った。

const NOW = Date.UTC(2026, 5, 3, 1, 0);   // 2026-06-03 10:00 JST(Day セッション)

let tmp = '';
const ORIG: Record<string, string | undefined> = {};
const ORIG_CONSOLE = { log: console.log, warn: console.warn, error: console.error };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gendiag-'));
  for (const k of ['APPDATA', 'HOME', 'USERPROFILE', 'JP225_TICK_EXPORT_DIR']) ORIG[k] = process.env[k];
  process.env.APPDATA = tmp; process.env.HOME = tmp; process.env.USERPROFILE = tmp;
  delete process.env.JP225_TICK_EXPORT_DIR;
  _resetGeneratorFileLogForTest();
});
afterEach(() => {
  console.log = ORIG_CONSOLE.log; console.warn = ORIG_CONSOLE.warn; console.error = ORIG_CONSOLE.error;
  _resetGeneratorFileLogForTest();
  for (const [k, v] of Object.entries(ORIG)) { if (v !== undefined) process.env[k] = v; else delete process.env[k]; }
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─────────────────────────────────────────────────────────
describe('★① 生成器が自分のログをファイルに書く(コンソール止まりをやめる)', () => {
  it('書き出しフォルダが設定されていれば、そこへ generator_<host>.log を置く(既存の同期に乗る)', () => {
    const dir = join(tmp, 'trade');
    mkdirSync(dir, { recursive: true });
    process.env.JP225_TICK_EXPORT_DIR = dir;
    const p = resolveGeneratorLogPath();
    expect(p.startsWith(dir)).toBe(true);
    expect(p).toMatch(/generator_.*\.log$/);
  });

  it('書き出しフォルダが未設定でも **台帳と同じフォルダ** に残す(何も残らない状況を作らない)', () => {
    const p = resolveGeneratorLogPath();
    expect(p).toBe(join(tmp, 'jp225-monitor', 'generator.log'));
  });

  it('★起動直後に1行書く=前提検証で即終了しても痕跡が残る', () => {
    const r = installGeneratorFileLog(NOW);
    expect(r.ok).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf-8')).toContain('起動 pid=');
    expect(generatorLogPath()).toBe(r.path);
  });

  it('console.log/warn/error がファイルにも落ちる(元の出力も従来どおり呼ばれる)', () => {
    // ★元の console を横取り前に差し替えておき、「元が呼ばれたか」を直接見る。
    let echoed = '';
    console.log = ((...a: unknown[]) => { echoed += a.join(' '); }) as typeof console.log;
    const r = installGeneratorFileLog(NOW);
    console.log('[generator] 前提OK: 決済実装=private');
    expect(echoed).toContain('前提OK');   // = コンソール側の出力は消えていない
    console.error('[generator] ★起動しません: 到達できません');
    const text = readFileSync(r.path, 'utf-8');
    expect(text).toContain('前提OK');
    expect(text).toContain('★起動しません');
  });

  it('大きくなったら1世代だけ退避する(同期フォルダを太らせない)', () => {
    const p = join(tmp, 'big.log');
    writeFileSync(p, 'x'.repeat(GENERATOR_LOG_MAX_BYTES + 10));
    rotateGeneratorLog(p);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(existsSync(p)).toBe(false);
    appendGeneratorLog(p, 'new');
    expect(readFileSync(p, 'utf-8')).toContain('new');
  });

  it('書けない場所でも例外を投げない(ログのために生成器を落とさない)', () => {
    expect(() => appendGeneratorLog('', 'x')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────
describe('★② サイドカー自身の名乗り(「居るのか」を台帳と別に読む)', () => {
  const state = (over: Partial<GeneratorSidecarState> = {}): GeneratorSidecarState => ({
    v: 1, at: NOW, atJst: '', pid: 4242, phase: 'running', enabled: true, variant: 'full',
    logPath: 'C:/x/generator_kabu.log', ledgerPath: 'C:/x/generator_proposals.db',
    monitorUrl: 'http://127.0.0.1:3000', lastCycleAt: NOW - 60_000,
    lastPreflight: { at: NOW - 120_000, ok: true }, halt: null, lastReplay: null, ...over,
  });

  it('meta に書いて読める(共有DB=30分スナップショットに乗る経路)', () => {
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    writeGeneratorSidecarState(db, state());
    const back = readGeneratorSidecarState(db);
    expect(back?.pid).toBe(4242);
    expect(back?.phase).toBe('running');
    db.close();
  });

  it('鮮度で「生きている」を判定する(古い名乗りを生存と読まない)', () => {
    expect(viewGeneratorSidecar(state(), NOW + 1_000).alive).toBe(true);
    expect(viewGeneratorSidecar(state(), NOW + GENERATOR_SIDECAR_FRESH_MS + 1).alive).toBe(false);
    expect(viewGeneratorSidecar(null, NOW).present).toBe(false);
  });

  const LEDGER_NONE: GeneratorLedgerStatus = {
    available: false, lastRecordAt: null, ageMin: null, today: [], total: 0,
  };
  const HALT: GeneratorHaltState = {
    active: false, remainingSec: 0, untilAt: 0, provider: null, sessionKey: null,
    skipped: 0, ignored: 0, lastIgnored: null,
  };
  const GATE: GeneratorGateState = {
    dayKey: 'd', sessionKey: 's', budget: 800, used: 0, inFlight: 0,
    skipped: { busy: 0, budget: 0, defaultQuota: 0, disabled: 0 },
  };
  const hb = (over: Partial<Parameters<typeof buildGeneratorHeartbeat>[0]>) => buildGeneratorHeartbeat({
    now: NOW, enabled: true, ledger: LEDGER_NONE, halt: HALT, gate: GATE, ...over,
  });

  it('★有効・名乗り無し・台帳無し = 「プロセスが起動していない疑い」と言い切れる(実売買PCの症状)', () => {
    const h = hb({});
    expect(h.state).toBe('stalled');
    expect(h.reason).toContain('起動していない');
    expect(h.reason).toContain('spawn');
  });

  it('★有効なのにサイドカーは待機中 = 設定の読み先が食い違っている疑いを名指しする', () => {
    const h = hb({ sidecar: viewGeneratorSidecar(state({ phase: 'waiting', enabled: false }), NOW) });
    expect(h.state).toBe('stalled');
    expect(h.reason).toContain('食い違');
  });

  it('サイドカーが「自ら停止」と名乗っていれば、その理由がそのまま出る', () => {
    const h = hb({
      sidecar: viewGeneratorSidecar(state({
        phase: 'halted', halt: { at: NOW, phase: '起動しません', reason: 'monitor に到達できません: fetch failed' },
      }), NOW),
    });
    expect(h.state).toBe('stalled');
    expect(h.reason).toContain('到達できません');
  });

  it('名乗りが生きていれば「台帳がまだ無い」も別の理由として読める(混同しない)', () => {
    const h = hb({ sidecar: viewGeneratorSidecar(state({ phase: 'running' }), NOW) });
    expect(h.state).toBe('stalled');
    expect(h.reason).toContain('プロセスは生きているが台帳がまだ無い');
  });

  it('★1行サマリに「どこを見ればよいか」が載る(ログ・接続先・前提検証・キーの出どころ・spawn)', () => {
    const line = formatGeneratorStatus(hb({
      sidecar: viewGeneratorSidecar(state({
        lastPreflight: { at: NOW, ok: false, kind: 'unreachable', reason: 'monitor に到達できません' },
        lastReplay: { at: NOW - 3_600_000, code: 0, sec: 7 },
      }), NOW),
      keySources: { gemini: 'own', groq: 'own', openai: 'own', kimi: 'shared' },
      spawn: { path: 'C:/x/sidecar-spawn.log', lines: ['1 [generator] spawned pid=99'] },
      ledgerPath: 'C:/x/generator_proposals.db',
    }));
    expect(line).toContain('pid=4242');
    expect(line).toContain('ログ=C:/x/generator_kabu.log');
    expect(line).toContain('接続先=http://127.0.0.1:3000');
    expect(line).toContain('前提検証=NG(unreachable)');
    expect(line).toContain('再生=');
    expect(line).toContain('生成器キーの出どころ=gemini=own groq=own openai=own kimi=shared');
    expect(line).toContain('spawned pid=99');
    // ★キーの値は絶対に出さない。
    expect(line).not.toMatch(/AIza|sk-|gsk_/);
  });
});

// ─────────────────────────────────────────────────────────
describe('★④ 起動順序で永久停止しない(monitor と同時 spawn される事実に合わせる)', () => {
  // 何が壊れていたか: サイドカーは monitor 本体と同時に spawn されるので、monitor の HTTP が
  // 待ち受ける前に前提検証が走ると 'unreachable' で止まり、**設定を無効→有効に切り替えるまで
  // 永久に待機** していた。ユーザーは何もしていないのに、起動のたびに生成器だけが死にうる。
  // ★'violated'(前提が崩れた)は従来どおり止める=測っていない標本を溜め続けない。
  it('到達できない(unreachable)は再試行する理由になる', () => {
    expect(isRetryableHalt({ ok: false, kind: 'unreachable' })).toBe(true);
  });
  it('前提が崩れた(violated)は再試行しない(従来どおり止める)', () => {
    expect(isRetryableHalt({ ok: false, kind: 'violated' })).toBe(false);
  });
  it('前提検証を通っている/記録が無い場合は再試行対象ではない', () => {
    expect(isRetryableHalt({ ok: true })).toBe(false);
    expect(isRetryableHalt(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
describe('★③ Rust が spawn できたかを残す(TS はそれを読むだけ)', () => {
  it('末尾数行を読む。ファイルが無ければ空(「観測できない」を「無事」と読まない)', () => {
    const p = resolveSpawnLogPath();
    expect(p).toBe(join(tmp, 'jp225-monitor', 'sidecar-spawn.log'));
    expect(readSpawnLogTail(p)).toEqual([]);

    mkdirSync(join(tmp, 'jp225-monitor'), { recursive: true });
    writeFileSync(p, ['1 [collector] spawned pid=1', '2 [generator] spawn failed: x', ''].join('\n'));
    expect(readSpawnLogTail(p)).toEqual(['1 [collector] spawned pid=1', '2 [generator] spawn failed: x']);
    expect(readSpawnLogTail(p, 1)).toEqual(['2 [generator] spawn failed: x']);
  });
});
