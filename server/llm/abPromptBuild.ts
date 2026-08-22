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
//   ③ 版(A は単一・B は4種)ごとに違う値になる。
//   ★設定(floorYen/ceilingYen)を含めない理由も pb1 と同じ:「今の設定」ではなく「型」を測るため。
//     固定の合成値(SYN_FLOOR/SYN_CEILING)で描く。
//
// ■ ★循環参照の心配は無い
//   trendPrompt.ts / planVariants.ts はどちらも scalpPlan.ts を **型としてしか** import しない
//   (実行時の import は無い)。promptBuild.ts が抱えていた「openai.js のバレルを実体化してしまい
//   既存のモック15本が割れる」という問題はここには当てはまらない。

import { buildTrendSystemPrompt, buildTrendUserPrompt } from './trendPrompt.js';
import { buildBSystemPrompt, buildBUserPrompt, type BVariant } from './planVariants.js';
import { promptBuildFingerprint } from './promptFingerprint.js';

/** ★市場データの代わりに食わせる固定プレースホルダ(pb1 と同じ考え方: 本文にデータを含めない)。 */
const SYN_MARKET_DATA = '(固定プレースホルダ: データはプロンプトの型の指紋に含めない)';
const SYN_FLOOR = 11;
const SYN_CEILING = 97;
const SYN_REF_PRICE = 12345;

/** B の4版(pickBVariant が返しうる値と同じ)。 */
export const AB_B_VARIANTS: readonly BVariant[] = ['buy', 'sell', 'range-fade', 'range-breakout'];

/** A(目線)の pb 指紋を計算する純関数(キャッシュしない実体)。
 *  ★A は版が1つだけ(bull/bear/range を選ぶ問いは常に同じ文面。B と違い pickBVariant のような
 *  分岐が無い)。 */
export function computeATrendPromptBuildFp(): string {
  const system = buildTrendSystemPrompt(SYN_MARKET_DATA);
  const user = buildTrendUserPrompt();
  return promptBuildFingerprint(['a-trend', system, user]);
}

/** B(価格と損切幅)の pb 指紋を計算する純関数。版(buy/sell/range-fade/range-breakout)ごとに別の値。 */
export function computeBOrderPromptBuildFp(variant: BVariant): string {
  const system = buildBSystemPrompt(variant, SYN_FLOOR, SYN_CEILING, SYN_MARKET_DATA);
  const user = buildBUserPrompt(variant, SYN_REF_PRICE, SYN_FLOOR, SYN_CEILING);
  return promptBuildFingerprint([`b-${variant}`, system, user]);
}

// ★起動時に1回だけ計算して使い回す(pb1 と同じキャッシュ作法)。合成コンテキストは固定なので
//   プロセス生存中に値が変わることはない。
let aCache: string | null = null;
const bCache = new Map<BVariant, string>();

/** A の pb 指紋(初回だけ計算・以降はキャッシュ)。 */
export function aTrendPromptBuildFp(): string {
  if (aCache === null) aCache = computeATrendPromptBuildFp();
  return aCache;
}

/** その B 版の pb 指紋(初回だけ計算・以降はキャッシュ)。 */
export function bOrderPromptBuildFp(variant: BVariant): string {
  const hit = bCache.get(variant);
  if (hit !== undefined) return hit;
  const fp = computeBOrderPromptBuildFp(variant);
  bCache.set(variant, fp);
  return fp;
}

/** ★meta(行数によらず読める記録・server/db/store.ts の meta テーブル)へ載せる用の一括計算。
 *  「この版が持つ A/B のプロンプトの型」を、行が1件も無い日でも読めるようにする。 */
export function allAbPromptBuildFps(): { aPromptBuild: string; bPromptBuilds: Record<BVariant, string> } {
  const bPromptBuilds = {} as Record<BVariant, string>;
  for (const v of AB_B_VARIANTS) bPromptBuilds[v] = bOrderPromptBuildFp(v);
  return { aPromptBuild: aTrendPromptBuildFp(), bPromptBuilds };
}
