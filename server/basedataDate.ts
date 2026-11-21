// 基礎データ(N225mini xlsx '1min' シート)の「A列(セッション日付シリアル)+ B列(時刻=1日小数)」を
// 実時刻 epoch(ms)へ変換する純関数群。publish(scripts/basedata-publish.mts)と取り込み側テストの
// 唯一の正準実装(SSOT)。store/session 等への依存は持たない。
//
// 【日付規約】(ライブDB突合で確定 2026-06-06 / 祝日の扱いを実ファイルで確定 2026-11-21)
// A列は実カレンダー日付ではなく OSE の「セッション日付(=取引日)」。夜間(17:00→翌6:00)は
// **次の取引日** の日付でラベルされる(水曜夜→木 / 木曜夜→金 / 金曜夜→月=週末跨ぎ)。
// ★「次の取引日」は「翌営業日(土日だけ飛ばす)」ではない。休業する祝日・年末年始も飛ぶ。
//   実例(N225minif_2026.xlsx): 2026-11-20(金)の夜間 781行のラベルは 2026-11-24(火)
//   (11/23 勤労感謝の日は BCP テストで休業)。2026-01-05 ラベルの夜間は 2025-12-30(大納会)の夜。
// よって夜間の実日付は「カレンダー」ではなく **データ自身** から決める(rowsToBars):
//   夕方(τ≥16:00) → 実日付 = そのデータ内で「この行のラベルの1つ前に現れるラベル」(=前の取引日)
//   早朝(τ<08:00) → 実日付 = 同上 + 1暦日
//   日中           → 実日付 = A そのまま
// 1つ前のラベルがデータ内に無い(=先頭ラベルの夜間)ときだけ、土日だけ飛ばす近似
// (prevBusinessDaySerial)にフォールバックし、警告を出す。祝日カレンダーは持ち込まない(表は腐る)。
// 実ファイルは取引日単位で区切られている(2026 版の先頭ラベルは 2025-12-30 で、その夜間=12/29 夜から始まる)。
// 複数ファイルを扱うときは **全ファイルの行を連結してから** rowsToBars に渡すこと
// (年初の夜間の「1つ前のラベル」は前年ファイルにある)。
// 取り込み後の session_date(=寄付日)は classifySession(t) が別途決める(規約が DB と逆な点に注意:
// DB session_date=寄付日 / 基礎データ A列=次の取引日。詳細は memory reference-basedata-dates)。
//
// 【未来データの扱い】正しくマッピングできていれば未来時刻のバーは出ない。出た場合は「日付バグ」として
// 扱う。中止/ドロップの実施箇所は取り込み方法を参照: server/basedata.ts:importBars(ドロップ+error ログ)
// と scripts/basedata-publish.mts(publish 中止)が同じ「未来=バグ」方針を実装する。

export interface BaseBar { t: number; o: number; h: number; l: number; c: number; v: number | null; }

/** xlsx の1行(A=セッション日付シリアル, B=時刻小数, OHLCV)。 */
export interface BaseRow {
  serialDate: number; timeFrac: number;
  o: number; h: number; l: number; c: number; v: number | null;
}

export const EXCEL_1970 = 25569;            // 1970-01-01 の Excel シリアル(1900日付系)
const JST_OFFSET_MS = 9 * 3600_000;
const EVENING_FROM = 16 / 24;               // これ以降 = 夜間の夕方側
const MORNING_BEFORE = 8 / 24;              // これより前 = 夜間の早朝側
/** 1つ前のラベルとの間隔がこれを超えたら「データ欠落の疑い」として警告(GW 最長でも 11日程度)。 */
const LABEL_GAP_WARN_DAYS = 14;

function isWeekendSerial(serial: number): boolean {
  const dow = new Date((serial - EXCEL_1970) * 86400_000).getUTCDay();   // 0=日, 6=土
  return dow === 0 || dow === 6;
}
/** 土日だけを飛ばす前営業日(祝日は考慮しない近似)。rowsToBars の先頭ラベル用フォールバック専用。 */
function prevBusinessDaySerial(serial: number): number {
  let s = serial - 1;
  while (isWeekendSerial(s)) s--;
  return s;
}

const isNightFrac = (timeFrac: number) => timeFrac >= EVENING_FROM || timeFrac < MORNING_BEFORE;

