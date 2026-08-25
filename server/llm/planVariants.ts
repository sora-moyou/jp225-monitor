// server/llm/planVariants.ts — ★B(価格と損切幅を尋ねる呼び出し)の **4種の版** と、その対応表(SSOT)。
//
// ■ この設計の芯
//   AI に聞くのは **数値だけ**(価格・損切幅)と、その理由。
//   ★**「買いか売りか」「指値か逆指値か」は AI に返させない。この表からコードが埋める。**
//   実測 `sell/stop/上` 22件(売りのブレイク新規が現在値より上=即約定する不正)は、
//   AI が side を返していたから起きた。★**返す場所が無ければ、間違えようがない。**
//
// ■ 版はコードが選ぶ(AI は選ばない)
//   目線 buy(ブル) → 'buy' / 目線 sell(ベア) → 'sell'
//   目線 range → BB がスクイーズなら 'range-breakout'、それ以外(bulge / どちらでもない / 測れない)は 'range-fade'
//   ★判定は既存の buildSqueezeSnapshot の生値をそのまま使う(新しい閾値を作らない)。
//
// ■ ★問いの形(あ／い)が向きを決める
//   あ) = **現在価格より上** の価格 / い) = **現在価格より下** の価格。
//   この2つは独立した問いなので、★**片方だけ見送れる**(「片方が置けなかった」が「計画ごと見送り」に潰れない)。
//   価格の不等式(上/下)はプロンプトの問いの形で担保し、★**コード側でも必ず検査する**
//   (=規則の散文を増やさない。散文で強めるのは6版効かなかった経緯がある)。
//   ★2026-08-25 訂正(エバリュエーター指摘②): ここには「下流の既存検証で再確認する」と書いてあったが
//     **事実と違った**。entryPositionOk(=entrySideOk)は parseScalpPlan の中にしかなく、
//     ★分割経路は parseScalpPlan を通らない(scalpPlan.ts は outcome.parsed をそのまま使う)。
//     enforcePlanConstraintsReport の本体にも entryPositionOk は1回も出てこない。
//     ★実測: refPrice=65700 に「逆指値買い65,600円（LC幅60円）」を食わせると、
//       **買いの逆指値が現在値の下(=即約定)** のまま plan に入り、legDrops も空だった。
//     最後の砦は ARM 時の checkStaleLegs(live 価格)だけ=それが消えたら誰も気づかない。
//     ★よって buildPlanFromBAnswer で entryPositionOk を呼ぶ(下)。落ちた脚は既存の 'geometry' で記録する。
//   ★2026-08-25: **読み取り** の側は「上/下」を1文字も見ない。脚を決めるのは注文タイプの語だけ
//     (逆指値買い / 指値買い / 指値売り / 逆指値売り)。下の「B が返す答え」の節を参照。
//
// ■ ★レンジ2版は当面 **1回も使われません**
//   レンジ設定は既定 OFF で、当面 OFF のまま運用します(実データ 22,011件中 range は0件)。
//   それでも作って残すのは、①目線が range になる回は必ず起きるので「注文側を呼ばなかった」と
//   記録すること自体が目的(b_variant='none')であり、②後で ON にするとき文面を書き起こさずに済み、
//   ③OFF のままでも squeeze_state は記録できる=ON にする前に「どちらの版が何回選ばれたはずか」を実測できるため。

import type { AiPlan, LegDrop, RangeLeg } from './scalpPlan.js';
import { stopLossFromWidth } from '../../core/stopGeometry.js';
// ★2026-08-25(エバリュエーター指摘②): 価格の「側」の検査は **既存の権威をそのまま呼ぶ**。
//   新しい判定を書かない(2箇所で別々に書くと片方だけ直す事故が生まれる=core/entryLabel.ts の警告)。
import { entryPositionOk } from '../../core/entryLabel.js';

/** 目線(A の答え)。ブル/ベア/レンジ。
 *  ★2026-08-25: 語が `bull`/`bear` → **`buy`/`sell`** に変わった(ユーザー指定文面)。
 *  ★注文の side と **同じ綴り** になったが、意味は別物(こちらは「相場の方向」)。
 *    side を決めるのは依然として B_VARIANTS の表だけで、A の答えは版の選択にしか使わない。 */
export type TrendDirection = 'buy' | 'sell' | 'range';

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
  // ★2026-08-25(エバリュエーター指摘(g)): **網羅を型で止める**。
  //   以前は if 2本 + 既定 range-fade だったので、TrendDirection に語を足すと
  //   **黙って range-fade に落ちて**いた(planNote.ts の対応表は型で止まるのに、ここは止まらない)。
  //   ★同じ流儀に揃える: 未知の目線は never で型エラーになり、実行時も投げる。
  switch (trend) {
    case 'buy': return 'buy';
    case 'sell': return 'sell';
    case 'range': return squeeze === 'squeeze' ? 'range-breakout' : 'range-fade';
    default: {
      const exhaustive: never = trend;
      throw new Error(`pickBVariant: 未知の目線 ${String(exhaustive)}`);
    }
  }
}

