// ─── レンジ両面プランの「形」の観測(記録専用) ─────────────────────────────
// ★v0.9.44: プロンプトは「レンジは2択=fade(両側指値) / breakout(両側ブレイク新規)の組を丸ごと選ぶ・
//   組を混ぜない」と指示する。その指示が効いているかを次セッションで観測するための計測フック。
//   ★受理は現状のまま=ここでは何も落とさない(弾かない方がバグを発見できる、というユーザー判断)。
//
// ★依存ゼロの leaf モジュールにしてある(import 文を増やさないこと)。
//   engine.ts は LLM スタック(llm/openai.js = providers の副作用を含む barrel)を意図的に遅延ロード
//   (`await import('../llm/scalpPlanRunner.js')`)している。観測関数のために barrel を静的 import すると
//   engine を読むだけで LLM プロバイダ初期化が走り、その設計方針が壊れる。よってここへ切り出す。

/** 判定に必要な最小の構造(AiPlan / RangeLeg を構造的に受ける=型 import 不要)。 */
export interface RangeShapeLeg { side: 'buy' | 'sell'; type: 'limit' | 'stop'; entry: number }
export interface RangeShapeInput {
  direction: string;
  range?: { upper?: RangeShapeLeg; lower?: RangeShapeLeg };
}

/** レンジ規約違反の観測結果(ログ1行用のタグ + 生数値)。規約どおりなら null。 */
export interface RangeAnomaly { tag: 'plan-range-mixed' | 'plan-range-sides'; legs: string }

/** レンジ両面プランが、プロンプトの規約「2択=fade(両側指値) / breakout(両側ブレイク新規)、組を混ぜない」に
 *  反する形で届いたかを判定する純関数。規約どおり(または判定対象外)なら null。
 *  - 'plan-range-mixed' : 片方 type:'limit'・片方 type:'stop'(組の混在)
 *  - 'plan-range-sides' : 組は揃っているが向きが逆(fade で上=買い/下=売り、breakout で上=売り/下=買い)
 *  ★必ず **AI の生出力(parse 直後の plan)** に対して呼ぶこと。enforce(トレンド veto / バイアス / LC上限)の
 *    後だと片脚が落ちて upper/lower が揃わず null になり、いちばん知りたい母集団で盲目になる。 */
export function describeRangeAnomaly(plan: RangeShapeInput): RangeAnomaly | null {
  if (plan.direction !== 'range') return null;
  const u = plan.range?.upper;
  const l = plan.range?.lower;
  if (!u || !l) return null;   // 片脚だけ(AI が1本しか出さなかった等)は組の判定対象外。
  const legs = `upper=${u.side}/${u.type}@${Math.round(u.entry)} lower=${l.side}/${l.type}@${Math.round(l.entry)}`;
  if (u.type !== l.type) return { tag: 'plan-range-mixed', legs };
  // 組が揃っている場合の正しい向き: fade(両 limit)=上売り/下買い、breakout(両 stop)=上買い/下売り。
  const wantUpper = u.type === 'limit' ? 'sell' : 'buy';
  const wantLower = u.type === 'limit' ? 'buy' : 'sell';
  if (u.side !== wantUpper || l.side !== wantLower) return { tag: 'plan-range-sides', legs };
  return null;
}
