// server/llm/trendPrompt.ts — ★A(目線だけを尋ねる呼び出し)のプロンプトと応答パース。
//
// ■ A が答えるのは **1語と理由だけ**
//   buy / sell / range の3つ。★**見送り(none)はありません。**
//   ★見送れるのは B だけ・しかも理由を書いたときだけ、という設計の芯がこれで成立する。
//
// ■ ★2026-08-25(v0.9.99): **文面はユーザーが全文を指定した**(この2版が SSOT)。
//   ここから下のコードは「その文面をそのまま組み立てる」ことだけを担当する。文面の創作はしない。
//
//   (1) レンジ有効:
//     あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。
//     渡されたデータを使い、現在の相場の方向を判断し、その理由を教えてください。
//     制約:
//     - 返すのは現在の相場の方向 buy(ブル) / sell(ベア) / range(レンジ) のいずれか1語とその理由。
//     - range判断は、MA20傾きが小さく、30分間の値幅が200円以内であることを必要条件とするが、
//       十分条件ではない。rangeが確定できない場合は buy(ブル) / sell(ベア) を返すこと。
//     - 渡されたデータやテクニカル指標と、それから得られる事柄のみを根拠にする。
//
//   (2) ★レンジ無効: **range という選択肢そのものを出さない**(2語だけ)。条件の行ごと消える。
//
//   ★これで A のプロンプトは **設定(rangeEnabled)の関数** になった(従来は単一の文面)。
//     ゆえに a_prompt_build(型の指紋)も2つになる — server/llm/abPromptBuild.ts を参照。
//
// ■ ★★答えの語が変わった: bull/bear → **buy/sell**(2026-08-25・ユーザーが文面で明示)
//   旧(v0.9.90〜v0.9.98): `bull`/`bear`/`range`。「A に注文の side の語を置かない」という当時の規約。
//   新(この版〜)         : `buy`/`sell`/`range`。★ユーザーの指定文面が `buy(ブル) / sell(ベア)` と書いている。
//   ★**台帳 signal_plans.a_direction の値が版で切り替わる**(bull/bear ←→ buy/sell)。
//     ★変換はしない(過去行を書き換えない)。分析する人は **app_version と a_prompt_build で切る**。
//     境界は server/db/store.ts の a_direction 列コメントに書いた。★無言で語彙を変えない。
//   ★この語の変更で、A の禁止語表から `buy`/`sell` を **契約語へ移した**(下の A_CONTRACT_WORDS)。
//     ——A のテンプレートに出るのは当然だが、**データ部では引き続き0件** を求める。
//
// ■ ★指定文面と既存の検査の衝突は1語だけ: 「幅」(「30分間の値幅」)
//   「幅」は A の禁止語だった(損切幅/利幅がこちらの作業の語だから)。ユーザーの文面が
//   range の必要条件として「値幅」を使うので、★**表を直すのではなく語の置き場所を移す**:
//   A_FORBIDDEN_WORDS(全文で0件) → A_CONTRACT_WORDS(テンプレートには出てよい/データ部には出てはいけない)。
//   ★データ部での0件は従来どおり保たれる(弱くなるのはテンプレート側の検査だけ)。
//   ★「スキャルピング」「デイトレード」「トレーダー」は表と衝突しない(実測: 禁止語0件)。
//
// ■ ★指定文面が持ち込んだもの(承知の上・これまでの規約とは逆)
//   ① **数値のしきい値が入った**(MA20 / 30分 / 200円)。本プロジェクトの実測では
//      「印字した数値は AI がそのまま選ぶ」。range の必要条件に効くのは狙いどおりだが、
//      値幅200円というアンカーが a_why の書き方に出るかは **未測定**。
//   ② **否定文が入った**(「十分条件ではない」「確定できない場合は」)。従来は否定文を避けていた。
//   ★どちらもユーザーが文面を指定したもので、こちらの判断で直さない。効果は実運用で測る。
//
// ■ ★A に渡さないもの(呼び出し側の責務。ここは文面だけを持つ)
//   節目 / アラート / ニュース / 仮想取引の成績 / チャート画像 / データツール。
//   理由: A は方向だけを答える。価格を決める材料も、外部の裏取りも要らない。
//   ★とくにツールは、A の全文にツールの語が1つも無い以上 呼ばれない前提のものに
//   毎回 約1,088字を払うことになる(explain_move は内部で更に LLM を1回呼ぶ)。
//
// ■ ★以前の経緯(文面は入れ替わったが、判断の理由は残す)
//   ・2026-08-22 v0.9.96: 分割が実走した21件で **A が21件すべて range**(100%)→ 全件見送り。
//   ・2026-08-24 v0.9.97: 「迷ったら range」を反転。★語釈・問いの立て方まで直さないと効かない
//     ことを実データ(a_why 41〜47件が例外なく「トレンドが明確ではない → range」の形)で確認した。
//   ・2026-08-25 v0.9.99: ユーザーが全文を指定。反転の意図(range は条件を満たすときだけ)は
//     「必要条件だが十分条件ではない」という形で引き継がれている。
//   ★退行検知(server/llm/trendPrompt.test.ts の BINARY_FRAMING=有無の二分に戻す語の表)は
//     **そのまま残す**。指定文面はこの表の語を1つも含まない(実測)。
// ─── ★A に出てはいけない語の SSOT(2026-08-24 第3次) ────────────────────────────
//
// ■ なぜ **ここ**(trendPrompt.ts)に置くか
//   ① A のプロンプトを持つ唯一のモジュールで、文面を書き換える人が **同じ画面で** 表を見る。
//   ② テストは2本ある(このファイルの trendPrompt.test.ts=テンプレート側 /
//      aFullTextForbidden.test.ts=実際に送る全文側)。★表を2つ持つと片方だけ育ってズレる——
//      **実際にズレた**: 全文側の表を新設したとき、テンプレート側の27語から16語を落として作り、
//      アラート・ニュース・仮想取引の成績・ツール・買い/売り の混入を **全部素通り** させた
//      (エバリュエーターが実文を注入して実証: 破壊3で4本ともグリーン / 破壊5で28本ともグリーン)。
//      ★「表を持つ設計は項目を足すと無言で漏れる」を、表を作り直すときに **項目を減らして** 再現した。
//   ③ 実装の隣に置く前例がある(server/llm/abContext.ts の TREND_CONTEXT_FORBIDDEN)。
// ■ ★依存を増やさない: この表は文字列だけで、他モジュールを import しない
//   (trendPrompt.ts は scalpPlanSplit.ts が読む軽いモジュールのまま)。
//   abContext.ts の TREND_CONTEXT_FORBIDDEN を包含していることは **テストで固定** する。