// ─── ★B が返す答え(2026-08-25: JSON → **自由文**) ──────────────────────────────
//
// ■ 何が変わったか
//   旧: `{"aPrice":65780,"aLcWidth":60,...}` という JSON 契約をこちらが与え、ホワイトリストで写していた。
//   新: ★**ユーザーが応答の形式を指定した**。
//         逆指値買い65,780円（LC幅60円）65,775の節目を抜けたら追随するため5円上。幅は…
//       この1行を読む。JSON は **求めない**(求めると契約が2つ並び、どちらを守るかが不定になる。
//       v2 質問文で同じことをやって「短くしたはずが元の分量に戻る」を実測している)。
//
// ■ ★脚の識別は **注文タイプの語** で行う(「上」「下」では識別しない)
//   ★この案件で最も高くついた事故の型が「位置の語で脚を決める」ことだった
//   (「外側」の語の衝突で損切りの向きが逆になった一件と同じ根)。よって:
//     ・`逆指値買い` / `指値買い` / `指値売り` / `逆指値売り` の4語だけが脚を決める。
//     ・期待した注文タイプが来なかった行は **どの脚にも入れない**(unmatched に記録して捨てる)。
//     ・「上」「下」の語は **価格を入れる判断には一切使わない**。
//       ★例外(意図的): 注文タイプの行が1つも無い脚に対してだけ、`(上)`/`(下)` で始まる行の
//       文章を **理由として** 拾う(見送りの理由を捨てないため)。★価格は絶対に入らないので
//       誤った注文にはならない。これが無いと「AI が理由を書いて見送った(none_reason='ai')」と
//       「B が黙って壊れた('aiSilent')」の区別が消える。
//
// ■ ★読めなかったことを必ず記録する(黙って落とさない)
//   ・脚ごとの読み取り失敗の理由 … BAnswer.readIssues → buildPlanFromBAnswer が LegDrop に写す
//     → 既存の leg_drops_json(reason='missing' + parseIssue)にそのまま乗る。
//   ・1本も読めなかった回 … 従来どおり none_reason='aiSilent'(理由の文だけ在れば 'ai')。
//   ★「読めなかった率」は `leg_drops_json LIKE '%parseIssue%'` で数えられる。

/** ★脚ごとの読み取りの記録(記録専用・採否には使わない)。 */
export interface BReadIssues {
  /** あ)の脚を読めなかった理由。読めていれば undefined。 */
  a?: string;
  /** い)の脚を読めなかった理由。読めていれば undefined。 */
  i?: string;
  /** ★どの脚にも入れなかった行(期待と違う注文タイプ / 重複)。捨てた事実を残す。 */
  unmatched?: readonly string[];
}

export interface BAnswer {
  /** この相場をどう読んで この価格にしたか(1行)。
   *  ★2026-08-25: 指定された自由文の形式にこの欄が無いので **常に undefined**(台帳 b_strategy は NULL)。
   *  ★欄を残すのは、旧経路の台帳行と型を揃えるため / 形式に戻すときに配線を書き直さないため。 */
  strategy?: string;
  aPrice?: number; aLcWidth?: number; aWhy?: string;
  iPrice?: number; iLcWidth?: number; iWhy?: string;
  /** ★段6(2026-08-22): 判断に必要なデータが足りなかったときに、何が足りなかったかを書く自由文。 */
  missingData?: string;
  /** ★2026-08-25(記録専用): 読み取りの失敗と、捨てた行。 */
  readIssues?: BReadIssues;
}

// ─── ★自由文の読み取り ───────────────────────────────────────────────────────

/** ★全角/半角の揺れを吸収する。NFKC が `０-９` `（）` `ＬＣ` `，` `：` を一括で半角にする。
 *  ★NFKC が触らないダッシュ類(U+2012〜U+2015 / U+2212)だけ別に潰す。 */
export function normalizeBText(text: string): string {
  return text.normalize('NFKC').replace(/[‒–—―−]/g, '-');
}

