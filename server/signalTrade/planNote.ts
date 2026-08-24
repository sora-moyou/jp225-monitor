// 待機中(シグナル無し)の画面に出す「AI の目線と、見送った理由」を組み立てる **純関数**。
//
// ■ なぜ要るか(実測・2026-08-24)
//   v0.9.96 で A/B 分割が実走した21件は **全部** A が range と答え、レンジ無効の設定なので
//   B を1度も呼ばずに見送っていた。台帳(signal_plans)には
//     a_direction='range' / a_why=「…RSI も 50 付近で明確な勢いが見られない」/ none_reason='rangeDisabled'
//   が 21/21 入っているのに、画面は「シグナル待機（節目クロス待ち）」の1行だけだった
//   = **目線も理由も在るのに、画面へ届く経路が1本も無かった**(配線漏れ)。
//
// ■ ★出所を勝手に作らない(この案件で最も嫌われる失敗=推測で断定する)
//   ・目線は ① A の答え(splitRecord.aDirection) ② それが無ければ **計画自身の direction**
//     (buy/sell/range)からしか取らない。★どちらも **AI が答えた値そのもの** で、推測ではない。
//     `direction === 'none'` の回は目線が本当に分からないので **ラベルを出さない**。
//     rationale の本文から「目線はレンジ」を正規表現で抜くような復元はしない。
//     ★②を足した理由(2026-08-24・リーダー裁定): 8/19以降で ARM しなかった127件のうち **7件** は
//       `direction` が buy/sell のまま **こちらのゲート(サニティ等)で止めた** 回だった。
//       これはまさに「目線はあって、その目線のもとでシグナルを見送った」形で、目線は実在する。
//   ・理由は 分割の回=A の自由文(aWhy)/ 旧経路=directionWhy → rationale の順。
//   ・**見送り**(計画の中で決まった none)の日本語は既存の SSOT(legDropReasonText)だけを使う。
//   ・**不採用**(こちらのゲートで止めた)の日本語は GATE_TEXT(下)。★うち3語は 2026-08-24 に
//     **新しく足した語彙**(リーダー裁定)。既存語で足りなかった根拠は GATE_TEXT のコメントに実測で残す。
//
// ■ RECORD/DISPLAY-ONLY
//   ここで作った値は SSE に載せて画面に出すだけ。採否・価格・台帳・決済には一切影響しない。

import type { ScalpPlanResult } from '../llm/scalpPlan.js';
import { legDropReasonText, type NoneReason } from '../llm/scalpPlan.js';
import type { SignalTradeState } from '../types.js';

/** 待機表示の材料(SignalTradeState.lastNone と同じ形)。 */
export type PlanNote = NonNullable<SignalTradeState['lastNone']>;

/** ★エンジンのゲート(=AI ではなく **こちらの検証** が計画を止めた場所)の一覧。
 *  ★語は engine の console ログで既に使っている識別子をそのまま使う(新しい識別子を作らない)。
 *  ★**この配列が唯一の出所**: 型も表もここから導く=新しいゲートを足すと
 *    ① Record<PlanGate,…> が全キーを要求して **tsc が落ちる**
 *    ② server/signalTrade/planNote.test.ts の §ゲートの表 が **落ちる**
 *    ので、「文言を書き忘れて画面が『不採用』の1語だけになる」経路が作れない。 */
export const PLAN_GATES = ['sanity', 'refDrift', 'stale', 'recheck', 'armBlocked'] as const;

/** ★エンジンのゲート。engine.ts が渡す。 */
export type PlanGate = typeof PLAN_GATES[number];

