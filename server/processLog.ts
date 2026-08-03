// 常駐サイドカー(collector / 将来の他プロセス)の **ファイルログ**(診断専用・取引挙動には一切関与しない)。
//
// ■ なぜ要るか(実運用で起きたこと)
//   collector は Rust がデタッチ起動し、その stdout/stderr は Rust の `eprintln!` = **コンソール止まり**。
//   運用PCは別マシンでコンソールを見られないので、10:13:44 に collector が止まったとき
//   「なぜ止まったか」の手がかりが **どこにも1バイトも残らなかった**。
//   ログにしか無い理由は、無いのと同じ。ましてログが無ければ、原因は永遠に分からない。
//
// ■ ★既存の流儀に合わせる(新しい機構を作らない)
//   ・置き場所は resolveTickExportDir()(= trade2 の export.json の exportDir)。ティックの日次書き出し・
//     台帳スナップショットと同じフォルダに落ちるので、既存の同期でそのまま別PCへ届く。
//   ・未設定の PC では %APPDATA%/jp225-monitor/<name>.log に落とす(「設定していないから何も残らない」
//     は、いま困っている状況そのものなので作らない)。
//   ・ファイル名に host を入れるのは prices_<host>.db と同じ理由(複数PCの書き出しが衝突しない)。
//
// ■ ★何を必ず残すか
//   起動 / 通常終了(code) / uncaughtException / unhandledRejection / シグナル。
//   さらに **これらの節目だけ** は共有の sidecar-spawn.log(Rust が spawn の成否を書いている所)へも
//   相乗りさせる(onLifecycle)。spawn 記録と死亡記録が **1つのファイルで時系列に並ぶ** ので、
//   「起動された → 3時間後に落ちた」が1画面で読める。
//
// ■ ★挙動を減らさない
//   console の横取りは **元の出力を必ず先に呼ぶ**(コンソール表示は従来どおり)。
//   uncaughtException は記録したうえで **異常終了のまま落とす**(握りつぶすと「生きているのに何も
//   しない」という、いちばん分かりにくい状態を作る)。
//
// ■ 既知の限界(正直に書く)
//   SIGKILL / `taskkill /F` / 電源断ではハンドラは1つも走らない = 終了行は残らない。
//   その場合でも「起動行はあるのに終了行が無い」+ monitor 側の死亡記録(server/collectorWatch.ts)で
//   「いつ静かになったか」までは分かる。
//
// ■ ★規約は **ここ1か所** (重複を残さない)
//   生成器向けの server/generator/sidecarLog.ts は、この一般形の **薄い包み** に畳んである
//   (名前 'generator' と相乗り先を決めるだけ)。
//   畳む前は「listener を付けたら exit する」という同じ規約が2か所に分かれ、生成器側だけが
//   unhandledRejection を **記録して生き残らせていた**。生成器の名乗りは setInterval なので、
//   本体が死んでも心拍だけ打ち続け、共有DBは「生きている」と言い続ける = このモジュールが
//   「作ってはいけない」と書いた状態を、同じリリースの中で作れてしまっていた。

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveTickExportDir } from './db/tickArchive.js';
import { hostLabel } from './db/ledgerExport.js';
import { jstStamp } from './db/tickArchiveHeartbeat.js';

/** これを超えたら1世代だけ退避する(同期フォルダを太らせない)。 */
export const PROCESS_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** ログの置き場所。書き出しフォルダ → 無ければ %APPDATA%/jp225-monitor。 */
export function resolveProcessLogPath(name: string): string {
  try {
    const dir = resolveTickExportDir();
    if (dir) return join(dir, `${name}_${hostLabel()}.log`);
  } catch { /* 解決できなければ既定の置き場所に落とす */ }
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  return join(base, 'jp225-monitor', `${name}.log`);
}

