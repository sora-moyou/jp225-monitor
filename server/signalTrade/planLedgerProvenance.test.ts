// ★計画サイクルの台帳に「文脈を組み立てた時刻」と「プロンプトの指紋」が
//   **実ファイルの SQLite に本当に入る** ことの実証(メモリDBではない)。
//
// ■ なぜ要るか(実測で分かった穴)
//   凍結した入力から計画を再生して検証しようとしたところ、
//    ・プロンプトがどこにも残っていないため「凍結した入力から組んだ文脈が、その時刻に実際に
//      AI へ渡ったものと同じか」を突き合わせられない(サーバログの行を時刻の代用にして
//      秒オーダーの誤差が残り、1件は1分足が隣にずれた)
//    ・一部の計画サイクルは ref_price が collector の tick 列に一度も現れず、時刻すら決められない
//   → 「文脈を組み立てた時刻」と「組み立てたプロンプトの指紋」が記録されていれば、どちらも消える。
//
// ■ ★本文は保存しない
//   プロンプトには非公開の決済仕様が入る。台帳は同期フォルダ経由で機外へ出るので、
//   入れてよいのは一方向の指紋だけ。§本文が入らない でそれを実ファイルのバイト列に対して確かめる。
//
// ■ ★否定対照
//   planLedger.ts の2行(contextAt/promptFp の写し)を消すと §見送り/§ARM が赤。
//   store.ts の ALTER を消すと §古いDBとの互換 が赤(列が生えない)。
//   実証手順: git show HEAD:server/signalTrade/planLedger.ts で旧版に差し替えて実行。

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ScalpPlanResult } from '../llm/scalpPlan.js';

/** 差し替え可能な AI 応答(各テストが代入する)。 */
let canned: ScalpPlanResult = { ok: false, error: 'unset' };

vi.mock('../llm/scalpPlanRunner.js', () => ({
  runScalpPlanWithChart: vi.fn(async () => canned),
}));
vi.mock('../sse/broker.js', () => ({ broadcast: () => { /* noop */ } }));

import { SignalEngine } from './engine.js';
import { openDb, resolveDbPath, getSignalPlans, type SignalPlanRow } from '../db/store.js';
import { promptFingerprint } from '../llm/promptFingerprint.js';

/** 取引時間内(2026-08-03 月曜 10:00 JST)。時間外だと計画要求そのものが出ない。 */
const NOW = Date.UTC(2026, 7, 3, 1, 0, 0);
const REF = 38250;
const A_CFG = { profile: 'A' as const, systemTag: null, broadcastType: 'signalTrade' as const, maintainsCurrentSignal: true };

/** 文脈を組み立てた時刻(記録時刻 t より **前**。撮影と LLM の待ちぶん t は後ろにずれる)。 */
const CONTEXT_AT = NOW - 4_321;

/** 「本文が台帳に入っていない」ことを見るための目印つきプロンプト(実物と同じ経路で指紋にする)。 */
const SENTINEL_SYSTEM = '【市場の現状】SENTINEL-SYSTEM-BODY-DO-NOT-PERSIST';
const SENTINEL_USER = '【質問】SENTINEL-USER-BODY-DO-NOT-PERSIST';
const FP = promptFingerprint(SENTINEL_SYSTEM, SENTINEL_USER);

const NONE: ScalpPlanResult = {
  ok: true,
  plan: { direction: 'none', rationale: '方向感が定まらず見送り', refPrice: REF },
  noneReason: 'trend',
  contextAt: CONTEXT_AT, promptFp: FP,
};

const ARM: ScalpPlanResult = {
  ok: true,
  plan: {
    direction: 'buy', rationale: '押し目買い', refPrice: REF,
    limitEntry: 38200, stopLossForLimit: 38145,
    stopEntry: 38300, stopLossForStop: 38245,
  },
  contextAt: CONTEXT_AT, promptFp: FP,
};