/** ★A の全文(system + **データ部** + user)に1文字も出てはいけない語。
 *
 *  6つの禁止カテゴリを全部見る:
 *    ① 注文・執行(指値/逆指値/注文/建玉/発注/ロット/枚/買い/売り/buy/sell/limit/stop/side …)
 *    ② こちらの作業(丸め/刻み/aPrice/iPrice/lcWidth/stopEntry/limitEntry …)
 *    ③ 戦略・行動指針(順張り/逆張り/戦略/計画/見送り/veto/fade/breakout/ストラドル/両側/バックテスト …)
 *    ④ ★A に渡さない材料(節目/主要節目/長期高安/アラート/ニュース/仮想取引の成績/チャート画像)
 *    ⑤ ★A に付けないデータツール(ツール/explain_move/query_alerts/price_history/web_search)
 *    ⑥ ★A の契約に無い答えの形(none/regime/confidence/directional)
 *  ★`direction` / `range` は A 自身の契約の語なのでここには入れない(A_CONTRACT_WORDS を参照)。 */
export const A_FORBIDDEN_WORDS: readonly string[] = [
  // ① 注文・執行
  '指値', '逆指値', '注文', 'エントリー', '新規', '建玉', '発注', 'ロット', '枚', '約定', 'ポジション', 'ドテン',
  // ★'幅' は 2026-08-25 に A_CONTRACT_WORDS へ移した(ユーザー指定文面の「30分間の値幅」と衝突するため)。
  //   '損切' と '利幅' は残る=損切幅/利幅そのものは依然として A の全文に出てはいけない。
  // ★'buy'/'sell' は 2026-08-25 に A_CONTRACT_WORDS へ移した(A の答えの語そのものになったため)。
  //   ★日本語の '買い'/'売り' は禁止のまま=注文の話を A に持ち込ませない性質は生きている。
  '損切', '利幅', '両側', '建値', '買い', '売り', 'limit', 'stop', 'side', 'ロング', 'ショート',
  // ② こちらの作業(価格の調整はコードの仕事)
  '丸め', '刻み', 'stopEntry', 'limitEntry', 'lcWidth', 'aPrice', 'iPrice',
  // ③ 戦略・行動指針
  '順張り', '逆張り', '戦略', '計画', '見送り', 'veto', 'fade', 'breakout', 'ストラドル', 'バックテスト',
  // ④ A に渡さない材料(振り分け表 server/llm/abContext.ts の A×)
  '節目', '主要節目', '長期高安', 'アラート', 'ニュース', '仮想取引', '成績', '勝率', '純損益', 'pnl',
  'チャート', '画像',
  // ⑤ A に付けないデータツール
  'ツール', 'explain_move', 'query_alerts', 'price_history', 'web_search',
  // ⑥ A の契約に無い答えの形
  'none', 'regime', 'confidence', 'directional',
];

