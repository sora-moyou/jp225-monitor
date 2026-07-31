// core/detectionKinds.ts — 検知種別(detectionKind)の **唯一の定義**。
//
// ★なぜこのファイルが在るか(事故の履歴):
//   検知種別は「union 型 / 実行時 allowlist / テクニカル判定 / 表示ラベル」の4種類の知識に分かれ、
//   それぞれが別ファイルで手書きコピーされていた。v0.9.36 で nwave / dailyband を足したとき、
//     - server/routes/explain.ts の allowlist … 漏れ → /api/explain が HTTP 400 →「説明取得失敗」
//     - web/main.ts の isTechnicalPattern    … 漏れ → LLM を呼びに行ってしまう(上記400の入口)
//     - web/components/alertBanner.ts        … 漏れ → N波動バナーが「[トレンド]」と誤表示
//     - server/alertHistory.ts の L2_KINDS   … 漏れ → AI へ渡す「直近の状況」から永久に脱落
//   が一斉に起きた。v0.9.48 は前2つだけを直し、後ろ2つを取りこぼした=**同じ病気が修正の中で再発**した。
//
// ★再発しない形(このファイルの契約):
//   種別の union は下の DETECTION_KIND_SPEC の **キーから導出** する(union の手書きが存在しない)。
//   つまり「種別を足す」= 「ここに1行足して layer / label / promptLabel を決める」以外に方法が無く、
//   足りない項目があれば `tsc --noEmit` が落ちる。消費側は全てこのファイルの導出値を使う。
//
// ★消費側(ここを変えたら影響する箇所):
//   - core/types.ts            … AlertEventPayload['detectionKind'] の型
//   - server/routes/explain.ts … /api/explain の実行時 allowlist
//   - server/alertHistory.ts   … rowKind(履歴ラベル) / getRecentL2Summary(直近の状況)
//   - server/llm/explain.ts    … LLM プロンプトの種別名 / テクニカル判定
//   - web/components/alertBanner.ts, web/main.ts … バナー表示とテクニカル固定文

/** 検知種別1つぶんの決定事項。ここに項目を足すと、全種別で埋めるまで型検査が通らない。 */
export interface DetectionKindSpec {
  /** 層。
   *  L1 = 価格変化そのもの(急変/暴落/超短期)。ニュース AI に原因を聞きに行く。
   *  L2 = テクニカル状態(水準・パターン・トレンド)。サーバの note が明確文なので LLM を呼ばず固定文を出し、
   *       「直近の状況(getRecentL2Summary)」の母集団にもなる。
   *  ★UI の「テクニカル扱い(isTechnicalKind)」はこの層そのもの。別の集合を作らないこと。 */
  layer: 'L1' | 'L2';
  /** 履歴一覧/バナーの種別名。null = 固有名を持たない(窓秒から 超短期/短期/長期 を導出する旧 z-score 系)。 */
  label: string | null;
  /** LLM プロンプト(server/llm/explain.ts)に載せる種別名。ラベルとは語彙が違うので別項目。 */
  promptLabel: string;
}

/** ★検知種別の唯一の表。ここに無い文字列は検知種別ではない。 */
export const DETECTION_KIND_SPEC = {
  // ── L1: 価格変化(ニュース AI で原因を説明する) ────────────────────────────
  slope:     { layer: 'L1', label: null,             promptLabel: 'フラッシュ' },
  magnitude: { layer: 'L1', label: null,             promptLabel: 'トレンド' },        // 旧仕様(現在は発火しない・履歴互換)
  shock:     { layer: 'L1', label: '急変',           promptLabel: '急変' },
  crash:     { layer: 'L1', label: '暴落',           promptLabel: '暴落' },
  // ── L2: テクニカル状態(固定文・LLM を呼ばない) ───────────────────────────
  double:    { layer: 'L2', label: 'ダブル天底',     promptLabel: 'ダブル天底' },
  ma_sr:     { layer: 'L2', label: 'MAサポレジ',     promptLabel: 'MAサポレジ' },
  level_sr:  { layer: 'L2', label: '水準サポレジ',   promptLabel: '水準サポレジ' },
  break:     { layer: 'L2', label: '水準ブレイク',   promptLabel: '水準ブレイク' },
  pivot:     { layer: 'L2', label: 'スイング形成',   promptLabel: 'スイング形成' },
  trend:     { layer: 'L2', label: 'トレンド転換',   promptLabel: 'トレンド転換' },
  dailyband: { layer: 'L2', label: '日足バンド',     promptLabel: '日足バンド/MA' },
  nwave:     { layer: 'L2', label: 'N波動',          promptLabel: 'N波動(値幅観測)' },
  // ── L2(後方互換: 過去履歴にのみ現れる旧種別) ────────────────────────────
  granville: { layer: 'L2', label: 'グランビル',     promptLabel: 'グランビル' },
  dtb:       { layer: 'L2', label: 'Wトップ/ボトム', promptLabel: 'ダブル天井/大底' },
  ma:        { layer: 'L2', label: 'MA抜け',         promptLabel: 'MA抜け' },
  swingdtb:  { layer: 'L2', label: 'ダブル(大)',     promptLabel: 'ダブル天底' },
} as const satisfies Record<string, DetectionKindSpec>;

/** 検知種別。★手書きの union は存在しない — 上の表のキーがそのまま型になる。 */
export type DetectionKind = keyof typeof DETECTION_KIND_SPEC;

/** 全検知種別(実行時 allowlist 等に使う)。表の並び順。 */
export const DETECTION_KINDS = Object.keys(DETECTION_KIND_SPEC) as readonly DetectionKind[];

// ★Map で引く(素のオブジェクト添字だと 'toString'/'constructor' が Object.prototype に当たり、
//   /api/explain の allowlist をすり抜ける。未検証の HTTP body を通す関数なので素の添字は使わない)。
const SPEC_BY_KEY: ReadonlyMap<string, DetectionKindSpec> =
  new Map<string, DetectionKindSpec>(Object.entries(DETECTION_KIND_SPEC));

/** 実行時の種別判定(HTTP body 等の未検証入力用)。 */
export function isDetectionKind(v: unknown): v is DetectionKind {
  return typeof v === 'string' && SPEC_BY_KEY.has(v);
}

/** 種別の仕様。未知(過去 DB の想定外文字列など)は null。 */
export function detectionKindSpec(kind: string | null | undefined): DetectionKindSpec | null {
  return (kind != null && SPEC_BY_KEY.get(kind)) || null;
}

/** テクニカル(L2)種別か。
 *  true = バナーはサーバ note の固定文(LLM を呼ばない・🔄 なし)/「直近の状況」に載る。
 *  未知の種別は false(= L1 扱い)。新種別の取りこぼしを黙って握り潰さないため、判定は必ずここを通すこと。 */
export function isTechnicalKind(kind: string | null | undefined): boolean {
  return detectionKindSpec(kind)?.layer === 'L2';
}

/** 履歴/バナーの種別名。null = 固有名なし(呼び出し側が窓秒などから導出する)。 */
export function detectionKindLabel(kind: string | null | undefined): string | null {
  return detectionKindSpec(kind)?.label ?? null;
}

/** LLM プロンプトの種別名。未知は 'トレンド'(従来の最終 else と同一)。 */
export function detectionKindPromptLabel(kind: string | null | undefined): string {
  return detectionKindSpec(kind)?.promptLabel ?? 'トレンド';
}
