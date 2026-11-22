// バックテスト用DB(Desktop/backtest-multiyear.db)の「祝日の前夜の夜間が、祝日の夜に置かれている」不備を
// 見つけて、直し方(何日ずらすか)を決める **純関数**。DB には触らない(読み書きは scripts/backtest-db/)。
//
// 【何が起きていたか】
//   基礎データ xlsx の夜間行は「次の取引日」のラベルで並ぶ。旧 rowToBar は夜間の実日付を
//   「ラベルの前営業日(土日だけ飛ばす)」で決めていたため、取引の無い祝日の前夜(例: 2018-01-05 金の夜・
//   ラベル 01-09 火)を 1 営業日あと(01-08 月=祝日の夜)に置いた。v0.9.116 で上流
//   (server/basedataDate.ts:rowsToBars = データ内の1つ前のラベル)は直ったが、DB は旧版で作られたまま。
//
// 【検出】 session='Night' で、同じ session_date の Day が無く、その日が平日。
//   (取引の無い日に夜間だけがある = その夜間は本来は別の日の夜)
// 【直し方】 その夜間の全ての足を「直前の Day セッションの session_date の夜」へ日数単位でずらす。
//   OHLCV は変えない。
// 【安全条件】 1つでも満たさなければ problems に積み、呼ぶ側は **全体を中止** する:
//   ・夜間の次のセッションが Day で、その日付を「土日だけ飛ばす前営業日」に戻すと、いまの夜間の日付になる
//     (= 旧 rowToBar の誤りで説明できる。説明できない夜間は動かさない)
//   ・直前のセッションが Day(=間に別のセッションが挟まっていない)
//   ・移動先の日付に既存の夜間が無い(同じ日に夜間が2つできない)
//   ・先頭(直前の Day が無い)夜間は、呼ぶ側が根拠付きで移動先を与えたときだけ動かす(headTargets)

export interface SessionSpan {
  sessionDate: string;          // 'YYYY-MM-DD'
  session: string;              // 'Day' | 'Night'
  startT: number;               // その (session_date, session) の min(t)
  endT: number;                 // max(t)
  bars: number;
}

export interface NightMove {
  fromDate: string;             // いまの session_date
  toDate: string;               // 直した後の session_date
  shiftDays: number;            // 何日前へずらすか(>0)
  shiftMs: number;              // shiftDays × 86400000(t から引く)
  startT: number; endT: number; bars: number;
  nextDayDate: string;          // 次の Day(= xlsx のラベル = 次の取引日)
  basis: 'prev-day' | 'head-target';
}

export interface DetectResult { moves: NightMove[]; problems: string[]; }

const DAY_MS = 86_400_000;
export const ymdToDayNum = (ymd: string): number => Date.parse(`${ymd}T00:00:00Z`) / DAY_MS;
export const dayNumToYmd = (n: number): string => new Date(n * DAY_MS).toISOString().slice(0, 10);
const dowOf = (ymd: string): number => new Date(ymdToDayNum(ymd) * DAY_MS).getUTCDay();
export const isWeekdayYmd = (ymd: string): boolean => { const d = dowOf(ymd); return d >= 1 && d <= 5; };

/** 土日だけを飛ばす前営業日(旧 rowToBar の近似を再現する。祝日は飛ばさない)。 */
export function weekendOnlyPrevYmd(ymd: string): string {
  let n = ymdToDayNum(ymd) - 1;
  while (!isWeekdayYmd(dayNumToYmd(n))) n--;
  return dayNumToYmd(n);
}

/** 平日で、同じ日付の Day が無い夜間(検出条件そのもの)。整合チェックにも使う。
 *  excludeFirst: データ全体の先頭セッション(その Day はデータの外=期間の境界)を数えない。
 *  整合チェックはこちらで数える(修復後の先頭 2017-12-29 夜間は、日中がデータの外にあるだけで正常)。 */
export function nightsWithoutDay(sessions: readonly SessionSpan[], opts: { excludeFirst?: boolean } = {}): SessionSpan[] {
  const dayDates = new Set(sessions.filter(s => s.session === 'Day').map(s => s.sessionDate));
  let firstT = Infinity;
  if (opts.excludeFirst) for (const s of sessions) firstT = Math.min(firstT, s.startT);
  return sessions.filter(s => s.session === 'Night' && !dayDates.has(s.sessionDate) && isWeekdayYmd(s.sessionDate)
    && s.startT !== firstT);
}

