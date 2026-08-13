// 常駐プロセスの **pid ファイル**(= 外から死活が見える唯一の証拠)。
//
// ■ なぜ要るか
//   collector は %APPDATA%/jp225-monitor/collector.pid を書くので「居るのか / 居ないのか」を
//   外から1秒で確かめられる。分析用は **何も残していなかった** ため、
//   「起動していない」のか「待機していただけ」なのかを外から区別する手段がゼロで、
//   実取引PCの調査が長引いた(共有DBのハートビートは分析用自身が書けるときしか出ない)。
//
// ■ ★新しい機構は作らない
//   collector が既にやっている流儀(pid ファイル + kill(pid,0) の生存判定 + 生きていれば起動しない)を
//   そのまま部品にして、collector と分析用の **両方が同じ実装を使う**(知識を複製しない)。
//   collector/lock.ts はこのモジュールの薄い包み。
//
// ■ ★pid の同一性検証(Rust 側と同じ考え方に揃える)
//   `kill(pid,0)` は **pid が実在するか** しか言わない。強制終了(taskkill /F)や process.exit(0) では
//   pid ファイルが消えないので **stale pid が常態** で、その pid を OS が別プロセスに再利用すると
//   「生きている」= 起動しない、と誤判定して常駐プロセスが二度と上がらなくなる。
//   同じリリースの Rust 側(src-tauri/src/lib.rs の is_alive_with_image)は、まさにこの pid 再利用対策に
//   **イメージ名の照合** を入れている。TS 側だけ素の kill(pid,0) では、同じ危険に二つの基準になる。
//   → ここでも tasklist で **イメージ名まで確かめる**(照合の材料は Rust と同じ)。
//   ★新しい機構は増やさない: pid ファイルの中身は従来どおり `String(pid)` のまま
//     (形式を変えると既存の collector.pid / 既存の読み手がすべて巻き添えになる)。
//     照合する名前は「自分自身の実行ファイル名」= 同じバイナリだけが自分のロックを持ちうる、という規則。
//   ★tasklist が使えない環境(非 Windows / 実行不能)では **従来の kill(pid,0) に戻す**。
//     判定できないときに「死んでいる」へ倒すと二重起動を許すので、保護側(生存扱い)に倒す。

import { join, dirname, basename } from 'node:path';
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveDbPath } from './db/store.js';

/** pid ファイルを置くフォルダ(%APPDATA%/jp225-monitor)。無ければ作る。 */
export function pidLockDir(): string {
  const dir = dirname(resolveDbPath());
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** pid ファイルのフルパス。fileName は 'collector.pid' のような単純名。 */
export function pidLockPath(fileName: string): string {
  return join(pidLockDir(), fileName);
}

/** プロセスが生存しているか (kill(pid,0))。存在しなければ false。EPERM は生存扱い。 */
export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** tasklist の1行から `{image, pid}` を取り出す(純関数=テストできる)。
 *  CSV 行例: `"jp225-generator.exe","1234","Console","1","50,000 K"`
 *  ★「該当なし」のときの文言(`INFO: No tasks…` / `情報: 指定された条件に…`)は
 *    この形に一致しないので、ロケールに関係なく落ちる。 */
export function parseTasklistRow(line: string): { image: string; pid: number } | null {
  const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
  if (!m) return null;
  const pid = Number(m[2]);
  return Number.isInteger(pid) ? { image: m[1]!, pid } : null;
}

/** tasklist の出力から、その pid のイメージ名を取り出す(純関数)。無ければ null。 */
export function imageFromTasklist(output: string, pid: number): string | null {
  for (const line of output.split(/\r?\n/)) {
    const row = parseTasklistRow(line);
    if (row && row.pid === pid) return row.image;
  }
  return null;
}

/** イメージ名の問い合わせ結果。
 *  ・`{ ok: true, image: 'x.exe' }` … その pid はこのイメージで動いている
 *  ・`{ ok: true, image: null }`    … その pid は **居ない**
 *  ・`{ ok: false, … }`             … ★問い合わせできなかった(判定材料が無い) */
export type ImageProbe = { ok: true; image: string | null } | { ok: false; error: string };

/** その pid のイメージ名を tasklist で確かめる。**例外を投げない**。 */
export function probeProcessImage(pid: number): ImageProbe {
  if (process.platform !== 'win32') return { ok: false, error: 'tasklist は Windows のみ' };
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf-8', windowsHide: true, timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, image: imageFromTasklist(out, pid) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 自分自身の実行ファイル名(SEA なら jp225-generator.exe / 開発時は node.exe)。 */
export function ownImageName(): string {
  return basename(process.execPath);
}

/** pid が生存し、**かつイメージ名が一致する**か(Rust の is_alive_with_image と同じ考え方)。
 *  ★問い合わせに失敗したときだけ従来の kill(pid,0) に戻す(判定できないなら保護側=生存扱い)。 */
export function isAliveAsImage(pid: number, image: string = ownImageName()): boolean {
  const probe = probeProcessImage(pid);
  if (!probe.ok) return isAlive(pid);
  if (probe.image === null) return false;
  return probe.image.toLowerCase() === image.toLowerCase();
}

/** 既存pidと生存判定から「自分が取得してよいか」。純粋関数(テスト用)。 */
export function shouldAcquire(existingPid: number | null, alive: (pid: number) => boolean): boolean {
  if (existingPid === null) return true;
  return !alive(existingPid);
}

/** pid ファイルを読む。無い/壊れているときは null(=ロック無し扱い)。 */
export function readPidFile(path: string): number | null {
  try {
    const n = parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

/** ロック取得を試みる。別の生存インスタンスがあれば false。成功時は自分のpidを書く。
 *  @param alive 生存判定。既定は従来どおり kill(pid,0)。
 *    ★pid 再利用まで見るなら `isAliveAsImage` を渡す(分析用はそうしている)。 */
export function acquirePidLock(
  fileName: string, pid: number = process.pid, alive: (pid: number) => boolean = isAlive,
): boolean {
  const p = pidLockPath(fileName);
  if (!shouldAcquire(readPidFile(p), alive)) return false;
  writeFileSync(p, String(pid), 'utf-8');
  return true;
}

/** ロックの現況(取れなかった理由を人に説明するための材料)。**例外を投げない**。 */
export interface PidLockHolder {
  path: string;
  /** ロックファイルの中身(無ければ null)。 */
  pid: number | null;
  /** イメージ名の問い合わせ結果(pid が無ければ null)。 */
  probe: ImageProbe | null;
  /** 照合に使った自分のイメージ名。 */
  expectedImage: string;
}

export function inspectPidLock(fileName: string, image: string = ownImageName()): PidLockHolder {
  let path = fileName;
  try { path = pidLockPath(fileName); } catch { /* 解決できなければ名前だけ残す */ }
  const pid = readPidFile(path);
  return { path, pid, probe: pid === null ? null : probeProcessImage(pid), expectedImage: image };
}

/** 自分のロックを解放 (pidファイル削除)。
 *  ★**自分が持っているときだけ** 消す。取得できずに待機している2本目が終了するときに
 *    保持者のロックを消してしまう(=二重起動を許す)のを防ぐ。 */
export function releasePidLock(fileName: string, pid: number = process.pid): void {
  try {
    const path = pidLockPath(fileName);
    const owner = readPidFile(path);
    if (owner !== null && owner !== pid) return;   // 他人のロックには触らない
    rmSync(path, { force: true });
  } catch { /* ignore */ }
}
