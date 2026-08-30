// ★ピボット節目に **完全一致** したエントリー価格を5円ずらす(純関数・2026-08-26)。
//
// ■ 仕様(ユーザー承認済み・server/llm/scalpPlan.ts の設計コメントが原文)
//   ── ずらす向き(機械的に一意。★AI は関与しない) ──
//     指値(引きつける)    : 現在価格に **近づく側** へ5円
//     逆指値(抜けたら乗る): 現在価格から **遠ざかる側** へ5円
//   ── 5円をずらす対象 ──
//     ずらす(ピボット)   : スイング高安 / セッション高安・本日高安・長期高安 / 前日終値・寄付 /
//                          反応価格・もみ合い帯・出来高集中
//     ずらさない(計算値) : フィボ戻し / N値・V値・E値 / キリ番 / ADR予測レンジ / トレンドライン
//     ★重なったらピボット優先(キリ番70,000が同時に本日高値なら **ピボット扱いで5円ずらす**)
//   ── 一致の判定 ──
//     ★**完全一致**(ユーザー確定 2026-08-21「完全一致です。」)。**許容(±数円)は作らない**。
//     ★AI が 70,003 と出せばピボット(70,000)に一致しないので **そのまま 70,003 で発注**。
//       これは欠陥ではなく仕様: この設計では AI は節目に縛られず、中間を選んでもよい。
//       一致しない価格 = AI が節目以外の根拠で選んだ価格 なので、ずらさないのが正しい。
//
// ■ ★なぜ「実際に注文が出た値段」だけをずらすのか
//   ピボットは板が厚い(そこに注文が並んだ実績がある)ので、指値はちょうどだと刺さらず、
//   逆指値はちょうどだとだまし(往復)に遭いやすい。★計算値(フィボ・N値・キリ番・ADR・トレンドライン)は
//   板が厚い理由が無いので、ずらす意味も無い。
//
// ■ ★5円という値に根拠は無い(定数の由来として必ず残す)
//   「執行の都合」と言うなら執行の実測(だましの発生率)から決めるのが筋だが **今は未測定**。
//   ユーザーの判断で 5円 とした。後で実測から見直せるよう、この経緯をここに残す。
//
// ■ ★丸めとは別物。混ぜないこと
//   ・ピボットの5円ずらし … **執行の都合として説明できる**(70,000のブレイク → 70,005)。理由と矛盾しない。
//   ・端数の5円刻み丸め   … ★説明する筋が無い。ただの処理(server/signalTrade/entryTick.ts)。
//   ★二重にずれることは無い: ピボットは実際に注文が出た値段なので5円刻みに乗っており、
//     ±5円しても刻みのまま = 後段の丸めは no-op。

/** ずらす量[円]。★根拠は未測定(上記)。 */
export const PIVOT_NUDGE_YEN = 5;

/** ★ずらす対象の種別(= 実際に注文が出た値段)。server/levels.ts の Cand.kind と同じ語彙。
 *  ・sessHL … スイング高安 / セッション高安(前日Day高 等)
 *  ・todayHL … 本日高安 / longHL … 長期高安 / open … 寄付 / prevClose … 前日終値
 *  ・reaction … 反応価格(複数回反転した実水準) / congestion … もみ合い帯 / volume … 出来高集中(HVN/POC) */
export const PIVOT_KINDS: readonly string[] = [
  'sessHL', 'todayHL', 'longHL', 'open', 'prevClose', 'reaction', 'congestion', 'volume',
];

/** ★ずらさない種別(=計算値)。**この表は判定に使わない**(判定は PIVOT_KINDS の包含だけ)。
 *  ここに置くのは「意図して外した」ことを残すため。新しい kind が増えたら
 *  **どちらにも入らない=ずらさない** に倒れる(安全側)。 */
export const CALCULATED_KINDS: readonly string[] = [
  // ★2026-08-26 訂正(エバリュエーター実測): 'fib' という kind は **実在しない**。
  //   server/levels.ts が実際に出すのは fib-today / fib-retr / fib-ext の3種
  //   (実データ18本で fib-retr:5 / fib-today:2 を観測)。挙動は変わらない(どちらもずらさない)が、
  //   ★この表の目的は「意図して外したことを残す」ことなので、実在しない語を書くと目的が壊れる。
  'grid250', 'grid500', 'grid1000', 'fib-today', 'fib-retr', 'fib-ext', 'nwave', 'adr', 'trendline',
];

/** 判定に渡す水準(server の Level のうち、この関数が使う分だけ)。 */
export interface NudgeLevel {
  price: number;
  kinds?: string[];
}

/** その水準がピボットか。★重なったらピボット優先 = **1つでも** ピボット種別を含めば true。 */
export function isPivotLevel(level: NudgeLevel): boolean {
  return (level.kinds ?? []).some(k => PIVOT_KINDS.includes(k));
}

