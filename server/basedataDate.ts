// 基礎データ(N225mini xlsx '1min' シート)の「A列(セッション日付シリアル)+ B列(時刻=1日小数)」を
// 実時刻 epoch(ms)へ変換する純関数群。publish(scripts/basedata-publish.mts)と取り込み側テストの
// 唯一の正準実装(SSOT)。store/session 等への依存は持たない。
//
// 【日付規約】(ライブDB突合で確定 2026-06-06)
// A列は実カレンダー日付ではなく OSE の「セッション日付」。夜間(17:00→翌6:00)は **次のデイセッションの
// 日付 = 翌営業日** でラベルされる(水曜夜→木 / 木曜夜→金 / 金曜夜→月=週末跨ぎ)。よって A をそのまま
// 実日付に使うと夜間が(特に金曜は週末ぶん)未来へずれる。下の rowToBar で実日付へ逆変換する。
// 取り込み後の session_date(=寄付日)は classifySession(t) が別途決める(規約が DB と逆な点に注意:
// DB session_date=寄付日 / 基礎データ A列=翌営業日。詳細は memory reference-basedata-dates)。
//
// 【未来データの扱い】正しくマッピングできていれば未来時刻のバーは出ない。出た場合は「日付バグ」として
// 扱う。中止/ドロップの実施箇所は取り込み方法を参照: server/basedata.ts:importBars(ドロップ+error ログ)
// と scripts/basedata-publish.mts(publish 中止)が同じ「未来=バグ」方針を実装する。

export interface BaseBar { t: number; o: number; h: number; l: number; c: number; v: number | null; }

export const EXCEL_1970 = 25569;            // 1970-01-01 の Excel シリアル(1900日付系)
const JST_OFFSET_MS = 9 * 3600_000;

function isWeekendSerial(serial: number): boolean {
  const dow = new Date((serial - EXCEL_1970) * 86400_000).getUTCDay();   // 0=日, 6=土
  return dow === 0 || dow === 6;
}
function prevBusinessDaySerial(serial: number): number {
  let s = serial - 1;
  while (isWeekendSerial(s)) s--;            // 週末スキップ(祝日は未対応=近似)
  return s;
}

/** A列(セッション日付シリアル) + 時刻(1日小数) → 実時刻 epoch ms(分床へ丸め)。
 *  夕方(τ≥16:00 ≒ 夜間17:00〜) → 実日付 = A の前営業日
 *  早朝(τ<08:00 ≒ 翌0:00–6:00) → 実日付 = A の前営業日 + 1暦日
 *  日中(08:45–15:45)            → 実日付 = A */
export function rowToBar(serialDate: number, timeFrac: number,
  o: number, h: number, l: number, c: number, v: number | null): BaseBar {
  let realSerial: number;
  if (timeFrac >= 16 / 24) realSerial = prevBusinessDaySerial(serialDate);            // 夕方 = 前営業日
  else if (timeFrac < 8 / 24) realSerial = prevBusinessDaySerial(serialDate) + 1;     // 早朝 = 前営業日 + 1暦日
  else realSerial = serialDate;                                                        // 日中 = D
  const dayMs = (realSerial - EXCEL_1970) * 86400_000;
  const minMs = Math.round((timeFrac * 86400_000) / 60_000) * 60_000;
  return { t: dayMs + minMs - JST_OFFSET_MS, o, h, l, c, v };
}
