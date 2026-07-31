// ARM(武装)直前のゲート。**「計画を作った時の価格」ではなく「今まさに武装する時の価格」** で
// 最終判定するための純関数群。checkSanity(sanity.ts)は trade2 と byte 同期する契約があるため一切触らず、
// monitor 固有のこのレイヤから **再利用** する。
//
// ─── なぜ必要か(実データ) ─────────────────────────────────────
// ① 単レッグ化したプランが再検証されない(2026-07-30 sid=361)
//    従来の順序は checkSanity(2レッグとして合格) → checkStaleLegs(通過済みレッグを落として単レッグ化)
//    → 武装 だった。checkSanity は **2レッグ時は距離上限を課さない**(現値を挟むことが正当性の基準)ため、
//    片脚が落ちて単レッグになった瞬間に「単レッグ ≤ MAX_ENTRY_DISTANCE_YEN(200円)」という制約が
//    ノーチェックで素通りする。
//      実測: 2026-07-30T23:45:41Z `plan-stale dir=buy ref=63865 live=64120 limit=63805 stop=63955(通過済み)`
//            → 残った指値 63805 は ARM 時 live 64120 から 315円。trade2 は受信直後から
//              `sanity:buy: 単レッグ(指値のみ)の指値(63805)が現在値(64025)から220円離れており上限200円超`
//              を **147回** 出し続け、15分の armed-timeout まで一度も約定しなかった。
//    ★判定基準は ARM 時の live 価格でなければ意味がない: レッグ値も refPrice も武装までに変わらないので、
//      refPrice で再検証しても結果は必ず「合格」になる(実測でも refPrice 基準では新規に落ちる件が 0 件)。
//
// ② refPrice に鮮度の上限が無い(2026-07-23)
//    checkSanity は plan.refPrice(チャート撮影時の価格)基準で判定するが、その refPrice が
//    **どれだけ古くてよいか** の制限がどこにも無かった。
//      実測: 21:42:01→21:56:52 sell 指値@66725(初回現値 65795・乖離 930円)= 131回連続で trade2 が拒否。
//            22:44:35→22:59:30 sell 指値@66990(初回現値 65995・乖離 995円)= 130回連続で拒否。
//            bars_1m では 66,725 の最終到達は同日 14:45、66,990 は 10:16 = 7〜12時間前の水準。
//    → 「refPrice と ARM 時 live 価格の乖離」に上限を課す。
//
// ─── 上限値の根拠(MAX_REF_DRIFT_YEN = 200円) ────────────────────
//  (a) 実測分布: 欠陥の稼働全期間の serverlog に残る plan-stale 18件(= ref と ARM 時 live が両方記録されて
//      いる全サンプル。価格が動いたせいで脚が落ちた回なので **乖離が大きい側に偏った** 母集団)の乖離は
//      15,15,15,15,15,20,20,45,45,50,50,55,60,65,65,70,100,255 円。
//      17/18 が 100円以下で、唯一の外れ値 255円 が上記 sid=361(147回拒否)そのもの。
//  (b) 意味論: monitor が保証できるのは「refPrice に対する checkSanity」だけ。単レッグの距離上限は
//      MAX_ENTRY_DISTANCE_YEN=200円 なので、live が refPrice から 200円 を超えて離れた時点で
//      refPrice 基準の合格は live で何も保証しない(距離0の完璧な計画ですら上限超になり得る)。
//      = 200円 は「refPrice 基準の判定がまだ何かを保証できる」上限そのもの。
//  → 健全な 17/18 を通し、既知の実害 1件(255円)と 7/23 の 930/995円(4.6〜5倍)を止める。

import type { AiPlan } from '../llm/openai.js';
import { checkSanity, MAX_ENTRY_DISTANCE_YEN } from './sanity.js';
import type { ArmedBracket } from './decisions.js';

export type ArmGateResult = { ok: true } | { ok: false; reason: string };

/** refPrice(計画時価格)と ARM 時 live 価格の乖離上限[円]。根拠はファイル冒頭。
 *  MAX_ENTRY_DISTANCE_YEN と同値なのは偶然ではない(上記 (b))。 */
export const MAX_REF_DRIFT_YEN = MAX_ENTRY_DISTANCE_YEN;

/**
 * ★武装する **そのもの** を AiPlan の形へ戻す(checkSanity を再利用するためのアダプタ)。
 *  checkStaleLegs で脚が落ちた後の ArmedBracket を渡すので、「実際に発注される形」がそのまま検証対象になる。
 *  refPrice は AiPlan の必須フィールドだが checkSanity は第2引数の currentPrice しか見ないため、
 *  ここでは記録目的で載せるだけ(判定には使われない)。
 */
export function armedToPlan(a: ArmedBracket, refPrice: number): AiPlan {
  if (a.mode === 'range' || a.range != null) {
    return { direction: 'range', rationale: a.rationale, refPrice, range: a.range ?? {} };
  }
  const p: AiPlan = { direction: a.direction, rationale: a.rationale, refPrice };
  if (a.limitEntry != null) p.limitEntry = a.limitEntry;
  if (a.stopEntry != null) p.stopEntry = a.stopEntry;
  if (a.stopLossForLimit != null) p.stopLossForLimit = a.stopLossForLimit;
  if (a.stopLossForStop != null) p.stopLossForStop = a.stopLossForStop;
  return p;
}

/**
 * ★作業2: refPrice の鮮度ゲート。計画時価格と ARM 時 live 価格の乖離が MAX_REF_DRIFT_YEN を超えたら NG。
 *  live が取れない/非有限(null/undefined/NaN/Inf)なら判定しない(=ok)。checkStaleLegs と同じ fail-safe
 *  規約: 新しい抑止で取引を止めない(判定材料が無いときに落とさない)。
 *  refPrice が非有限のときは乖離を測れないので NG(壊れた refPrice で武装しない)。
 */
export function checkRefDrift(refPrice: number, live: number | null | undefined): ArmGateResult {
  if (live == null || !Number.isFinite(live)) return { ok: true };
  if (!Number.isFinite(refPrice)) {
    return { ok: false, reason: `refPrice が非有限(${refPrice})=計画時価格が壊れている` };
  }
  const drift = Math.abs(refPrice - live);
  if (drift > MAX_REF_DRIFT_YEN) {
    return {
      ok: false,
      reason: `refPrice 鮮度: 計画時価格(${Math.round(refPrice)})が ARM 時価格(${Math.round(live)})から`
        + `${Math.round(drift)}円 乖離しており上限${MAX_REF_DRIFT_YEN}円超`,
    };
  }
  return { ok: true };
}

/**
 * ★作業1: ARM 直前の再検証。checkStaleLegs で脚が落ちた **後** のブラケットを、**ARM 時の live 価格** で
 *  もう一度 checkSanity にかける。2レッグ→単レッグ化で新たに効くようになる距離上限(200円)を必ず通す。
 *  live が取れない/非有限なら判定しない(=ok・fail-safe)。
 *  ★refPrice で再検証しても意味が無い(レッグ値も refPrice も武装まで変わらない=必ず合格)ので、
 *    判定基準は live 一択。呼び出し側は必ず「stale plan veto と同じ新鮮値」を渡すこと。
 */
export function recheckArmedSanity(
  armed: ArmedBracket, refPrice: number, live: number | null | undefined,
): ArmGateResult {
  if (live == null || !Number.isFinite(live)) return { ok: true };
  const s = checkSanity(armedToPlan(armed, refPrice), live);
  return s.ok ? { ok: true } : { ok: false, reason: `ARM時再検証(live=${Math.round(live)}): ${s.reason}` };
}
