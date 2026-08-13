// 分析用サイドカーの **ファイルログ**(診断専用・取引挙動には一切関与しない)。
//
// ■ ★このファイルは薄い包みでしかない(規約は1か所)
//   中身は server/processLog.ts(名前を引数に取る一般形)。**同じ規約が2か所に分かれている状態そのもの**
//   が事故だったので畳んだ:
//     ・processLog.ts は「unhandledRejection に listener を付けると Node 15+ の既定(=落ちる)が止まる。
//       記録だけして生き残らせると『プロセスは生きているのに何もしない』という、いちばん分かりにくい
//       状態をこちらが作ってしまう」と書いたうえで process.exit(1) している。
//     ・こちら(分析用用)は **その listener を付けて exit していなかった**。
//   分析用の名乗りは setInterval(server/generator/sidecarRun.ts)なので、本体の promise 連鎖が
//   死んでも心拍だけ打ち続け、共有DBは「生きている」と言い続ける = このリリースが解こうとしている
//   誤診断そのものを、リリース自身が製造できる状態だった。
//   → 規約を分けない。ここは名前と相乗り先を決めるだけにする。
//
// ■ 置き場所(従来どおり・resolveProcessLogPath('generator') と同一)
//   書き出しフォルダ(= trade2 の export.json の exportDir)に `generator_<host>.log`。
//   未設定の PC では %APPDATA%/jp225-monitor/generator.log(「設定していないから何も残らない」は作らない)。
//
// ■ ★節目は共用の1行ログにも相乗りさせる(collector と同じ流儀)
//   起動/例外/終了だけを sidecar-spawn.log へ。Rust が書く `[generator] spawned pid=…` と
//   **同じファイルに時系列で並ぶ**ので、「起動された → いつ落ちた」が1画面で読める。
//   このログは monitor が meta(generator_heartbeat.spawn)に載せて別PCへ運ぶ = 新しい配管は増えない。

import {
  installProcessFileLog, resolveProcessLogPath, appendProcessLog, rotateProcessLog,
  processLogPath, _resetProcessFileLogForTest, PROCESS_LOG_MAX_BYTES,
  type ProcessLogInstall,
} from '../processLog.js';
import { appendSpawnLog } from '../spawnLog.js';

/** これを超えたら1世代だけ退避する(同期フォルダを太らせない)。 */
export const GENERATOR_LOG_MAX_BYTES = PROCESS_LOG_MAX_BYTES;

/** 分析用のログ名(= resolveProcessLogPath に渡す名前)。 */
export const GENERATOR_LOG_NAME = 'generator';

/** 節目の行に付ける名札。 */
export const GENERATOR_LOG_TAG = 'generator-sidecar';

export type GeneratorLogInstall = ProcessLogInstall;

/** ログの置き場所。書き出しフォルダ → 無ければ %APPDATA%/jp225-monitor。 */
export function resolveGeneratorLogPath(): string {
  return resolveProcessLogPath(GENERATOR_LOG_NAME);
}

/** 1行書く。**絶対に throw しない**(ログのために分析用を落とさない)。 */
export function appendGeneratorLog(path: string, line: string, now: number = Date.now()): void {
  appendProcessLog(path, line, now);
}

/** 大きくなりすぎたら1世代だけ退避する(.1 は上書き)。 */
export function rotateGeneratorLog(path: string, maxBytes: number = GENERATOR_LOG_MAX_BYTES): void {
  rotateProcessLog(path, maxBytes);
}

/** 現在のログ出力先(未インストールなら null)。meta に載せて「どこを見ればよいか」を伝える。 */
export function generatorLogPath(): string | null {
  return processLogPath();
}

/** ファイルログを有効にする。**サイドカーの一番最初に呼ぶこと**。
 *  ★冪等(2回呼んでも二重に横取りしない)。テストからも安全に呼べる。
 *  ★uncaughtException / unhandledRejection は **どちらも記録したうえで exit(1)**(processLog.ts の規約)。 */
export function installGeneratorFileLog(now: number = Date.now()): GeneratorLogInstall {
  return installProcessFileLog({
    path: resolveGeneratorLogPath(),
    tag: GENERATOR_LOG_TAG,
    onLifecycle: line => appendSpawnLog(`[generator] ${line}`),
    now,
  });
}

/** テスト専用: 横取り状態を忘れる(console は戻さない=テストは元の console を保存して使うこと)。 */
export function _resetGeneratorFileLogForTest(): void { _resetProcessFileLogForTest(); }
