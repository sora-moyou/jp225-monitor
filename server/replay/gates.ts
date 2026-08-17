// ★A(実取引につながる系統)と **同じ武装ゲート** を、オフラインで復元した「その瞬間の価格」に適用する。
//
// ■ なぜ要るか
//   分析用はライブでは **生の提案だけ** を記録している(別プロセスは「その瞬間のライブ価格」を持てないので、
//   ライブで判定すると A と違う価格で判定することになる)。一方 A は武装のたびに3つの検査を通す。
//   ゲートを通さずに影を作ると、影の母集団は「A が実際に武装しえた提案」ではなく「AI が言っただけの提案」に
//   なり、決済パラメータの比較が **別の母集団の上での比較** になる。
//
// ■ ★オフラインだからこそ忠実にできる
//   3つの検査はいずれも「ARM 時点の live 価格」を要求する。保管ティックからその時刻の価格を復元できるので、
//   ライブの別プロセスでは不可能だった適用が、再生では可能になる。
//
// ■ ★再実装しない
//   検査はすべて **エクスポート済みの本番の純関数をそのまま呼ぶ**(条件を書き写さない):
//     server/signalTrade/sanity.ts    checkSanity
//     server/signalTrade/armGate.ts   checkRefDrift / recheckArmedSanity / armedToPlan
//     server/signalTrade/decisions.ts checkStaleLegs / planToArmed
//   順序と適用条件も engine.ts の ARM 経路①(flat 計画)と同一にしてある(下の applyArmGates 参照)。

import type { AiPlan } from '../llm/scalpPlan.js';
import { checkSanity } from '../signalTrade/sanity.js';
import { checkRefDrift, recheckArmedSanity, armedToPlan } from '../signalTrade/armGate.js';
import { planToArmed, checkStaleLegs, entryRoundedFromPlan, type ArmedBracket } from '../signalTrade/decisions.js';
import type { ShadowPlan } from '../signalTrade/shadow/sim.js';

/** どの門で落ちたか。★engine.ts が1行ログに出している呼び名(reason=refstale / stale / recheck)に揃える
 *  =serverlog と再生の記録が同じ語彙で読める(新しい語彙を作らない)。 */
export type ArmGateName =
  | 'sanity'          // checkSanity(計画時価格 refPrice 基準・trade2 と byte 同期の検査)
  | 'refstale'        // checkRefDrift(refPrice と ARM 時 live の乖離)
  | 'stale'           // checkStaleLegs(全レッグが「もう通過した価格」)
  | 'recheck'         // recheckArmedSanity(単レッグ化した後の再検証)
  | 'not-armable'     // planToArmed が null(向きガード等)
  | 'not-directional';// レンジ提案(影はラチェットを測るものなので対象外)

export type ArmGateResult =
  | { ok: true; armed: ArmedBracket; plan: ShadowPlan }
  | { ok: false; gate: ArmGateName; reason: string };

/**
 * ★A と同じ順序・同じ適用条件で武装ゲートを通す。
 *   ① checkSanity(plan, plan.refPrice)          — 計画時価格基準(A の設計判断をそのまま踏襲)
 *   ② checkRefDrift(plan.refPrice, live)        — checkStaleLegs より **前**(A と同じ)
 *   ③ planToArmed(plan, now, { vetoFired })
 *   ④ checkStaleLegs(armed0, live)              — 全レッグ通過済みなら武装しない
 *   ⑤ recheckArmedSanity(armed, refPrice, live) — ★脚が落ちた時 + 刻み丸めでエントリーが動いた時だけ
 *                                                  (A と同じ条件。無条件に掛けると健全なブラケットまで
 *                                                   落ちて母集団が A と別物になる)
 * @param live ARM 時点の live 価格。**必ず新鮮値**(A の livePrice() は stale を null にする)を渡すこと。
 *   ここでは null を受けない: null だと②④⑤が素通しになり「門を通した」と言えなくなるため、
 *   価格を復元できなかった提案は **呼び出し側が別の理由で除外** する(server/replay/replay.ts)。
 * @returns ok:true のとき plan は「実際に武装される形」に戻した計画(落ちた脚は載っていない)。
 *   ShadowSim.open はこれを受けて **本番の planToArmed** をもう一度通す(=影が使うブラケットは armed と一致)。
 */
export function applyArmGates(
  plan: AiPlan, live: number, now: number, vetoFired?: boolean,
): ArmGateResult {
  if (plan.direction === 'range') {
    return { ok: false, gate: 'not-directional', reason: 'レンジ提案(影はラチェットを測るので対象外)' };
  }
  if (plan.direction !== 'buy' && plan.direction !== 'sell') {
    return { ok: false, gate: 'not-armable', reason: `direction=${String(plan.direction)}` };
  }
  const sanity = checkSanity(plan, plan.refPrice);
  if (!sanity.ok) return { ok: false, gate: 'sanity', reason: sanity.reason };

  const drift = checkRefDrift(plan.refPrice, live);
  if (!drift.ok) return { ok: false, gate: 'refstale', reason: drift.reason };

  const armed0 = planToArmed(plan, now, { vetoFired });
  if (!armed0) return { ok: false, gate: 'not-armable', reason: 'planToArmed が null(向きガード等)' };

  const stale = checkStaleLegs(armed0, live);
  const armed = stale.armed;
  if (!armed) {
    const legs = stale.legs.map(l => `${l.name}${l.stale ? '(通過済み)' : ''}`).join(' ');
    return { ok: false, gate: 'stale', reason: `全レッグが ARM 時価格で通過済み: ${legs}` };
  }
  // ★脚が落ちた時だけ再検証(checkStaleLegs は何も落ちなければ引数と同一参照を返す)= engine と同じ条件。
  //   ★+ 刻み丸めでエントリーが動いた時も再検証する(丸めは幅を広げる方向にしか動かず、幅400円ちょうどの
  //     ブラケットが405円に化けて上限超になる)。engine.ts の3つの ARM 経路と **同じ条件** に保つ。
  if (armed !== armed0 || entryRoundedFromPlan(plan, armed)) {
    const recheck = recheckArmedSanity(armed, plan.refPrice, live);
    if (!recheck.ok) return { ok: false, gate: 'recheck', reason: recheck.reason };
  }
  return { ok: true, armed, plan: toShadowPlan(armed, plan) };
}

/** 武装が決まったブラケット → ShadowSim.open に渡す計画。
 *  ★変換は本番の armedToPlan(armGate.ts)を使う(「実際に発注される形」を計画へ戻す既存の関数)。
 *    記録のみの regime/confidence は AiPlan 側から持ち直す(armedToPlan は載せないため)。 */
export function toShadowPlan(armed: ArmedBracket, plan: AiPlan): ShadowPlan {
  const p: ShadowPlan = armedToPlan(armed, plan.refPrice);
  if (plan.regime !== undefined) p.regime = plan.regime;
  if (typeof plan.confidence === 'number') p.confidence = plan.confidence;
  return p;
}
