// server/llm/contextPresence.ts — ★段5続き: 「文脈のどのブロックが実際に入ったか」を記録する純関数。
//
// ■ なぜ要るか(リーダー指摘への対応)
//   ATR・節目までの距離・BB幅・スイング高安・長い時間軸・日足バンド等は、いずれも
//   scalpContext.ts / basedataContext.ts の各サブブロックが try/catch で **独立に省略しうる**
//   (足数不足・levels 未計算・確定終値不足 等)。「本当に帯(55〜160円)しか手がかりが無い回」が
//   何%あるかを測るには、まず「その回に何が渡ったか」を記録する必要がある。
//   ★プロンプトの中身・文脈の計算ロジックは1バイトも変えない(ここは **読むだけ**)。
//
// ■ ★なぜ既存の proposals.context_omitted を流用しないか(調べた結果)
//   `context_omitted`(server/db/generatorStore.ts)は **caller によるポリシー除外**の記録で、
//   中身は現状 ['paper-trade-history'] の1種類だけ(GENERATOR_OMITTED_CONTEXT・
//   server/llm/scalpPlanRunner.ts)。値は同じ caller なら毎回同じ **定数配列**であり、
//   「今回たまたま levels が0件だった」のような **データ不足による黙示的な省略**とは意味が違う。
//   同じ列に混ぜると「ポリシーで外した」と「データが無かった」が区別できなくなる
//   (= squeeze_state と squeeze_unavailable を分けた理由と同じ罠)。★よって新設する。
//
// ■ どうやって「入ったか」を知るか(実装への最小侵襲)
//   scalpContext.ts / basedataContext.ts の各ブロックは、値が計算できた時だけ現れる
//   **一意な日本語の見出し/マーカー文字列**を持つ(例: 'ATR14(' は ATR が計算できた回にしか出ない)。
//   buildRichScalpContextResult が組み立てた **最終文字列**(marketData+basedata+仮想取引成績を
//   結合したもの)をそのままスキャンすることで、scalpContext.ts/basedataContext.ts に
//   一切手を入れずに検出できる(=既存実装は不変)。
//   ★旧経路(分割 OFF)でも buildRichScalpContextResult は無条件に呼ばれるので、そのまま機能する。
//
// ■ ★ニュースだけ別の入力(文字列スキャンでは分からない)
//   ニュース(getNews())は marketData/basedata の文字列に一切含まれない。
//   (A: ご指示で外した / B: A/B 分割の文脈では technical/technicalForTrend のどちらにも
//    埋め込まれない——2026-08-22 の調査で判明。旧(分割 OFF)の1回呼び出しだけが
//    systemPrompt に別途 '■ 関連ニュース:' を追記している)。
//   ★つまり news=true は「その回にニュースが存在した」であって「AI に渡った」ではない
//   (分割経路では現状 true でも中身は見せていない)。この非対称性は呼び出し側で必ず注記すること。

/** ブロックごとに「実際に入ったか」。★NULL(未測定/この版に無い)は呼び出し側の責務
 *  (この型自体は測れた回にしか作らない=全部 false の値と「測っていない」を混同させない)。 */
export interface ContextPresence {
  /** ATR14(1分・「ボラ/レンジ」ブロック内)。 */
  atr: boolean;
  /** 本日高安(同じく「ボラ/レンジ」ブロック内・ATR とは独立に省略されうる)。 */
  sessionHighLow: boolean;
  /** 主要節目(節目ブロック)。 */
  levels: boolean;
  /** BB(テクニカル指標ブロック内・RSI/SMA とは独立に省略されうる)。 */
  bb: boolean;
  /** 直近スイング。 */
  swing: boolean;
  /** 長い時間軸(1時間/2時間/当日始値比)。 */
  longHorizon: boolean;
  /** 直近アラートとその後。 */
  alerts: boolean;
  /** 日足バンド(基礎データ内・本数不足のときは false)。 */
  dailyBand: boolean;
  /** 基礎データブロックそのものが取得できたか(全欠測なら false)。 */
  basedata: boolean;
  /** ★ニュースが**存在した**か(「渡った」かではない。上のコメント参照)。 */
  news: boolean;
}

/** 「文脈の各ブロックが実際に入ったか」を、組み上がった文字列から検出する純関数。
 *  ★実装(scalpContext.ts/basedataContext.ts)には一切手を入れない=見出しの文字列を読むだけ。
 *  richText … buildRichScalpContextResult().text(marketData+basedata+仮想取引成績を結合済み)。
 *  newsItemCount … その計画サイクルで取得したニュース件数(getNews().length)。 */
export function detectContextPresence(richText: string, newsItemCount: number): ContextPresence {
  const t = typeof richText === 'string' ? richText : '';
  return {
    atr: t.includes('ATR14('),
    sessionHighLow: t.includes('本日高安 '),
    levels: t.includes('主要節目('),
    bb: t.includes('BB['),
    swing: t.includes('直近スイング: '),
    longHorizon: t.includes('長い時間軸('),
    alerts: t.includes('直近アラートとその後('),
    // ★'日足バンド: '(コロン)= 実データ入り。'日足バンド=本数不足' 等はイコールなのでここには一致しない。
    dailyBand: t.includes('日足バンド: '),
    // ★基礎データブロックの見出しはあるが、全欠測の定型文が出ているときは false にする。
    basedata: t.includes('基礎データ(日足') && !t.includes('このサイクルでは基礎データを渡していません'),
    news: newsItemCount > 0,
  };
}
