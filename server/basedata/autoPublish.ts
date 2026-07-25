// 基礎データの自動公開スケジューラ(monitor2=full 専用)。
// 平日(月-金)に「その日 8:00 以降の初回チェック」で1回だけ publish を実行する catch-up 方式。
// 固定 8:00 タイマーではなく、5分ごと+起動直後の周期チェックで「8時以降にアプリを開けばその日1回」動く。
// アプリ/サーバ稼働中のみ動作(PCが終日オフなら発火しない=仕様どおり)。creds/token はログに出さない。

import { loadConfig, resolveBasedataCreds } from '../configStore.js';
import { resolveVariant } from '../variant.js';
import { openDb, resolveDbPath, getMeta, setMeta } from '../db/store.js';
import { runBasedataPublish, isPublishInFlight } from '../routes/basedata.js';

const CHECK_INTERVAL_MS = 5 * 60_000;   // 周期チェック(5分)
const INITIAL_DELAY_MS = 10_000;        // 起動直後の初回チェック(8時以降に開いたらすぐ発火)
const FAIL_THROTTLE_MS = 30 * 60_000;   // 失敗時の再試行間隔(同日内)
const LAST_DATE_KEY = 'basedata_auto_last_date';     // 直近成功日(YYYY-MM-DD)
const LAST_RESULT_KEY = 'basedata_auto_last_result'; // 直近結果サマリ(UI表示用)

// ローカル YYYY-MM-DD。
export function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface AutoRunDecision {
  enabled: boolean;
  hasCreds: boolean;
  variant: string;
  weekday: number;   // getDay(): 0=日 .. 6=土
  hour: number;      // getHours()
  todayStr: string;
  lastDate: string | null;   // 直近成功日(meta)
  lastAttemptMs: number;     // 直近試行(in-memory)
  nowMs: number;
}

/** 自動公開を今 走らせるべきか(純関数=テスト対象)。
 *  無効/creds無し/lite/週末/8時前/本日実行済み/失敗スロットル中 は false。 */
export function shouldAutoRun(d: AutoRunDecision): boolean {
  if (!d.enabled) return false;
  if (!d.hasCreds) return false;
  if (d.variant !== 'full') return false;              // lite では絶対に走らせない(ハードゲート)
  if (d.weekday < 1 || d.weekday > 5) return false;    // 月-金のみ
  if (d.hour < 8) return false;                        // 8:00 以降
  if (d.lastDate === d.todayStr) return false;         // 本日は公開済み
  if (d.nowMs - d.lastAttemptMs < FAIL_THROTTLE_MS) return false;  // 失敗スロットル中
  return true;
}

let lastAttemptMs = 0;
let credWarned = false;

/** 1回のチェック。条件を満たせば公開を実行し、成功/失敗を meta に記録する。 */
export async function maybeAutoPublish(now: Date = new Date()): Promise<void> {
  const cfg = loadConfig();
  if (cfg.basedataAutoPublish !== true) return;        // 無効(既定)
  if (resolveVariant() !== 'full') return;             // belt-and-suspenders: lite は走らせない
  if (isPublishInFlight()) return;                     // 手動ボタン等と重ならない

  const { user, pass } = resolveBasedataCreds();
  const hasCreds = !!(user && pass);
  if (!hasCreds) {
    if (!credWarned) {
      console.warn('[basedata-auto] 自動公開は有効ですが 225labo の資格情報が未設定のためスキップします。');
      credWarned = true;   // creds 値はログに出さない。設定されたら次回また警告できるようリセット。
    }
    return;
  }
  credWarned = false;

  const todayStr = localDateStr(now);
  const db = openDb(resolveDbPath());
  let lastDate: string | null;
  try { lastDate = getMeta(db, LAST_DATE_KEY); } finally { db.close(); }

  const decision: AutoRunDecision = {
    enabled: true, hasCreds: true, variant: 'full',
    weekday: now.getDay(), hour: now.getHours(),
    todayStr, lastDate, lastAttemptMs, nowMs: now.getTime(),
  };
  if (!shouldAutoRun(decision)) return;

  lastAttemptMs = now.getTime();   // 成否に関わらず試行時刻を更新(失敗スロットルの基点)
  try {
    const r = await runBasedataPublish();
    const summary = `${todayStr} ${r.count}本 〜${r.lastDate} 公開`;
    const db2 = openDb(resolveDbPath());
    try {
      setMeta(db2, LAST_DATE_KEY, todayStr);       // 本日成功=以降スキップ
      setMeta(db2, LAST_RESULT_KEY, summary);
    } finally { db2.close(); }
    console.log(`[basedata-auto] ${summary}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[basedata-auto] 自動公開に失敗しました: ${reason}`);   // creds/token は含めない
    const db2 = openDb(resolveDbPath());
    try { setMeta(db2, LAST_RESULT_KEY, `${todayStr} 失敗: ${reason}`); } finally { db2.close(); }
    // last_date は更新しない=30分スロットル後に同日内で再試行する。
  }
}

/** スケジューラ起動: 起動直後の初回チェック + 5分ごとの周期チェック。full 変種でのみ startup から呼ぶ。 */
export function startBasedataAutoScheduler(): void {
  setTimeout(() => { void maybeAutoPublish(); }, INITIAL_DELAY_MS);
  setInterval(() => { void maybeAutoPublish(); }, CHECK_INTERVAL_MS);
  console.log('[basedata-auto] 自動公開スケジューラを開始しました(平日8:00以降の初回・monitor2専用)。');
}
