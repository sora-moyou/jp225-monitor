// server/llm/planVariants.ts — ★B(価格と損切幅を尋ねる呼び出し)の **4種の版** と、その対応表(SSOT)。
//
// ■ この設計の芯
//   AI に聞くのは **数値だけ**(価格・損切幅)と、その理由。
//   ★**「買いか売りか」「指値か逆指値か」は AI に返させない。この表からコードが埋める。**
//   実測 `sell/stop/上` 22件(売りのブレイク新規が現在値より上=即約定する不正)は、
//   AI が side を返していたから起きた。★**返す場所が無ければ、間違えようがない。**
//
// ■ 版はコードが選ぶ(AI は選ばない)
//   目線 buy  → 'buy' / 目線 sell → 'sell'
//   目線 range → BB がスクイーズなら 'range-breakout'、それ以外(bulge / どちらでもない / 測れない)は 'range-fade'
//   ★判定は既存の buildSqueezeSnapshot の生値をそのまま使う(新しい閾値を作らない)。
//
// ■ ★問いの形(あ／い)が向きを決める
//   あ) = **現在価格より上** の価格 / い) = **現在価格より下** の価格。
//   この2つは独立した問いなので、★**片方だけ見送れる**(「片方が置けなかった」が「計画ごと見送り」に潰れない)。
//   価格の不等式(上/下)はプロンプトの問いの形で担保し、コード側は下流の既存検証で再確認する
//   (=規則の散文を増やさない。散文で強めるのは6版効かなかった経緯がある)。
//
// ■ ★レンジ2版は当面 **1回も使われません**
//   レンジ設定は既定 OFF で、当面 OFF のまま運用します(実データ 22,011件中 range は0件)。
//   それでも作って残すのは、①目線が range になる回は必ず起きるので「注文側を呼ばなかった」と
//   記録すること自体が目的(b_variant='none')であり、②後で ON にするとき文面を書き起こさずに済み、
//   ③OFF のままでも squeeze_state は記録できる=ON にする前に「どちらの版が何回選ばれたはずか」を実測できるため。

import type { AiPlan, RangeLeg } from './scalpPlan.js';
import { stopLossFromWidth } from '../../core/stopGeometry.js';

/** 目線(A の答え)。★注文の語ではない。ブル/ベア/レンジ。 */
export type TrendDirection = 'bull' | 'bear' | 'range';

/** B の版。★コードが選ぶ。 */
export type BVariant = 'buy' | 'sell' | 'range-fade' | 'range-breakout';

/** BB スクイーズ判定の生値(server/indicators.ts の buildSqueezeSnapshot().state と同じ語彙)。 */
export type SqueezeState = 'squeeze' | 'bulge' | null;

/** 問いの記号。あ)=上の価格 / い)=下の価格。 */
export type LegKey = 'a' | 'i';

/** 1本のレッグの契約。★side / type は **ここだけ** が決める(AI は返さない)。 */
export interface LegContract {
  key: LegKey;
  /** 現在価格に対する位置。あ=above / い=below(問いの形そのもの)。 */
  position: 'above' | 'below';
  /** ★コードが埋める売買の側。 */
  side: 'buy' | 'sell';
  /** ★コードが埋める注文の種類。 */
  type: 'limit' | 'stop';
  /** プロンプトに書く注文の日本語名(この語だけが AI に見える)。 */
  orderJa: string;
}

export interface BVariantSpec {
  variant: BVariant;
  /** system に書く目線の言葉。 */
  trendJa: string;
  /** 方向プラン(limitEntry/stopEntry)か、レンジ2脚(range.upper/lower)か。 */
  shape: 'directional' | 'range';
  legs: { a: LegContract; i: LegContract };
}

const L = (
  key: LegKey, side: 'buy' | 'sell', type: 'limit' | 'stop', orderJa: string,
): LegContract => ({ key, position: key === 'a' ? 'above' : 'below', side, type, orderJa });

/** ★4種の対応表(SSOT)。呼び出し側に if を散らさないため、文面も対応表もここに集める。 */
export const B_VARIANTS: Readonly<Record<BVariant, BVariantSpec>> = {
  buy: {
    variant: 'buy', trendJa: '上昇トレンド', shape: 'directional',
    legs: { a: L('a', 'buy', 'stop', '逆指値買い注文'), i: L('i', 'buy', 'limit', '指値買い注文') },
  },
  sell: {
    variant: 'sell', trendJa: '下降トレンド', shape: 'directional',
    legs: { a: L('a', 'sell', 'limit', '指値売り注文'), i: L('i', 'sell', 'stop', '逆指値売り注文') },
  },
  'range-fade': {
    variant: 'range-fade', trendJa: 'トレンドが無い(レンジ)', shape: 'range',
    legs: { a: L('a', 'sell', 'limit', '指値売り注文'), i: L('i', 'buy', 'limit', '指値買い注文') },
  },
  'range-breakout': {
    variant: 'range-breakout', trendJa: 'トレンドが無い(レンジ)', shape: 'range',
    legs: { a: L('a', 'buy', 'stop', '逆指値買い注文'), i: L('i', 'sell', 'stop', '逆指値売り注文') },
  },
};

