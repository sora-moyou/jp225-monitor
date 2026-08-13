// ─── 質問文の変種(PromptVariant) ─────────────────────────────────────────
//
// ★これは **決済仕様の変種(ExitVariant)とは別の軸** である。混ぜないこと。
//   - ExitVariant  … AI に教える「決済の仕様」を変える(プロンプトの決済ブロックだけが変わる)
//   - PromptVariant … AI に投げる「質問文そのもの」を変える(user プロンプトの本体が変わる)
//
// なぜ足すか(2026-08-13):
//   決済仕様の A/B(current vs candidate-a)は 08-10〜08-12 の3セッション・実測で
//   **どの指標も動かなかった**(両レッグ同幅 88.1% vs 87.9% / LC幅中央値 60 vs 60 /
//   エントリー率 70.2% vs 71.4%)。測っていたのは「決済の説明を変えたら入り方が変わるか」で、
//   答えは「変わらない」。よってその腕は畳み、**質問文** を候補に載せ替える。
//
//   主指標は「両レッグ同幅率」(指値レッグとブレイク新規レッグの LC幅が同じ数値になる割合)。
//   実測 87〜92% で、これは「幅を節目から導いていない」ことの代理指標。現行 v1 は 5,475文字・
//   ★24個まで肥大しており、規則を足すたびに失敗が **移動** しただけだった(下限55固着 → 中間60固着)。
//   v2 は禁止を並べず「システムの分担」を書く。効くかどうかは語りでなく上の率で決める。
//
// ★'v1' が既定。**省略時は完全に従来どおり**(稼働機・実弾につながる経路は byte 不変)。

export type PromptVariant = 'v1' | 'v2';

/** 受理する変種名の一覧(エラーメッセージの生成もここから作る=一覧と実装がずれない)。 */
export const PROMPT_VARIANTS = ['v1', 'v2'] as const;

/** 省略時の質問文。既存の呼び出し元(シグナルエンジン・手動診断・trade2)は必ずこれ。 */
export const DEFAULT_PROMPT_VARIANT: PromptVariant = 'v1';

export type NormalizePromptVariantResult =
  | { ok: true; variant: PromptVariant }
  | { ok: false; error: string };

/** 外部入力(HTTP body/query)を PromptVariant へ正規化する純関数。
 *  - 未指定 / null / 空文字 → 'v1'(省略時は従来どおり)
 *  - 'v1' / 'v2' → そのまま
 *  - それ以外 → **エラー(400)**。
 *
 *  ★未知の値を黙って 'v1' に倒さない理由は exitVariant と同じ: 「v2 で生成した」つもりの標本が
 *    実は v1 になり、A/B の差が消えたことに誰も気づけない(=実験が静かに壊れる)。 */
export function normalizePromptVariant(v: unknown): NormalizePromptVariantResult {
  if (v === undefined || v === null || v === '') return { ok: true, variant: DEFAULT_PROMPT_VARIANT };
  if (typeof v === 'string' && (PROMPT_VARIANTS as readonly string[]).includes(v)) {
    return { ok: true, variant: v as PromptVariant };
  }
  const got = typeof v === 'string' ? v.slice(0, 32) : typeof v;
  return { ok: false, error: `promptVariant は ${PROMPT_VARIANTS.map(n => `'${n}'`).join(' | ')} のみ(受信: ${got})` };
}

/** ★生成器の **予算の帳簿を分ける単位**。
 *  従来は決済仕様の変種名そのものだった(腕=変種だったため)。質問文の A/B では両腕とも
 *  exitVariant='current' を送るので、変種名だけを鍵にすると **2本の腕が1つの財布を共有** し、
 *  先着の腕が取引日の残りを食い切って標本が時間帯に偏る(=既知最大の交絡がそのまま入る)。
 *  よって鍵は (決済変種 × 質問文変種) にする。v1 のときは従来と同じ文字列になる(過去の期と繋がる)。 */
export function generatorArmKey(exitVariant: string, promptVariant: PromptVariant = DEFAULT_PROMPT_VARIANT): string {
  return promptVariant === DEFAULT_PROMPT_VARIANT ? exitVariant : `${exitVariant}+${promptVariant}`;
}
