// core/exitReasons.ts — 決済理由(exitReason)の **唯一の定義**。
//
// ★なぜこのファイルが在るか(何を防ぐか):
//   signal_trades には「いつ・いくらで決済したか」しか残っていない(rationale はエントリー時の文言の使い回し)。
//   そのため後から「この決済は初期LCで切られたのか / ラチェット床で利確したのか / レンジTPか / ドテンか」が
//   判別できず、決済パラメータを変えた反実仮想(if 節目を変えていたら)を再現できなかった。
//   さらに悪いのは **決済経路が増えたときに記録が黙って抜ける** ことで、これは検知種別(detectionKinds)で実際に
//   起きた事故と同型である(union / allowlist / ラベルが別ファイルに手書きコピーされ、新種別で一斉に漏れた)。
//
// ★漏れない形(このファイルの契約):
//   1) 決済理由の union は下の EXIT_REASON_SPEC の **キーから導出** する(union の手書きが存在しない)。
//   2) RecordedTrade(server/signalTrade/decisions.ts)の `exitReason` は **必須フィールド** である。
//      → 決済経路を1本足す = RecordedTrade を作る = ここのキーを1つ選ぶ、以外に方法が無い。
//         新しい理由を足したいなら、この表に1行足して label / ratchet を決めるまで `tsc --noEmit` が落ちる。
//   3) 同じ理由で `exitInitialStop`(約定レッグの初期LC)と `peakProfit`(決済時点の含み益ピーク)も必須にしてある。
//      新経路が「理由だけ書いて値を忘れる」ことができない。
//
// ★消費側(ここを変えたら影響する箇所):
//   - server/signalTrade/decisions.ts … RecordedTrade.exitReason の型 / 各決済経路の理由決定
//   - server/signalTrade/persist.ts   … signal_trades への挿入行(exit_reason 列)
//   - server/db/store.ts              … signal_trades.exit_reason(TEXT・後付け ALTER)
//
// ★RECORD-ONLY: 決済の判断・タイミング・価格には一切関与しない(理由は決済が確定した後に付ける名札)。

/** 決済理由1つぶんの決定事項。ここに項目を足すと、全理由で埋めるまで型検査が通らない。 */
export interface ExitReasonSpec {
  /** 履歴/分析での表示名(日本語)。 */
  label: string;
  /** 非公開 phase-exit のラチェット床が決済水準を決めたか。
   *  true  = 床(peak_profit から床の段が逆算できる=決済パラメータ変更の反実仮想の主対象)。
   *  false = 床以外(初期LC・レンジの固定LC/TP・ドテンの成行)。 */
  ratchet: boolean;
}

/** ★決済理由の唯一の表。ここに無い文字列は決済理由ではない。
 *  ★掲載基準: 「signal_trades に1行 INSERT される(=建玉が実際に閉じた)」経路だけを載せる。
 *    未約定ブラケットの失効(armed-timeout)やレンジ再評価の取消(cancel)は建玉が無く行も作られないので載せない
 *    (載せると永久に0件の理由=死んだ選択肢になる)。 */
export const EXIT_REASON_SPEC = {
  /** 初期LC(約定レッグの損切り)に到達して決済。ラチェット床は未発動、または床より初期LC の方が有利側だった。 */
  initial_stop:  { label: '初期LC',       ratchet: false },
  /** phase-exit のラチェット床(利益ロック)に到達して決済。床の段は peak_profit から逆算できる。 */
  ratchet_floor: { label: 'ラチェット床', ratchet: true },
  /** レンジ建玉(TP設定済)の固定初期LC に到達して決済(レンジ建玉はラチェットしない)。 */
  range_stop:    { label: 'レンジLC',     ratchet: false },
  /** レンジ建玉の反対側節目の手前に到達して成行TP。 */
  range_tp:      { label: 'レンジTP',     ratchet: false },
  /** ドテン(保有中の反転評価)で建玉を成行決済して反対側へ武装した。 */
  doten:         { label: 'ドテン',       ratchet: false },
} as const satisfies Record<string, ExitReasonSpec>;

/** 決済理由。★手書きの union は存在しない — 上の表のキーがそのまま型になる。 */
export type ExitReason = keyof typeof EXIT_REASON_SPEC;

/** 全決済理由(実行時 allowlist / 集計の母集団に使う)。表の並び順。 */
export const EXIT_REASONS = Object.keys(EXIT_REASON_SPEC) as readonly ExitReason[];

// ★Map で引く(素のオブジェクト添字だと 'toString'/'constructor' が Object.prototype に当たり、
//   DB から読んだ未検証文字列の判定をすり抜ける)。detectionKinds と同じ規約。
const SPEC_BY_KEY: ReadonlyMap<string, ExitReasonSpec> =
  new Map<string, ExitReasonSpec>(Object.entries(EXIT_REASON_SPEC));

/** 実行時の理由判定(DB 行など未検証入力用)。 */
export function isExitReason(v: unknown): v is ExitReason {
  return typeof v === 'string' && SPEC_BY_KEY.has(v);
}

/** 理由の仕様。未知(旧行の NULL・想定外文字列)は null。 */
export function exitReasonSpec(reason: string | null | undefined): ExitReasonSpec | null {
  return (reason != null && SPEC_BY_KEY.get(reason)) || null;
}

/** 表示名。未知/NULL(=記録前の旧行)は null。 */
export function exitReasonLabel(reason: string | null | undefined): string | null {
  return exitReasonSpec(reason)?.label ?? null;
}