/**
 * ★どの B を渡すかを決める純関数。**AI は選ばない。**
 * range のときだけスクイーズ判定を見る。判定が使えない(null)なら fade(=既定)。
 */
export function pickBVariant(trend: TrendDirection, squeeze: SqueezeState): BVariant {
  if (trend === 'bull') return 'buy';
  if (trend === 'bear') return 'sell';
  return squeeze === 'squeeze' ? 'range-breakout' : 'range-fade';
}

// ─── B が返す答え ────────────────────────────────────────────────────────────
// ★このインターフェイスに side / type / direction は **無い**。だから AI がそれを書いても
//   parseBAnswer が拾わず、下流に1バイトも届かない(=返す場所が存在しない)。

export interface BAnswer {
  /** この相場をどう読んで この価格にしたか(1行)。 */
  strategy?: string;
  aPrice?: number; aLcWidth?: number; aWhy?: string;
  iPrice?: number; iLcWidth?: number; iWhy?: string;
  /** ★段6(2026-08-22): 判断に必要なデータが足りなかったときに、何が足りなかったかを書く自由文。
   *  ★あ/い の理由(aWhy/iWhy)とは別物・混ぜない(①の contextPresence と後で突き合わせるため、
   *  AI の自己申告はそれ専用の列に置く)。選択肢は作らない(自由文のみ)。 */
  missingData?: string;
}

