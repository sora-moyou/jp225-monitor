// ★「その版が持っているプロンプトの型」の指紋(pb1)を作る = **固定の合成コンテキスト**での描画。
//
// ─── なぜ要るか(実際に解析が誤った) ─────────────────────────────────────
//   書き出しから「どの版のシグナルか」が分からず、解析では
//     ・collector_status_<host>.txt の起動ログの時刻
//     ・機能列(direction_why 等)がいつ初めて埋まったか
//   からの **間接推定** に頼るしかなかった。切り分けの定数を2時間ずらして誤った結論を出しかけている。
//
//   ★版番号(app_version)だけでは足りない:
//     ・chore リリース(プロンプト不変)でも版は上がる
//     ・版を上げずにプロンプトが変わることもありうる(開発中・ホットな修正)
//   ★既存の prompt_fp(sp1)も使えない:
//     あれは **実際に送った全文** の指紋で、refPrice・時刻・足・ニュース・画像で毎回変わる。
//
// ─── pb1 の性質(この3つを満たすように作る) ───────────────────────────────
//   ① データ(現在値・時刻・足・ニュース・画像)が変わっても **動かない**
//      → 市場文脈ブロック(【市場の現状 …】以降)は **1バイトも入れない**。入れるのは規則の文面だけ。
//   ② 文面(テンプレート)が1文字でも変われば **必ず動く**
//      → 条件分岐で出し分ける文面を1つ残らず踏むよう、**固定のスライス表** を描いて全部を食わせる。
//   ③ 腕(質問文の変種)ごとに違う値になる → 変種ごとに別の指紋を返す(v1 と v1f は必ず別)。
//
// ─── ★設定(LC下限/上限・バイアス・レンジ許可…)を含めない理由 ───────────────────
//   設定は「データ」ではないが **実行時に変わる**。含めると
//     (a) 起動時に1回計算して使い回せない(設定変更で古い値が嘘になる=無音の失敗)
//     (b) 「版のプロンプトの型」ではなく「今の設定」を測る別物になる
//   よって **合成の固定値**(下の SYN_*)で描く。実際の設定は signal_plans.settings_json /
//   signal_trades.meta に既に別枠で記録されている(同じ事実を二重に持たない)。
//
// ─── ★非公開の決済仕様を入れない理由(漏洩の遮断は「ハッシュだから安全」に頼らない) ─────
//   strategySpec には describeExitLogic() 経由で **非公開の実数値** が入る。pb1 は
//   固定のプレースホルダ(SYN_EXIT_DESC)に差し替えてから食わせるので、
//   私的な数値はダイジェストの入力に **1バイトも入らない**(構造で断つ)。
//   ★代償(正直に書く): private の決済説明文だけが変わった版では pb1 は動かない。
//     その軸は既存の exit_cfg_version / exit_cfg_hash(signal_trades)と /api/status の
//     exit.configHash が担当しており、pb1 と役割が重ならない。

import {
  buildScalpQuestion, buildScalpQuestionV2, buildScalpSystemPrompt, scalpJsonInstruction,
  buildBiasNote, buildHeldNote, buildArmedNote, buildBandwalkNote, buildVisionNote,
  buildDelegationNote, buildStrategySpec, resolveLcPresentation, LC_CEIL_MANUAL,
  type LcCeilingPresentation, type KnobModes,
} from './scalpPlan.js';
import type { ScalpBias, KnobSource } from '../configStore.js';
import { DEFAULT_PROMPT_VARIANT, PROMPT_VARIANTS, type PromptVariant } from './promptVariant.js';
import { promptBuildFingerprint } from './promptFingerprint.js';
import { publishPromptBuilds } from '../buildIdentity.js';
import type { Bandwalk } from '../bandwalk.js';

