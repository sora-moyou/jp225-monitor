// collector の単一インスタンス保証(pid ファイル)。
// ★実装は server/pidLock.ts に移した(生成器も同じ流儀で pid を残すため。知識を複製しない)。
//   ここは「どのファイル名か」だけを知っている薄い包み。外向きの API は従来どおり。

import {
  acquirePidLock, releasePidLock, isAlive, shouldAcquire,
} from '../server/pidLock.js';

/** collector の pid ファイル名。 */
export const COLLECTOR_PID_FILE = 'collector.pid';

export { isAlive, shouldAcquire };

/** ロック取得を試みる。別の生存インスタンスがあれば false。成功時は自分のpidを書く。 */
export function acquireLock(): boolean {
  return acquirePidLock(COLLECTOR_PID_FILE);
}

/** 自分のロックを解放 (pidファイル削除)。 */
export function releaseLock(): void {
  releasePidLock(COLLECTOR_PID_FILE);
}