/** ずらした結果(記録用に「ずらしたか」も返す)。 */
export interface NudgeResult {
  /** ずらした後の価格(ずらさなかったときは入力のまま)。 */
  price: number;
  /** ずらしたか。★台帳/ログで「何件発火したか」を数えるために返す。 */
  nudged: boolean;
  /** 一致したピボットの価格(★一致したら入る。ずらしを見送ったときも入る)。 */
  pivot?: number;
  /** ★ピボットには一致したのに ずらさなかった理由。
   *  ・'crossesRef' … ずらすと現在値をまたぐ(**この関数が決める**)。
   *  ・'lcCeiling'  … ずらすと LC幅が実効上限を超える(★**この関数は決めない**)。
   *      理由: core は LC の帯(ceilingYen / ceilingMode / 安全上限)を知らないし、知るべきでもない。
   *      上限の唯一の権威は server/llm/scalpPlan.ts の lcEffectiveCeiling / lcLegExceeds なので、
   *      **applyPivotNudge が「ずらす」と決めた脚を後から この理由に倒す**。ここは語彙だけを持つ。
   *  ・'tpCollapse' … ずらすと TP幅が 0以下 になる(★**この関数は決めない**。lcCeiling と同じ作法)。
   *      理由: 建値は必ず **利益方向へ** 5円動く(4脚とも)ので、TP の絶対価格を保つには TP幅を
   *      5円 詰めることになる。詰めた結果が 0以下 = その脚は約定と同時に利確する不正なので、
   *      ★**ずらしを諦める**(crossesRef / lcCeiling と同じ判断=ずらしは執行の都合であって
   *      相場の判断ではない)。★TP幅を知っているのは AiPlan を見る applyPivotNudge だけ。
   *  ★数えられるようにしてある: 「一致はしたが ずらせなかった」は、頻度が分からないと
   *    「発火していない」と区別がつかない(この案件が繰り返し踏んできた型)。 */
  blocked?: 'crossesRef' | 'lcCeiling' | 'tpCollapse';
}

/**
 * ★エントリー価格がピボット節目に **完全一致** していたら5円ずらす。
 *
 * @param price   AI が出したエントリー価格
 * @param kind    'limit'(指値=引きつける) / 'stop'(逆指値=抜けたら乗る)
 * @param refPrice 現在価格(向きの基準。★これだけが基準=側の規則と同じ)
 * @param levels  こちらが持つ水準(上下まとめて渡してよい)
 *
 * ■ 向き(機械的に一意):
 *   指値   … 現在価格に **近づく側**   (現在価格より上の指値なら下へ / 下の指値なら上へ)
 *   逆指値 … 現在価格から **遠ざかる側** (現在価格より上の逆指値なら上へ / 下なら下へ)
 * ■ ★price === refPrice のときはずらさない: どちらが「近づく側」か決まらない。
 *   ★この価格はそもそも側の検査(entryPositionOk)で落ちるので、ここで無理に決めない。
 */
export function nudgeEntryOnPivot(
  price: number, kind: 'limit' | 'stop', refPrice: number,
  levels: readonly NudgeLevel[] | null | undefined,
): NudgeResult {
  if (!Number.isFinite(price) || !Number.isFinite(refPrice) || !levels?.length) return { price, nudged: false };
  if (price === refPrice) return { price, nudged: false };   // 向きが決まらない
  // ★完全一致だけ(許容は作らない)。重なっていればピボット優先=どれか1つがピボットなら足りる。
  const hit = levels.find(l => l.price === price && isPivotLevel(l));
  if (!hit) return { price, nudged: false };
  const above = price > refPrice;
  // 指値=近づく側 / 逆指値=遠ざかる側。上に在るなら「近づく」は下、「遠ざかる」は上。
  const toward = kind === 'limit' ? -1 : 1;
  const sign = (above ? 1 : -1) * toward;
  const moved = price + sign * PIVOT_NUDGE_YEN;
  // ★★現在値をまたぐ/触れるなら **ずらさない**(2026-08-26・エバリュエーター実測で判明)。
  //
  //   実際に起きること: 現在値61,652・ピボット61,650 の買い指値を「近づける」と 61,655 =
  //   **現在値の上** になり、買い指値として不正になる。ずらした後に側を検査する層は
  //   **存在しない**(entryPositionOk は parseScalpPlan / buildPlanFromBAnswer の中にしかなく、
  //   enforce は stopSideOk しか見ない)ので、engine の checkSanity まで素通りする。
  //   ★そして checkSanity は **プラン全体** を拒否するので、健全だったもう一方の脚まで
  //     巻き添えで消える(gate='sanity' で丸ごと見送り)。5円のずらしが計画を1本消す。
  //
  //   ★直し方は2択あった: (a)ずらしを諦める (b)enforce に側の検査を足してその脚だけ落とす。
  //     **(a)を採る**。ずらしは執行の都合であって相場の判断ではないので、諦めても失うものは
  //     5円ぶんの板の厚みだけ。(b)は「ずらし」の意図が「脚を消す」に化ける。
  //   ★これで「幅は広がる方向にしか動かない」が **この関数だけで自己完結** する
  //     (現在値をまたがない ⇒ 建値は損切りから遠ざかる側にしか動かない)。
  if ((above && moved <= refPrice) || (!above && moved >= refPrice)) {
    return { price, nudged: false, pivot: price, blocked: 'crossesRef' };
  }
  return { price: moved, nudged: true, pivot: price };
}
