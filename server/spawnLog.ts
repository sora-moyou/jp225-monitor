// サイドカー spawn の成否を残す **1行ログ**(Rust が書き・TS が読む)。
//
// ■ なぜ要るか
//   src-tauri/src/lib.rs のサイドカー起動は、失敗しても `eprintln!` するだけ = Rust のコンソール止まり。
//   運用PC(別マシン)ではコンソールを見られないので、**そもそも spawn できたのか** が分からない。
//   「生成器が動いていない」の切り分けで最初に知りたいのは「起動されたのか」なのに、それが観測できなかった。
//
// ■ ★置き場所は Rust と TS の **両方が env だけで解決できる**所
//   書き出しフォルダ(trade2 の export.json)は TS 側の解決関数でしか読めない。Rust に同じ解決を
//   実装すると知識が複製されて必ずズレる。→ Rust は %APPDATA%\jp225-monitor\ に置くことだけ知り、
//   そこから先(別PCへ届ける)は **monitor が meta に載せる**。既存の30分スナップショットに乗るので
//   新しい同期経路は増えない(ティック保管・台帳書き出しと同じ発想)。

// ■ ★TS 側も **書ける**(追記のみ)
//   Rust が書くのは「起動できたか」だけで、**落ちたこと** は誰も書いていなかった。
//   collector は Rust のコンソールにしか出力されず、異常終了は痕跡ゼロで消える(実際に消えた)。
//   同じ1行ログに collector 自身の生死(起動/例外/終了コード)と、monitor から見た
//   「collector が死んだ/戻った」を相乗りさせる = 新しい配管を増やさずに死因の手がかりを残す。
//
// ■ ★書き込みの正確な性質(宣言と実装を一致させる)
//   ・**通常の追記は appendFileSync だけ**(read-modify-write をしない)。Rust の書き換えと競合しても
//     最悪1行落ちるだけで、ファイルが壊れたり他プロセスの行を消したりしない。
//   ・ただし **サイズ上限を超えたときだけ** trimSpawnLog が read-modify-write で切り詰める
//     (SPAWN_LOG_MAX_BYTES=256KB / 1行数十バイトなので通常は一生到達しない)。
//     ここは「追記のみ」ではない: 切り詰めの読み→書きの間に他プロセスが追記した行は落ちうる。
//     それでも置いているのは、上限が無いと同期フォルダに載る meta 経由で無限に太るため。
//     ★「追記のみ」と書いておきながら実装がそうでない、という食い違いを残さないためにここに明記する。
//
// ■ 行の形式
//   `<epoch_ms> <line>`(Rust の log_spawn と同じ)。**唯一の例外がインストーラの行**で、
//   NSIS からは epoch ms を安価に作れないため `YYYY-MM-DD HH:MM:SS [installer] …` の
//   ローカル時刻で始まる。読み手(readSpawnLogTail)は行をそのまま返すだけなので解釈は壊れない。

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Rust が追記する spawn ログのパス(%APPDATA%/jp225-monitor/sidecar-spawn.log)。 */
export function resolveSpawnLogPath(): string {
  const base = process.env.APPDATA ?? process.env.HOME ?? process.cwd();
  return join(base, 'jp225-monitor', 'sidecar-spawn.log');
}

/** 末尾 N 行を読む。**例外を投げない**(無ければ空配列)。
 *  ファイルは1起動あたり数行なので全読みで十分(Rust 側が上限行数で切り詰める)。 */
export function readSpawnLogTail(path: string = resolveSpawnLogPath(), maxLines = 12): string[] {
  try {
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '');
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/** これを超えたら末尾だけ残して切り詰める(1行が短いので通常は到達しない)。 */
export const SPAWN_LOG_MAX_BYTES = 256 * 1024;
/** 切り詰め後に残す行数(Rust 側 SPAWN_LOG_MAX_LINES と同じ考え方)。 */
export const SPAWN_LOG_KEEP_LINES = 200;

/** このログの1行の上限(スタックトレースで tail が埋まらないように切る。全文は各プロセスの
 *  ファイルログ側に残っているので、ここは「いつ・何が起きたか」が読めれば十分)。 */
export const SPAWN_LOG_MAX_LINE = 600;

/** ★1行に畳む。このファイルは **1レコード=1行** が前提(Rust も行数で切り詰める)。
 *  スタックトレースをそのまま入れると readSpawnLogTail が断片を別レコードとして返してしまう。 */
export function oneLine(s: string, maxLen: number = SPAWN_LOG_MAX_LINE): string {
  const flat = s.replace(/\r?\n/g, ' ⏎ ').trim();
  return flat.length <= maxLen ? flat : `${flat.slice(0, maxLen)}…(以下略)`;
}

/** 1行追記する。**絶対に throw しない**(ログのためにプロセスを落とさない)。
 *  形式は Rust の log_spawn と同じ `<epoch_ms> <line>`(readSpawnLogTail はそのまま読む)。 */
export function appendSpawnLog(
  line: string, now: number = Date.now(), path: string = resolveSpawnLogPath(),
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${now} ${oneLine(line)}\n`, 'utf-8');
    trimSpawnLog(path);
  } catch { /* 書けないこと自体はコンソールに出ている(ここで落とさない) */ }
}

/** ★「同じ失敗が続いている」を共用ログに出す頻度(純関数)。
 *
 *  なぜ要るか: 握りつぶして周回を続ける経路(collector の poll など)は、1回の失敗では止めないのが
 *  正しい一方、**続いていること** は外に出さないと「生きているのに何もしていない」が無音になる。
 *  かといって毎回書くと共用ログが1つの失敗で埋まり、他プロセスの記録を押し流す。
 *  → 最初に「明らかに一時的ではない」と言える回数で1行、あとは間隔をあけて1行。
 *
 *  @param streak 連続失敗回数(1 始まり)
 *  @param firstAt 最初に書く回数
 *  @param everyN 以降、何回ごとに書くか */
export function shouldReportStreak(streak: number, firstAt = 5, everyN = 150): boolean {
  if (streak < firstAt) return false;
  return streak === firstAt || (streak - firstAt) % everyN === 0;
}

/** ★生成器が「別インスタンスに pid ロックを取られていて起動を保留している」ことを表す目印。
 *  生成器サイドカー(書き手)と monitor のハートビート(読み手)で **同じ文字列** を使うための唯一の出どころ。
 *  ここに置くのは、両者が共通して依存できる一番軽いモジュールだから(生成器の重い依存を monitor に持ち込まない)。 */
export const GENERATOR_PID_LOCK_BLOCKED_MARK = 'pidロックを取得できません';

/** 肥大したときだけ末尾 N 行に切り詰める(★ここだけ read-modify-write)。失敗しても無視(次回また試す)。 */
export function trimSpawnLog(
  path: string, maxBytes: number = SPAWN_LOG_MAX_BYTES, keep: number = SPAWN_LOG_KEEP_LINES,
): void {
  try {
    if (!existsSync(path) || statSync(path).size <= maxBytes) return;
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/).filter(l => l.trim() !== '');
    writeFileSync(path, `${lines.slice(-keep).join('\n')}\n`, 'utf-8');
  } catch { /* ignore */ }
}
