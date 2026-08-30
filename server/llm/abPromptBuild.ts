// server/llm/abPromptBuild.ts — ★段5: A/B 分割の「プロンプトの型」の指紋(pb1 と同じ作法・別の入力)。
//
// ■ なぜ本体(server/llm/promptBuild.ts)を使い回さないか
//   pb1(promptBuild.ts)は **旧経路(1回呼び出し)** の buildScalpQuestion/buildScalpSystemPrompt を
//   描画するためのもので、A/B 分割の文面(trendPrompt.ts / planVariants.ts)を一切通らない。
//   旧経路と分割経路は文面そのものが別物なので、同じ指紋空間に混ぜず、
//   別の列(a_prompt_build / b_prompt_build)に別の関数で書く。
//
// ■ ★pb1 と同じ3条件を守る(promptBuild.ts 冒頭を参照)
//   ① データ(現在値・時刻・足・ニュース・画像)を含めない → 合成の固定プレースホルダで描く。
//   ② 文面(テンプレート)が1文字でも変われば必ず動く。
//   ③ 版(★A は2種=レンジ有効/無効・★B は6種=directional 2版 × TP有無 + レンジ2版)ごとに違う値になる。
//   ★設定(floorYen/ceilingYen)を含めない理由も pb1 と同じ:「今の設定」ではなく「型」を測るため。
//     固定の合成値(SYN_FLOOR/SYN_CEILING)で描く。
//
// ■ ★循環参照の心配は無い
//   trendPrompt.ts / planVariants.ts はどちらも scalpPlan.ts を **型としてしか** import しない
//   (実行時の import は無い)。promptBuild.ts が抱えていた「openai.js のバレルを実体化してしまい
//   既存のモック15本が割れる」という問題はここには当てはまらない。

import { buildTrendSystemPrompt, buildTrendUserPrompt } from './trendPrompt.js';
import { buildBSystemPrompt, buildBUserPrompt, effectiveAskTp, tpAskable, type BVariant } from './planVariants.js';
import { promptBuildFingerprint } from './promptFingerprint.js';

/** ★市場データの代わりに食わせる固定プレースホルダ(pb1 と同じ考え方: 本文にデータを含めない)。 */
const SYN_MARKET_DATA = '(固定プレースホルダ: データはプロンプトの型の指紋に含めない)';
const SYN_FLOOR = 11;
const SYN_CEILING = 97;
const SYN_REF_PRICE = 12345;

/** B の4版(pickBVariant が返しうる値と同じ)。 */
export const AB_B_VARIANTS: readonly BVariant[] = ['buy', 'sell', 'range-fade', 'range-breakout'];

/** ★TP(利確幅)を尋ねるか の2値。★2026-08-30: B の文面は TP を尋ねる/尋ねないで分かれる。
 *  設定 scalpTpWidthSource='manual'(または scalpTpEnabled=false)のときは TP の行を1文字も出さないので、
 *  文面が違う = **別の指紋でなければならない**(pb の3条件② 文面が1文字でも変われば必ず動く)。
 *  ★版を1つのままにすると「TP を尋ね始めたのに b_prompt_build が同じ値」になり、
 *    A/B の層別キーとして使えなくなる(a_prompt_build が rangeEnabled で2版に割れたのと同じ理由)。 */
export const AB_TP_ASKS: readonly boolean[] = [false, true];

/** ★この版が実際に持つ B の文面の全組み合わせ。★**6通り**(8通りではない)。
 *
 *  ★レンジ2版は TP を尋ねない(planVariants.ts の tpAskable・リーダー裁定1)ので、
 *    'range-fade+tp' / 'range-breakout+tp' という文面は **存在しない**。
 *  ★存在しない組み合わせを指紋の一覧に載せると、meta を読んだ人が
 *    「レンジでも TP を尋ねる版がある」と誤読する(=この一覧の目的そのものが壊れる)。 */
export const AB_B_PROMPT_COMBOS: ReadonlyArray<{ variant: BVariant; askTp: boolean }> =
  AB_B_VARIANTS.flatMap(v => AB_TP_ASKS
    .filter(tp => tp === false || tpAskable(v))
    .map(askTp => ({ variant: v, askTp })));

