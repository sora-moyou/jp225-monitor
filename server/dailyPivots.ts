// server/dailyPivots.ts — ★日足・週足のスイング高安(ピボット)を1分足から組み、今も効いているものだけを返す **純関数**。
//
// ■ なぜ在るか(2026-10 の実測)
//   重要価格(server/levels.ts の computeLevels)が見ている高安は、
//     ・セッション高安 … 最大24セッション(registry の fetchSessionsFor)≒ 2週間弱
//     ・反応水準       … 5日
//   しか届かない。そのため日足のスイング安値 62,530(2026-09-14 09:28・以後 10/15 まで未割れ)が
//   **候補にすら入らず**、重要価格に出なかった。bars_1m(NIY=F)には基礎データ由来の1分足が
//   2025-12-29 から入っているので、そこから日足・週足を組めば届く。
//
// ■ 取引日(=日足1本)の組み方
//   日足1本 = 「前の夜間セッション + 当日の日中セッション」。ラベルは **Day の sessionDate**。
//   ★core/session.ts の classifySession は Night の sessionDate を **セッション開始日** で返す
//     (金曜夜間の sessionDate は金曜)。だから日付で束ねると夜間が前日に入ってしまう。
//     ここでは **時系列順にセッションを並べ**、Day が来たら「直前の Night(あれば)+ その Day」で1本を閉じる。
//   ・最後の Day より後の Night は **進行中の取引日** に属する(まだ Day が来ていない)= 日足を作らない。
//   ・休場日(classifySession=null)の足は無視。祝日を挟んでも「直前の Night」は次の Day へ付く
//     (例: 11/20 金 夜間 → 11/23 月 休場 → 11/24 火 Day の日足に入る)。
//   ・★Night が2つ続いた(間の Day のデータが欠けた)ときは、古い方の Night を **捨てる**。
//     後ろの Day に混ぜると別の取引日の高安を偽って付けることになる(データ欠けは稀)。
//
// ■ 週足 = 取引日(Day の sessionDate)が属する週(月曜始まり)でまとめる。キーは週の月曜日。
//
// ■ 確定の定義(★右側の本数は確定足だけで数える)
//   ・日足: 現在時刻が その日の 15:45(日中の引け)以降。
//   ・週足: 現在時刻が その週の金曜 15:45 以降 かつ 週内の日足がすべて確定。
//     (金曜が休場の週は木曜の引けで実質終わっているが、金曜 15:45 まで待つ。遅れるだけで誤りにはならない)
//
// ■ 日足ピボット = **さかのぼり方式(高値/安値の階段)**(ユーザー確定・前後5本方式から置き換え)
//   h[n], l[n] = n取引日前の日足の高安。h[0], l[0] は進行中の当日(現値で即時拡張)。
//   ★h[0]/l[0] は **階段の起点としてだけ** 使い、出力(dailyPivotsOf)には含めない(★★の日足ピボットとして
//     表示も監視もしない)。現値に追従して動く値を固定水準にすると、下げ中に新安値のたびに「サポート」通知が
//     連発するため(2026-10 のアラート監査。levels.ts の「当日高安は固定水準にしない」方針とも揃える)。
//     当日高安は levels.ts の「当日高」「当日安」行で従来どおり出る。
//   ・高値列: h[0] から過去へさかのぼり、**初めて h[k] > 直前に採用した値** となる k を順に採用。
//       例: h[5] > h[4] > h[2] > h[0] >= 現値(h[1], h[3] は直前の採用値以下なので飛ばす)。
//       → 出力は h[5], h[4], h[2](h[0] は起点なので出さない)。
//   ・安値列: 対称。例: 現値 >= l[0] > l[1] > l[3] → 出力は l[1], l[3]。
//   ★採用は厳密な >(<)。同値は採用しない(= より新しい側の日が列に残る)。
//   ★言い換え(決定的に再計算できる形): 確定日 k の高値 h[k] は、**それより後(当日を含む)のどの日の高値よりも
//     厳密に高い** とき、そしてそのときに限り列の要素。これを日足の h/l の走査で判定する:
//       後の日 j で初めて h[j] >= h[k] になったら列から外れる。そのとき
//         h[j] >  h[k] … 「超えた」→ 下の「役割と寿命」で 超え→支持 に反転して残す
//         h[j] == h[k] … 同値 → 列は j(新しい側)に引き継がれるだけなので k は **捨てる**(同じ値を2行出さない)
//   ★表示の窓(現値±1500円)は levels.ts 側で掛ける。ここは列の全要素と反転済みを返す。
//
// ■ 週足ピボット: 前後 WEEKLY_PIVOT_SPAN(2)本の中で **厳密に** 最安/最高(同値は落とす=一意)。
//
// ■ 役割と寿命(要素の取引日が **終わった後** の日足を時系列に → 進行中の取引日 → 現値)
//   ・安値ピボット L: 未割れの間は「支持」。初めて価格 < L で「割れ→抵抗」に反転して残す。
//                     反転後に価格 > L になったら **削除**(機能しなくなった)。
//   ・高値ピボット H: 対称(超え→支持 に反転、反転後に < H で削除)。
//   ★判定は **日足の h/l** で行う(1分足の全走査はしない=ユーザー指定「日足なら1日1回で済む・計算に時間を
//     かけない」)。日足の h/l だけでは日中の順序が分からないので、規則を1つに決める:
//       **同じ取引日に「割れ」と「戻り」が両方起きても、その日は「反転」まで。削除の判定は翌取引日から。**
//     (例: L=60,000 の日足安値を、ある日 59,900 まで割って 60,100 まで戻した → その日は「割れ→抵抗」で残る。
//      翌日以降に 60,000 を超えたら削除。)
//   ★進行中の取引日も同じ規則: 当日に反転したもの(flippedToday)は当日中は削除しない。
//     当日より前に反転していたものは、当日に戻せば(1分足でも現値でも)即削除。
//   ★要素の足自身は見ない(その足の安値が L そのもの)。見るのはその取引日の **翌取引日** から
//     (週足は週の最後の取引日の翌取引日から)。
//
// ■ 計算の頻度(registry 側の約束・ユーザー指定)
//   ・DB(1分足)を読んで日足/週足を組み、ピボットと役割を確定するのは **起動時と、確定日足が1本増えた時だけ**
//     (= 1日1回。latestConfirmedTradingDate が変わった時)。
//   ・その間は毎ティック updateDailyPivotCache で **現値・当日高安とピボット本数ぶんの比較だけ**(DB を読まない)。
//
// ■ この関数は DB も時計も触らない(現在時刻は引数)。DB 読み込みと間引き(キャッシュ)は registry 側。