// ─── 合成の固定値。★実運用の設定と紛れないよう、現実には使わない値にしてある ────────────
const SYN_FLOOR = 11;
const SYN_CEILING = 97;
const SYN_TREND_VETO = 13;
const SYN_COOLDOWN = 7;
const SYN_REF_PRICE = 12345;
const SYN_HARD_MAX = { enabled: true, value: 199 } as const;
/** ★非公開の決済説明の代わりに食わせる固定文字列(private の数値は入力に入らない)。 */
const SYN_EXIT_DESC = '(決済仕様の説明はここでは固定のプレースホルダにする=私的な数値を指紋の入力に入れない)';
const SYN_BANDWALK: Bandwalk = {
  direction: 'up', ratio: 0.75, bars: 12, sinceT: 1, t: 2, close: SYN_REF_PRICE, band: SYN_REF_PRICE, rsi: 55,
};
const CEIL_DELEGATED: LcCeilingPresentation = { delegated: true, capLabel: '安全上限' };
const MODES_MANUAL: KnobModes = {
  lcFloor: 'manual', lcCeiling: 'manual', trendVeto: 'manual', cooldown: 'manual', bias: 'manual', range: 'manual',
};
const MODES_AI: KnobModes = {
  lcFloor: 'ai', lcCeiling: 'ai', trendVeto: 'ai', cooldown: 'ai', bias: 'ai', range: 'ai',
};

/** 1スライス(=1通りの条件)で描く。★市場文脈(価格・時刻・足・ニュース)は入れない。 */
export interface PromptShapeSlice {
  rangeEnabled: boolean;
  ceil: LcCeilingPresentation;
  aiTechnical: boolean;
  modes: KnobModes;
  bias: ScalpBias;
  withImage: boolean;
  held: boolean;
  armed: boolean;
  bandwalk: boolean;
}
const BASE: PromptShapeSlice = {
  rangeEnabled: false, ceil: LC_CEIL_MANUAL, aiTechnical: false, modes: MODES_MANUAL,
  bias: 'none', withImage: false, held: false, armed: false, bandwalk: false,
};

/** ★条件分岐で出し分ける文面を1つ残らず踏むための固定表。
 *  基準1本 + 「1つだけ変えた」派生。ここに載っていない分岐の文面が変わっても pb1 は動かないので、
 *  **新しい条件分岐をプロンプトに足したら、ここにも1行足すこと**。 */
export const PROMPT_SHAPE_SLICES: readonly PromptShapeSlice[] = [
  BASE,
  { ...BASE, rangeEnabled: true },
  { ...BASE, ceil: CEIL_DELEGATED },
  { ...BASE, aiTechnical: true },
  { ...BASE, modes: MODES_AI },
  { ...BASE, bias: 'long' },
  { ...BASE, bias: 'short' },
  { ...BASE, withImage: true },
  { ...BASE, held: true },
  { ...BASE, armed: true },
  { ...BASE, bandwalk: true },
];

const knobMode = (m: KnobModes, k: keyof KnobModes): KnobSource => m[k];

/** 1スライスぶんの system / user を組み立てる(buildScalpPlan と **同じ関数・同じ順序**)。
 *  ★市場文脈は付けない = ここが pb1 の「データを含めない」の実装そのもの。 */
