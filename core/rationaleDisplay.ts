// 根拠文(rationale)を **画面に出すとき** だけ、LC幅の検算部分を落とす純関数。
//
// ■ なぜ「表示だけ」落とすのか(★プロンプトからは絶対に外さない)
//   AI に「出力前に自分で引き算して LC幅を書け」と要求しているのは、答えを読むためではなく
//   **符号を保たせるため**。オフライン再生ハーネスの実測で、式の要求を外すと損切りの向きの誤り
//   (stopSide 落ち)が 10件→30件 に増えた(p<0.05)。LLM は算術をしないが形は守る。
//   → 生成の側は1文字も変えない。**画面に出す直前にだけ** 検算の断片を落とす。
//   → 生の rationale は台帳(signal_trades.rationale / signal_plans)にそのまま残り、
//     server/llm/rationaleLc.ts の突き合わせ監査(RECORD-ONLY)も従来どおり生文字列を読む。
//
// ■ 語彙の出所(★重複していることを承知で置いている)
//   ここで使う「LC幅の申告(書式①)」「代入の式(書式②)」の語彙は、
//   **server/llm/rationaleLc.ts の WIDTH_RE / EQUATION_RE / HEADING_RE が唯一の出所** で、
//   このファイルはその写し。core は server に依存できない(web も同じモジュールを読む)ため import で
//   共有できず、写しになっている。ずれを検知するために core/rationaleDisplay.test.ts に
//   「同じサンプル文字列を rationaleLc のパーサが LC 申告として読み、こちらは落とす」ことを
//   突き合わせるテストを置いてある。**片方だけ直すとそのテストが落ちる。**
//
// ■ 落とす/落とさない の境界
//   落とす: 「LC の検算しか含まない断片」だけ。
//     「指値レッグ 68725 と 68665 の引き算 → LC幅は60円。」/「ブレイク新規レッグ … → LC幅は60円。」
//     「指値レッグ 65540 + 55 = 65595」/「65015+LC幅(55)=65070」/「LC幅は60円」/「LC=55円」
//   落とさない:
//     ・コード側が機械生成で足す注記(`※上部(売り指値)は不採用: …` / `（逆指値なし: AIが提案せず）`)
//     ・AI の判断理由の本文。**LC に触れていても、理由が混ざっている文は残す**
//       (例「LC幅は60円とし、直近安値の外側に置く。」→ 残す)。
//       規範の「AI の判断理由の本文は絶対に落とさない」を優先し、判定を保守側に倒している。
//   全部落ちて空になる場合は、**理由が書かれていない事実を出す**(NO_REASON)。
//   ★元の文字列を戻す設計にはしない。実測(2026-08-17 書き出し)で直近セッションの根拠文は
//     19件中17件(89.5%)・B系は9/9 が LC検算しか含まない。元を戻すと画面はほぼ何も変わらず、
//     「検算は表示不要」という要求を満たせない。かといって空にすると **無言の失敗** になる
//     (AI が理由を書かなかったのか、剥がし過ぎたのか、画面から区別できない)。
//   ★誤って理由を消す心配は無い: isLcOnlyFragment は「実質の語が1つも残らない断片」しか落とさないので、
//     理由が1語でも書かれていれば必ず残る。NO_REASON が出るのは本当に検算しか無い回だけ。
//
// ■ 2026-08-17 に塞いだ2つの穴(旧「既知の穴」・ユーザー判断「過去との整合性より正しい表示を優先」)
//    ①「LC幅は(55)円」「LC=(55)円」= **幅を括弧で囲んだ形**。従来 WIDTH_SRC は助詞なしの「LC幅(55)」しか読めなかった。
//      ★実測(複製DB・2026-08-17): 剥がし方が変わった根拠文は signal_trades 1,539件中 9件 /
//        generator proposals 12,043件中 108件。うち NO_REASON へ落ちたのが計23件。
//        ★**出力が長くなった(剥がし損ねる方向へ動いた)根拠文は 13,582件中 0件**=回帰なし。
//    ②「ＬＣ＝５５円」= **英字も数字も全角の形**。→ 判定の直前に全角 ASCII を半角へ写して読む。
//      ★未測定: この形は手元の複製DBに1件も無く、効き目は単体テストでしか確認していない。
//   ★どちらも監査側 server/llm/rationaleLc.ts と **同時** に直してある(片方だけ直すと下の突き合わせテストが赤)。
//   ★正規化(normalizeFullWidthAscii)は **判定にだけ** 使い、画面に残す文字列は元のまま
//     (剥がさない文は1バイトも書き換えない)。