/** 時間が重なっているセッションの組(startT 順に並べて、前の endT >= 次の startT)。0 であるべき。 */
export function overlappingSessions(sessions: readonly SessionSpan[]): [SessionSpan, SessionSpan][] {
  const xs = [...sessions].sort((a, b) => a.startT - b.startT);
  const out: [SessionSpan, SessionSpan][] = [];
  for (let i = 1; i < xs.length; i++) if (xs[i - 1]!.endT >= xs[i]!.startT) out.push([xs[i - 1]!, xs[i]!]);
  return out;
}

/** 誤って置かれた夜間と、その移動先を決める。
 *  headTargets: 先頭(直前の Day が無い)夜間の移動先 { いまの日付: 正しい日付 }。根拠を持つ呼び手だけが渡す。 */
export function findMisplacedNights(
  sessions: readonly SessionSpan[],
  headTargets: Readonly<Record<string, string>> = {},
): DetectResult {
  const xs = [...sessions].sort((a, b) => a.startT - b.startT);
  const nightDates = new Set(xs.filter(s => s.session === 'Night').map(s => s.sessionDate));
  const suspects = new Set(nightsWithoutDay(xs));
  const moves: NightMove[] = [];
  const problems: string[] = [];
  const targets = new Set<string>();
  const headRepaired = new Set(Object.values(headTargets));

  for (let i = 0; i < xs.length; i++) {
    const n = xs[i]!;
    if (!suspects.has(n)) continue;
    const next = xs[i + 1];
    const prev = i > 0 ? xs[i - 1] : undefined;
    // 先頭の夜間が既に headTargets の移動先にある = 修復済み(冪等: 2回目は何もしない)
    if (!prev && headRepaired.has(n.sessionDate)) continue;
    if (!next || next.session !== 'Day') {
      problems.push(`${n.sessionDate} Night: 次のセッションが Day でない(${next ? next.sessionDate + ' ' + next.session : 'なし'})`);
      continue;
    }
    if (weekendOnlyPrevYmd(next.sessionDate) !== n.sessionDate) {
      problems.push(`${n.sessionDate} Night: 次の Day ${next.sessionDate} の「土日だけ飛ばす前営業日」が `
        + `${weekendOnlyPrevYmd(next.sessionDate)} で、旧 rowToBar の誤りでは説明できない`);
      continue;
    }
    let toDate: string;
    let basis: NightMove['basis'];
    if (prev) {
      if (prev.session !== 'Day') {
        problems.push(`${n.sessionDate} Night: 直前のセッションが Day でない(${prev.sessionDate} ${prev.session})`);
        continue;
      }
      toDate = prev.sessionDate; basis = 'prev-day';
    } else {
      const h = headTargets[n.sessionDate];
      if (!h) { problems.push(`${n.sessionDate} Night: 先頭の夜間で直前の Day が無い(headTargets 未指定のため動かさない)`); continue; }
      toDate = h; basis = 'head-target';
    }
    const shiftDays = ymdToDayNum(n.sessionDate) - ymdToDayNum(toDate);
    if (!(shiftDays > 0)) { problems.push(`${n.sessionDate} Night: 移動先 ${toDate} が前ではない`); continue; }
    // 既存の夜間との衝突。prev-day 経路では「toDate の夜間が、直後ではなく別の位置(時刻の異常な行)にある」
    // ときに、head-target 経路では「headTargets の日付に既に夜間がある」ときに到達する(どちらもテストあり)。
    if (nightDates.has(toDate)) {
      problems.push(`${n.sessionDate} Night: 移動先 ${toDate} に既に夜間がある`); continue;
    }
    // 今回の計画どうしの衝突。★構造上は到達しない: prev-day の移動先は「直前の Day」で、1つの Day の直後は
    //   1セッションしか無い。head-target の移動先は先頭より前の日付で、データ内のどの Day の日付とも重ならない
    //   (先頭より前に Day は無い)。それでも残すのは、上の前提(startT 順の隣接)が将来崩れたときに
    //   同じ日に夜間を2つ作るのを、件数の照合より手前で止めるため(安価な最後の網)。
    if (targets.has(toDate)) {
      problems.push(`${n.sessionDate} Night: 移動先 ${toDate} が他の夜間の移動先と重なる`); continue;
    }
    if (!isWeekdayYmd(toDate)) { problems.push(`${n.sessionDate} Night: 移動先 ${toDate} が土日`); continue; }
    targets.add(toDate);
    moves.push({
      fromDate: n.sessionDate, toDate, shiftDays, shiftMs: shiftDays * DAY_MS,
      startT: n.startT, endT: n.endT, bars: n.bars, nextDayDate: next.sessionDate, basis,
    });
  }
  return { moves, problems };
}