import { classifySession } from '../core/session.js';

/** 前後何本で週足ピボットを判定するか(ユーザー確定)。 */
export const WEEKLY_PIVOT_SPAN = 2;

const JST_OFFSET = 9 * 3600_000;
const DAY_MS = 86_400_000;
const BUCKET_MS = 15 * 60_000;       // セッション判定の使い回し単位(全境界が15分の倍数)
const DAY_CLOSE_MIN = 15 * 60 + 45;   // 15:45(core/session.ts の DAY_CLOSE と同じ。日中の引け)

/** 入力の1分足(この関数が使う分だけ)。 */
export interface PivotSrcBar { t: number; h: number; l: number }

/** 日足/週足1本。date = 日足は Day の sessionDate / 週足は週の月曜日。 */
export interface TfBar {
  date: string;
  h: number; l: number;
  hT: number; lT: number;   // 高安を付けた1分足の時刻(最初の到達)
  /** この足の最後の取引日の引け(15:45 JST)の epoch ms。ピボットの走査はここから。 */
  endMs: number;
  /** 確定済みか(★右側の本数はこれが true の足だけで数える)。 */
  confirmed: boolean;
}

/** 今も効いている日足/週足ピボット。 */
export interface DailyPivot {
  price: number;
  tf: 'D' | 'W';
  type: 'low' | 'high';
  /** 日足 = 取引日(Day の sessionDate)/ 週足 = 週の月曜日。 */
  date: string;
  /** 今の役割。安値ピボットは未割れ=support・割れ後=resistance(高値は対称)。 */
  role: 'support' | 'resistance';
  /** 一度抜けて役割が反転したか。 */
  flipped: boolean;
  /** ★進行中の取引日に反転したか(true の間は当日中に戻しても削除しない=同じ取引日は「反転」まで)。 */
  flippedToday?: boolean;
  /** 極値を付けた1分足の時刻。 */
  t: number;
}