/** A列(セッション日付シリアル) + 時刻(1日小数) → 実時刻 epoch ms(分床へ丸め)。1行だけを見る低水準関数。
 *  prevLabelSerial = 「1つ前の取引日」のシリアル(rowsToBars がデータから求めて渡す)。
 *  夕方(τ≥16:00 ≒ 夜間17:00〜) → 実日付 = prevLabelSerial
 *  早朝(τ<08:00 ≒ 翌0:00–6:00) → 実日付 = prevLabelSerial + 1暦日
 *  日中(08:45–15:45)            → 実日付 = A(prevLabelSerial は使わない)
 *  prevLabelSerial 省略時は土日だけ飛ばす近似(祝日の前夜を誤る)。★通常は rowsToBars を使うこと。 */
export function rowToBar(serialDate: number, timeFrac: number,
  o: number, h: number, l: number, c: number, v: number | null,
  prevLabelSerial?: number): BaseBar {
  const prev = prevLabelSerial ?? prevBusinessDaySerial(serialDate);
  let realSerial: number;
  if (timeFrac >= EVENING_FROM) realSerial = prev;                 // 夕方 = 前の取引日
  else if (timeFrac < MORNING_BEFORE) realSerial = prev + 1;       // 早朝 = 前の取引日 + 1暦日
  else realSerial = serialDate;                                    // 日中 = A
  const dayMs = (realSerial - EXCEL_1970) * 86400_000;
  const minMs = Math.round((timeFrac * 86400_000) / 60_000) * 60_000;
  return { t: dayMs + minMs - JST_OFFSET_MS, o, h, l, c, v };
}

export interface RowsToBarsResult {
  bars: BaseBar[];                 // 入力行と同じ順(ソートしない)
  /** 1つ前のラベルがデータ内に無く、土日近似にフォールバックした夜間行の数(通常は先頭ラベルの夜間だけ)。 */
  fallbackRows: number;
  /** 警告文(フォールバック・ラベル間隔の異常)。呼び出し側がログに出す。 */
  warnings: string[];
}

/** sheet_to_json(header:1) の生配列(先頭=見出し行) → BaseRow[]。A/B/始値が数値でない行は捨てる(従来どおり)。 */
export function sheetAoaToRows(aoa: readonly unknown[][]): BaseRow[] {
  const out: BaseRow[] = [];
  for (let i = 1; i < aoa.length; i++) {
    const [d, tm, o, h, l, c, v] = aoa[i] as unknown[];
    if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
    out.push({ serialDate: d, timeFrac: tm, o, h: h as number, l: l as number, c: c as number,
      v: typeof v === 'number' ? v : null });
  }
  return out;
}

const serialToYmd =(s: number) => new Date((s - EXCEL_1970) * 86400_000).toISOString().slice(0, 10);

/** xlsx の行の配列 → BaseBar[](正準実装)。夜間の実日付を「データ内で1つ前に現れるラベル」から決める。
 *  ・ラベル列は入力全体の相異なる A 値を昇順に並べたもの(行の並び順には依存しない)。
 *  ・先頭ラベルの夜間は前ラベルが無いので土日近似にフォールバックし warnings に記録。
 *  ・複数ファイルは連結してから渡す(年をまたぐ夜間の前ラベルが前年ファイルにあるため)。 */
export function rowsToBars(rows: readonly BaseRow[]): RowsToBarsResult {
  const labels = [...new Set(rows.map(r => r.serialDate))].sort((a, b) => a - b);
  const prevOf = new Map<number, number | undefined>();
  const warnings: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const prev = i > 0 ? labels[i - 1] : undefined;
    prevOf.set(labels[i]!, prev);
    if (prev !== undefined && labels[i]! - prev > LABEL_GAP_WARN_DAYS) {
      warnings.push(`ラベル ${serialToYmd(prev)} → ${serialToYmd(labels[i]!)} の間隔が ${labels[i]! - prev} 日`
        + `(データ欠落の疑い。${serialToYmd(labels[i]!)} ラベルの夜間は ${serialToYmd(prev)} の夜に置かれる)`);
    }
  }
  let fallbackRows = 0;
  const fallbackLabels = new Set<number>();
  const bars = rows.map(r => {
    const prev = prevOf.get(r.serialDate);
    if (prev === undefined && isNightFrac(r.timeFrac)) { fallbackRows++; fallbackLabels.add(r.serialDate); }
    return rowToBar(r.serialDate, r.timeFrac, r.o, r.h, r.l, r.c, r.v, prev);
  });
  for (const s of fallbackLabels) {
    warnings.push(`先頭ラベル ${serialToYmd(s)} の夜間は前の取引日がデータ内に無いため、土日だけ飛ばす近似で `
      + `${serialToYmd(prevBusinessDaySerial(s))} の夜に置いた(祝日の前夜なら誤り)`);
  }
  return { bars, fallbackRows, warnings };
}
