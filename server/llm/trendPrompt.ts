// server/llm/trendPrompt.ts — ★A(目線だけを尋ねる呼び出し)のプロンプトと応答パース。
//
// ■ A が答えるのは **1語と理由だけ**
//   bull / bear / range の3つ。★**見送り(none)はありません。**
//   トレンドに確信が持てないときは全部 range に落ちます。
//   ★見送れるのは B だけ・しかも理由を書いたときだけ、という設計の芯がこれで成立する。
//
// ■ ★語の選び方(ユーザー指示 v0.9.90)
//   「Aの相場方向を尋ねるプロンプトは、ブル、ベア、レンジを使用し、買い/売りの用語は用いない」
//   ★よって答えの値も `buy`/`sell` ではなく **`bull`/`bear`** にした。
//   `buy`/`sell` はこのコードベースでは注文の side そのものの語なので、A に置くと
//   「A に注文の語を1文字も入れない」に反する。★設計文書は `buy`/`sell` と書いていたので、
//   実装に合わせて文書のほうを直した(2026-08-22)。
//   ★注文の side の語は不変(B と台帳と画面は従来どおり buy/sell)。ここは A の答えの語だけ。
//
// ■ ★A に渡さないもの(呼び出し側の責務。ここは文面だけを持つ)
//   節目 / アラート / ニュース / 仮想取引の成績 / チャート画像 / データツール。
//   理由: A は「トレンドの有無」だけを答える。価格を決める材料も、外部の裏取りも要らない。
//   ★とくにツールは、A の全文にツールの語が1つも無い以上 呼ばれない前提のものに
//   毎回 約1,088字を払うことになる(explain_move は内部で更に LLM を1回呼ぶ)。

/** A の答え。★注文の語ではない。 */
export type TrendAnswerDirection = 'bull' | 'bear' | 'range';

export interface TrendAnswer {
  direction: TrendAnswerDirection;
  /** そう判断した理由(自由文)。★理由が無くても目線が返れば成立とする(ユーザー指示)。 */
  why?: string;
}

const DIRECTIONS: readonly TrendAnswerDirection[] = ['bull', 'bear', 'range'];

/** ★A の max_tokens。**旧経路は 8000**。
 *
 *  ■ なぜ小さくするか: A は1語と短い理由しか返さない。8000 のままだと、暴走出力の上限が
 *    A にも効かず、課金と待ち時間の上限が実質無制限になる。
 *  ■ ★なぜ 16 ではないか(算術で確かめた): 応答は
 *      {"direction":"bull","why":"<日本語の理由>"}
 *    JSON の骨格だけで約 30字≒15〜20トークン。16 では **direction を書き終える前に切れる**。
 *    日本語の理由を1〜2文(40〜80字)入れると 60〜120トークン。★余裕を見て 256 にした
 *    (旧 8000 の 1/31)。
 *  ■ ★それでも切れたときに備えて、下の parseTrendAnswer は **壊れた JSON からでも
 *    direction を拾える**(切り詰めで目線を丸ごと失わない)。 */
export const TREND_MAX_TOKENS = 256;

/** A の system プロンプト。★注文の語も、こちらの作業(丸め・5円ずらし・側の検査)も1文字も書かない。
 *  ★2026-08-22 訂正(エバリュエーター指摘E): 1行目の位置語に「下」を使っていたが、同じ文面に
 *  「下降トレンド」があり、「外側」の事故(語の衝突で AI が向きを取り違えた)と同じ型のリスクだった。
 *  位置語を「次に」に変え、方向の語「下」と衝突しないようにする(データ・判断ロジックは無変更)。 */
export function buildTrendSystemPrompt(marketData: string): string {
  return `あなたは日経225先物(NIY=F)の相場を読むアナリストです。
次に与えたデータだけを見て、いまトレンドがあるか、あるならどちらかを答えてください。

答えは次の3つから1つ選びます。
  bull  … 上昇トレンド(ブル)がある
  bear  … 下降トレンド(ベア)がある
  range … トレンドが無い(レンジ)

トレンドに確信が持てないときは range としてください。
そう判断した理由も書いてください。

【データ】
${marketData}`;
}

/** A の user プロンプト。 */
export function buildTrendUserPrompt(): string {
  return `いまトレンドはありますか。あるならどちらですか。理由も教えてください。

次の JSON だけを出力してください(前後に説明文・コードフェンス・マークダウンを付けない)。
{
  "direction": "bull" | "bear" | "range",
  "why": string
}`;
}

/**
 * A の応答テキストから TrendAnswer を取り出す純関数。
 * ★3語のどれでもない/読めない場合は null(=呼び出し側が none_reason='aFailed' にする)。
 * ★理由(why)が空でも **null にしない**: 「A が理由なしでも目線が返れば OK」(ユーザー指示)。
 */
export function parseTrendAnswer(text: string): TrendAnswer | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      if (o && typeof o === 'object') {
        const d = o['direction'];
        if (typeof d === 'string') {
          const dir = DIRECTIONS.find(x => x === d.trim().toLowerCase());
          if (dir) {
            const why = typeof o['why'] === 'string' && o['why'].trim().length > 0 ? o['why'].trim() : undefined;
            return why === undefined ? { direction: dir } : { direction: dir, why };
          }
        }
      }
    } catch { /* ★下の救済へ落ちる(ここで null を返さない) */ }
  }
  // ★救済: max_tokens で途中で切れた応答からでも **目線だけは拾う**。
  //   why の途中で切れると JSON.parse は必ず失敗するが、direction は先頭にあるので生きている。
  //   ★ここで拾えなければ本当に読めていない=呼び出し側が none_reason='aFailed' にする。
  const md = text.match(/"direction"\s*:\s*"([A-Za-z]+)"/);
  if (!md) return null;
  const dir = DIRECTIONS.find(x => x === md[1]!.trim().toLowerCase());
  if (!dir) return null;
  // 理由は「閉じ引用符まで揃っているとき」だけ採る(切れた文を理由として記録しない)。
  const mw = text.match(/"why"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const why = mw && mw[1]!.trim().length > 0 ? mw[1]!.trim() : undefined;
  return why === undefined ? { direction: dir } : { direction: dir, why };
}