/** 'YYYY-MM-DD' の 15:45 JST を epoch ms に。 */
function dayCloseMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!, Math.floor(DAY_CLOSE_MIN / 60), DAY_CLOSE_MIN % 60) - JST_OFFSET;
}
/** 'YYYY-MM-DD' を n 日ずらす。 */
function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!) + n * DAY_MS).toISOString().slice(0, 10);
}
/** その日が属する週の月曜日('YYYY-MM-DD')。 */
function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();   // 0=日
  return addDays(date, -((dow + 6) % 7));
}

/** 時刻昇順で、now より先の足と非有限の足を除いた配列。
 *  ★入力がすでに条件を満たしていれば(DB の ORDER BY t で読んだ通常の場合)**コピーせずそのまま返す**。
 *    25万本を毎回 filter で複製するのは無駄(起動時1回の計算時間の一部だった)。外れていた時だけ作り直す。 */
function sortedUpTo(bars: readonly PivotSrcBar[], now: number): readonly PivotSrcBar[] {
  let clean = true;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (!(b.t <= now) || !Number.isFinite(b.h) || !Number.isFinite(b.l) || (i > 0 && b.t < bars[i - 1]!.t)) { clean = false; break; }
  }
  if (clean) return bars;
  const out = bars.filter(b => b.t <= now && Number.isFinite(b.h) && Number.isFinite(b.l));
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.t < out[i - 1]!.t) { out.sort((a, b) => a.t - b.t); break; }
  }
  return out;
}

interface Seg { key: string; session: 'Day' | 'Night'; sessionDate: string; h: number; l: number; hT: number; lT: number }

/**
 * 1分足から取引日(日足)を組む。★古い→新しい順。進行中の Day は confirmed=false で末尾に残る。
 * 最後の Day より後の Night(=進行中の取引日の前半)は日足にしない。
 */
export function buildTradingDays(bars: readonly PivotSrcBar[], now: number): TfBar[] {
  return buildTradingDaysSorted(sortedUpTo(bars, now), now);
}

/** buildTradingDays の本体。★src は sortedUpTo 済み(昇順・now 以前・有限)であること。
 *  computeDailyPivots は整えた src を自分でも使うので、ここを直接呼んで絞り込みを二重にしない。 */
