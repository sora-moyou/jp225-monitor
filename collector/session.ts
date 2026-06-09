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

// 平日でも日経225先物が取引されない休場日 (sessionDate=セッション開始日 が一致したら休場)。
// 元日/年始/年末は毎年。2026は勤労感謝の日(11/23)も JPX グループ BCP テストのため休場。
// 注: 1/3 は土曜のため週末ロジックで既に除外。年ごとに手動メンテする。
const HOLIDAYS = new Set<string>([
  '2026-01-01',  // 元日
  '2026-01-02',  // 年始休業
  '2026-11-23',  // 勤労感謝の日 (2026は BCP テストのため休場)
  '2026-12-31',  // 年末休業
]);

/** セッション判定。休場帯/週末/休場日は null。 */
export function classifySession(epochMs: number): SessionInfo | null {
  const { dow, mod, date } = jstParts(epochMs);
  let info: SessionInfo | null = null;
  if (isWeekday(dow) && mod >= DAY_OPEN && mod < DAY_CLOSE) info = { sessionDate: date, session: 'Day' };
  else if (isWeekday(dow) && mod >= NIGHT_OPEN) info = { sessionDate: date, session: 'Night' };
  else if (mod < NIGHT_MORN_CLOSE) {
    const prev = jstParts(epochMs - DAY_MS);
    if (isWeekday(prev.dow)) info = { sessionDate: prev.date, session: 'Night' };
  }
  // セッション開始日が休場日なら、その Day/Night(翌朝の続きも含む)はすべて非取引。
  if (info && HOLIDAYS.has(info.sessionDate)) return null;
  return info;
}

// ── 東証 現物(個別株 .T)の立会時間帯。先物(8:45-15:45/夜間)とは別物。
// AI が個別株を「今リアルタイムに動いている」材料として誤用しないための判定。
// 昼休み(11:30-12:30)は取引停止だが、朝の値動きは新鮮で連動材料として有効(ユーザー指定)なので
// 9:00-15:30 を**連続**で「引用可(=立会時間帯)」と扱う。夜間・早朝は前回終値で停止=false。
const CASH_OPEN = 9 * 60;          // 9:00
const CASH_CLOSE = 15 * 60 + 30;   // 15:30(大引け・2024拡大後)
/** 東証現物の立会時間帯か。平日 9:00-15:30 JST(昼休み含む・休場日・週末は false)。 */
export function tokyoCashOpen(epochMs: number): boolean {
  const { dow, mod, date } = jstParts(epochMs);
  if (!isWeekday(dow) || HOLIDAYS.has(date)) return false;
  return mod >= CASH_OPEN && mod < CASH_CLOSE;
}

export const OPEN_GUARD_BARS = 3;   // 寄りから3本(=3分)は抑制

/** 立会開始(寄付)からの分オフセット。非取引時間は null。
 *  Day=8:45起点、Night=17:00起点。早朝継続(00:00-06:00)は前日Nightの大きなオフセットになり寄付近傍にならない。 */
export function minutesFromOpen(epochMs: number): number | null {
  const s = classifySession(epochMs);
  if (!s) return null;
  const j = new Date(epochMs + JST_OFFSET);
  const mod = j.getUTCHours() * 60 + j.getUTCMinutes();
  if (s.session === 'Day') return mod - DAY_OPEN;            // 8:45起点 (525)
  if (mod >= NIGHT_OPEN) return mod - NIGHT_OPEN;            // 当日 17:00起点 (1020)
  return (24 * 60 - NIGHT_OPEN) + mod;                       // 早朝継続 = 420 + mod (寄付から十分離れる)
}

/** 寄りから OPEN_GUARD_BARS 本以内か(=最初の3分。trueなら全アラート抑制)。 */
export function isWithinOpenGuard(epochMs: number, nBars: number = OPEN_GUARD_BARS): boolean {
  const off = minutesFromOpen(epochMs);
  return off !== null && off >= 0 && off < nBars;
}

const LEAD_MS = 5 * 60_000;    // 開始5分前から
const TRAIL_MS = 10 * 60_000;  // 終了10分後まで

/** 収集プロセスがポーリングすべき時間帯か (セッション ± マージン)。 */
export function inPollWindow(epochMs: number): boolean {
  return classifySession(epochMs) !== null
    || classifySession(epochMs + LEAD_MS) !== null
    || classifySession(epochMs - TRAIL_MS) !== null;
}