const num = (v: unknown): number | undefined =>
  (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
const str = (v: unknown): string | undefined =>
  (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

/**
 * B の応答テキストから BAnswer を取り出す純関数。コードフェンスや前後の説明が混じっていてもよい。
 * ★**ホワイトリストで1つずつ写す**ので、契約に無いキー(side/type/direction/entry…)は
 *   ここで落ちる=下流に届かない。読めなければ null。
 */
export function parseBAnswer(text: string): BAnswer | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const out: BAnswer = {};
  const s = str(o['strategy']); if (s !== undefined) out.strategy = s;
  const ap = num(o['aPrice']); if (ap !== undefined) out.aPrice = ap;
  const aw = num(o['aLcWidth']); if (aw !== undefined) out.aLcWidth = aw;
  const ay = str(o['aWhy']); if (ay !== undefined) out.aWhy = ay;
  const ip = num(o['iPrice']); if (ip !== undefined) out.iPrice = ip;
  const iw = num(o['iLcWidth']); if (iw !== undefined) out.iLcWidth = iw;
  const iy = str(o['iWhy']); if (iy !== undefined) out.iWhy = iy;
  const md = str(o['missingData']); if (md !== undefined) out.missingData = md;
  return out;
}

/** B の答えを既存の AiPlan に組み立てた結果。理由は記録用に別で返す(AiPlan の形を変えない)。 */
export interface BPlanBuild {
  plan: AiPlan;
  /** ★AI が「置けない」と書いた理由(あ/い ぶん)。両方見送りのときは none_reason='ai' の ai_why になる。 */
  aWhy?: string;
  iWhy?: string;
  /** レッグが1本も立たなかったか(=B の見送り)。 */
  bothDropped: boolean;
}

/** 1レッグぶんの価格と幅が揃っているか(幅は正・非0)。★向きの検査は下流の既存検証に任せる。 */
function legReady(price: number | undefined, width: number | undefined): boolean {
  return price !== undefined && width !== undefined && width > 0;
}

/**
 * ★B の答えを **既存の AiPlan** に組み立てる純関数。
 *
 *   ■ なぜ既存の形に戻すのか
 *     こうすると下流(parse 後の enforce・LC 上下限・bias/trend veto・legDrops・台帳・SSE・trade2)を
 *     **1行も変えずに再利用できる**。分割で変わるのは「数値をどう手に入れるか」だけにする。
 *   ■ ★side は表から、損切り価格は stopLossFromWidth から。AI の値は使わない。
 *     stopLossFromWidth(core/stopGeometry.ts)は損切りの符号を決める **唯一の場所**(v0.9.70)。
 *   ■ 揃っていないレッグは **落とす**(片脚だけでも成立させる)。両方落ちたら direction:'none'。
 */
export function buildPlanFromBAnswer(
  variant: BVariant, answer: BAnswer, refPrice: number, rationale = '',
): BPlanBuild {
  const spec = B_VARIANTS[variant];
  const aOk = legReady(answer.aPrice, answer.aLcWidth);
  const iOk = legReady(answer.iPrice, answer.iLcWidth);
  const base = { rationale, refPrice } as const;
  const strategy = answer.strategy;

  if (!aOk && !iOk) {
    return {
      plan: { direction: 'none', ...base, ...(strategy ? { strategy } : {}) },
      aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: true,
    };
  }

  const legOf = (c: LegContract, price: number, width: number): RangeLeg => ({
    side: c.side, type: c.type, entry: price,
    stopLoss: stopLossFromWidth(c.side, price, width),   // ★向きはここだけが決める
  });

  if (spec.shape === 'range') {
    const plan: AiPlan = {
      direction: 'range', ...base, ...(strategy ? { strategy } : {}),
      range: {
        ...(aOk ? { upper: legOf(spec.legs.a, answer.aPrice!, answer.aLcWidth!) } : {}),
        ...(iOk ? { lower: legOf(spec.legs.i, answer.iPrice!, answer.iLcWidth!) } : {}),
      },
    };
    return { plan, aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: false };
  }

  // 方向プラン: あ/い のどちらが limit でどちらが stop かは **版ごとに逆**(表が持つ)。
  const plan: AiPlan = { direction: spec.variant as 'buy' | 'sell', ...base, ...(strategy ? { strategy } : {}) };
  for (const c of [spec.legs.a, spec.legs.i]) {
    const ok = c.key === 'a' ? aOk : iOk;
    if (!ok) continue;
    const price = (c.key === 'a' ? answer.aPrice : answer.iPrice)!;
    const width = (c.key === 'a' ? answer.aLcWidth : answer.iLcWidth)!;
    if (c.type === 'limit') {
      plan.limitEntry = price;
      plan.stopLossForLimit = stopLossFromWidth(c.side, price, width);   // ★向きはここだけ
    } else {
      plan.stopEntry = price;
      plan.stopLossForStop = stopLossFromWidth(c.side, price, width);
    }
  }
  return { plan, aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: false };
}

// ─── B のプロンプト(4種) ──────────────────────────────────────────────────────

/** B の system プロンプト。★損切幅の帯は設定から解決した値をそのまま埋める(固定値ではない)。
 *  ★2026-08-22 訂正(リーダー指摘): 一度 delegationNote(AI委任の注記)を引数に追加して B へ渡したが、
 *  取り消した。理由は「B に戻さないもの」の節(このファイル冒頭コメント/設計書)を参照。
 *  ★delegationNote は受け取らない(意図的)。 */
export function buildBSystemPrompt(
  variant: BVariant, floorYen: number, ceilingYen: number, marketData: string,
): string {
  const spec = B_VARIANTS[variant];
  return `あなたは日経225先物(NIY=F)のスキャルピングを行うトレーダーです。
いまの相場は【${spec.trendJa}】と判断されています。

制約:
- 損切幅は ${floorYen}円以上 ${ceilingYen}円以下 の正の数(円)。
- 価格はすべて円単位の実数。

【データ】
${marketData}`;
}

/** B の user プロンプト。★あ)=上 / い)=下 の2つの独立した問いにする(片方だけ見送れる形)。 */
export function buildBUserPrompt(variant: BVariant, refPrice: number, floorYen: number, ceilingYen: number): string {
  const spec = B_VARIANTS[variant];
  const a = spec.legs.a, i = spec.legs.i;
  const priceJa = (c: LegContract): string => (c.type === 'limit' ? '指値価格' : '逆指値価格');
  const band = `${floorYen}円以上${ceilingYen}円以下`;
  return `現在価格は ${refPrice} です。次の2つに答えてください。

あ)(現在価格の)上の価格に${a.orderJa}を入れるとしたとき、${priceJa(a)}と損切幅を提案してください。
い)(現在価格の)下の価格に${i.orderJa}を入れるとしたとき、${priceJa(i)}と損切幅を提案してください。
またそれぞれについて、提案理由を教えてください。
置けないと判断したときは、その価格と損切幅を省き、理由だけを書いてください。
判断に必要なデータが足りなかったときは、何が足りなかったかも書いてください。

次の JSON だけを出力してください(前後に説明文・コードフェンス・マークダウンを付けない)。
{
  "strategy": string,  // この相場をどう読んで この価格にしたか
  "aPrice": number,   // あ) の${priceJa(a)}(置かないときは省く)
  "aLcWidth": number, // あ) の損切幅(${band}・置かないときは省く)
  "aWhy": string,     // あ) の提案理由(置かないときは その理由)
  "iPrice": number,   // い) の${priceJa(i)}(置かないときは省く)
  "iLcWidth": number, // い) の損切幅(${band}・置かないときは省く)
  "iWhy": string,     // い) の提案理由(置かないときは その理由)
  "missingData": string // 判断に必要なデータが足りなかったときに、何が足りなかったか(無ければ省く)
}`;
}