/** 1行書く。**絶対に throw しない**(ログのためにプロセスを落とさない)。 */
export function appendProcessLog(path: string, line: string, now: number = Date.now()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${jstStamp(now)} ${line}\n`, 'utf-8');
  } catch { /* 書けないこと自体はコンソールに出ている(ここで落とさない) */ }
}

/** 大きくなりすぎたら1世代だけ退避する(.1 は上書き)。 */
export function rotateProcessLog(path: string, maxBytes: number = PROCESS_LOG_MAX_BYTES): void {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return;
    renameSync(path, `${path}.1`);
  } catch { /* 退避できなくても書き続ける */ }
}

export interface ProcessLogInstall {
  path: string;
  ok: boolean;
  error: string | null;
}

export interface ProcessLogOptions {
  /** ログの置き場所(resolveProcessLogPath の結果を渡す)。 */
  path: string;
  /** 節目の行に付ける名札(例 'collector')。 */
  tag: string;
  /** 起動/終了/例外の **節目だけ** を別経路にも流す(sidecar-spawn.log への相乗り)。 */
  onLifecycle?: (line: string) => void;
  /** ★受信を記録するシグナル。**呼び出し側が既に自分で listen しているものだけ** を渡すこと。
   *  Node は「listener が1つでも付いた瞬間に既定の終了動作を止める」ので、ここで勝手に足すと
   *  「Ctrl+Break で死ななくなる」= 挙動を変えてしまう。既定は空(=何も足さない)。 */
  signals?: readonly NodeJS.Signals[];
  now?: number;
}

let installed: ProcessLogInstall | null = null;
/** 節目を書く関数(install 時に決まる)。signals を後から足すために保持する。 */
let lifecycleFn: ((line: string) => void) | null = null;

/** 現在のログ出力先(未インストールなら null)。 */
export function processLogPath(): string | null {
  return installed?.ok ? installed.path : null;
}

/** ★シグナル受信の記録を **後から** 足す。
 *
 *  なぜ分けるか: ファイルログは「import の途中で落ちた」も残せるように **一番最初**
 *  (副作用モジュールの import)で開く必要がある。一方シグナルは
 *  「**呼び出し側が既に自分で listen しているものだけ**」を渡す約束なので、
 *  本体が listen する場所と同じところで足す(Node は listener が1つでも付いた瞬間に
 *  既定の終了動作を止めるため、勝手に足すと挙動が変わる)。
 *  ★ログが開いていなければ何もしない。 */
export function recordProcessLogSignals(signals: readonly NodeJS.Signals[]): void {
  if (!installed?.ok || !lifecycleFn) return;
  const lifecycle = lifecycleFn;
  for (const sig of signals) {
    try { process.on(sig, () => { lifecycle(`シグナル受信 ${sig}`); }); } catch { /* 未対応シグナルは無視 */ }
  }
}

/** ファイルログを有効にする。**プロセスの一番最初に呼ぶこと**(落ちてから書くのでは間に合わない)。
 *  ★冪等(2回呼んでも二重に横取りしない)。 */
export function installProcessFileLog(opts: ProcessLogOptions): ProcessLogInstall {
  if (installed) return installed;
  const { path, tag } = opts;
  const now = opts.now ?? Date.now();
  const lifecycle = (line: string): void => {
    appendProcessLog(path, line);
    try { opts.onLifecycle?.(line); } catch { /* 相乗り先の失敗で本体を落とさない */ }
  };

  rotateProcessLog(path);
  let ok = true;
  let error: string | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${jstStamp(now)} ─── 起動 pid=${process.pid} `
      + `variant=${process.env.MONITOR_VARIANT ?? '(未設定)'} node=${process.version} exec=${process.execPath}\n`, 'utf-8');
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
    console.error(`[${tag}] ファイルログを開けません(${path}): ${error}`);
  }
  installed = { path, ok, error };
  try { opts.onLifecycle?.(`起動 pid=${process.pid} ログ=${ok ? path : `(開けず: ${error ?? '?'})`}`); }
  catch { /* ignore */ }
  if (!ok) return installed;

  // ★元の出力を必ず先に呼ぶ = コンソール側の挙動は1ミリも変わらない。
  const wrap = (orig: (...a: unknown[]) => void) => (...args: unknown[]): void => {
    orig(...args);
    appendProcessLog(path, args.map(a => (typeof a === 'string' ? a : safeStr(a))).join(' '));
  };
  console.log = wrap(console.log.bind(console)) as typeof console.log;
  console.warn = wrap(console.warn.bind(console)) as typeof console.warn;
  console.error = wrap(console.error.bind(console)) as typeof console.error;

  // ★落ちたことこそ残す(いま困っているのは「何も残らずに消える」ケース)。
  process.on('uncaughtException', (e) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    lifecycle(`★uncaughtException: ${detail}`);
    console.error(`[${tag}] ★uncaughtException: ${detail}`);
    process.exit(1);   // 記録したうえで **異常終了のまま** 落ちる(既定と同じ結末を保つ)
  });
  // ★unhandledRejection は **既定の結末を変えない** ことが大事。
  //   Node 15 以降の既定は「未処理の reject は uncaughtException として投げてプロセスを落とす」。
  //   listener を付けた瞬間にその既定が止まるので、記録だけして生き残らせると
  //   「プロセスは生きているのに何もしない」という、いちばん分かりにくい状態を **こちらが作ってしまう**。
  //   → 記録し、標準エラーにも出し、**同じ終了コード(1)で落とす**。
  process.on('unhandledRejection', (r) => {
    const detail = r instanceof Error ? (r.stack ?? r.message) : String(r);
    lifecycle(`★unhandledRejection: ${detail}`);
    console.error(`[${tag}] ★unhandledRejection: ${detail}`);
    process.exit(1);
  });
  // シグナルは「誰かに止められた」= 異常終了ではない、を区別するために別行で残す。
  // ★既存のハンドラを置き換えない(on は追加登録)し、exit も呼ばない = 終了の仕方は変わらない。
  lifecycleFn = lifecycle;
  recordProcessLogSignals(opts.signals ?? []);
  process.on('exit', (code) => { lifecycle(`─── 終了 code=${code}`); });
  return installed;
}

function safeStr(v: unknown): string {
  try {
    return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}

/** テスト専用: 横取り状態を忘れる(console は戻さない=テストは元の console を保存して使うこと)。 */
export function _resetProcessFileLogForTest(): void { installed = null; lifecycleFn = null; }