function buildTradingDaysSorted(src: readonly PivotSrcBar[], now: number): TfBar[] {
  const days: TfBar[] = [];
  let pendingNight: Seg | null = null;
  let cur: Seg | null = null;

  const close = (seg: Seg): void => {
    if (seg.session === 'Night') {
      // ★Night が2つ続いたら古い方は捨てる(間の Day が欠けた=別の取引日の高安を混ぜない)。
      pendingNight = seg;
      return;
    }
    const n: Seg | null = pendingNight;
    pendingNight = null;
    // 高安は「夜間 → 日中」の順に見る(同値なら先に付けた夜間の時刻を残す)。
    let h = seg.h, hT = seg.hT, l = seg.l, lT = seg.lT;
    if (n) {
      if (n.h >= h) { h = n.h; hT = n.hT; }
      if (n.l <= l) { l = n.l; lT = n.lT; }
    }
    const endMs = dayCloseMs(seg.sessionDate);
    days.push({ date: seg.sessionDate, h, l, hT, lT, endMs, confirmed: now >= endMs });
  };

  // ★classifySession は1本ごとに Date を作るので25万本だと重い(実測で計算時間の大半)。セッション境界
  //   (8:45 / 15:45 / 17:00 / 6:00)はすべて15分の倍数なので、15分枠ごとに1回だけ判定して使い回す
  //   (JST オフセット 9h も15分の倍数なので、UTC の15分枠でそのまま切れる)。
  let bucket = NaN;
  let bucketSession: ReturnType<typeof classifySession> = null;
  for (const b of src) {
    const k = Math.floor(b.t / BUCKET_MS);
    if (k !== bucket) { bucket = k; bucketSession = classifySession(k * BUCKET_MS); }
    const s = bucketSession;
    if (!s) continue;   // 休場/場外は無視
    const key = `${s.sessionDate}|${s.session}`;
    if (!cur || cur.key !== key) {
      if (cur) close(cur);
      cur = { key, session: s.session, sessionDate: s.sessionDate, h: b.h, l: b.l, hT: b.t, lT: b.t };
      continue;
    }
    if (b.h > cur.h) { cur.h = b.h; cur.hT = b.t; }
    if (b.l < cur.l) { cur.l = b.l; cur.lT = b.t; }
  }
  // 末尾: Day なら日足にする(進行中なら未確定)。Night は進行中の取引日の前半なので捨てる。
  if (cur && (cur as Seg).session === 'Day') close(cur);
  return days;
}

/** 取引日(日足)を週(月曜始まり)にまとめる。★古い→新しい順。 */
export function buildWeeks(days: readonly TfBar[], now: number): TfBar[] {
  const weeks: TfBar[] = [];
  const allConfirmed = new Map<string, boolean>();
  for (const d of days) {
    const wk = mondayOf(d.date);
    const last = weeks[weeks.length - 1];
    if (!last || last.date !== wk) {
      weeks.push({ date: wk, h: d.h, l: d.l, hT: d.hT, lT: d.lT, endMs: d.endMs, confirmed: false });
      allConfirmed.set(wk, d.confirmed);
      continue;
    }
    if (d.h > last.h) { last.h = d.h; last.hT = d.hT; }
    if (d.l < last.l) { last.l = d.l; last.lT = d.lT; }
    last.endMs = d.endMs;
    allConfirmed.set(wk, (allConfirmed.get(wk) ?? true) && d.confirmed);
  }
  for (const w of weeks) {
    // ★金曜 15:45 を過ぎ、かつ週内の日足がすべて確定していれば週足も確定。
    w.confirmed = (allConfirmed.get(w.date) ?? false) && now >= dayCloseMs(addDays(w.date, 4));
  }
  return weeks;
}

/**
 * 前後 span 本の中で **厳密に** 最安/最高の足の位置を返す。
 * ★右側は確定足だけで数える(未確定足は末尾にしか来ないので、確定足の範囲で窓を取る)。
 */
export function findTfPivots(bars: readonly TfBar[], span: number): { i: number; type: 'low' | 'high' }[] {
  let n = 0;
  while (n < bars.length && bars[n]!.confirmed) n++;
  const out: { i: number; type: 'low' | 'high' }[] = [];
  for (let i = span; i + span < n; i++) {
    let isLow = true, isHigh = true;
    for (let j = i - span; j <= i + span && (isLow || isHigh); j++) {
      if (j === i) continue;
      if (!(bars[i]!.l < bars[j]!.l)) isLow = false;
      if (!(bars[i]!.h > bars[j]!.h)) isHigh = false;
    }
    if (isLow) out.push({ i, type: 'low' });
    if (isHigh) out.push({ i, type: 'high' });
  }
  return out;
}

/** 状態遷移の1歩。hi/lo = その区間(日足 / 進行中の取引日 / 現値なら hi=lo=現値)の高安。
 *  ★区間の中では「反転」までしか進めない(同じ区間で割れ→戻りが起きても削除はしない)。
 *  sameDayFlip=true(=反転したのが今見ている取引日)なら、戻しても削除しない。
 *  tieDrops=true(日足の階段)なら、未反転のまま **同値** に並ばれたら捨てる(列は新しい側の日に引き継がれる)。
 *  戻り値 'deleted' = 機能しなくなった / 列から外れた。 */
