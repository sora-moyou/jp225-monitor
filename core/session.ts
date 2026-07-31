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

// ══ 休場日テーブルは市場ごとに別物。総称名 `HOLIDAYS` を先物と現物で共用していたのが事故の元。
//    先物(デリバティブ)= DERIV_NON_TRADING / 東証現物 = CASH_HOLIDAYS。名前で用途が分かるようにする。
//
//    ★2つを分ける本質的な理由 = **メンテのとき調べるものが違う**:
//      ・CASH_HOLIDAYS(現物) = 「**国民の祝日 + 年末年始**」という単純規則をそのまま並べたもの。
//        市場固有の例外は無い。次の年を足す人は**祝日カレンダーを写すだけでよい**(実施可否の調査は不要)。
//      ・DERIV_NON_TRADING(先物) = 「**祝日取引を実施しない日**」という市場固有の例外リスト。
//        祝日は原則すべて取引ありで、BCP テスト等で年ごとに変わる → **毎年 JPX の告知を調べる必要がある**。
//
//    どちらも **平日に当たる日だけ** を列挙する(土日は週末ロジックで除外・不変条件テストで担保)。
//    包含関係: CASH_HOLIDAYS ⊇ DERIV_NON_TRADING(先物が止まる日は現物も必ず休場)。
//
// ★テーブルの有効期限。過ぎると無言で誤判定するので、期限まで HOLIDAY_TABLE_RENEW_LEAD_DAYS を
//   切ったら session.test.ts が赤くなる(= 年を越して誤判定する前に必ず気づく)。
export const HOLIDAY_TABLE_COVERED_THROUGH = '2027-12-31';
export const HOLIDAY_TABLE_RENEW_LEAD_DAYS = 90;

// 平日でも日経225先物が取引されない非取引日 (sessionDate=セッション開始日 が一致したら休場)。
//
// ★規則(OSE デリバティブ・2022/9 の祝日取引開始以降):
//   国民の祝日は原則すべて「祝日取引」で **取引あり**。取引が無いのは
//     ① 土日(週末ロジックで除外・この表には書かない)
//     ② 1月1日 / 1月2日 / 12月31日(年末年始。1/2 と 12/31 は「当分の間、祝日取引を実施しない」)
//     ③ JPX グループの BCP テスト日(その年ごとに個別に告知される祝日)
//   → だから「祝日カレンダー」ではなく、上の ②③ のうち **平日に当たる日** だけを列挙する。
//
// ★出典(2026-07-31 確認): 三菱UFJ eスマート証券「先物・オプション取引 祝日取引について」
//   https://kabu.com/item/fop/holiday.html — 1/2・12/31 の非実施、2026-11-23 と 2027-09-20 の
//   BCP テストによる非実施を明記。JPX 公式(jpx.co.jp)は当環境からの取得が 403 で不可だったため、
//   同内容を検索結果(JPX 告知の要約)でも突き合わせて一致を確認した。
//
// ★年ごとに手動メンテする。**次に足すのは 2028 年分**(2028-01-03 は月曜=平日なので要追加、
//   2028-01-01/02 は土日。2028 の BCP テスト日は未告知)。空のまま年を越すと正月が「取引時間」と
//   判定され、実弾 bot が動く。→ HOLIDAY_TABLE_COVERED_THROUGH も同時に更新すること。
export const DERIV_NON_TRADING: ReadonlySet<string> = new Set<string>([
  // ── 2026年 ───────────────────────────────────────────────
  '2026-01-01',  // 元日(木)
  '2026-01-02',  // 年始休業(金)
  '2026-11-23',  // 勤労感謝の日(月) — JPX グループ BCP テストのため祝日取引なし
  '2026-12-31',  // 年末休業(木)
  // 注: 2026-01-03 は土曜のため週末ロジックで既に除外。
  // ── 2027年 ───────────────────────────────────────────────
  '2027-01-01',  // 元日(金)
  '2027-09-20',  // 敬老の日(月) — 9/18〜20 の3連休で JPX グループ BCP テスト(DR切替)のため祝日取引なし
  '2027-12-31',  // 年末休業(金)
  // 注: 2027-01-02(土)/2027-01-03(日)は週末ロジックで既に除外。
]);

