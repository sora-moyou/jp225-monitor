// 発注前サニティ(monitor 側ポート・正規シグナルのゲート)。
//
// ★このファイルは 兄弟リポ jp225-trade2 の `src/ai/sanity.ts`(checkSanity / checkRangeSanity)の
//   ロジックを byte-for-byte で写したもの。両リポは常に一緒にリリースされるため、必ず同期を保つこと
//   (trade2 の送信直前サニティで REJECT される計画を monitor が「正規シグナル」として出さないための先取り検証)。
//   trade2 は自前の checkSanity を最終安全網(defense in depth)として保持し続ける=このゲートで弾かれた計画は
//   そもそも trade2 へ届かないため、向こうの checkSanity はほぼ発火しなくなる。
//
// 判定の考え方(trade2 と同一):
//  - 各レッグの entry が現在値に対して正しい側にあること(指値=引きつけ側 / 逆指値=ブレイク側)。
//    buy:  指値は現値の下(limitEntry < price)/ 逆指値は現値の上(price < stopEntry)。
//    sell: 指値は現値の上(price < limitEntry)/ 逆指値は現値の下(stopEntry < price)。
//    ★両レッグ(OCO)がある時は結果的に「現値を挟む」ブラケットになる。片レッグのみの時は該当レッグの側だけ検証。
//  - ストップが entry に対し正しい向き(buy: stop<entry / sell: stop>entry)。
//  - 現在値が有限(非有限は NG=発注不可)。
//  - 単レッグ(片側のみ)は現在値から MAX_ENTRY_DISTANCE_YEN 円以内・両レッグは幅 MAX_BRACKET_WIDTH_YEN 円以内。
//  - すべて厳密不等号(同値も NG)。
//
// ★monitor の AiPlan は trade2 と型が僅かに異なる(range を `direction==='range'` で表す・`mode` フィールドは無い・
//   range レッグは RangeLeg={side,type,entry,stopLoss})。そのためレッグ検出ヘルパは monitor 構造に合わせて
//   このファイル内でローカル定義する(trade2 の types.ts の hasLimitLeg/hasStopLeg/isRangePlan/firstSlotLeg/
//   secondSlotLeg と論理的に等価)。判定式(不等号・距離・幅)は trade2 と 1:1 で一致させている。

import type { AiPlan, RangeLeg } from '../llm/openai.js';

export type SanityResult = { ok: true } | { ok: false; reason: string };

export const MAX_ENTRY_DISTANCE_YEN = 200;  // 単レッグ(片側のみ)の指値/逆指値が現在値からこの距離を超えたら発注しない(遠すぎる=約定不能/古いシグナル対策)。★両レッグ(現値を挟むブラケット)には適用しない。
export const MAX_BRACKET_WIDTH_YEN = 400;  // 両レッグ(指値＋逆指値)のブラケット幅の上限。|指値−逆指値|がこれを超えたら発注しない。

// ─── レッグ検出(monitor 構造・trade2 types.ts と論理等価) ───

/** 指値レッグを持つか(entry+SL 両方が有限)。★directional 専用。 */
function hasLimitLeg(p: AiPlan): boolean {
  return Number.isFinite(p.limitEntry) && Number.isFinite(p.stopLossForLimit);
}
/** 逆指値レッグを持つか(entry+SL 両方が有限)。★directional 専用。 */
function hasStopLeg(p: AiPlan): boolean {
  return Number.isFinite(p.stopEntry) && Number.isFinite(p.stopLossForStop);
}
/** レンジ両面プランか(monitor は direction==='range' で表す・上下いずれかのレッグを持つ)。 */
function isRangePlan(p: AiPlan): p is AiPlan & { range: { upper?: RangeLeg; lower?: RangeLeg } } {
  return p.direction === 'range' && p.range != null && (p.range.upper != null || p.range.lower != null);
}
/** スロットA(range では upper レッグ)。無ければ undefined。 */
function firstSlotLeg(plan: AiPlan & { range: { upper?: RangeLeg; lower?: RangeLeg } }): RangeLeg | undefined {
  return plan.range.upper;
}
/** スロットB(range では lower レッグ)。無ければ undefined。 */
function secondSlotLeg(plan: AiPlan & { range: { upper?: RangeLeg; lower?: RangeLeg } }): RangeLeg | undefined {
  return plan.range.lower;
}

