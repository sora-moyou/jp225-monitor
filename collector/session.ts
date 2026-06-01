// OSE 日経先物の取引セッション判定 (JST=UTC+9, 日本はDSTなし)。
// 週: 月 8:45 → 土 6:00。Day=8:45:00–15:45:00、Night=17:00:00→翌6:00:00。
export interface SessionInfo { sessionDate: string; session: 'Day' | 'Night'; }

const JST_OFFSET = 9 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** epoch ms を JST の {dow(0=日), minutesOfDay, dateStr 'YYYY-MM-DD'} に。 */
function jstParts(epochMs: number): { dow: number; mod: number; date: string } {
  const j = new Date(epochMs + JST_OFFSET);   // UTC ゲッタで JST 壁時計を読む
  return {
    dow: j.getUTCDay(),
    // 分粒度(秒は無視)。全セッション境界(8:45/15:45/17:00/6:00)が分ちょうどなので安全。
    // 将来、秒付きの境界を導入する場合はここを秒対応にすること。
    mod: j.getUTCHours() * 60 + j.getUTCMinutes(),
    date: j.toISOString().slice(0, 10),
  };
}
const isWeekday = (dow: number): boolean => dow >= 1 && dow <= 5;   // Mon–Fri

const DAY_OPEN = 8 * 60 + 45;     // 8:45
const DAY_CLOSE = 15 * 60 + 45;   // 15:45
const NIGHT_OPEN = 17 * 60;       // 17:00
const NIGHT_MORN_CLOSE = 6 * 60;  // 6:00

/** セッション判定。休場帯/週末は null。 */
export function classifySession(epochMs: number): SessionInfo | null {
  const { dow, mod, date } = jstParts(epochMs);
  if (isWeekday(dow) && mod >= DAY_OPEN && mod < DAY_CLOSE) return { sessionDate: date, session: 'Day' };
  if (isWeekday(dow) && mod >= NIGHT_OPEN) return { sessionDate: date, session: 'Night' };
  if (mod < NIGHT_MORN_CLOSE) {
    const prev = jstParts(epochMs - DAY_MS);
    if (isWeekday(prev.dow)) return { sessionDate: prev.date, session: 'Night' };
  }
  return null;
}

const LEAD_MS = 5 * 60_000;    // 開始5分前から
const TRAIL_MS = 10 * 60_000;  // 終了10分後まで

/** 収集プロセスがポーリングすべき時間帯か (セッション ± マージン)。 */
export function inPollWindow(epochMs: number): boolean {
  return classifySession(epochMs) !== null
    || classifySession(epochMs + LEAD_MS) !== null
    || classifySession(epochMs - TRAIL_MS) !== null;
}