/** `65,780` / `65780.0` を数値に。読めなければ undefined。 */
function toNum(raw: string): number | undefined {
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** 注文タイプの語。★この4語だけが脚を決める。 */
const ORDER_TOKEN_RE = /(逆指値|指値)\s*(買い|売り)/;
/** 行頭から注文タイプの語までに許す字数(「(上) 」「1. 」「**」「「」等の飾りを吸収する)。 */
const HEADER_PREFIX_MAX = 12;
/** ★行の途中に2本目の見出しが来る形(「…、指値買い65,600円（LC幅55円）」)を拾うための区切り。
 *  ★区切り記号の直後に限る=文中の「指値」を見出しに化けさせない。 */
const INLINE_HEAD_SEP = '、,／/。;；・|｜';
/** 注文タイプの語から価格までに許す字数(「注文 」「: 」等)。★句点・読点を含む隙間は認めない
 *  (「指値買いを見送ります。理由は65,780円…」の 65,780 を価格として読まないため)。 */
const PRICE_GAP_RE = /^[^0-9。、]{0,8}$/;
/** ★価格の直後から LC幅のラベルまでに許す字数(=**採用してよい範囲**)。
 *
 *  ■ ★2026-08-25(第2次・エバリュエーター指摘①): **一度 40 に広げたが 20 に戻した**。
 *    ・私が拡大の根拠にした実例は、そもそも拡大を必要としていなかった(自分で検算した):
 *        `指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。`
 *      → 価格直後の残りは `円 直近の値幅80円を考慮しLC幅は60円とする。` で `LC幅` は **index 14**。
 *        ★14 <= 20 なので旧の20字窓に余裕で収まる。「前置きが入るから広げる」は誤りだった。
 *    ・★そして 40 でだけ **無言で誤読する形** が生まれた:
 *        `逆指値買い65,780円 直近高値65,775円の少し上に置く。LC幅55円が制度上の最小値なので、実際にはLC幅80円。`
 *      → ラベルは index 21(値55)と index 43(値80)。
 *        窓40 … 21 だけが入る → **lc=55 を無言採用**(意図は80)・readIssues 空・SL が25円ずれる
 *        窓20 … どちらも入らない → 「LC幅を読めなかった」で **記録付きドロップ**
 *      ★「明示ラベルなら広げても誤読しない」は誤り。**窓が広いほど、間違ったほうの候補だけを
 *        単独で拾う確率が上がる**(候補が2つ揃えば下の食い違い検出で止まるが、1つだけ入ると止まらない)。
 *  ■ ★採用は20字以内だけ。ただし **窓の外にラベルがあれば必ず記録に残す**(下の OUTSIDE 判定)。
 *    目的は「窓を最適化すること」ではなく **無言で採らないこと**。 */
const WIDTH_NEAR_PRICE = 20;
const NUM_SRC = '[0-9][0-9,]*(?:\\.[0-9]+)?';
const PRICE_AFTER_RE = new RegExp(`^(.{0,8}?)(${NUM_SRC})`);
/** ★LC幅のラベル。**裸の `幅` は入れない**(2026-08-25・エバリュエーター指摘①)。
 *
 *  ■ 何が起きていたか(実測)
 *      `指値買い65,600円 直近の値幅80円を考慮しLC幅は60円とする。`
 *    裸の `幅` があると最左一致が **`値幅80`** を取り、lcWidth=80(意図は60)で損切り価格も20円ずれる。
 *    ★80 は帯の中なので下流も通し、readIssues にも legDrops にも残らない=**無言で数値を間違える**。
 *    ★「近傍の語を拾う曖昧な照合」は、この案件で最も高くついた事故(損切りの向きが逆・
 *      「外側」の語の衝突)と同じ根。
 *  ■ ★しかも A の新文面が「30分間の値幅が200円以内」と教えるので、B の理由文に
 *    「値幅◯◯円」が出る確率はむしろ **上がった**。 */
const WIDTH_LABEL = '(?:LC幅|損切り幅|損切幅|ロスカット幅|LC)';
const WIDTH_RE = new RegExp(`${WIDTH_LABEL}\\s*(?:は|[:：=])?\\s*(${NUM_SRC})`, 'g');
/** ★「置けない」と述べている脚の語。★価格/幅が欠けている脚に限って効かせる(下の実装を参照)。 */
const DECLINE_RE = /見送|置けな|置きません|出さな|見合わせ|不可/;
/** `(上)` `[下]` `「上」` `上:` で始まる行。★理由の受け皿としてのみ使う(価格は絶対に入れない)。
 *  ★閉じ記号を必須にしてある: これが無いと「上昇トレンドなので…」が位置の行に化ける。 */
const POSITION_LINE_RE = /^[\s\-*・>]*[([「【]?\s*(上|下)\s*[)\]」】:：]\s*[:：]?/;
/** 不足データの申告行(user プロンプトで「不足データ: …」と書かせる)。
 *  ★理由の継続行として脚に足さないため、行の判定にも使う(実際に aWhy へ紛れ込んだ)。 */
const MISSING_LINE_RE = /^[\s\-*・]*(?:不足データ|足りなかったデータ)\s*[:：]\s*(.+)$/;

/** 自由文から取り出した「注文タイプの見出し」1本ぶん。 */
export interface BLegCandidate {
  type: 'limit' | 'stop';
  side: 'buy' | 'sell';
  price?: number;
  lcWidth?: number;
  why?: string;
  /** ★読めなかった/曖昧だった理由(記録用)。読めていれば undefined。 */
  issue?: string;
  /** 元の行(記録用に短く残す)。 */
  raw: string;
}

/** ★プロンプトの **形式の見本** をモデルがそのまま書き写した断片。
 *
 *  ■ ★2026-08-25(ユーザー指示): 実際にボードへ出ていた
 *      `指値: その後に理由を日本語で自由表記 → 65,595 の節目手前で拾う`
 *    の `その後に理由を日本語で自由表記 → ` の部分。B の system の形式行
 *      `形式は「指値買い○○円（LC幅○○円）その後に理由を日本語で自由表記）`
 *    をモデルが理由の頭に写しただけで、**中身は1ビットも無い**。
 *  ■ ★消す場所は「読み取り」1箇所にする(画面では消さない)。
 *    理由の文が生まれるのはここだけで、ここで落とせば **画面・台帳(entry_why_for_*)・
 *    AI へ返す履歴** の3つが同時にきれいになる。画面だけで消すと台帳に見本が残り、
 *    学習ループ(理由 → 記録 → AI へ返す)に見本を食わせ続けることになる。
 *  ■ ★落とすのは見本の語と、その直後の矢印/括弧だけ。**理由の本文には触らない**。 */
const FORMAT_ECHO_RE = /[（(「]?\s*(?:その後に)?理由を日本語で自由表記\s*[）)」]?\s*(?:[→⇒]\s*)?/g;

/** 理由の先頭/末尾に残る区切り文字と装飾記号を落とす。空になったら undefined。
 *  ★2026-08-25(エバリュエーター指摘(e)): `**` `__` `#` `>` が理由に残り、**画面と台帳にそのまま出て**いた。
 *  ★2026-08-25(ユーザー指示): 形式の見本の書き写し(FORMAT_ECHO_RE)も落とす。 */
function trimWhy(s: string): string | undefined {
  const t = s
    .replace(FORMAT_ECHO_RE, '')
    .replace(/^[\s円\])）」』。、:：\-*_#>~]+/, '')
    .replace(/[\s*_~]+$/, '');
  return t.length > 0 ? t : undefined;
}

/** 1行の中の「見出しの位置」を全部返す。
 *  ★1本目は行頭から HEADER_PREFIX_MAX 字以内。★2本目以降は **区切り記号の直後** だけ
 *    (=文中の「指値」を見出しに化けさせない)。 */
function headerPositionsOf(
  line: string,
): Array<{ type: 'limit' | 'stop'; side: 'buy' | 'sell'; start: number; end: number }> {
  const out: Array<{ type: 'limit' | 'stop'; side: 'buy' | 'sell'; start: number; end: number }> = [];
  const re = new RegExp(ORDER_TOKEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const start = m.index;
    const first = out.length === 0;
    // 1本目=行頭近く / 2本目以降=直前に区切り記号(空白・括弧は挟んでよい)。
    const before = line.slice(0, start).replace(/[\s「『(（【]+$/, '');
    const ok = first
      ? start <= HEADER_PREFIX_MAX
      : before.length > 0 && INLINE_HEAD_SEP.includes(before[before.length - 1]!);
    if (!ok) continue;
    out.push({
      type: m[1] === '逆指値' ? 'stop' : 'limit',
      side: m[2] === '買い' ? 'buy' : 'sell',
      start, end: start + m[0].length,
    });
  }
  return out;
}

/** 見出しの後ろの本文から 価格 / LC幅 / 理由 を取り出す(★1脚ぶんの読み取りの全部)。 */
function readOneLeg(
  type: 'limit' | 'stop', side: 'buy' | 'sell', after: string, raw: string,
): BLegCandidate {
  const cand: BLegCandidate = { type, side, raw };
  const declines = DECLINE_RE.test(after);
  // ── 価格: 隙間に句読点・「見送」が無いときだけ採る ──────────────────────
  const priceM = after.match(PRICE_AFTER_RE);
  let priceEnd = -1;
  if (priceM && PRICE_GAP_RE.test(priceM[1]!) && !priceM[1]!.includes('見送')) {
    const v = toNum(priceM[2]!);
    if (v !== undefined && v > 0) { cand.price = v; priceEnd = priceM[0].length; }
  }
  // ── LC幅: **採用は近傍20字以内の明示ラベルだけ**。窓の外のラベルも数えて、無言で採らない ──
  //
  //   ■ ★2つの検出を分ける(2026-08-25 第2次):
  //     ・IN  … 価格直後 WIDTH_NEAR_PRICE 字以内。★**採用してよいのはここだけ**。
  //     ・OUT … その先(この脚の本文の最後まで)。★**採用しないが、必ず数える**。
  //   ■ ★なぜ OUT を数えるか
  //     窓を狭くすると誤採用は減るが、「正しい値が窓の外にあって、窓の中には別の値がある」形で
  //     **窓の中の間違ったほうを無言で採る** 事故が残る。OUT を数えておけば、
  //     食い違いに気づいて脚を落とせる=**無言で採らない**(この節の目的そのもの)。
  //   ■ 代償(承知の上): 「(LC幅60円)…LC幅は最大159円まで許容」のような文でも落ちる。
  //     ★ただし落ちた事実と両方の値が readIssues → leg_drops_json(parseIssue)に残るので、
  //     後から件数で数えられる。★黙って間違った値で発注するより安い。
  let whySrc = priceEnd >= 0 ? after.slice(priceEnd) : after;
  if (priceEnd >= 0) {
    const rest = after.slice(priceEnd);
    const inHits: Array<{ value: number; index: number; len: number }> = [];
    const outValues: number[] = [];
    const re = new RegExp(WIDTH_RE.source, 'g');
    let wm: RegExpExecArray | null;
    while ((wm = re.exec(rest)) !== null) {
      const v = toNum(wm[1]!);
      if (v === undefined || v <= 0) continue;
      if (wm.index <= WIDTH_NEAR_PRICE) inHits.push({ value: v, index: wm.index, len: wm[0].length });
      else outValues.push(v);
    }
    const inDistinct = new Set(inHits.map(h => h.value));
    const all = new Set([...inDistinct, ...outValues]);
    if (inDistinct.size > 1 || (inDistinct.size === 1 && all.size > 1)) {
      // ★候補が食い違う(窓の内どうし / 窓の内と外)。★脚を立てず、値を全部記録に残す。
      cand.issue = `LC幅の候補が複数(${[...all].join(' / ')}円)`;
    } else if (inDistinct.size === 1) {
      const h = inHits[0]!;
      cand.lcWidth = h.value;
      whySrc = after.slice(priceEnd + h.index + h.len);
    } else if (outValues.length > 0) {
      // ★窓の中には無いが外にはある。★「読めなかった」で終わらせず、**何が在ったか** を残す。
      cand.issue = `LC幅が近傍(${WIDTH_NEAR_PRICE}字)に無い(窓外に ${[...new Set(outValues)].join(' / ')}円の記述)`;
    }
  }
  // ── ★非整数の幅は採らない(2026-08-25・エバリュエーター指摘(f)) ─────────────
  //   帯を半開表記 `floor円<=損切幅<ceiling+1円` で書いているが、この等価性は **円が整数** のときだけ
  //   成り立つ。159.5 は表記上「可」・コードは `>159` で不可 = 帯の主張が崩れる。
  //   ★実運用の幅は5円刻みなので、非整数は AI の出力として不正。読まずに記録へ回す。
  if (cand.lcWidth !== undefined && !Number.isInteger(cand.lcWidth)) {
    cand.issue = `LC幅が整数ではない(${cand.lcWidth})`;
    delete cand.lcWidth;
  }
  // ── ★「置けない」と述べている脚(2026-08-25・エバリュエーター指摘(d)) ────────
  //   価格か幅が欠けていて、かつ「見送/置けな/出さな…」と書いてあるなら、それは **表明** であって
  //   提案ではない。★中途半端に読めた価格を legDrops に残すと台帳が汚れるので捨てる
  //   (捨てた事実は issue に残す)。★両方読めている脚には効かせない
  //   (「押し目が来なければ指値は置けない」のような正当な理由文で有効な脚を殺さないため)。
  if (declines && (cand.price === undefined || cand.lcWidth === undefined)) {
    delete cand.price;
    delete cand.lcWidth;
    cand.issue = '「置けない」と述べている';
    whySrc = after;
  }
  const why = trimWhy(whySrc);
  if (why !== undefined) cand.why = why;
  return cand;
}

/**
 * ★B の自由文を1行ずつ読み、脚の候補を **注文タイプごとに** 取り出す純関数。
 * ★1行1脚が基本だが、区切り記号の後ろに2本目の見出しが来る形も拾う(1行に2脚)。
 * ★理由が次の行に続く場合は次の見出し行までを理由に含める。
 * ★ここでは **どの脚に入れるかを決めない**(それは parseBFreeText の仕事)。
 */
export function readLegCandidates(
  text: string,
): { legs: BLegCandidate[]; positionReasons: { 上?: string; 下?: string } } {
  const lines = normalizeBText(text).split(/\r?\n/);
  const legs: BLegCandidate[] = [];
  const positionReasons: { 上?: string; 下?: string } = {};
  // 「いまどの脚の続きを読んでいるか」(理由の継続行を足すため)。
  let current: BLegCandidate | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/^\s+/, '');
    if (line.length === 0) continue;
    const heads = headerPositionsOf(line);
    if (heads.length === 0) {
      // ★不足データの申告行は **どの脚の理由でもない**(別の欄に入る)。継続行として足さない。
      if (MISSING_LINE_RE.test(line)) { current = null; continue; }
      // ★見出しでない行。①(上)/(下)の行なら理由として控える ②直前の脚の理由の続きなら足す。
      const posM = line.match(POSITION_LINE_RE);
      if (posM) {
        const key = posM[1] as '上' | '下';
        const body = trimWhy(line.slice(posM[0].length));
        if (body) positionReasons[key] = positionReasons[key] ? `${positionReasons[key]} ${body}` : body;
        current = null;
        continue;
      }
      if (current) current.why = current.why ? `${current.why} ${line.trim()}` : line.trim();
      continue;
    }
    for (let i = 0; i < heads.length; i++) {
      const h = heads[i]!;
      const stop = i + 1 < heads.length ? heads[i + 1]!.start : line.length;
      const cand = readOneLeg(h.type, h.side, line.slice(h.end, stop), line.slice(h.start, h.start + 60));
      legs.push(cand);
      current = cand;
    }
  }
  return { legs, positionReasons };
}