/**
 * ★レンジ両面のサニティ。各レッグ(present なもの)が **現在値に対し正しい側** にあり、SL の向きが side と整合するか。
 *  - upper レッグ: entry > 現在値(上)。lower レッグ: entry < 現在値(下)=「upper.entry>現値>lower.entry」。
 *  - SL 向き: buy レッグ → stopLoss < entry(下)/ sell レッグ → stopLoss > entry(上)。
 *  ★片面(upper/lower いずれか欠落)は present レッグのみ検証。レッグ皆無は NG。
 *  ★両レッグは幅上限(400円)・片レッグはその1本を現在値から200円以内。
 */
function checkRangeSanity(plan: AiPlan & { range: { upper?: RangeLeg; lower?: RangeLeg } }, currentPrice: number): SanityResult {
  const upper = firstSlotLeg(plan);   // range では upper。
  const lower = secondSlotLeg(plan);  // range では lower。
  if (!upper && !lower) return { ok: false, reason: 'range: 発注できるレッグが無い(上下とも欠落)' };
  const legSlOk = (leg: RangeLeg): boolean => (leg.side === 'buy' ? leg.stopLoss < leg.entry : leg.stopLoss > leg.entry);
  if (upper) {
    if (!(upper.entry > currentPrice)) return { ok: false, reason: `range: upper(${upper.entry})が現在値(${currentPrice})の上にない` };
    if (!legSlOk(upper)) return { ok: false, reason: `range: upper SL(${upper.stopLoss})の向きが side=${upper.side} と不整合(entry=${upper.entry})` };
  }
  if (lower) {
    if (!(lower.entry < currentPrice)) return { ok: false, reason: `range: lower(${lower.entry})が現在値(${currentPrice})の下にない` };
    if (!legSlOk(lower)) return { ok: false, reason: `range: lower SL(${lower.stopLoss})の向きが side=${lower.side} と不整合(entry=${lower.entry})` };
  }
  // ★距離制限(directional と同じ思想): 両レッグは上下の幅上限(400円)のみ・片レッグはその1本を現在値から200円以内。
  if (upper && lower) {
    const width = Math.abs(upper.entry - lower.entry);
    if (width > MAX_BRACKET_WIDTH_YEN) return { ok: false, reason: `range: 上下(upper-lower)の幅(${width}円)が上限${MAX_BRACKET_WIDTH_YEN}円超` };
  } else if (upper) {
    const dist = Math.abs(upper.entry - currentPrice);
    if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `range: 単レッグ(upperのみ)の upper(${upper.entry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
  } else if (lower) {
    const dist = Math.abs(lower.entry - currentPrice);
    if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `range: 単レッグ(lowerのみ)の lower(${lower.entry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
  }
  return { ok: true };
}

/**
 * 発注前サニティ。存在する各レッグの entry が現在値に対し正しい側にあり、各ストップの向きが正しいことを検証。
 *  - 価格が非有限 → NG(priceUnavailable と同義=発注しない)。
 *  - どちらのレッグも存在しない → NG(発注不能・防御)。
 *  - buy 指値: limitEntry < price かつ stopLossForLimit < limitEntry(指値=下・SL は更に下)。
 *  - buy 逆指値: price < stopEntry かつ stopLossForStop < stopEntry(逆指値=上・SL は下)。
 *  - sell 指値: price < limitEntry かつ stopLossForLimit > limitEntry(指値=上・SL は上)。
 *  - sell 逆指値: stopEntry < price かつ stopLossForStop > stopEntry(逆指値=下・SL は上)。
 * 厳密不等号=同値も NG。
 */
export function checkSanity(plan: AiPlan, currentPrice: number): SanityResult {
  if (!Number.isFinite(currentPrice)) return { ok: false, reason: '現在値が取得できていない(発注不可)' };
  // ★レンジ両面: 「upper は現値超・lower は現値未満」+ 各 SL の向き(side 整合)を別経路で検証。
  if (isRangePlan(plan)) return checkRangeSanity(plan, currentPrice);
  const { direction } = plan;
  const hasLimit = hasLimitLeg(plan);
  const hasStop = hasStopLeg(plan);
  if (!hasLimit && !hasStop) return { ok: false, reason: '発注できるレッグが無い(指値/逆指値とも欠落)' };

  if (direction === 'buy') {
    // 指値=現値の下・SL は更に下。
    if (hasLimit) {
      const { limitEntry, stopLossForLimit } = plan;
      if (!(limitEntry! < currentPrice)) return { ok: false, reason: `buy: 指値(${limitEntry})が現在値(${currentPrice})の下にない` };
      if (!(stopLossForLimit! < limitEntry!)) return { ok: false, reason: `buy: 指値ストップ(${stopLossForLimit})が指値(${limitEntry})の下にない` };
      // ★上限距離: この指値が単レッグ(片側のみ・逆指値なし)の時だけ適用。両レッグ時は「現値を挟む」ことが正当性の基準ゆえ距離上限は課さない。
      if (!hasStop) {
        const dist = Math.abs(limitEntry! - currentPrice);
        if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `buy: 単レッグ(指値のみ)の指値(${limitEntry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
      }
    }
    // 逆指値=現値の上・SL は下。
    if (hasStop) {
      const { stopEntry, stopLossForStop } = plan;
      if (!(currentPrice < stopEntry!)) return { ok: false, reason: `buy: 逆指値(${stopEntry})が現在値(${currentPrice})の上にない` };
      if (!(stopLossForStop! < stopEntry!)) return { ok: false, reason: `buy: 逆指値ストップ(${stopLossForStop})が逆指値(${stopEntry})の下にない` };
      // ★上限距離: この逆指値が単レッグ(片側のみ・指値なし)の時だけ適用。両レッグ時は距離上限を課さない。
      if (!hasLimit) {
        const dist = Math.abs(stopEntry! - currentPrice);
        if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `buy: 単レッグ(逆指値のみ)の逆指値(${stopEntry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
      }
    }
    // ★ブラケット幅上限: 両レッグ時のみ、指値-逆指値の絶対差(SL は対象外)が広すぎるプランは拒否。
    if (hasLimit && hasStop) {
      const width = Math.abs(plan.limitEntry! - plan.stopEntry!);
      if (width > MAX_BRACKET_WIDTH_YEN) return { ok: false, reason: `buy: 両レッグの指値-逆指値の幅(${width}円)が上限${MAX_BRACKET_WIDTH_YEN}円超` };
    }
    return { ok: true };
  }

  // sell: 指値=現値の上・SL は上 / 逆指値=現値の下・SL は上。
  if (hasLimit) {
    const { limitEntry, stopLossForLimit } = plan;
    if (!(currentPrice < limitEntry!)) return { ok: false, reason: `sell: 指値(${limitEntry})が現在値(${currentPrice})の上にない` };
    if (!(stopLossForLimit! > limitEntry!)) return { ok: false, reason: `sell: 指値ストップ(${stopLossForLimit})が指値(${limitEntry})の上にない` };
    // ★上限距離: この指値が単レッグ(片側のみ・逆指値なし)の時だけ適用。両レッグ時は「現値を挟む」ことが正当性の基準ゆえ距離上限は課さない。
    if (!hasStop) {
      const dist = Math.abs(limitEntry! - currentPrice);
      if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `sell: 単レッグ(指値のみ)の指値(${limitEntry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
    }
  }
  if (hasStop) {
    const { stopEntry, stopLossForStop } = plan;
    if (!(stopEntry! < currentPrice)) return { ok: false, reason: `sell: 逆指値(${stopEntry})が現在値(${currentPrice})の下にない` };
    if (!(stopLossForStop! > stopEntry!)) return { ok: false, reason: `sell: 逆指値ストップ(${stopLossForStop})が逆指値(${stopEntry})の上にない` };
    // ★上限距離: この逆指値が単レッグ(片側のみ・指値なし)の時だけ適用。両レッグ時は距離上限を課さない。
    if (!hasLimit) {
      const dist = Math.abs(stopEntry! - currentPrice);
      if (dist > MAX_ENTRY_DISTANCE_YEN) return { ok: false, reason: `sell: 単レッグ(逆指値のみ)の逆指値(${stopEntry})が現在値(${currentPrice})から${dist}円離れており上限${MAX_ENTRY_DISTANCE_YEN}円超` };
    }
  }
  // ★ブラケット幅上限: 両レッグ時のみ、指値-逆指値の絶対差(SL は対象外)が広すぎるプランは拒否。
  if (hasLimit && hasStop) {
    const width = Math.abs(plan.limitEntry! - plan.stopEntry!);
    if (width > MAX_BRACKET_WIDTH_YEN) return { ok: false, reason: `sell: 両レッグの指値-逆指値の幅(${width}円)が上限${MAX_BRACKET_WIDTH_YEN}円超` };
  }
  return { ok: true };
}
