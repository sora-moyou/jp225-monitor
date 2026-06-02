export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number; openT: number;   // セッション最初のバー時刻(寄り欠け判定用)
}

// セッションの寄り(Day=8:45 / Night=17:00 JST)を UTC epoch に。
export const DAY_OPEN_MIN = 8 * 60 + 45, NIGHT_OPEN_MIN = 17 * 60;
export const COMPLETE_TOL_MS = 12 * 60_000;   // 最初のバーが寄りからこの範囲内なら「寄りから揃っている」とみなす
export function sessionOpenEpoch(sd: string, ses: 'Day' | 'Night'): number {
  const [y, m, d] = sd.split('-').map(Number);
  const min = ses === 'Day' ? DAY_OPEN_MIN : NIGHT_OPEN_MIN;
  return Date.UTC(y!, m! - 1, d!, Math.floor(min / 60), min % 60) - 9 * 3600_000;   // JST壁時計→UTC
}
/** セッションのデータが寄りから揃っているか(収集開始が遅れて寄り欠けのセッションは高安が不正確)。 */
export function isSessionComplete(s: SessionOHLC): boolean {
  return s.openT <= sessionOpenEpoch(s.sessionDate, s.session) + COMPLETE_TOL_MS;
}