/** ★テンプレート(system/user の固定文)**だけ** で数える語。
 *
 *  ★`5円` は「5円ずらし」「+5円ではない」というこちらの作業の語だが、**価格文字列と部分一致する**
 *  (実データの勢い1行「10分-45円」/ADR「下555円」)。データ部を含む全文で数えると偽陽性になるので、
 *  文面が固定のテンプレート側でだけ数える。★落とすのではなく、数える場所を分ける。 */
export const A_FORBIDDEN_TEMPLATE_ONLY: readonly string[] = ['5円'];

/** ★A 自身の契約の語。**テンプレートには出てよい / データ部には出てはいけない**。
 *  system の選択肢(`range …`)と user の JSON(`"direction": … "range"`)に必ず出るので、
 *  全文で 0件 を求めると恒偽になる。★禁じたいのは「選択肢を持つこと」ではなく
 *  「答えを **こちらが指定する** こと」(A_DIRECTIVE_FORM_RE)。
 *
 *  ★2026-08-25: ここに **'幅' と 'buy' / 'sell'** を足した。
 *  `buy`/`sell` は **A の答えの語そのもの**(ユーザー指定文面)なので、テンプレートには必ず出る。
 *  ★データ部で0件を求める性質は変わらない=「注文の話を A のデータに混ぜない」は生きている。
 *  ★'幅' の理由: ユーザーが指定した A の文面が range の必要条件として
 *  「30分間の値幅が200円以内」と書くため、テンプレートには必ず出る。★禁止語のまま残すと恒偽になる。
 *  ★データ部で0件を求める性質は変わらない=「損切幅/利幅の話を A のデータに混ぜない」は生きている。 */
export const A_CONTRACT_WORDS: readonly string[] = ['direction', 'range', '幅', 'buy', 'sell'];

/** ★「答えをこちらが指定する形」(`direction` : `"`)の出現回数。
 *
 *  ■ 使い方: **データ部は 0 / テンプレートはちょうど 1**(user プロンプトの JSON 雛形
 *    `"direction": "buy" | "sell" | "range"` がその1つ)。
 *    ★「全文で 0」にはできない——雛形と `"direction": "none"` は **形が同一** で、
 *    違うのは値だけだから。★形で禁じ、場所で分ける。
 *  ■ ★以前は literal 4本(`direction:"` / `direction: "` / `"direction":"` / `direction："`)で持っており、
 *    ★**`"direction": "none"`(コロンの後に空白)が4本のどれにも当たらなかった**
 *    (合算では `none` が捕まえていたので赤にはならなかったが、この検査自体は素通りしていた)。
 *    空白・全角コロン・引用符の種類を吸収する1本にする。
 *  ■ ★正規表現をここで閉じ込める理由: `g` フラグ付きの RegExp を export すると `lastIndex` が
 *    呼び出し間で持ち越されて、2回目の検査が黙って通る(無言の失敗)。関数にして毎回作る。 */