/** A(目線)の pb 指紋を計算する純関数(キャッシュしない実体)。
 *  ★2026-08-25: A は **2版になった**(レンジ有効=3択 / レンジ無効=2択で range の行ごと消える)。
 *    ★従来は「A は版が1つだけ」と書いてあったが、それは文面が rangeEnabled に依存していなかった頃の話。
 *    版を1つのままにすると、レンジ設定を切り替えても a_prompt_build が同じ値になり、
 *    **文面が変わったのに指紋が変わらない**(pb の3条件②に反する)。 */
export function computeATrendPromptBuildFp(rangeEnabled: boolean): string {
  const system = buildTrendSystemPrompt(SYN_MARKET_DATA, rangeEnabled);
  const user = buildTrendUserPrompt(rangeEnabled);
  return promptBuildFingerprint([rangeEnabled ? 'a-trend-range' : 'a-trend-norange', system, user]);
}

/** ★B の指紋のラベル(版 × TPを尋ねるか)。★meta の keys にもこの綴りが出る。
 *  ★レンジ2版は askTp=true を渡されても '+tp' を付けない(その文面は存在しないため。
 *    付けると「同じ文面に2つのラベル」= 指紋が2つに割れて層別が壊れる)。 */
export function bOrderPromptBuildKey(variant: BVariant, askTp: boolean): string {
  return effectiveAskTp(variant, askTp) ? `${variant}+tp` : variant;
}

/** B(価格と損切幅)の pb 指紋を計算する純関数。
 *  ★組み合わせは **6通り**(directional 2版 × TP有無 + レンジ2版)。それぞれ別の値。
 *  ★レンジ版に askTp=true を渡しても、文面もラベルも TP 無しに正規化されるので
 *    **TP 導入前と同じ指紋** が返る(= 過去の層別と地続きのまま)。 */
export function computeBOrderPromptBuildFp(variant: BVariant, askTp: boolean): string {
  const ask = effectiveAskTp(variant, askTp);
  const system = buildBSystemPrompt(variant, SYN_FLOOR, SYN_CEILING, SYN_MARKET_DATA, ask);
  const user = buildBUserPrompt(variant, SYN_REF_PRICE, SYN_FLOOR, SYN_CEILING, ask);
  return promptBuildFingerprint([`b-${bOrderPromptBuildKey(variant, ask)}`, system, user]);
}

// ★起動時に1回だけ計算して使い回す(pb1 と同じキャッシュ作法)。合成コンテキストは固定なので
//   プロセス生存中に値が変わることはない。
const aCache = new Map<boolean, string>();
const bCache = new Map<string, string>();

/** A の pb 指紋(初回だけ計算・以降はキャッシュ)。★レンジ設定ごとに別の値。 */
export function aTrendPromptBuildFp(rangeEnabled: boolean): string {
  const hit = aCache.get(rangeEnabled);
  if (hit !== undefined) return hit;
  const fp = computeATrendPromptBuildFp(rangeEnabled);
  aCache.set(rangeEnabled, fp);
  return fp;
}

/** その B 版の pb 指紋(初回だけ計算・以降はキャッシュ)。★TPを尋ねるかで別の値。 */
export function bOrderPromptBuildFp(variant: BVariant, askTp: boolean): string {
  const key = bOrderPromptBuildKey(variant, askTp);
  const hit = bCache.get(key);
  if (hit !== undefined) return hit;
  const fp = computeBOrderPromptBuildFp(variant, askTp);
  bCache.set(key, fp);
  return fp;
}

/** ★meta(行数によらず読める記録・server/db/store.ts の meta テーブル)へ載せる用の一括計算。
 *  「この版が持つ A/B のプロンプトの型」を、行が1件も無い日でも読めるようにする。 */
export function allAbPromptBuildFps(rangeEnabled: boolean): { aPromptBuild: string; bPromptBuilds: Record<string, string> } {
  // ★2026-08-30: **6つ全部** を載せる(directional 2版 × TP有無 + レンジ2版)。キーは 'buy' / 'buy+tp' の形。
  //   ★呼び出し側(server/index.ts)は1行も変えていない: 戻り値の形(Record<string,string>)は同じで、
  //     キーが4つ→8つに増えるだけ。行が1件も無い日でも「この版が持つ8つの型」を meta から読める。
  const bPromptBuilds: Record<string, string> = {};
  for (const { variant, askTp } of AB_B_PROMPT_COMBOS) {
    bPromptBuilds[bOrderPromptBuildKey(variant, askTp)] = bOrderPromptBuildFp(variant, askTp);
  }
  return { aPromptBuild: aTrendPromptBuildFp(rangeEnabled), bPromptBuilds };
}
