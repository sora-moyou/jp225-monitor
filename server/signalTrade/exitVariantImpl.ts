// 決済仕様の「変種」が **実体で解決されているか、公開フォールバックのままか** を外から観測する。
//
// ■ なぜ要るか(この観測が無いと起きること)
//   exit/index.ts は private(非公開実装)が在れば describeExitLogicVariant を差し替え、無ければ
//   公開フォールバック(数値が一切入らない定性文)のままにする。private 不在の環境では
//   'candidate-a' のプロンプトが 'current' とほぼ同一になり、**2本の生成器が同じ質問を投げる**。
//   それでも route は exitVariant:'candidate-a' を応答に載せるので、記録には
//   「候補仕様で生成した」と残る。実験は何も測っていないのに、標本は測ったふりをする。
//   これは exit/index.ts 自身が「変種名の打ち間違いを黙って current に倒すのは最悪の壊れ方」と
//   書いているのと **同じ壊れ方** で、private 不在経路だけが無防備だった。
//
// ■ どう判定するか
//   実数値そのものは見ない(見られない・見てはいけない)。「その変種の説明文が **公開フォールバックと
//   byte 一致するか**」だけを見る。一致 = 差し替えが起きていない = 実数値が入っていない。
//   ★判定に決済の数値は一切現れないので、この結果は HTTP/ログ/DB に出しても漏れない。
//
// ■ 前提
//   describeExitLogicVariant は loadExitImpl() が走った後でないと必ずフォールバックを返す。
//   呼ぶ側は先に await loadExitImpl() すること(冪等)。

import {
  EXIT_VARIANTS, DEFAULT_EXIT_VARIANT,
  describeExitLogicVariant, describeExitLogicVariantSimple,
  type ExitVariant,
} from './exit/index.js';

/** 決済実装の種別。'private'=非公開実装が入っている / 'fallback'=公開フォールバック(数値なし)。 */
export type ExitImplKind = 'private' | 'fallback';

/** その変種が公開フォールバックのままか。
 *  ★'current'(既定)は判定の主対象ではない: 実体が無くても現行仕様として動くのが正しい状態で、
 *    「候補で生成したつもりが現行だった」という壊れ方が起きるのは **既定以外の変種** だけ。 */
export function exitVariantImplKind(variant: ExitVariant): ExitImplKind {
  return describeExitLogicVariant(variant) === describeExitLogicVariantSimple(variant) ? 'fallback' : 'private';
}

/** 既定以外の変種が **1つでも** フォールバックなら 'fallback'。/api/status の表示用。 */
export function exitVariantImplKindAll(): ExitImplKind {
  const named = EXIT_VARIANTS.filter(v => v !== DEFAULT_EXIT_VARIANT);
  if (named.length === 0) return 'fallback';
  return named.every(v => exitVariantImplKind(v) === 'private') ? 'private' : 'fallback';
}