/** 不足データの申告行を全文から拾う版(上の MISSING_LINE_RE と同じ形・`m` フラグだけ違う)。 */
const MISSING_RE = new RegExp(MISSING_LINE_RE.source, 'm');

/**
 * ★B の自由文を BAnswer に読み取る純関数。
 * ★空文字/文字列でないときだけ null(=呼び出し側が 'aiSilent' にする)。
 *   それ以外は **必ず** BAnswer を返し、読めなかった脚は readIssues に理由を残す。
 */
export function parseBFreeText(text: string, variant: BVariant): BAnswer | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  const spec = B_VARIANTS[variant];
  const { legs, positionReasons } = readLegCandidates(text);
  const slots: { a?: BLegCandidate; i?: BLegCandidate } = {};
  const unmatched: string[] = [];
  const matches = (c: BLegCandidate, want: LegContract): boolean => c.type === want.type && c.side === want.side;
  const nameOf = (c: BLegCandidate): string =>
    `${c.type === 'stop' ? '逆指値' : '指値'}${c.side === 'buy' ? '買い' : '売り'}`;

  for (const c of legs) {
    const key: 'a' | 'i' | null =
      matches(c, spec.legs.a) ? 'a' : matches(c, spec.legs.i) ? 'i' : null;
    if (key === null) {
      // ★期待した注文タイプではない。**黙って別の脚に入れない**(捨てて記録する)。
      unmatched.push(`期待外の注文タイプ(${nameOf(c)}): ${c.raw}`);
      continue;
    }
    const held = slots[key];
    if (held) {
      // ★同じ注文タイプが2回。既に持っている側に価格が無く、新しい側にあるなら **入れ替える**。
      //   ★理由(実際に起こりうる): モデルが system の形式行「形式は「逆指値買い○○円（LC幅○○円）」を
      //     そのまま復唱すると、価格の無い見出しが先に slot を埋め、本物の行が「重複」で捨てられる。
      //   ★どちらにしても捨てた行は必ず記録に残す(黙って上書きしない)。
      if (held.price === undefined && c.price !== undefined) {
        slots[key] = c;
        unmatched.push(`価格の無い見出しを差し替え(${nameOf(held)}): ${held.raw}`);
      } else {
        unmatched.push(`重複した見出し(${nameOf(c)}): ${c.raw}`);
      }
      continue;
    }
    slots[key] = c;
  }

  const out: BAnswer = {};
  const issues: BReadIssues = {};
  const fill = (key: 'a' | 'i', want: LegContract, posKey: '上' | '下'): void => {
    const c = slots[key];
    const short = orderShortJa(want);
    if (!c) {
      // ★見出しが無い脚。位置の行に文章があれば **理由としてだけ** 引き取る(価格は入らない)。
      const posWhy = positionReasons[posKey];
      if (posWhy) {
        if (key === 'a') out.aWhy = posWhy; else out.iWhy = posWhy;
        issues[key] = `「${short}」の行が無い(位置の行の文章を理由として記録)`;
      } else {
        issues[key] = `「${short}」の行が無い`;
      }
      return;
    }
    if (c.price !== undefined) { if (key === 'a') out.aPrice = c.price; else out.iPrice = c.price; }
    if (c.lcWidth !== undefined) { if (key === 'a') out.aLcWidth = c.lcWidth; else out.iLcWidth = c.lcWidth; }
    if (c.why !== undefined) { if (key === 'a') out.aWhy = c.why; else out.iWhy = c.why; }
    // ★読み取り段(readOneLeg)が具体的な理由を持っていればそれを優先する
    //   (LC幅の候補が複数 / 非整数 / 「置けない」と述べている)。無ければ何が欠けたかを書く。
    if (c.issue !== undefined) issues[key] = `「${short}」${c.issue}`;
    else if (c.price === undefined && c.lcWidth === undefined) issues[key] = `「${short}」の価格とLC幅を読めなかった`;
    else if (c.price === undefined) issues[key] = `「${short}」の価格を読めなかった`;
    else if (c.lcWidth === undefined) issues[key] = `「${short}」のLC幅を読めなかった`;
  };
  fill('a', spec.legs.a, '上');
  fill('i', spec.legs.i, '下');

  const md = normalizeBText(text).match(MISSING_RE);
  if (md && md[1]!.trim().length > 0) out.missingData = md[1]!.trim();
  if (unmatched.length > 0) issues.unmatched = unmatched;
  if (issues.a !== undefined || issues.i !== undefined || issues.unmatched !== undefined) out.readIssues = issues;
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
  /** ★2026-08-25(記録専用): 立たなかった脚を LegDrop として残す(leg_drops_json へ)。 */
  legDrops: LegDrop[];
}