// 東証**現物**(個別株 .T)の休場日。
//
// ★規則: **土日 + 国民の祝日(すべて) + 年末年始(1/1・1/2・12/31)**。以上。
//   祝日取引はデリバティブだけの制度なので、現物は祝日を一律で休場にする。
//   つまりこの表は「日本の祝日カレンダー + 年末年始」であって、**市場固有の例外は一切持たない**。
//   → 次の年を足す人は祝日カレンダーを写すだけでよい(先物側と違い、実施可否を調べる必要はない)。
//   土日は週末ロジックで除外するのでこの表には書かない(下記の全日付は平日=テストで担保)。
//
// ★出典: **ユーザー提供の一覧(2026-08-01 時点)**。この表について自前の再調査はしていない。
// ★年ごとに手動メンテ。次に足すのは 2028 年分(HOLIDAY_TABLE_COVERED_THROUGH も同時更新)。
export const CASH_HOLIDAYS: ReadonlySet<string> = new Set<string>([
  // ── 2026年 ───────────────────────────────────────────────
  '2026-01-01',  // 元日(木)
  '2026-01-02',  // 年始休業(金)
  '2026-01-12',  // 成人の日(月)
  '2026-02-11',  // 建国記念の日(水)
  '2026-02-23',  // 天皇誕生日(月)
  '2026-03-20',  // 春分の日(金)
  '2026-04-29',  // 昭和の日(水)
  '2026-05-04',  // みどりの日(月)
  '2026-05-05',  // こどもの日(火)
  '2026-05-06',  // 憲法記念日 振替休日(水) — 5/3 が日曜のため
  '2026-07-20',  // 海の日(月)
  '2026-08-11',  // 山の日(火)
  '2026-09-21',  // 敬老の日(月)
  '2026-09-22',  // 国民の休日(火)
  '2026-09-23',  // 秋分の日(水)
  '2026-10-12',  // スポーツの日(月)
  '2026-11-03',  // 文化の日(火)
  '2026-11-23',  // 勤労感謝の日(月)
  '2026-12-31',  // 年末休業(木)
  // 注: 2026-01-03(土)・2026-05-03(憲法記念日/日)は週末ロジックで既に除外。
  // ── 2027年 ───────────────────────────────────────────────
  '2027-01-01',  // 元日(金)
  '2027-01-11',  // 成人の日(月)
  '2027-02-11',  // 建国記念の日(木)
  '2027-02-23',  // 天皇誕生日(火)
  '2027-03-22',  // 春分の日 振替休日(月) — 3/21 が日曜のため
  '2027-04-29',  // 昭和の日(木)
  '2027-05-03',  // 憲法記念日(月)
  '2027-05-04',  // みどりの日(火)
  '2027-05-05',  // こどもの日(水)
  '2027-07-19',  // 海の日(月)
  '2027-08-11',  // 山の日(水)
  '2027-09-20',  // 敬老の日(月)
  '2027-09-23',  // 秋分の日(木)
  '2027-10-11',  // スポーツの日(月)
  '2027-11-03',  // 文化の日(水)
  '2027-11-23',  // 勤労感謝の日(火)
  '2027-12-31',  // 年末休業(金)
  // 注: 2027-01-02(土)/2027-01-03(日)は週末ロジックで既に除外。
]);

/** 有効期限まで leadDays を切ったか(=次の年を足す時期)。テストがこれで赤くなる。 */
export function holidayTableNeedsRenewal(epochMs: number, leadDays = HOLIDAY_TABLE_RENEW_LEAD_DAYS): boolean {
  return jstParts(epochMs + leadDays * DAY_MS).date > HOLIDAY_TABLE_COVERED_THROUGH;
}

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
  if (info && DERIV_NON_TRADING.has(info.sessionDate)) return null;
  return info;
}

// ── 東証 現物(個別株 .T)の立会時間帯。先物(8:45-15:45/夜間)とは別物。
// AI が個別株を「今リアルタイムに動いている」材料として誤用しないための判定。
// 昼休み(11:30-12:30)は取引停止だが、朝の値動きは新鮮で連動材料として有効(ユーザー指定)なので
// 9:00-15:30 を**連続**で「引用可(=立会時間帯)」と扱う。夜間・早朝は前回終値で停止=false。
const CASH_OPEN = 9 * 60;          // 9:00
const CASH_CLOSE = 15 * 60 + 30;   // 15:30(大引け・2024拡大後)
/** 東証現物の立会時間帯か。平日 9:00-15:30 JST(昼休み含む・休場日・週末は false)。
 *  休場判定は **現物専用の CASH_HOLIDAYS**。先物用 DERIV_NON_TRADING を使うと祝日取引のせいで
 *  国民の祝日が「立会中」になり、前営業日の終値を「今動いている株価」として AI に渡してしまう。 */
export function tokyoCashOpen(epochMs: number): boolean {
  const { dow, mod, date } = jstParts(epochMs);
  if (!isWeekday(dow) || CASH_HOLIDAYS.has(date)) return false;
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

/**
 * 市場(日経225先物)が開いているか。価格ボードの「取引時間外」表示用。
 * ポーリング窓(セッション ± マージン)を市場開場とみなす。窓外(週末/休場日/セッション間)は false。
 * これにより「フィード障害(取得不能)」と「そもそも市場が閉まっている(取引時間外)」を UI が区別できる。
 */
export function isMarketOpen(epochMs: number): boolean {
  return inPollWindow(epochMs);
}