type PivotState = { flipped: boolean; flippedNow: boolean } | 'deleted';
function step(
  type: 'low' | 'high', price: number, flipped: boolean, sameDayFlip: boolean, hi: number, lo: number, tieDrops: boolean,
): PivotState {
  const broke = type === 'low' ? lo < price : hi > price;      // 抜けた(安値は割れ / 高値は超え)
  const back = type === 'low' ? hi > price : lo < price;       // 反転後に元の側へ戻した
  if (!flipped) {
    if (broke) return { flipped: true, flippedNow: true };
    if (tieDrops && (type === 'low' ? lo === price : hi === price)) return 'deleted';
    return { flipped: false, flippedNow: false };
  }
  if (back && !sameDayFlip) return 'deleted';
  return { flipped: true, flippedNow: sameDayFlip };
}

const roleOf = (type: 'low' | 'high', flipped: boolean): 'support' | 'resistance' =>
  (type === 'low') !== flipped ? 'support' : 'resistance';

/** 'YYYY-MM-DD'(JST)の日付文字列。 */
const jstDate = (t: number): string => new Date(t + JST_OFFSET).toISOString().slice(0, 10);

/** その日に日中セッション(=取引日)があるか。休場日/週末は false。 */
function isTradingDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  return classifySession(Date.UTC(y!, m! - 1, d!, 10 - 9, 0))?.session === 'Day';   // その日の 10:00 JST
}

/**
 * ★直近の確定取引日(= 日中の引け 15:45 を過ぎた最後の Day の sessionDate)。休場日/週末は飛ばす。
 * registry はこれが変わった時だけ DB から再計算する(確定日足が1本増えた = 判定材料が増えた時だけ)。
 * O(数日) の計算で DB は触らない。
 */
export function latestConfirmedTradingDate(now: number): string | null {
  for (let k = 0; k < 15; k++) {
    const date = jstDate(now - k * DAY_MS);
    if (dayCloseMs(date) <= now && isTradingDate(date)) return date;
  }
  return null;
}

/** date より後の最初の取引日(進行中の取引日のラベル)。 */
function nextTradingDate(date: string): string {
  for (let k = 1; k < 15; k++) {
    const d = addDays(date, k);
    if (isTradingDate(d)) return d;
  }
  return addDays(date, 1);
}

/**
 * ★日足/週足ピボットのキャッシュ。registry が保持し、毎ティック updateDailyPivotCache で現値を当てる。
 * ・base   … **確定日まで** で判定した日足(階段の要素 + 反転済み)と週足。1日1回だけ作り、ティックでは変えない。
 * ・pivots … base に当日の高安(today*)を当てた結果。**毎ティック base から作り直す**(下の理由)。
 *            当日の h[0]/l[0] そのものは含めない(起点として列の判定に使うだけ。dailyPivotsOf も足さない)。
 * ・today* … 進行中の取引日のラベル日付と高安(DB の1分足 + その後の現値で拡張)。高安がまだ無ければ NaN。
 *            ★階段の起点(applyTodayRange の区間)専用。出力には出さない。
 * ★なぜ前回の pivots に現値を1歩ずつ当てず、毎回 base + 当日高安 から作り直すのか:
 *   同値の規則があるから。当日の途中で現値がちょうど H に並んだ瞬間に「列から外れた」と確定させてしまうと、
 *   その後 H を **超えても**「超え→支持」に戻せない。翌日に日足(当日高値 > H)から再計算すると反転になるので
 *   食い違う。base + 当日高安 から作れば、日足からの再計算と常に同じ結論になる(決定的)。コストは O(本数)。
 */
export interface DailyPivotCache {
  base: DailyPivot[];
  pivots: DailyPivot[];
  todayDate: string;
  todayHi: number; todayHiT: number;
  todayLo: number; todayLoT: number;
}