/**
 * ★ゲートの日本語(サイクルの抑止理由)。**画面はこれを「不採用: 〜」の形で出す。**
 *
 * ■ ★これは `LEG_DROP_REASON_TEXT`(server/llm/scalpPlan.ts)とは **別の表** である
 *   ・あちら … **レッグ1本** が最終プランに残らなかった理由(missing / stopSide / lcFloor …)。
 *   ・こちら … **計画は成立したのに、サイクルごと ARM しなかった** 理由。
 *   ★混ぜてはいけない: 同じ語が2つの意味を持つと「外側」の事故(語の衝突で向きを取り違えた)と
 *     同じ型の間違いになる。だから **表を分け、キーの集合も別**(NoneReason ではなく PlanGate)にする。
 *
 * ■ ★新しい語彙であることの明示(2026-08-24・リーダー裁定)
 *   `sanity` / `refDrift` / `recheck` の3つは **このプロジェクトに既存の日本語が無かった**。
 *   ★根拠(実測): `legDropReasonText` の13語
 *     (AIが提案せず / 損切りがエントリーの逆側 / エントリーが現在値の逆側 / 損切り幅の値が不正 /
 *      損切り幅が設定の下限より狭い / 損切り幅が設定の上限より広い / トレンドに逆行 / バイアス設定と逆 /
 *      現在値が既にエントリーを通過 / レンジ設定が無効 / 目線の判断が得られず / AIが理由も価格も返さず)
 *     に「エントリーが現在値から遠すぎる」に当たる語が **1つも無い**(`lc` は損切り幅の話で別概念)。
 *     `server/signalTrade/sanity.ts` の理由文は
 *     「sell: 単レッグ(指値のみ)の指値(65745)が現在値(65500)から245円離れており上限200円超」
 *     のような **診断用の文字列**(生の閾値入り)で、画面の言い回しではない。
 *   ★よって **新語を3つ足した**。足したのはリーダーの裁定であり、コーダーの独断ではない。
 *
 * ■ ★数値を書かない
 *   「200円超」のような閾値を画面に出さない。**閾値が変わったら文言が嘘になる** から
 *   (このプロジェクトは「数値は AI にも人にもアンカーになる」を実測で確認している)。
 *
 * ■ 既存語を使う2つ
 *   stale ……… legDropReasonText('stale') = 既存 SSOT をそのまま引く(写しを作らない)。
 *   armBlocked … 「連続失効」= 待機表示(web/components/signalPanel.ts の buildWaitMain)が
 *                既に画面で使っている語。
 *
 * ■ ★既知の限界(★未解決・報告済み): `sanity` は **1つのゲートに複数の落ち方** がある
 *   (側の検査 / 損切りの向き / 単レッグの距離 / 両レッグの幅 / レッグ皆無 / 現在値なし)。
 *   文言はそのうち **距離** を指しているので、別の落ち方で発火した回は文言が実態とずれる。
 *   ★実測(8/19以降・ARM しなかった127件)では sanity 7件が **7件とも距離超** だった
 *   (4件は serverlog の実文・3件は台帳の drift_yen=NULL と距離の算術から復元)。
 *   ★落ち方まで書き分けるには checkSanity に種別を持たせる必要があるが、
 *     `server/signalTrade/sanity.ts` は jp225-trade2 の同名ファイルと **byte 単位で同期する規約**
 *     なので、こちらだけで変えられない(両リポ同時の変更が要る)。 */
const GATE_TEXT: Record<PlanGate, string> = {
  sanity: 'エントリーが現在値から遠い',
  refDrift: '価格が動いた',
  recheck: '再検証で落ちた',
  stale: legDropReasonText('stale'),
  armBlocked: '連続失効',
};

/** ★A の答え('bull'/'bear'/'range')→ 画面の語彙('buy'/'sell'/'range')の対応づけ。
 *  ★**この1箇所だけ**。A は「相場の向き」を答えるので bull/bear、画面は注文の語彙に揃えた
 *  「買い目線/売り目線/レンジ目線」(web/components/signalPanel.ts の BIAS_JA)を出すため、
 *  どこかで必ず1回写す必要がある。pickBVariant(bull→'buy' / bear→'sell')と同じ対応。 */
const A_TREND_TO_BIAS = { bull: 'buy', bear: 'sell', range: 'range' } as const;

/** ★計画自身の向き(AiPlan.direction)→ 画面の語彙。★'none' は **入れない**(目線が無い回だから)。
 *  ★写しではなく素通し(buy→buy / sell→sell / range→range)。表を置くのは
 *  「'none' を混ぜない」ことを型で示すため。 */
const PLAN_DIR_TO_BIAS = { buy: 'buy', sell: 'sell', range: 'range' } as const;

/** ★分割経路で **計画そのものが無い** 回の noneReason。この3つのときだけ plan.rationale は
 *  scalpPlanSplit.ts が置いた **合成文** になる(AI の言葉ではない)。
 *  ★出所は scalpPlanSplit.ts の3つの早期 return(A 失敗 / レンジ不許可 / B 無言)。
 *  ★旧経路(scalpPlan.ts)でも 'rangeDisabled' は付くが、あちらの rationale は AI 自身の文なので、
 *    この表は **splitRecord がある回にだけ** 使う(下の分岐を参照)。 */
const SPLIT_SYNTHESIZED_REASONS: readonly NoneReason[] = ['aFailed', 'rangeDisabled', 'aiSilent'];

/** 表示用に整える(空白の正規化のみ。中身は削らない)。空/未指定は undefined。
 *  ★LC 検算の剥がしは **画面側**(cleanAiText)が既存の作法でやる。ここで二重に整形しない。 */
