// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  pass8: B の質問文 v8(ユーザー原文) — A の判断ごとに注文の型を指定し、ストップ幅も提案させる
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ★原文のまま。**1文字も直さない**:
//   ・全角の Ｘ / Ｙ / Ａ ・行頭のハイフン、2行目の行末のハイフン ・「一つづつを」
//
// ★「ストップ幅（○○円以上ＸＸ円以下）」の伏字は **設定から埋める雛形** だった(ユーザー回答で確定)。
//   AI に範囲を提案させるのではない。よって本番と同じ経路で帯を解決する:
//     resolveLcPresentation({ floorYen, ceilingYen, ceilingMode, lcHardMax })  ← server/llm/scalpPlan.ts
//   ★実機の設定は「上限=AI委任 + 安全上限 有効」で 55〜160。
//     この開発機の config は 55〜65(上限=手動)で **実機と違う** ため、実機の値を引数で与えて
//     本番の関数に解決させる(数値を自分で書かない=本番が変われば追従する)。

import { resolveLcPresentation } from '../llm/scalpPlan.js';

/** 実機の設定(上限=AI委任 / 安全上限 有効 160円)。env で上書き可。 */
function liveBand(): { floor: number; ceiling: number } {
  const floor = Number(process.env.LABTEST_LC_FLOOR ?? 55);
  const hard = Number(process.env.LABTEST_LC_HARDMAX ?? 160);
  const p = resolveLcPresentation({
    floorYen: floor, ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: hard },
  });
  return { floor: p.floorYen, ceiling: p.ceilingYen };
}

export function buildQuestionV8(): string {
  const { floor, ceiling } = liveBand();
  return `現在価格より上の価格Ｘと下の価格Ｙを一つづつを選び、それぞれに対して、Ａに応じたエントリー注文を提案してください。
-買い目線の場合：Ｘの逆指値買い注文、Ｙの指値買い注文-
-売り目線の場合：Ｘの指値売り注文、Ｙの逆指値売り注文
-レンジの場合は、アまたはイで提案してください。
ア）レンジ抜け：Ｘの逆指値買い注文、Ｙの逆指値売り注文
イ）レンジ継続：Ｘの指値売り注文、Ｙの指値買い注文
またそれぞれに、ストップ幅（${floor}円以上${ceiling}円以下）も提案し、価格Ｘ、Ｙの説明も加えてください。`;
}
