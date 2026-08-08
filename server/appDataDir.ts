// ★アプリのデータ置き場(%APPDATA%/jp225-monitor)の **唯一の** 解決口。
//
//   これを1箇所に集めた理由は2つある。
//
//   (1) 知識の複製をやめる: `process.env.APPDATA ?? process.env.HOME ?? process.cwd()` + 'jp225-monitor' が
//       server/collector の各所に7コピー散らばっており、どれか1つを直しても他が残る形だった。
//
//   (2) ★テストが **実ユーザーの DB/ログ** に書き込む事故を、構造で止める。
//       実測(2026-08-04〜08-08): 実 DB `%APPDATA%/jp225-monitor/jp225.db` の signal_plans 689行のうち
//       688行がテストの書き込み(目印 rationale='r')だった。4日間だれも気づかなかった。
//       原因は engine 系テストの afterEach が `process.env.APPDATA` を **実値へ戻す** 一方、engine の
//       台帳書き込みが非同期で、**遅れて到着した書き込みが本番の台帳に落ちる** レース。
//       個々のテストの afterEach を直して回る対処では、新しいテストが増えるたびに同じ穴が開く。
//
//   そこで **テスト実行中は実パスを物理的に選べなくする**:
//       vitest 実行中(VITEST/VITEST_WORKER_ID)に、ベースが os.tmpdir() の外を指していたら、
//       そのプロセス専用の隔離ディレクトリ(tmpdir 配下)へ **強制的に差し替える**。
//   正しく `mkdtempSync(join(tmpdir(), …))` を使っているテストは tmpdir 配下なので素通りし、
//   何も設定していない/戻してしまったテストだけが隔離される。よって **新しいテストが増えても再発しない**
//   (テストが実パスを選べる経路が存在しない)。
//
//   ★本番(vitest 以外)は isTestRuntime() が false を返し、guardAppDataBase() は引数をそのまま返す。
//     以降の行は1行も実行されない = 従来と完全に同一のパスになる。

import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdirSync, mkdtempSync, appendFileSync } from 'node:fs';

/** 実行中が vitest かどうか(vitest がワーカーに必ず立てる env で判定)。 */
export function isTestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === 'true' || env.VITEST_WORKER_ID !== undefined || env.VITEST_POOL_ID !== undefined;
}

/** Windows は大文字小文字を区別しないので正規化して比較する。末尾に区切りを足して前方一致の取りこぼしを防ぐ。 */
function normDir(p: string): string {
  let r = resolve(p);
  if (process.platform === 'win32') r = r.toLowerCase();
  return r.endsWith(sep) ? r : r + sep;
}

/** p が一時ディレクトリ配下か(= テストが自分で用意した使い捨ての置き場か)。 */
export function isInsideTmp(p: string, tmp: string = tmpdir()): boolean {
  try { return normDir(p).startsWith(normDir(tmp)); } catch { return false; }
}

/** ★テスト実行中に「実パスを選ぼうとした」記録の置き場。globalSetup が消し、globalTeardown が読む。
 *  この1行が出たら、テストのどこかが実ユーザーの %APPDATA% を指した(= 昔なら実 DB を汚していた)。 */
export const REAL_APPDATA_VIOLATION_LOG = join(tmpdir(), 'jp225-real-appdata-violations.log');

/** 「この機体の本物のベース」を固定して置く env 名。
 *  vitest.globalSetup が本体プロセスで立てる(= テストが1行も走る前の値)。ワーカーは fork で継承する。
 *  隔離(防止)は tmpdir 判定だけで効くので、これはあくまで **検知の精度** のための値。 */
export const REAL_APPDATA_BASE_ENV = 'JP225_REAL_APPDATA_BASE';

// import 時点(= どのテスト本体よりも前。ESM の import は巻き上げられる)で1度だけ確定させる。
if (isTestRuntime() && !process.env[REAL_APPDATA_BASE_ENV]) {
  process.env[REAL_APPDATA_BASE_ENV] = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
}

let quarantine: string | null = null;

/** このプロセス専用の隔離ベース(tmpdir 配下)。テスト間で使い回してもファイルは実環境に出ない。 */
function quarantineBase(): string {
  if (quarantine) return quarantine;
  const root = join(tmpdir(), 'jp225-test-quarantine');
  mkdirSync(root, { recursive: true });
  quarantine = mkdtempSync(join(root, `p${process.pid}-`));
  return quarantine;
}

/** 記録するのは **この機体の本物のベース** を指した時だけ(= 実害があったはずの回だけ)。
 *  隔離テストのプローブ用の架空パスまで記録すると、警報が狼少年になって誰も見なくなる。 */
function isRealUserBase(base: string): boolean {
  const real = process.env[REAL_APPDATA_BASE_ENV];
  return real !== undefined && normDir(base) === normDir(real);
}

function recordViolation(base: string, redirected: string): void {
  try {
    const stack = new Error('real-appdata access during test').stack ?? '';
    appendFileSync(
      REAL_APPDATA_VIOLATION_LOG,
      JSON.stringify({
        at: new Date().toISOString(), pid: process.pid,
        worker: process.env.VITEST_WORKER_ID ?? null,
        file: process.env.VITEST_POOL_ID ?? null,
        base, redirected,
        stack: stack.split('\n').slice(1, 12).join('\n'),
      }) + '\n',
      'utf8',
    );
  } catch { /* 記録に失敗しても隔離そのものは効かせる(検知より防止を優先) */ }
}

/**
 * ベースディレクトリを「テスト中に実パスを指していたら隔離先へ」差し替える。
 * ★本番では引数をそのまま返す(挙動不変)。
 */
export function guardAppDataBase(base: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isTestRuntime(env)) return base;   // ★本番経路: ここで即 return。以降は一切走らない。
  if (isInsideTmp(base)) return base;     // テストが自分で用意した一時ディレクトリ = 正しい使い方
  const q = quarantineBase();
  if (isRealUserBase(base)) recordViolation(base, q);
  return q;
}

/** 従来から各所に散らばっていたベースの解決式(APPDATA → HOME → cwd)。 */
export function appDataBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPDATA ?? env.HOME ?? process.cwd();
}

/**
 * アプリのデータ置き場 `<base>/jp225-monitor`。
 * base を省略すると従来の解決式(APPDATA → HOME → cwd)。呼び出し側の fallback 規約が違う場合だけ base を渡す。
 * ★ディレクトリは作らない(作る責務は呼び出し側のまま = 従来の挙動を変えない)。
 */
export function resolveAppDataDir(base: string = appDataBase()): string {
  return join(guardAppDataBase(base), 'jp225-monitor');
}
