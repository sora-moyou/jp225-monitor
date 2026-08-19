// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  pass9: 本番の user プロンプトを **本番の関数で組み立てて** 送る
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ なぜこれが要るか(pass7 と本番の食い違いの原因)
//   pass7 の検証台は「質問文 + JSON 契約」しか送っておらず、本番の buildScalpQuestion(=LC の規則群)を
//   **1文字も送っていなかった**。本番の実測で lcWhyFor* が 100% 検算だったのに検証台が 0% だったのは
//   これが理由と考えられる。buildScalpQuestion の中の selfCheckNote に、こう書いてある:
//       「③損切りの幅: … 実際に引き算し、… その引き算を rationale に書き、答えと
//         実際に出力する lcWidthFor… の数値が一致しているか。」
//   ★「lcWidthFor…」と新設の「lcWhyFor…」は 1 文字違いで隣接している。引き算の要求が隣の箱に
//     流れ込んだ、という筋が立つ。だから pass9a では **本番と同じものを送って再現するか** をまず見る。
//
// ■ 本番ファイルは1バイトも変更していない(import して呼ぶだけ)。

import { buildScalpQuestion, scalpJsonInstruction, resolveLcPresentation } from '../llm/scalpPlan.js';

/** 実機の設定(下限55 / 上限=AI委任 + 安全上限160)。env で上書き可。 */
export function liveLcPresentation() {
  const floor = Number(process.env.LABTEST_LC_FLOOR ?? 55);
  const hard = Number(process.env.LABTEST_LC_HARDMAX ?? 160);
  return resolveLcPresentation({
    floorYen: floor, ceilingYen: 65, ceilingMode: 'ai', lcHardMax: { enabled: true, value: hard },
  });
}

/** ★本番の user プロンプト(vision 注記を除く)。= buildScalpQuestion + scalpJsonInstruction。 */
export function productionUserPrompt(refPrice: number): string {
  const pres = liveLcPresentation();
  const rangeEnabled = false;                 // 稼働機は現在 false
  const trendVetoYen = 0;                     // 実機は trendVeto=AI委任 → 0
  const q = buildScalpQuestion(pres.floorYen, pres.ceilingYen, rangeEnabled, trendVetoYen, pres.ceil);
  const j = scalpJsonInstruction(refPrice, pres.floorYen, pres.ceilingYen, rangeEnabled, pres.ceil);
  return `${q}\n\n${j}`;
}

/** 本番の lcWhy の説明文(現行)。この2行だけを候補で差し替える。 */
export const LC_WHY_LIMIT_PROD = '  "lcWhyForLimit": string,     // なぜ lcWidthForLimit をその幅にしたか(日本語)。lcWidthForLimit と対で省略';
export const LC_WHY_STOP_PROD = '  "lcWhyForStop": string,      // なぜ lcWidthForStop をその幅にしたか(日本語)。lcWidthForStop と対で省略';

/** 候補ごとの lcWhy 説明文。★変えるのはこの2行だけ(他は本番の出力そのまま)。 */
export function lcWhyVariant(kind: 'a' | 'b' | 'c'): { limit: string; stop: string } {
  if (kind === 'b') {
    // pass9b: 「計算ではなく判断を書かせる」。★「数式は書かない」は **禁止を1つ足している**(報告に明記)。
    return {
      limit: '  "lcWhyForLimit": string,     // その幅にした理由(何が壊れたら撤退かを、価格か指標で書く)。数式は書かない。lcWidthForLimit と対で省略',
      stop: '  "lcWhyForStop": string,      // その幅にした理由(何が壊れたら撤退かを、価格か指標で書く)。数式は書かない。lcWidthForStop と対で省略',
    };
  }
  if (kind === 'c') {
    // pass9c: 検算の宛先が rationale であることを明示して棲み分けさせる(新しい禁止・数値は足さない)。
    return {
      limit: '  "lcWhyForLimit": string,     // 幅の根拠(検算は rationale に書くので、ここには書かない)。lcWidthForLimit と対で省略',
      stop: '  "lcWhyForStop": string,      // 幅の根拠(検算は rationale に書くので、ここには書かない)。lcWidthForStop と対で省略',
    };
  }
  return { limit: LC_WHY_LIMIT_PROD, stop: LC_WHY_STOP_PROD };
}

/** pass9 の user プロンプト。kind='a' は本番と byte 一致(差し替えなし)。 */
export function pass9UserPrompt(refPrice: number, kind: 'a' | 'b' | 'c'): string {
  const base = productionUserPrompt(refPrice);
  if (kind === 'a') return base;
  const v = lcWhyVariant(kind);
  if (!base.includes(LC_WHY_LIMIT_PROD) || !base.includes(LC_WHY_STOP_PROD)) {
    // ★無言で素通りさせない: 本番の文言が変わったら差し替えが効かないので、その場で落とす。
    throw new Error('本番の lcWhy の行が見つからない(本番の契約文が変わった可能性)。差し替えを中止する。');
  }
  return base.replace(LC_WHY_LIMIT_PROD, v.limit).replace(LC_WHY_STOP_PROD, v.stop);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  pass9a の再現失敗を受けた診断: 本番の **system プロンプト** も本番の関数で組み立てる
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// pass9a(user だけ本番)では LC2箱の検算率が 0% で、本番の 100% を再現できなかった。
// 検証台に **無かった** ものは4つ:
//   ①本番の system プロンプト(規則群)を1文字も送っていない  ②A の連鎖(assistant 発話)が前にある
//   ③max_tokens 2000(本番 8000)                          ④データに節目が無い
// ここでは①を本番の関数で埋める。②③は fixture 側の env で切る。

import { buildScalpSystemPrompt, buildBiasNote, buildDelegationNote, buildStrategySpec } from '../llm/scalpPlan.js';
import { describeExitLogic } from '../signalTrade/exit/index.js';

/** ★本番の system プロンプトの **規則部分**(データより前の全体)。実機の設定で組む。 */
export function productionSystemRules(): string {
  const pres = liveLcPresentation();
  const rangeEnabled = false;
  const trendVetoYen = 0;             // 実機は trendVeto=AI委任
  const hardMax = { enabled: true, value: Number(process.env.LABTEST_LC_HARDMAX ?? 160) };
  const sys = buildScalpSystemPrompt(pres.floorYen, pres.ceilingYen, rangeEnabled, trendVetoYen, true, pres.ceil);
  const biasNote = buildBiasNote('none');
  const strategySpec = buildStrategySpec({
    floor: { mode: 'manual', value: pres.floorYen },
    ceiling: { mode: 'ai', value: 65 },
    trendVeto: { mode: 'ai', value: 100 },
    cooldown: { mode: 'ai', value: 90 },
    bias: { mode: 'manual', value: 'none' },
    range: { mode: 'manual', value: rangeEnabled },
    hardMax,
    exitDesc: describeExitLogic(),
  });
  const delegationNote = buildDelegationNote(
    { lcFloor: 'manual', lcCeiling: 'ai', trendVeto: 'ai', cooldown: 'ai', bias: 'manual', range: 'manual' },
    { floorYen: pres.floorYen, ceilingYen: 65, hardMax, rangeEnabled },
  );
  return `${sys}${biasNote}${strategySpec}${delegationNote}`;
}