export function countDirectiveForms(text: string): number {
  return (text.match(/"?direction"?\s*[:：]\s*["'\u201C\u201D]/g) ?? []).length;
}

/** A の答え。★注文の語ではない。 */
export type TrendAnswerDirection = 'buy' | 'sell' | 'range';

export interface TrendAnswer {
  direction: TrendAnswerDirection;
  /** そう判断した理由(自由文)。★理由が無くても目線が返れば成立とする(ユーザー指示)。 */
  why?: string;
}

const DIRECTIONS: readonly TrendAnswerDirection[] = ['buy', 'sell', 'range'];

/** ★A の max_tokens。**旧経路は 8000**。
 *
 *  ■ なぜ小さくするか: A は1語と短い理由しか返さない。8000 のままだと、暴走出力の上限が
 *    A にも効かず、課金と待ち時間の上限が実質無制限になる。
 *  ■ ★なぜ 16 ではないか(算術で確かめた): 応答は
 *      {"direction":"buy","why":"<日本語の理由>"}
 *    JSON の骨格だけで約 30字≒15〜20トークン。16 では **direction を書き終える前に切れる**。
 *    日本語の理由を1〜2文(40〜80字)入れると 60〜120トークン。★余裕を見て 256 にした
 *    (旧 8000 の 1/31)。
 *  ■ ★それでも切れたときに備えて、下の parseTrendAnswer は **壊れた JSON からでも
 *    direction を拾える**(切り詰めで目線を丸ごと失わない)。
 *  ■ ★2026-08-25 実測して 256 → 384 に上げた(prices_kabu.db の複製 / signal_plans 2,586件 /
 *    期間 2026-08-04〜08-24 / a_why が入っている行 122件):
 *      a_why の文字数 最小60 / 中央値108 / p90 135 / p95 142 / **最大172**。
 *    応答は {"direction":"buy","why":"<理由>"} で骨格が約20トークン。日本語を最悪1字=1トークンと
 *    見ても 最大 172+20 ≒ 192 トークン < 256 なので、**旧文面では 256 で足りていた**
 *    (実際 122件すべて why が閉じた形で入っており、切り詰めの痕跡は0件)。
 *    ★それでも上げる理由: 余裕が25%しかなく、★指定された新文面は未使用=理由の長さは **未測定**。
 *      max_tokens は上限であって課金ではない(実際に生成した分だけ課金される)ので、
 *      上げても平時の費用は増えない。最悪ケース(毎回384まで書く)でも
 *      +128tok × 89回/日 × $0.60/1M(gpt-4o-mini 出力) ≒ **$0.007/日**。
 *    ★切り詰めると why が丸ごと失われる(下の救済は閉じ引用符が無い理由を採らない)=測りたい当のものが消える。 */
export const TREND_MAX_TOKENS = 384;

/** ★A(目線)のプロンプトを一意に識別する **構造の1行**。
 *
 *  ■ なぜ定数にするか(2026-08-24・エバリュエーター指摘④)
 *    「これは A のプロンプトだ」の目印に、**改訂の対象になっている問いの文**
 *    (旧「いまトレンドがあるか」)を literal で使っていたテストがあり、問いを反転したときに
 *    **そのテストだけが古い文面を指したまま赤くなった**(server/llm/scalpPlanSplitWiring.test.ts)。
 *    目印は「いつ変わるか分からない文」ではなく **A の定義そのもの** にし、
 *    ★**本文をこの定数から組む**ことで、文面と目印が構造的にずれないようにする。
 *  ★2026-08-25: 旧値「答えは次の3つから1つ選びます。」は 選択肢が2つになる版(レンジ無効)を
 *    持てないうえ、指定文面にその行が無い。★A の定義そのもの=「方向を判断させる問い」に置き換える。
 *    ★1行目(「あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。」)は
 *    **B と同一** なので目印にできない。この2行目だけが A を一意に指す。 */
export const A_ANSWER_HEADING = '渡されたデータを使い、現在の相場の方向を判断し、その理由を教えてください。';

/** A の system プロンプト。★文面はユーザー指定(SSOT)。組み立て以外のことをしない。
 *
 *  @param rangeEnabled ★レンジ設定。false のときは **range という選択肢そのものを出さない**
 *    (選択肢の行から range が消え、range の条件の行も丸ごと消える)。
 *    ★「レンジは禁止です」とは書かない=否定文で range の語を供給しない(印字した語は AI が選ぶ)。
 *  ★注文の語も、こちらの作業(丸め・5円ずらし・側の検査)も1文字も書かない(検査は2本のテストが固定)。 */
export function buildTrendSystemPrompt(marketData: string, rangeEnabled: boolean): string {
  // ★制約の2行目(range の条件)は レンジ有効のときだけ。行ごと出す/出さないにする
  //   (空文字を残すと join が空行を作り、文面が「1変数」でなくなる)。
  const answerLine = rangeEnabled
    ? '- 返すのは現在の相場の方向 buy(ブル) / sell(ベア) / range(レンジ) のいずれか1語とその理由。'
    : '- 返すのは現在の相場の方向 buy(ブル) / sell(ベア) のいずれか1語とその理由。';
  const rangeLine = rangeEnabled
    ? ['- range判断は、MA20傾きが小さく、30分間の値幅が200円以内であることを必要条件とするが、十分条件ではない。'
       + 'rangeが確定できない場合は buy(ブル) / sell(ベア) を返すこと。']
    : [];
  return [
    'あなたは日経225先物(NIY=F)のスキャルピング/デイトレードを専門とするトレーダーです。',
    A_ANSWER_HEADING,
    '',
    '制約:',
    answerLine,
    ...rangeLine,
    '- 渡されたデータやテクニカル指標と、それから得られる事柄のみを根拠にする。',
    '',
    '【データ】',
    marketData,
  ].join('\n');
}

/** A の user プロンプト。★JSON の enum は system の選択肢と必ず一致させる(2択/3択)。 */
export function buildTrendUserPrompt(rangeEnabled: boolean): string {
  const enumLine = rangeEnabled
    ? '  "direction": "buy" | "sell" | "range",'
    : '  "direction": "buy" | "sell",';
  return `いまの相場はどう動いていますか。理由も教えてください。

次の JSON だけを出力してください(前後に説明文・コードフェンス・マークダウンを付けない)。
{
${enumLine}
  "why": string
}`;
}

/** ★A が **契約に無い語** を返したときに、その語だけを取り出す純関数(記録用・2026-08-25)。
 *
 *  ■ なぜ要るか(エバリュエーター指摘(h))
 *    parseTrendAnswer が null を返す経路は `aFailed` の早期 return で、そこは `aRecord` を作る前なので
 *    ★**a_direction も a_why も NULL** になる。つまり「A が何と答えたのか」がどこにも残らず、
 *    `aFailed` の **件数が増えることでしか** 気づけない。★語彙を切り替えた直後にこれは危ない
 *    (旧語 bull への先祖返りなのか、まったく別の壊れ方なのかが区別できない)。
 *  ■ ★取り出すのは `direction` の **値だけ**・英数と記号に限り・24字で切る。
 *    自由文(why)は一切持ち出さない=モデルの生出力をそのまま台帳へ運ばない(既存の方針)。
 *  ■ ★これは **記録専用**。読めた語として採用することは絶対にしない(救済しない)。 */
export function rawDirectionOf(text: string): string | undefined {
  if (typeof text !== 'string') return undefined;
  const m = text.match(/"?direction"?\s*[:：]\s*["'“”]?\s*([A-Za-z_-]{1,24})/);
  return m ? m[1] : undefined;
}

/**
 * A の応答テキストから TrendAnswer を取り出す純関数。
 * ★3語のどれでもない/読めない場合は null(=呼び出し側が none_reason='aFailed' にする)。
 * ★理由(why)が空でも **null にしない**: 「A が理由なしでも目線が返れば OK」(ユーザー指示)。
 */
export function parseTrendAnswer(text: string): TrendAnswer | null {
  if (typeof text !== 'string') return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as Record<string, unknown>;
      if (o && typeof o === 'object') {
        const d = o['direction'];
        if (typeof d === 'string') {
          const dir = DIRECTIONS.find(x => x === d.trim().toLowerCase());
          if (dir) {
            const why = typeof o['why'] === 'string' && o['why'].trim().length > 0 ? o['why'].trim() : undefined;
            return why === undefined ? { direction: dir } : { direction: dir, why };
          }
        }
      }
    } catch { /* ★下の救済へ落ちる(ここで null を返さない) */ }
  }
  // ★救済: max_tokens で途中で切れた応答からでも **目線だけは拾う**。
  //   why の途中で切れると JSON.parse は必ず失敗するが、direction は先頭にあるので生きている。
  //   ★ここで拾えなければ本当に読めていない=呼び出し側が none_reason='aFailed' にする。
  const md = text.match(/"direction"\s*:\s*"([A-Za-z]+)"/);
  if (!md) return null;
  const dir = DIRECTIONS.find(x => x === md[1]!.trim().toLowerCase());
  if (!dir) return null;
  // 理由は「閉じ引用符まで揃っているとき」だけ採る(切れた文を理由として記録しない)。
  const mw = text.match(/"why"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const why = mw && mw[1]!.trim().length > 0 ? mw[1]!.trim() : undefined;
  return why === undefined ? { direction: dir } : { direction: dir, why };
}