/** 1レッグぶんの価格と幅が揃っているか(幅は正・非0)。★向きと帯の検査は下流の既存検証に任せる。 */
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
 *   ■ ★落とした脚は必ず LegDrop に残す(reason='missing' + parseIssue)。黙って消さない。
 */
export function buildPlanFromBAnswer(
  variant: BVariant, answer: BAnswer, refPrice: number, rationale = '',
): BPlanBuild {
  const spec = B_VARIANTS[variant];
  // ★価格の「側」の検査(2026-08-25・エバリュエーター指摘②)。**既存の権威 entryPositionOk を呼ぶ**。
  //   買いの逆指値は現在値より上 / 買いの指値は下 / 売りの指値は上 / 売りの逆指値は下。
  //   ★違反した脚は落とす(即約定する不正注文を作らない)。理由は既存の語 'geometry' を使う。
  const sideOk = (c: LegContract, price: number | undefined): boolean =>
    price === undefined || entryPositionOk(c.side, c.type, price, refPrice);
  const aSideOk = sideOk(spec.legs.a, answer.aPrice);
  const iSideOk = sideOk(spec.legs.i, answer.iPrice);
  const aOk = legReady(answer.aPrice, answer.aLcWidth) && aSideOk;
  const iOk = legReady(answer.iPrice, answer.iLcWidth) && iSideOk;
  const base = { rationale, refPrice } as const;
  const strategy = answer.strategy;

  // ★立たなかった脚の記録。名前は既存の語彙(range=upper/lower / directional=limit/stop)。
  const legDrops: LegDrop[] = [];
  const dropName = (c: LegContract): LegDrop['name'] =>
    spec.shape === 'range' ? (c.key === 'a' ? 'upper' : 'lower') : c.type;
  const pushDrop = (c: LegContract, ok: boolean, sideOkFlag: boolean): void => {
    if (ok) return;
    const price = c.key === 'a' ? answer.aPrice : answer.iPrice;
    const width = c.key === 'a' ? answer.aLcWidth : answer.iLcWidth;
    const issue = c.key === 'a' ? answer.readIssues?.a : answer.readIssues?.i;
    // ★側の違反は 'geometry'(既存の語彙。エントリーが現在値の逆側だけを指す)。
    //   それ以外(価格/幅が揃わない=読めなかった)は 'missing'。★新しい理由の語は作らない。
    const reason: LegDrop['reason'] = sideOkFlag ? 'missing' : 'geometry';
    legDrops.push({
      name: dropName(c), reason,
      ...(price !== undefined ? { entry: price } : {}),
      ...(width !== undefined ? { lcWidth: width } : {}),
      ...(issue ? { parseIssue: issue } : {}),
      ...(sideOkFlag ? {} : { parseIssue: `${orderShortJa(c)}が現在価格(${refPrice})の逆側にある` }),
    });
  };
  pushDrop(spec.legs.a, aOk, aSideOk);
  pushDrop(spec.legs.i, iOk, iSideOk);

  if (!aOk && !iOk) {
    return {
      plan: { direction: 'none', ...base, ...(strategy ? { strategy } : {}) },
      aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: true, legDrops,
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
    // ★v0.9.96: レンジ2版の脚には理由の箱が無い(AiPlan.range の RangeLeg は
    //   side/type/entry/stopLoss だけ)。画面もレンジでは脚ごとの理由の行を出さない
    //   (既存の線引き)。★**意図して空**であって、配線漏れではない。理由は従来どおり
    //   rationale に載り、台帳では ai_why で追える。
    return { plan, aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: false, legDrops };
  }

  // 方向プラン: あ/い のどちらが limit でどちらが stop かは **版ごとに逆**(表が持つ)。
  const plan: AiPlan = { direction: spec.variant as 'buy' | 'sell', ...base, ...(strategy ? { strategy } : {}) };
  for (const c of [spec.legs.a, spec.legs.i]) {
    const ok = c.key === 'a' ? aOk : iOk;
    if (!ok) continue;
    const price = (c.key === 'a' ? answer.aPrice : answer.iPrice)!;
    const width = (c.key === 'a' ? answer.aLcWidth : answer.iLcWidth)!;
    // ★v0.9.96(リーダー裁定): B の脚ごとの理由を **画面の箱** へ入れる。
    //   ■ どの箱に入るかは **表(LegContract)が決める**(あ/い のどちらが指値かは版ごとに逆)。
    //     価格と同じ分岐に乗せてあるので、「価格を入れた脚」と「理由を入れた箱」は必ず一致する。
    //   ■ ★立たなかった脚には理由も入れない(価格の無い箱に理由だけ在る形を作らない)。
    const why = c.key === 'a' ? answer.aWhy : answer.iWhy;
    if (c.type === 'limit') {
      plan.limitEntry = price;
      plan.stopLossForLimit = stopLossFromWidth(c.side, price, width);   // ★向きはここだけ
      if (why) plan.entryWhyForLimit = why;
    } else {
      plan.stopEntry = price;
      plan.stopLossForStop = stopLossFromWidth(c.side, price, width);
      if (why) plan.entryWhyForStop = why;
    }
  }
  return { plan, aWhy: answer.aWhy, iWhy: answer.iWhy, bothDropped: false, legDrops };
}

// ─── ★B のプロンプト(4版・2026-08-25 にユーザーが全文を指定) ────────────────────
//
// ■ ★文面は SSOT(ユーザー指定)。ここは「4版とも同じ骨組みから、注文の語だけを差し替えて組む」だけ。
//   4版すべてが同じ形をしているので分岐は **表(B_VARIANTS)** が持ち、文面には if を書かない。
//   ★旧文面にあった「いまの相場は【上昇トレンド】と判断されています」は指定文面に無い=落とした。
//     目線は「上に逆指値買い / 下に指値買い」という注文の形そのものが表している。
//
// ■ ★損切幅の帯は **半開区間** で書く(`55円<=損切幅<160円`)。数値は設定から来る:
//     下限 = floorYen(lcFloor) / 上端 = ceilingYen + 1
//   ★なぜ +1 か(算術): コード側の受理は従来どおり **閉区間** `floor <= w <= ceilingYen`
//     (server/llm/scalpPlan.ts の lcLegExceeds は `w > 実効上限` で落とす=ちょうどは許可)。
//     円は整数なので `w <= C` と `w < C+1` は **同じ集合** を指す。
//     ★つまり半開表記にしても受理される集合は1円も変わらない=挙動は不変で、文面と実装が一致する。
//     ★もし `<${ceilingYen}` と書くと、実際には許可される C 円ちょうどを「不可」と告げることになり、
//       印字と受理が食い違う(このプロジェクトが繰り返し踏んできた型)。
//   ★実効上限は委任(scalpLcCeilingSource='ai')なら安全上限(既定159)。そのとき帯は
//     `55円<=損切幅<160円` になる=ユーザー指定の文面と一致する。手動(既定65)なら `55円<=損切幅<66円`。
//
// ■ ★2026-08-22 訂正(リーダー指摘): delegationNote(AI委任の注記)は **渡さない**(意図的)。
//   理由は設計書 docs/superpowers/specs/2026-08-21-ab-split-prompts.md を参照。

/** 注文の日本語名から「注文」を落とした短い形(形式行に書く語)。例: 逆指値買い注文 → 逆指値買い。 */
export function orderShortJa(c: LegContract): string {
  return c.orderJa.replace('注文', '');
}

/** 売買の側の日本語(形式行の「上の買いエントリー価格」の部分)。 */
function sideJa(c: LegContract): string {
  return c.side === 'buy' ? '買い' : '売り';
}

/** ★損切幅の帯(半開区間)。★数値は設定から来る=文面にベタ書きしない。 */
export function lcBandPhrase(floorYen: number, ceilingYen: number): string {
  return `${floorYen}円<=損切幅<${ceilingYen + 1}円`;
}

/** B の system プロンプト。★文面はユーザー指定(SSOT)。 */
export function buildBSystemPrompt(
  variant: BVariant, floorYen: number, ceilingYen: number, marketData: string,
): string {
  const spec = B_VARIANTS[variant];
  const a = spec.legs.a, i = spec.legs.i;
  return [
    'あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。',
    `現在価格より上の価格の${a.orderJa}、下の価格の${i.orderJa}を同時に出し、先に約定した方でエントリーし他方はキャンセルします。`,
    '渡されたデータと、利用可能なデータツール(explain_move / query_alerts / price_history / web_search)を必要に応じて使い、それぞれについて適切な注文価格と損切幅を教えてください。',
    '',
    '制約:',
    `- ${lcBandPhrase(floorYen, ceilingYen)}とする。`,
    '- 2つに分けて返してください。',
    `（上）現在価格より上の${sideJa(a)}エントリー価格とその理由。それに対応した損切幅とその理由。`,
    `形式は「${orderShortJa(a)}○○円（LC幅○○円）その後に理由を日本語で自由表記）`,
    `（下）現在価格より下の${sideJa(i)}エントリー価格とその理由。それに対応した損切幅とその理由。`,
    `形式は「${orderShortJa(i)}○○円（LC幅○○円）その後に理由を日本語で自由表記）`,
    '- 渡されたデータやテクニカル指標と、それから得られる事柄のみを根拠にする。',
    '',
    '【データ】',
    marketData,
  ].join('\n');
}

/** B の user プロンプト。
 *  ★system が問いと形式を全部持つので、ここは **現在価格** と、
 *    ①どの語で書き始めるか ②置けないときの書き方 ③不足データの書き方 だけを補う(JSON 契約は持たない)。
 *  ★「5円刻み」は従来どおり **書かない**(価格の丸め・5円ずらし・側の検査はコードの仕事)。
 *  ★①を書く理由: 読み取りが **注文タイプの語だけ** で脚を決めるから。語がずれた行は捨てられる
 *    (=黙って別の脚に入らない)ので、語を先に約束しておくほうが取りこぼしが減る。
 *  ★「1行」と書かない(2026-08-22 の実測: 字数/行数を指定すると理由が 47% 短くなった)。
 *    複数行に書かれても、読み取りは次の見出し行までを理由として拾う。 */
export function buildBUserPrompt(variant: BVariant, refPrice: number, floorYen: number, ceilingYen: number): string {
  const spec = B_VARIANTS[variant];
  return `現在価格は ${refPrice} です。損切幅は ${lcBandPhrase(floorYen, ceilingYen)} です。

（上）と（下）を、上の形式で書いてください。
（上）は「${orderShortJa(spec.legs.a)}」、（下）は「${orderShortJa(spec.legs.i)}」で書き始めてください。
置けないと判断した側は、価格と損切幅を書かず、理由だけを書いてください。
判断に必要なデータが足りなかったときは、最後に「不足データ: …」と書いてください。`;
}