export function renderPromptShape(variant: PromptVariant, s: PromptShapeSlice): { system: string; user: string } {
  const omitMinDistance = variant === 'v1d';
  const omitMaxDistance = variant === 'v1e';
  const lcWhyJudgment = variant === 'v1f';
  const pres = resolveLcPresentation({
    floorYen: SYN_FLOOR, ceilingYen: SYN_CEILING,
    ceilingMode: s.ceil.delegated ? 'ai' : 'manual', lcHardMax: SYN_HARD_MAX,
  });
  const strategySpec = buildStrategySpec({
    floor: { mode: knobMode(s.modes, 'lcFloor'), value: SYN_FLOOR },
    ceiling: { mode: knobMode(s.modes, 'lcCeiling'), value: SYN_CEILING },
    trendVeto: { mode: knobMode(s.modes, 'trendVeto'), value: SYN_TREND_VETO },
    cooldown: { mode: knobMode(s.modes, 'cooldown'), value: SYN_COOLDOWN },
    bias: { mode: knobMode(s.modes, 'bias'), value: s.bias },
    range: { mode: knobMode(s.modes, 'range'), value: s.rangeEnabled },
    hardMax: SYN_HARD_MAX,
    exitDesc: SYN_EXIT_DESC,
    omitMinDistance,
    omitMaxDistance,
  });
  const system =
    buildScalpSystemPrompt(SYN_FLOOR, pres.ceilingYen, s.rangeEnabled, SYN_TREND_VETO, s.aiTechnical, pres.ceil, omitMaxDistance)
    + buildBiasNote(s.bias)
    + strategySpec
    + buildDelegationNote(s.modes, { floorYen: SYN_FLOOR, ceilingYen: SYN_CEILING, hardMax: SYN_HARD_MAX, rangeEnabled: s.rangeEnabled })
    + buildBandwalkNote(s.bandwalk ? SYN_BANDWALK : undefined, omitMinDistance, omitMaxDistance)
    + buildHeldNote(s.held ? { dir: 'buy', entry: SYN_REF_PRICE } : undefined)
    + buildArmedNote(s.armed ? { mode: 'range-fade', ageMs: 900_000, avgMs: 600_000 } : undefined);
  const question = variant === 'v2'
    ? buildScalpQuestionV2({ floorYen: SYN_FLOOR, ceilYen: pres.ceilingYen, rangeEnabled: s.rangeEnabled, refPrice: SYN_REF_PRICE })
    : buildScalpQuestion(SYN_FLOOR, pres.ceilingYen, s.rangeEnabled, SYN_TREND_VETO, pres.ceil, omitMinDistance, omitMaxDistance);
  // v2 は自前の JSON 契約を持つ(buildScalpPlan と同じ分岐=契約を二重に付けない)。
  const vision = buildVisionNote(s.withImage);
  const user = variant === 'v2'
    ? [question, '', vision].join('\n').trimEnd()
    : [question, '', vision].join('\n')
      + scalpJsonInstruction(SYN_REF_PRICE, SYN_FLOOR, pres.ceilingYen, s.rangeEnabled, pres.ceil, lcWhyJudgment);
  return { system, user };
}

/** ★その変種のプロンプトの型の指紋(pb1:<16桁hex>)を計算する純関数(キャッシュしない実体)。 */
export function computePromptBuildFingerprint(variant: PromptVariant): string {
  const parts: string[] = [variant];
  for (const s of PROMPT_SHAPE_SLICES) {
    const { system, user } = renderPromptShape(variant, s);
    parts.push(system, user);
  }
  return promptBuildFingerprint(parts);
}

// ★起動時に1回だけ計算して使い回す(毎回描画しない)。合成コンテキストは固定で、実行時の設定にも
//   データにも依存しないので、プロセス生存中に値が変わることはない。
const CACHE = new Map<PromptVariant, string>();

/** その変種の pb1 指紋(初回だけ計算・以降はキャッシュ)。 */
export function promptBuildFp(variant: PromptVariant = DEFAULT_PROMPT_VARIANT): string {
  const hit = CACHE.get(variant);
  if (hit !== undefined) return hit;
  const fp = computePromptBuildFingerprint(variant);
  CACHE.set(variant, fp);
  return fp;
}

/** 全変種の指紋(meta の1行に載せる用)。★腕ごとに違う値になることが一目で分かる形にする。
 *  ★同時に葉(server/buildIdentity.ts)へ登録する = 台帳/ルートは LLM スタックを import せずに読める。
 *  起動時に1回呼べば足りる(合成コンテキストは固定なので、プロセス生存中に値は変わらない)。 */
export function allPromptBuildFps(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of PROMPT_VARIANTS) out[v] = promptBuildFp(v);
  publishPromptBuilds(out, DEFAULT_PROMPT_VARIANT);
  return out;
}
