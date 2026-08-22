// server/llm/abContext.ts — ★A と B に渡す文脈の **振り分け**(A ⊂ B)。純関数。
//
// ■ なぜ分けるか
//   A は「トレンドの有無」だけを答える。★価格を決める材料(節目・長期高安)も、
//   出来事の材料(アラート・ニュース)も、A の問いには要らない。
//   ★渡すと、A の理由に価格の語が混ざり、分けた意味が薄れる。
//
// ■ 振り分け(★A ⊂ B。A に在って B に無いものは1つも無い)
//                          A     B
//   現在価格                 ○     ○   (呼び出し側が別ブロックで付ける)
//   直近の足(1分/5分)         ○     ○
//   ボラ/レンジ(ATR・本日高安) ○     ○
//   スイング構造              ○     ○
//   セッション/時刻           ○     ○
//   テクニカル指標(RSI/BB)    ○     ○
//   長い時間軸(1h/2h/始値比)  ○     ○
//   基礎データ 日足MA/バンド/OHLC ○  ○
//   ★節目                    ×     ○
//   ★直近アラート＋その後      ×     ○   (ユーザー指示: A には不要 / B は渡す)
//   ★基礎データ 長期高安       ×     ○   (価格の候補=節目の一種)
//   ★仮想取引の成績            ×     ○
//   ★ニュース                 ×     ○   (ユーザー指示: A からは外す)
//   ★チャート画像              ×     ○   (2回送ると課金が跳ねる)
//   ★データツール              ×     ○   (A の全文にツールの語が無い=呼ばれない前提に払わない)
//
// ■ ★実装の要点: **既存の組み立て関数をそのまま使い、渡す材料を減らすだけ**。
//   buildScalpMarketData は levels が空なら節目ブロックを、alerts が空ならアラートブロックを
//   もともと出さない。よって A 用に別の組み立て関数を作らない(2つ持つと片方だけ直してズレる)。

import { buildScalpMarketData, type ScalpMarketDataInput } from './scalpContext.js';
import { buildBasedataContext, type BasedataContextInput } from './basedataContext.js';

export interface AbContextInput {
  /** buildScalpMarketData に渡す材料一式(B 向けの完全な形)。 */
  market: ScalpMarketDataInput;
  /** buildBasedataContext に渡す材料(scope は当関数が決めるので受け取らない)。 */
  basedata: Omit<BasedataContextInput, 'scope'>;
}

/** 2つのブロックを既存と同じ区切りで連結する(空は落とす)。 */
const join = (...parts: string[]): string => parts.filter(Boolean).join('\n\n');

/**
 * ★A(目線)に渡す文脈。節目・アラート・長期高安を **材料の段階で** 外す。
 * 「出力から消す」のではなく「渡さない」ので、書式を触らずに済む。
 */
export function buildTrendContext(input: AbContextInput): string {
  const market = buildScalpMarketData({
    ...input.market,
    levels: null,   // ★節目を渡さない
    alerts: [],     // ★アラートを渡さない
  });
  const basedata = buildBasedataContext({ ...input.basedata, scope: 'trend' });   // ★長期高安を外す
  return join(market, basedata);
}

/**
 * ★B(価格と損切幅)に渡す文脈。★分割前の1回呼び出しと **同じ材料**(節目・アラート・長期高安を含む)。
 * 仮想取引の成績・ニュース・画像は呼び出し側が別ブロックで付ける(従来どおり)。
 */
export function buildOrderContext(input: AbContextInput): string {
  const market = buildScalpMarketData(input.market);
  const basedata = buildBasedataContext({ ...input.basedata, scope: 'full' });
  return join(market, basedata);
}

/** ★A に出てはいけない語(テストと実装が同じ表を見る)。 */
export const TREND_CONTEXT_FORBIDDEN: readonly string[] = [
  '主要節目', '長期高安', '直近アラート',
];