/** 区間(hi, lo)を進行中の取引日として pivots に当てる(新しい配列)。日足は同値で外れる規則つき。 */
function applyTodayRange(pivots: readonly DailyPivot[], hi: number, lo: number): DailyPivot[] {
  const out: DailyPivot[] = [];
  for (const p of pivots) {
    const st = step(p.type, p.price, p.flipped, !!p.flippedToday, hi, lo, p.tf === 'D');
    if (st === 'deleted') continue;
    const flippedToday = !!p.flippedToday || st.flippedNow;
    out.push(st.flipped === p.flipped && flippedToday === !!p.flippedToday
      ? p : { ...p, flipped: st.flipped, flippedToday, role: roleOf(p.type, st.flipped) });
  }
  return out;
}

/**
 * ★重い方(起動時と確定取引日が変わった時だけ)。1分足から日足/週足を組み、確定日までの判定を済ませ、
 * 進行中の取引日の1分足(DB に在るぶん)も当てたキャッシュを返す。現値はまだ当てない(updateDailyPivotCache)。
 */
export function buildDailyPivotCache(
  bars: readonly PivotSrcBar[], now: number, opts: { weeklySpan?: number } = {},
): DailyPivotCache {
  const src = sortedUpTo(bars, now);   // ★絞り込みはここで1回だけ(下は整えた src をそのまま使う)
  const days = buildTradingDaysSorted(src, now);
  const weeks = buildWeeks(days, now);
  const confirmedDays = days.filter(d => d.confirmed);
  // 進行中の取引日 = 最後の確定日足の引けより後の1分足すべて(末尾の夜間 + 進行中の日中)。
  const lastEnd = confirmedDays.length ? confirmedDays[confirmedDays.length - 1]!.endMs : -Infinity;
  let todayHi = NaN, todayLo = NaN, todayHiT = NaN, todayLoT = NaN;
  for (let k = src.length - 1; k >= 0 && src[k]!.t >= lastEnd; k--) {
    const b = src[k]!;
    // 後ろから見るので、同値は古い方(先に付けた方)の時刻で上書きする(NaN との比較は false → 初回も入る)。
    if (!(b.h < todayHi)) { todayHi = b.h; todayHiT = b.t; }
    if (!(b.l > todayLo)) { todayLo = b.l; todayLoT = b.t; }
  }
  const lastConfirmed = confirmedDays.length ? confirmedDays[confirmedDays.length - 1]!.date : null;
  const todayDate = lastConfirmed ? nextTradingDate(lastConfirmed) : jstDate(now);

  /** fromEndMs(要素の取引日の引け)より後の確定日足を1本ずつ当てる。戻り値 = 反転したか / null = 削除・列から外れた。 */
  const scan = (fromEndMs: number, type: 'low' | 'high', price: number, tieDrops: boolean): boolean | null => {
    let flipped = false;
    for (const d of confirmedDays) {
      if (d.endMs <= fromEndMs) continue;
      const st = step(type, price, flipped, false, d.h, d.l, tieDrops);
      if (st === 'deleted') return null;
      flipped = st.flipped;
    }
    return flipped;
  };

  let pivots: DailyPivot[] = [];   // ★ここに積むのは確定日までの判定(= base)
  // ── 日足(階段): 全確定日の高値/安値を候補に、後の日足で「列に残る / 超えられて反転 / 同値で外れる /
  //    反転後に戻されて削除」を判定。比較は 確定日数² 程度(1分足の量には依存しない)。
  for (const d of confirmedDays) {
    for (const type of ['high', 'low'] as const) {
      const price = type === 'high' ? d.h : d.l;
      const flipped = scan(d.endMs, type, price, true);
      if (flipped === null) continue;
      pivots.push({ price, tf: 'D', type, date: d.date, role: roleOf(type, flipped), flipped, flippedToday: false, t: type === 'high' ? d.hT : d.lT });
    }
  }
  // ── 週足: 前後 WEEKLY_PIVOT_SPAN 本の厳密な最安/最高(同値で外れる規則は無し=従来どおり)。
  for (const { i, type } of findTfPivots(weeks, opts.weeklySpan ?? WEEKLY_PIVOT_SPAN)) {
    const w = weeks[i]!;
    const price = type === 'low' ? w.l : w.h;
    const flipped = scan(w.endMs, type, price, false);
    if (flipped === null) continue;
    pivots.push({ price, tf: 'W', type, date: w.date, role: roleOf(type, flipped), flipped, flippedToday: false, t: type === 'low' ? w.lT : w.hT });
  }
  // 進行中の取引日(DB に在るぶん)。ここで反転したら flippedToday = 当日中は削除しない。
  const base = pivots;
  if (Number.isFinite(todayHi)) pivots = applyTodayRange(base, todayHi, todayLo);
  return { base, pivots, todayDate, todayHi, todayHiT, todayLo, todayLoT };
}

