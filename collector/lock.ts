// collector の単一インスタンス保証(pid ファイル)。
// ★実装は server/pidLock.ts に移した(分析用も同じ流儀で pid を残すため。知識を複製しない)。
//   ここは「どのファイル名か」と「取れないときにどう待つか」だけを知っている薄い包み。

import {
  acquirePidLock, releasePidLock, isAlive, ownImageName, shouldAcquire, probeProcessImage,
  inspectPidLock, readPidFile, pidLockPath, type PidLockHolder, type ImageProbe,
} from '../server/pidLock.js';
import { writeFileSync, rmSync } from 'node:fs';
import { appendSpawnLog, GENERATOR_PID_LOCK_BLOCKED_MARK } from '../server/spawnLog.js';

/** collector の pid ファイル名。 */
export const COLLECTOR_PID_FILE = 'collector.pid';
/** ★ロック待ちの collector の pid ファイル名(待機者は常に1人=最後に来た者)。 */
export const COLLECTOR_WAIT_PID_FILE = 'collector.wait.pid';
/** ロックを再判定する間隔(分析用 PID_LOCK_RETRY_MS と同じ 60秒)。 */
export const COLLECTOR_LOCK_RETRY_MS = 60_000;

export { isAlive, shouldAcquire };

/** collector として動きうるイメージ名(小文字)。配布版の SEA と、開発時の `npm run collector:dev`(tsx → node.exe)。 */
export const COLLECTOR_IMAGES: readonly string[] = ['jp225-collector.exe', 'node.exe'];

/** ★保持者(または待機者)が「生きている collector」か。
 *
 *  ・pid が居て、イメージ名が **collector になりうるもの**(COLLECTOR_IMAGES か自分のイメージ名)なら生きている。
 *    ★自分のイメージ名と一致することまでは求めない: 配布版(jp225-collector.exe)が動いている PC で
 *      開発版(node.exe)を起動したとき(逆も)に「保持者は死んでいる」と判定してロックを奪い、
 *      2つの collector が同時に書き込んでしまう(エバリュエーター指摘の欠陥。以前の kill(pid,0) なら奪わなかった)。
 *  ・それ以外のイメージ名 = stale pid が別プロセスに再利用された → 死んだとみなす(pid 再利用対策は残す)。
 *  ・その pid が居ない → 死んでいる。
 *  ・tasklist で問い合わせできない → 従来の kill(pid,0) に戻す(判定できないなら保護側=生存扱い。pidLock.ts と同じ)。 */
export function isCollectorAlive(
  pid: number,
  own: string = ownImageName(),
  probe: (pid: number) => ImageProbe = probeProcessImage,
): boolean {
  const r = probe(pid);
  if (!r.ok) return isAlive(pid);
  if (r.image === null) return false;
  const image = r.image.toLowerCase();
  return image === own.toLowerCase() || COLLECTOR_IMAGES.includes(image);
}

/** ロック取得を試みる。別の生存インスタンスがあれば false。成功時は自分のpidを書く。
 *  @param own / probe テスト用(既定は自分のイメージ名と tasklist)。 */
export function acquireLock(
  own: string = ownImageName(),
  probe: (pid: number) => ImageProbe = probeProcessImage,
): boolean {
  return acquirePidLock(COLLECTOR_PID_FILE, process.pid, pid => isCollectorAlive(pid, own, probe));
}

/** 自分のロックを解放 (pidファイル削除)。 */
export function releaseLock(): void {
  releasePidLock(COLLECTOR_PID_FILE);
}

// ─── ★ロックが取れなくても抜けない(2026-11 の13日停止と同じ形の穴を塞ぐ) ──────────────
//
// ■ 何が起きうるか
//   collector はアプリを閉じても生き続ける。アプリを再起動すると、新しく spawn された collector は
//   ロックを取れずに **exit 0** で抜けていた。Rust の監視(src-tauri/src/lib.rs supervise_collector)は
//   0 を「再起動しない」と判断するので、そのあと **古い collector(どのアプリの監視下にも居ない)が落ちると、
//   誰も再起動しない** = 2026-10-28 からの13日停止と同じ形。
// ■ 方針(分析用 server/generator/sidecarRun.ts acquireGeneratorPidLock と同じ流儀)
//   取れなければ 60秒ごとに再判定して待つ。保持者が消えたらロックを取って収集を始める。
//   待機中は DB を開かない(=何も書かない)。待っている事実は sidecar-spawn.log に **1回だけ**、
//   取れたときも1行残す。これで「生き残っている待機中の collector」は Rust の監視下の子プロセスになる。
// ■ ★待機者を増やさない
//   アプリを何度も再起動すると待機者が積み上がる。→ 待機者は collector.wait.pid に自分を書き、
//   **後から来た者が勝つ**(来た瞬間に上書きする)。先に居た待機者は次の再判定で、ファイルが
//   「生きている別の collector」を指していれば身を引いて exit 0 で抜ける(Rust はそれを再起動しない=正しい:
//   新しい待機者は新しいアプリの監視下に居る)。ファイルの pid が死んでいれば取り戻す。

