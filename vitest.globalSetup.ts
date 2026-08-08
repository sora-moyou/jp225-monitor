// ★再発検知(トリップワイヤ): 「テストが実ユーザーの DB に書いた」を **テスト実行そのもので** 検知する。
//
//   実測(2026-08-04〜08-08): 実 DB `%APPDATA%/jp225-monitor/jp225.db` の signal_plans 689行のうち
//   688行がテストの書き込みだった。**4日間だれも気づかなかった。**
//   防止(server/appDataDir.ts の隔離)だけでは「直したつもり」を検出できないので、ここで2重に見張る。
//
//   ① 隔離の発火記録(決定的・誤検知ゼロ): テスト中に実 %APPDATA% を指した瞬間に
//      REAL_APPDATA_VIOLATION_LOG に1行残る。1行でもあればスイート全体を失敗させる。
//   ② 実 DB の行数差分: 実行前後で行数を数え、テストが書きうる表(signal_*)が増えていたら失敗。
//      ★collector/monitor が同時に走っていると ticks/bars_1m/alerts は正当に増えるので、
//        そちらは失敗させず情報として出すだけにする(誤検知でスイートを赤くしない)。
//
//   逃げ道: JP225_SKIP_REAL_DB_TRIPWIRE=1(実 DB を読めない環境や、シグナルエンジン稼働中の調査用)。

import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REAL_APPDATA_VIOLATION_LOG, REAL_APPDATA_BASE_ENV } from './server/appDataDir.js';

/** ★ここだけは隔離を通さない「実パス」。読み取り専用でしか開かない。 */
function realDbPath(): string {
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  return join(base, 'jp225-monitor', 'jp225.db');
}

/** テストが書き得る表(= ここが増えたら事故)。 */
const FATAL_TABLES = ['signal_plans', 'signal_trades', 'signal_exit_stops', 'signal_trades_clears', 'signal_meta'];
/** collector/monitor が正当に増やす表(= 情報として出すだけ)。 */
const INFO_TABLES = ['alerts', 'bars_1m', 'ticks', 'daily_closes', 'meta'];

type Snap = { ok: true; counts: Record<string, number>; mtimeMs: number } | { ok: false; reason: string };

function snapshot(): Snap {
  const p = realDbPath();
  if (!existsSync(p)) return { ok: false, reason: `実 DB が無い(${p})` };
  try {
    const db = new DatabaseSync(p, { readOnly: true });   // ★readOnly: 検知のために実 DB を触らない
    try {
      const counts: Record<string, number> = {};
      for (const t of [...FATAL_TABLES, ...INFO_TABLES]) {
        const exists = (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t) as { c: number }).c > 0;
        counts[t] = exists ? (db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number }).c : -1;
      }
      return { ok: true, counts, mtimeMs: statSync(p).mtimeMs };
    } finally { db.close(); }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

let before: Snap = { ok: false, reason: 'not taken' };
let enabled = false;

export function setup(): void {
  // ★テストが1行も走る前の「本物のベース」をワーカーへ引き継ぐ(検知の基準値)。fork は env を継承する。
  process.env[REAL_APPDATA_BASE_ENV] = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  try { rmSync(REAL_APPDATA_VIOLATION_LOG, { force: true }); } catch { /* ignore */ }
  // 前回の実行が残した使い捨て環境(vitest.setup.ts / 隔離先)を掃除する。
  try { rmSync(join(tmpdir(), 'jp225-testenv'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { rmSync(join(tmpdir(), 'jp225-test-quarantine'), { recursive: true, force: true }); } catch { /* ignore */ }
  enabled = process.env.JP225_SKIP_REAL_DB_TRIPWIRE !== '1';
  if (!enabled) return;
  before = snapshot();
  if (!before.ok) console.warn(`[real-db-tripwire] 事前スナップショットを取れず: ${before.reason}`);
}

export function teardown(): void {
  // ① 隔離の発火記録(決定的)
  let violations: string[] = [];
  if (existsSync(REAL_APPDATA_VIOLATION_LOG)) {
    violations = readFileSync(REAL_APPDATA_VIOLATION_LOG, 'utf8').split('\n').filter((l) => l.trim());
  }

  // ② 行数差分
  const problems: string[] = [];
  if (enabled && before.ok) {
    const after = snapshot();
    if (!after.ok) {
      console.warn(`[real-db-tripwire] 事後スナップショットを取れず: ${after.reason}`);
    } else {
      for (const t of FATAL_TABLES) {
        const b = before.counts[t] ?? -1, a = after.counts[t] ?? -1;
        if (a !== b) problems.push(`  ${t}: ${b} → ${a} (${a - b >= 0 ? '+' : ''}${a - b})`);
      }
      const info = INFO_TABLES
        .filter((t) => (after.counts[t] ?? -1) !== (before.counts[t] ?? -1))
        .map((t) => `${t}: ${before.counts[t]} → ${after.counts[t]}`);
      if (info.length) console.log(`[real-db-tripwire] 参考(collector 稼働中なら正常): ${info.join(' / ')}`);
    }
  }

  if (violations.length === 0 && problems.length === 0) return;

  const lines = ['★実ユーザーの DB/データフォルダにテストが触れました(トリップワイヤ発火)。'];
  if (violations.length) {
    lines.push(`  実 %APPDATA% を指した回数: ${violations.length}(隔離済みなので実害は無いが、原因のテストを直すこと)`);
    lines.push(`  記録: ${REAL_APPDATA_VIOLATION_LOG}`);
    for (const v of violations.slice(0, 3)) lines.push('  ' + v.slice(0, 600));
  }
  if (problems.length) {
    lines.push(`  実 DB の行数が変化しました(${realDbPath()}):`, ...problems);
    lines.push('  シグナルエンジンが同時に動いていた可能性もあります。切り分けたら JP225_SKIP_REAL_DB_TRIPWIRE=1 で再実行できます。');
  }
  throw new Error(lines.join('\n'));
}