/**
 * ★軽い方(毎ティック・O(ピボット本数)・DB を読まない)。現値で当日高安を拡張し、base から列を作り直す
 * (反転 / 削除 / 同値で外れる)。新しいキャッシュを返す(入力は書き換えない)。registry は結果を書き戻す。
 * ★当日に反転したもの(flippedToday)は当日中に戻しても削除しない(日足の h/l で判定する規則と同じ。
 *   当日高安という「区間」を当てるので自然にそうなる)。
 */
export function updateDailyPivotCache(cache: DailyPivotCache, current: number, at: number): DailyPivotCache {
  if (!Number.isFinite(current)) return cache;
  const next = { ...cache };
  if (!(current <= next.todayHi)) { next.todayHi = current; next.todayHiT = at; }
  if (!(current >= next.todayLo)) { next.todayLo = current; next.todayLoT = at; }
  next.pivots = applyTodayRange(cache.base, next.todayHi, next.todayLo);
  return next;
}

/**
 * キャッシュから一覧を作る: **確定日由来の要素だけ**(当日の h[0]/l[0] で反転/削除/同値外れを当て済み)。
 * ★当日の h[0]/l[0] は含めない。階段の起点として cache.pivots の判定に効いているだけで、それ自体は
 *   現値に追従して動くので ★★の固定水準にしない(当日高安は levels.ts の「当日高」「当日安」行が出す)。
 */
export function dailyPivotsOf(cache: DailyPivotCache): DailyPivot[] {
  return [...cache.pivots];
}

/**
 * ★1分足と現値から、今も効いている日足/週足ピボットの一覧を返す(build → 現値1歩 → 一覧)。テスト・検証用の一括版。
 * @param bars    1分足(NIY=F)。昇順でなくてもよい。now より後の足は無視。
 * @param current 現値。非有限なら現値は使わない。
 * @param now     現在時刻(足の確定判定に使う)。
 */
export function computeDailyPivots(
  bars: readonly PivotSrcBar[], current: number, now: number, opts: { weeklySpan?: number } = {},
): DailyPivot[] {
  return dailyPivotsOf(updateDailyPivotCache(buildDailyPivotCache(bars, now, opts), current, now));
}

/**
 * 表示ラベル。例: `日足安値(9/14)` / `日足安値(9/14)割れ→抵抗` / `週足高値(10/5週)超え→支持`。
 * ★★は付けない: 日足ピボットの★は重要価格の行左端の「強さ」欄(tier)で示す(levels.ts が日足ピボットを含む表示行を常に tier2=★★、週足ピボットを含む表示行を最低 tier1=★ にする)。
 * ★「高」「安」を必ず含める(levels.ts の isImportant の正規表現で遠方ラダーにも拾われる)。
 */
export function dailyPivotLabel(p: DailyPivot): string {
  const [, m, d] = p.date.split('-');
  const md = `${Number(m)}/${Number(d)}${p.tf === 'W' ? '週' : ''}`;
  const head = `${p.tf === 'D' ? '日足' : '週足'}${p.type === 'low' ? '安値' : '高値'}`;
  const tail = p.flipped ? (p.type === 'low' ? '割れ→抵抗' : '超え→支持') : '';
  return `${head}(${md})${tail}`;
}