export type CollectorLockWait =
  | { kind: 'acquired'; tries: number }
  | { kind: 'superseded'; by: number; tries: number };

export interface CollectorLockWaitDeps {
  pid?: number;
  acquire?: () => boolean;
  inspect?: () => PidLockHolder;
  alive?: (pid: number) => boolean;
  readWaiter?: () => number | null;
  writeWaiter?: (pid: number) => void;
  clearWaiter?: () => void;
  report?: (line: string) => void;
  wait?: (ms: number) => Promise<void>;
  retryMs?: number;
  /** 無限に待たないための上限(テスト専用。既定は無し)。到達したら superseded(by=-1)で返す。 */
  maxTries?: number;
}

/** ロックが取れない理由の1行(純関数)。文言は分析用(describePidLockBlocked)と揃える。
 *  ★`[collector]` で始まる行として書くので、分析用の保留判定(pidLockBlockedFromSpawn は
 *    `[generator]` の行しか見ない)とは混ざらない。 */
export function describeCollectorLockBlocked(holder: PidLockHolder, retryMs: number = COLLECTOR_LOCK_RETRY_MS): string {
  const who = holder.pid === null ? 'ロックの中身が読めません' : `保持者 pid=${holder.pid}`;
  const image = holder.probe === null
    ? ''
    : holder.probe.ok
      ? ` イメージ=${holder.probe.image ?? '(そのpidは居ない)'}(照合対象=${holder.expectedImage})`
      : ` イメージ照合=できず(${holder.probe.error} — kill(pid,0) の判定に戻しました)`;
  return `★${GENERATOR_PID_LOCK_BLOCKED_MARK}: ${who}${image}`
    + ` — ${Math.round(retryMs / 1000)}秒ごとに再判定します(収集は保留・終了はしません) / ${holder.path}`;
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** ロックが取れるまで待つ。取れたら acquired、より新しい待機者に譲ったら superseded。 */
export async function waitForCollectorLock(deps: CollectorLockWaitDeps = {}): Promise<CollectorLockWait> {
  const pid = deps.pid ?? process.pid;
  const retryMs = deps.retryMs ?? COLLECTOR_LOCK_RETRY_MS;
  const acquire = deps.acquire ?? (() => acquireLock());
  const inspect = deps.inspect ?? (() => inspectPidLock(COLLECTOR_PID_FILE));
  const alive = deps.alive ?? ((p: number) => isCollectorAlive(p));
  const readWaiter = deps.readWaiter ?? (() => readPidFile(pidLockPath(COLLECTOR_WAIT_PID_FILE)));
  const writeWaiter = deps.writeWaiter ?? ((p: number) => { writeFileSync(pidLockPath(COLLECTOR_WAIT_PID_FILE), String(p), 'utf-8'); });
  const clearWaiter = deps.clearWaiter ?? (() => {
    // ★自分が書いた待機者ファイルだけ消す(後から来た待機者の印を消さない)。
    try {
      const path = pidLockPath(COLLECTOR_WAIT_PID_FILE);
      if (readPidFile(path) === pid) rmSync(path, { force: true });
    } catch { /* ignore */ }
  });
  const report = deps.report ?? ((line: string) => { appendSpawnLog(`[collector] ${line}`); });
  const wait = deps.wait ?? sleep;
  let tries = 0;
  let reported = false;
  for (;;) {
    if (acquire()) {
      if (tries > 0) {
        clearWaiter();
        const line = `収集を開始しました: pid ロックを取得(保留 ${tries} 回 / 約${Math.round(tries * retryMs / 1000)}秒)`;
        console.log(`[collector] ${line}`);
        report(line);
      }
      return { kind: 'acquired', tries };
    }
    // ── 待機者は1人だけ(後から来た者が勝つ) ──
    if (tries === 0) {
      writeWaiter(pid);
    } else {
      const w = readWaiter();
      if (w !== null && w !== pid && alive(w)) {
        const line = `待機を終了します: より新しい待機者 pid=${w} に譲りました(exit 0)`;
        console.log(`[collector] ${line}`);
        report(line);
        return { kind: 'superseded', by: w, tries };
      }
      if (w !== pid) writeWaiter(pid);   // 印が消えた/死んだ待機者を指している → 取り戻す
    }
    tries += 1;
    const reason = describeCollectorLockBlocked(inspect(), retryMs);
    console.log(`[collector] ${reason}`);
    // ★共用ログは **最初の1回だけ**(毎分1行積み上げて他プロセスの記録を押し流さない)。
    if (!reported) { report(reason); reported = true; }
    if (deps.maxTries !== undefined && tries >= deps.maxTries) return { kind: 'superseded', by: -1, tries };
    await wait(retryMs);
  }
}