function text(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * 1計画サイクルの結果から、待機表示の材料を作る。
 * ★ARM した回では呼ばないこと(呼び出し側=engine が判定する)。
 * ★目線も理由も見送りの語も1つも取れない回は **null**(=「何も出さない」。空の括弧や「不明」を作らない)。
 */
export function buildPlanNote(result: ScalpPlanResult, at: number, gate?: PlanGate | null): PlanNote | null {
  const note: PlanNote = { at };

  // ── 目線: ① A の答え ② 無ければ計画自身の direction(どちらも AI が答えた値) ────────
  const aDir = result.splitRecord?.aDirection;
  if (aDir && aDir in A_TREND_TO_BIAS) {
    note.bias = A_TREND_TO_BIAS[aDir];
  } else if (result.ok && result.plan.direction !== 'none' && result.plan.direction in PLAN_DIR_TO_BIAS) {
    note.bias = PLAN_DIR_TO_BIAS[result.plan.direction as keyof typeof PLAN_DIR_TO_BIAS];
  }

  // ── 理由: 分割の回は A の自由文 → B の言葉 / 旧経路は directionWhy → rationale ────
  //   ★分割の回に **合成文** を理由として名乗らない。合成文とは scalpPlanSplit.ts が
  //     計画そのものが無い回に置く定型文:
  //       「目線はレンジ(<aWhy>)。レンジの取引は設定で無効なため見送り。」
  //       「目線の判断が得られませんでした(…)。」
  //       「AI が規定の形で答えませんでした。」
  //     これを理由の行に出すと、目線ラベル・理由・見送りの理由が同じ内容で3重に出る。
  //
  //   ★★2026-08-24(第3版・エバリュエーター指摘①): **第2版の直し方は行き過ぎだった。**
  //     第2版は「分割の回は rationale を一切見ない」にしたため、
  //     **A が目線だけ返し(why 無し)、B が本物の理由を返した回**(両脚落ち・noneReason='ai')で
  //     B の理由が捨てられていた:
  //       第2版 → ["09:24 買い目線"]                                  ← 理由が消えた
  //       第1版 → ["09:24 買い目線 ／ 節目が近すぎて置けないため見送り。"]  ← 出ていた
  //     ★第2版のコメントは「合成文かどうかを見分ける手段は無い」と書いていたが **これは誤り**
  //       だった(誤った根拠をソースに残さないためここに訂正を書く)。
  //       合成文が入るのは scalpPlanSplit.ts の **3経路だけ** で、その3経路は noneReason が
  //       aFailed / rangeDisabled / aiSilent に **確定する**。noneReason はこの関数が
  //       同じスコープで既に持っている値なので、**本文の正規表現は1文字も要らない**。
  //   ★よって「分割 かつ その3つの noneReason のとき **だけ** rationale を見ない」に絞る。
  //   ★★この絞り込みを **旧経路へ広げてはいけない**: 'rangeDisabled' は旧経路(scalpPlan.ts)でも
  //     付き、そちらの rationale は **AI 自身の文** である。広げると旧経路の理由が消える
  //     (=この直しの「逆側」。planNote.test.ts の §逆側 で固定してある)。
  const sr = result.splitRecord;
  if (sr) {
    const reason = result.ok ? result.noneReason : undefined;
    const synthesized = reason !== undefined && SPLIT_SYNTHESIZED_REASONS.includes(reason);
    note.why = text(sr.aWhy)
      ?? (result.ok ? text(result.plan.directionWhy) : undefined)
      ?? (result.ok && !synthesized ? text(result.plan.rationale) : undefined);
  } else if (result.ok) {
    note.why = text(result.plan.directionWhy) ?? text(result.plan.rationale);
  }

  // ── 見送り/不採用の語 ─────────────────────────────────────────────────────
  //   ★2つを **書き分ける**(リーダー裁定 2026-08-24):
  //     ① gate 在り …… AI は計画を出したが **こちらの検証で不採用**。suppressed:true を立てる。
  //        ★gate を noneReason より優先する: 計画が成立していても止めたのはゲートだから。
  //     ② gate 無し …… 計画の中で見送り(none)が決まった回。従来どおり noneReason を出す。
  //   ★ok:false(計画そのものが得られなかった回)は noneReason を持たない=語を出さない
  //     (嘘の理由を名乗らない)。
  if (gate) {
    note.suppressed = true;
    note.reason = gate;
    // ★表に無い値が来る経路は型で塞いであるが、画面に undefined を出す経路は残さない
    //   (legDropReasonText の LEG_DROP_REASON_UNKNOWN と同じ防御の作法)。
    //   ★ここが undefined になったら画面は「不採用」の1語に縮退する=黙って消えはしない。
    const text = GATE_TEXT[gate] as string | undefined;
    if (text) note.reasonText = text;
  } else {
    const reason: NoneReason | undefined = result.ok ? result.noneReason : undefined;
    if (reason) {
      note.reason = reason;
      note.reasonText = legDropReasonText(reason);
    }
  }

  return note.bias || note.why || note.reason ? note : null;
}