// ★ユーザーの実DBを絶対に触らない。
//   engine の計画書き込みは非同期(await した後にもう1本走りうる)ので、テストの終わりに
//   APPDATA を **実際の値へ戻すと、遅れて来た1行が本番の台帳に落ちる**(実測: 実DBに1行入った)。
//   → このファイルが走っているあいだ APPDATA は temp の外を指さない。テスト間は隔離用の別ディレクトリへ
//     退避し、本物の値は afterAll でだけ戻す(戻した後にはもうエンジンが生きていない)。
const ROOT = mkdtempSync(join(tmpdir(), 'jp225-planprov-'));
const QUARANTINE = join(ROOT, 'quarantine');
mkdirSync(QUARANTINE, { recursive: true });
const ORIG_APPDATA = process.env.APPDATA;
process.env.APPDATA = QUARANTINE;   // import 直後から本番を指さない

let dir: string;
let seq = 0;

beforeEach(() => {
  dir = join(ROOT, `case-${++seq}`);
  mkdirSync(dir, { recursive: true });
  process.env.APPDATA = dir;
  vi.spyOn(console, 'log').mockImplementation(() => { /* noop */ });
  vi.spyOn(console, 'warn').mockImplementation(() => { /* noop */ });
});
afterEach(() => {
  process.env.APPDATA = QUARANTINE;   // 遅れて来た書き込みも temp に落ちる(本番へは行かない)
  vi.restoreAllMocks();
});
afterAll(() => {
  if (ORIG_APPDATA !== undefined) process.env.APPDATA = ORIG_APPDATA; else delete process.env.APPDATA;
  try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** ★実測値を人間が目で確かめるための出力(PROMPT_FP_SHOW=1 のときだけ)。既定では黙る。 */
function say(r: SignalPlanRow, label: string): void {
  if (process.env.PROMPT_FP_SHOW !== '1') return;
  console.info(`[実測/${label}] t=${r.t} context_at=${r.context_at} 差=${r.context_at == null ? '-' : r.t - r.context_at}ms`
    + ` prompt_fp=${r.prompt_fp} direction=${r.direction} signal_id=${r.signal_id} error=${r.error}`);
}

function readPlans(): SignalPlanRow[] {
  const db = openDb(resolveDbPath());
  try { return getSignalPlans(db); } finally { db.close(); }
}

/** エンジンを1サイクル走らせ、台帳の行数が want になるまで待つ(既存行がある DB でも待ち損ねない)。 */
async function runCycle(result: ScalpPlanResult, want = 1): Promise<SignalEngine> {
  canned = result;
  const eng = new SignalEngine(A_CFG);
  await eng.start();
  eng.feed(REF, NOW);
  await vi.waitFor(() => expect(readPlans().length).toBe(want), { timeout: 3000 });
  return eng;
}

describe('§実ファイルの台帳に「文脈の時刻」と「プロンプトの指紋」が入る', () => {
  it('見送り(none)の回に入る(記録時刻 t とは別の値として)', async () => {
    const eng = await runCycle(NONE);
    const r = readPlans()[0]!;
    expect(r.direction).toBe('none');
    expect(r.context_at).toBe(CONTEXT_AT);
    expect(r.prompt_fp).toBe(FP);

    say(r, '見送り');
    // ★t(記録時刻)と context_at(文脈を組み立てた時刻)は別物。同じ値を書いていないことを固定する。
    expect(r.t).not.toBe(r.context_at);
    expect(r.t).toBeGreaterThan(r.context_at!);
    eng.stop();
  });

  it('ARM の回にも入る(采番した signal_id と同じ行に)', async () => {
    const eng = await runCycle(ARM);
    const r = readPlans()[0]!;
    expect(eng.getPhase()).toBe('armed');
    expect(r.signal_id).toBe(1);
    expect(r.context_at).toBe(CONTEXT_AT);
    expect(r.prompt_fp).toBe(FP);
    say(r, 'ARM');
    eng.stop();
  });

  it('★文脈を組む前に見送った回(chart-not-generated)は NULL のまま=値が無いことを捏造しない', async () => {
    const eng = await runCycle({ ok: false, error: 'chart-not-generated' });
    const r = readPlans()[0]!;
    expect(r.error).toBe('chart-not-generated');
    expect(r.context_at).toBeNull();
    expect(r.prompt_fp).toBeNull();
    say(r, '文脈前に見送り');
    eng.stop();
  });

  it('★文脈は組んだが計画が得られなかった回(LLM 失敗)は記録される=入力が在ったことが分かる', async () => {
    const eng = await runCycle({ ok: false, error: 'LLM未設定', contextAt: CONTEXT_AT, promptFp: FP });
    const r = readPlans()[0]!;
    expect(r.error).toBe('LLM未設定');
    expect(r.context_at).toBe(CONTEXT_AT);
    expect(r.prompt_fp).toBe(FP);
    eng.stop();
  });
});

describe('§本文が入らない(入るのは一方向の指紋だけ)', () => {
  it('★DB ファイルのバイト列にプロンプト本文が1つも現れない', async () => {
    const eng = await runCycle(NONE);
    eng.stop();
    const raw = readFileSync(resolveDbPath());
    const text = raw.toString('utf-8');
    expect(text).toContain(FP);                     // 指紋は入っている(空振りしていない)
    expect(text).not.toContain('SENTINEL-SYSTEM-BODY-DO-NOT-PERSIST');
    expect(text).not.toContain('SENTINEL-USER-BODY-DO-NOT-PERSIST');
    // 指紋の長さ(版タグ+16桁)より長い断片が入っていないこと=本文の切れ端も落ちていない。
    expect(FP.length).toBeLessThan(24);
  });
});

describe('§古いDB(列が無い)との互換', () => {
  /** この2列を持たない時代の signal_plans(arm_wait_* まで足した版)。 */
  const LEGACY_DDL = `
    CREATE TABLE signal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      t INTEGER NOT NULL, system TEXT NOT NULL, signal_id INTEGER,
      direction TEXT, none_reason TEXT, veto_fired INTEGER, ref_price REAL,
      regime TEXT, confidence REAL,
      limit_entry REAL, stop_entry REAL, stop_loss_for_limit REAL, stop_loss_for_stop REAL,
      leg_drops_json TEXT, settings_json TEXT, rationale TEXT, error TEXT,
      arm_wait_ms INTEGER, arm_wait_distance REAL, arm_wait_sigma REAL, arm_wait_reason TEXT
    );
  `;

  it('列が無いDBを開いても落ちず、後付けされ、既存行はそのまま残る', async () => {
    const path = resolveDbPath();
    // 旧版の DB を先に作る(1行だけ既存データを入れておく)。
    const legacy = new DatabaseSync(path);
    legacy.exec(LEGACY_DDL);
    legacy.prepare('INSERT INTO signal_plans (t, system, direction, rationale) VALUES (?,?,?,?)')
      .run(NOW - 60_000, 'A', 'none', '旧版で記録された行');
    const before = (legacy.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    legacy.close();
    expect(before).not.toContain('context_at');
    expect(before).not.toContain('prompt_fp');

    // openDb(= initSchema)で後付けされる。
    const db = openDb(path);
    const after = (db.prepare('PRAGMA table_info(signal_plans)').all() as Array<{ name: string }>).map(c => c.name);
    db.close();
    expect(after).toContain('context_at');
    expect(after).toContain('prompt_fp');

    // 既存行は保持され、新しい2列は NULL(=この列を持たない版で記録された)。
    const rows = readPlans();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rationale).toBe('旧版で記録された行');
    expect(rows[0]!.context_at).toBeNull();
    expect(rows[0]!.prompt_fp).toBeNull();

    // 後付け後の DB へ新しい行も普通に入る(旧行と新行が同居する)。
    const eng = await runCycle(NONE, 2);
    eng.stop();
    const all = readPlans();
    expect(all).toHaveLength(2);
    expect(all.filter(r => r.prompt_fp === FP)).toHaveLength(1);
    expect(all.filter(r => r.prompt_fp === null)).toHaveLength(1);
  });
});