/** 全角 ASCII(U+FF01〜U+FF5E)を半角へ写す(1文字→1文字・長さ不変)。
 *  ★出所: server/llm/rationaleLc.ts の normalizeFullWidthAscii(写し)。 */
function normalizeFullWidthAscii(s: string): string {
  return s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 幅の数値(括弧付きも同じ申告)。★出所: server/llm/rationaleLc.ts の WIDTH_NUM(写し)。 */
const WIDTH_NUM = '(?:[（(]\\s*(?:\\d{1,3})(?!\\d)\\s*[)）]|(?:\\d{1,3})(?!\\d))';

/** 書式①(幅の申告)。★出所: server/llm/rationaleLc.ts の WIDTH_RE(写し)。 */
const WIDTH_SRC = [
  `LC\\s*[=＝:：]\\s*${WIDTH_NUM}\\s*円?`,
  'LC幅\\s*(?:は|が|＝|=|:|：)?\\s*[（(]\\s*(?:\\d{1,3})(?!\\d)\\s*[)）]\\s*円?',
  'LC幅\\s*(?:は|が|＝|=|:|：)\\s*(?:\\d{1,3})(?!\\d)\\s*円?',
  `損切り幅\\s*(?:は|が|＝|=|:|：)?\\s*${WIDTH_NUM}\\s*円`,
  `lcWidthFor(?:Limit|Stop)\\s*(?:は|が|＝|=|:|：)\\s*${WIDTH_NUM}\\s*円?`,
  `lcWidth\\s*(?:は|が|＝|=|:|：)\\s*${WIDTH_NUM}\\s*円?`,
].join('|');

/** 書式②(代入の式)。★出所: server/llm/rationaleLc.ts の EQUATION_RE(写し)。 */
const EQUATION_SRC =
  '(?:\\d{4,6})(?!\\d)\\s*[+＋\\-−ー]\\s*(?:LC幅\\s*[（(]\\s*)?(?:\\d{1,3})(?!\\d)\\s*[)）]?\\s*[=＝]\\s*(?:\\d{4,6})(?!\\d)';

/** 見出し(レッグ名)。★長い語から先に(「逆指値」の中の「指値」を先に食わない)。
 *  出所: server/llm/rationaleLc.ts の HEADING_RE(写し・表示用に日本語の見出しだけ使う)。 */
const HEADING_SRC = 'ブレイク新規レッグ|ブレイク新規|逆指値レッグ|逆指値|指値レッグ|指値';

/** 検算の文を組み立てているだけの語(これしか残らなければ「検算しか書いていない」と見なす)。
 *  ★実質の語(名詞・動詞)は入れない。ここに意味のある語を足すと理由文まで落ちる。
 *  ★「損切りの位置」「エントリー価格」は **プロンプト自身の穴埋め語**(scalpPlan.ts の
 *    lcWidthDeclarationExample が例文に置く `(エントリー価格)` / `(損切りの位置)`)。AI がその穴を
 *    埋めずにそのまま写してくる回があり(実測: 全期間1,539件中62件・直近セッション19件中3件)、
 *    これが残るせいで「検算しか書いていない」断片が落ちなかった。判断理由ではないので filler に入れる。
 *    ※これらを消しても安全: 「損切りの位置は直近安値の外側に置く。」なら「直近安値/外側」が残る=落ちない。 */
const FILLER_SRC = '損切りの位置|エントリー価格|引き算|差|計算|の|を|に|で|と|は|が|も|から|まで|より|そして|よって';

const LC_DECLARATION_RE = new RegExp(`(?:${WIDTH_SRC}|${EQUATION_SRC})`, 'g');
const STRIP_RE = new RegExp(
  `(?:${EQUATION_SRC})|(?:${WIDTH_SRC})|(?:${HEADING_SRC})|(?:${FILLER_SRC})`,
  'g',
);
/** 残りかすに「実質の語」が在るか(ひらがな/カタカナ/漢字/英字)。
 *  ★数字は入れない: 検算を剥がした後に残る数字は価格の残骸であって、意味のある語ではない。 */
const SUBSTANCE_RE = /[ぁ-んァ-ヶ一-龥A-Za-z]/;
/** 数字と記号だけの残骸(価格・矢印・句読点・括弧・演算子・単位)は「実質なし」に数える。 */
const RESIDUE_RE = /[\d０-９,，.．\s。、・:：=＝+\-−ー→⇒（）()「」【】\[\]円]/g;

/** 機械生成の注記(コード側が足したもの)。**絶対に落とさない**。
 *  `※…`(rangeDropNote) と `（指値なし: …）`/`（逆指値は不採用: …）`(buildLegNote)。 */
const MACHINE_NOTE_RE = /^※|[（(](?:指値|逆指値|上部|下部)[^）)]*(?:なし|不採用)/;

/** その断片が「LC の検算しか含まない」か。
 *  ★判定は全角 ASCII を半角へ写した文字列で行う(「ＬＣ＝５５円」を読むため)。
 *   写しは長さ不変で、**判定にしか使わない**(残す文は呼び出し側が元の文字列をそのまま繋ぐ)。 */
function isLcOnlyFragment(fragment: string): boolean {
  const s = normalizeFullWidthAscii(fragment.trim());
  if (s === '') return false;
  if (MACHINE_NOTE_RE.test(s)) return false;   // コード側の注記は無条件で残す。
  LC_DECLARATION_RE.lastIndex = 0;
  if (!LC_DECLARATION_RE.test(s)) return false;   // 前提: LC の申告/式を含むこと。
  const rest = s.replace(STRIP_RE, '').replace(RESIDUE_RE, '');
  return !SUBSTANCE_RE.test(rest);
}

/** 1行を文(「。」区切り)に分ける。区切り文字は直前の文に残す(復元して繋げられる形)。 */
function splitSentences(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const ch of line) {
    buf += ch;
    if (ch === '。') { out.push(buf); buf = ''; }
  }
  if (buf !== '') out.push(buf);
  return out;
}

/** 検算しか書かれていなかったときに画面へ出す文。空にして無言で消さないための印。
 *  ★この文言が頻繁に出るなら、それは表示の不具合ではなく **AI が理由を書いていない** という観測結果。 */
export const NO_REASON = '（理由の記載なし）';

/** 根拠文から LC幅の検算だけを落とす(表示専用の純関数)。
 *  ・行(`\n`)の構造は保つ。行の中は「。」区切りの文単位で判定する。
 *  ・全部落ちて空になったら NO_REASON を返す(元文字列は戻さない/無言で空にもしない)。 */
export function stripLcArithmetic(text: string | null | undefined): string {
  if (typeof text !== 'string' || text === '') return '';
  const lines = text.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const sentences = splitSentences(line);
    const keptSentences = sentences.filter(s => !isLcOnlyFragment(s));
    // 文が全部落ちた行は行ごと落とす(空行を残さない)。元が空行なら空行のまま残す。
    if (keptSentences.length === 0 && sentences.length > 0) continue;
    kept.push(keptSentences.join('').replace(/\s+$/, ''));
  }
  const out = kept.join('\n').trim();
  return out === '' ? NO_REASON : out;
}
