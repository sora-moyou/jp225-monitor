// 根拠文(rationale)に **AI 自身が書いた LC幅** を読み取り、**実際に出力した損切り価格から数えた幅** と
// 突き合わせる純関数群(RECORD-ONLY)。
//
// ■ なぜ要るか(実測 2026-08-07)
//   AI は根拠文に正しい LC幅(例「LC幅=55円」)を書きながら、JSON の stopLossForStop には建値の隣(±5円)を
//   入れることがある。つまり「計算も申告も合っていて、代入の瞬間だけ壊れる」。
//   これは JSON だけ見ても(幅が5円=下限未満としか分からない)、根拠文だけ見ても(正しい)検出できない。
//   **両方を突き合わせて初めて** 「AI が自分の申告どおりに代入できていない」ことが見える。
//   プロンプトの文言では4版続けて直らなかったので、まず **コードで頻度と分布を測る**。
//
// ■ 検出は判定に使わない
//   ここで出す値は台帳(signal_plans.lc_audit_json)に載せるだけ。採否・価格・noneReason・legDrops の
//   意味は1バイトも変えない。「食い違ったら落とす/直す」もしない(落とせば機会損失が増え、直せば
//   『AI が直ったのか、コードが隠しているだけか』が二度と分からなくなる)。
//
// ■ 対応する書式(プロンプトの版で書き方が変わってきたので全部出る)
//   ① 幅の申告   「指値レッグ LC=55円」「LC幅(55)」「LC幅は55円」「LC幅は(55)円」「損切り幅は55円」
//   ② 代入の式   「指値レッグ 65540 + 55 = 65595」「65015+LC幅(55)=65070」(v0.9.62 以降に増えた形)
//   ③ 引き算     「指値レッグ 68725と68665の引き算 → LC幅は60円」(v0.9.70 以降の現行プロンプトの形)
//      ★③は幅そのものを持たない(幅は同じ文の①が持つ)。③を読む目的は **向き** を見ること(下記)。
//   ★①で数値の後に必ず (?!\d) を置く。置かないと「LC=65400」(幅ではなく **価格** を書いた形)から
//     先頭3桁「654」を幅として拾い、食い違い件数を水増しする(実データで確認済みの偽陽性)。
//     ★括弧付き「LC幅は(55)円」を読めるようにしても この防御は括弧の内側/外側の両方で維持する。
//
// ■ 全角(2026-08-17 に塞いだ穴の片方)
//   ★未測定の注意: この形は 手元の複製DB(signals_kabu.db 1,539件 / generator_proposals 12,043件)には
//     **1件も無かった**。塞いだ根拠はエバリュエーターの実測報告と単体テストであって、こちらの実データでは
//     効き目を確認できていない(=この穴を塞いだことによる件数の変化は 0件)。
//   「ＬＣ＝５５円」のように英字も数字も全角で書いてくる回がある。正規表現に全角の数字クラスを
//   足すのではなく、**走査の直前に全角 ASCII(U+FF01〜U+FF5E)を半角へ写す**。
//   ★この写しは 1文字→1文字 で **長さが変わらない**。見出しの割り当ては文字位置(index)で決めているので、
//     長さの変わる正規化(NFKC は半角カナを合成して縮む)を使うと割り当てが静かにずれる。だから自前で狭く写す。
//   ★既存の全角記号の分岐(＝ ： （ ）など)は **残す**。写しに漏れがあっても従来どおり読めるようにするため
//     (この変更で従来読めていた形が1件も読めなくならないことが要件)。
//
// ■ レッグへの割り当て
//   文中の見出し(「指値」「ブレイク新規」「逆指値」)の位置でテキストを区切り、各数値を **直前の見出し** の
//   レッグに割り当てる。見出しより前に出た数値は unassigned(どちらとも言えない)に置く=無理に割り当てない。
//   ★「逆指値」は文字列として「指値」を含むため、必ず長い語から先に照合する(順序が逆だと全部 limit になる)。
//
// ■ 向き(符号)の突き合わせ(v0.9.83・RECORD-ONLY)
//   ★これまで突き合わせていたのは **幅だけ**。そのため「幅は正しく符号だけ逆」の回が match と記録されていた。
//   ★実測(2026-08-17・generator_proposals_kabu.db 複製 / lc_audit_json のある 3,895提案 = 7,790レッグ /
//     session_date 2026-08-10〜08-17 / 腕 current・candidate-a・control・prompt-v2):
//       向きの材料が読めた 4,925レッグ中 **逆側 = 1,760(35.7%)**、正しい側 = 3,144。
//       そのうち **1,628レッグは幅が一致(status='match')** = 従来の台帳では「合っている」としか読めなかった分。
//     ★同じ母集団で **実際に出力された entry/stopLoss** が逆側だったのは 36レッグ(全て 2026-08-10・
//       widthSource 無し=v0.9.70 以前の旧契約の記録)で、**そのうち最終プランに残ったのは 0件**
//       (全て stopSide ガードで落ちている)。⇒ 壊れているのは **根拠文だけ** で執行への実害は無い。
//     それでも記録するのは、「AI が向きを間違えたまま書いている」ことが台帳から読めないと、
//     プロンプトの効き目(v0.9.70 で符号を表現不能にした後も 文章では間違え続けているか)を測れないから。
//     ★prompt-v2 の 1,870レッグは材料が0件(v2 の質問文は引き算/式を書かせない)。腕をまたいで比べないこと。
//   ★「幅の一致(status)」と「向きの一致(declaredSide)」は **別のフィールド** にする。status の3値
//     (match/mismatch/undeclared)の意味を変えると過去の集計と比較できなくなるため、1バイトも触らない。
//   ★向きが判定できるのは ②(式)と ③(引き算)だけ。①(幅だけの申告)には建値も損切りも書かれていないので
//     判定材料が存在しない。ここを混ぜない(「読めなかった」を「一致」に数えない のと同じ規律)。
//   ★向きの判定には direction(buy/sell)が要る。呼び出し側が渡さなければ 'sideUnknownDirection' と
//     **明示して残す**(推測で埋めない)。

/** 突き合わせの対象になるレッグ名(scalpPlan.ts の LegDrop.name と同じ語彙)。 */
export type LcLegName = 'limit' | 'stop' | 'upper' | 'lower';

/** 根拠文の見出しで区別できるレッグ種別(directional の2本だけ)。 */
export type LcLegKind = 'limit' | 'stop';

/** 書式②(代入の式)として読み取れた1件。 */
export interface LcDeclaredEquation {
  /** 左辺(エントリー価格として書かれた数)。 */
  a: number;
  /** 演算子。 */
  op: '+' | '-';
  /** 幅として書かれた数。 */
  w: number;
  /** 右辺(損切り価格として書かれた数)。 */
  b: number;
  /** a op w === b か(AI 自身の算術が合っているか)。 */
  selfConsistent: boolean;
  /** 直前の見出しから決めたレッグ(見出しが無ければ null)。 */
  leg: LcLegKind | null;
}

/** 根拠文が書いた「建値と損切り位置の対」= **向き** を判定できる唯一の材料(v0.9.83)。
 *  ★書式②(式)と書式③(引き算)の両方をここに集める。幅の申告(書式①)は建値も損切りも持たないので入らない。
 *  ★equations と別配列にした理由: LcDeclaredEquation の形(a/op/w/b/selfConsistent/leg)は
 *    既存の記録・テストが固定しているので1バイトも変えたくない。向き用の材料は「式」以外(引き算)からも
 *    来るため、そちらへ寄せるより **両方を受ける器を新しく作る** ほうが素直。 */
export interface LcSideClaim {
  /** 根拠文が **建値として** 書いた数。 */
  entry: number;
  /** 根拠文が **損切りの位置として** 書いた数。 */
  stopLoss: number;
  /** どの形から読んだか。 */
  from: 'equation' | 'subtraction';
  /** 直前の見出しから決めたレッグ(見出しが無ければ null)。 */
  leg: LcLegKind | null;
  /** 文中での出現位置(先に書かれた申告を採るための順序キー)。 */
  at: number;
}

/** 根拠文から読み取れた申告の全体。 */
export interface LcDeclarations {
  /** 指値レッグに割り当てられた申告幅(文中の出現順)。 */
  limit: number[];
  /** 逆指値(ブレイク新規)レッグに割り当てられた申告幅(文中の出現順)。 */
  stop: number[];
  /** 見出しより前に出て、どのレッグとも言えなかった申告幅。 */
  unassigned: number[];
  /** 書式②の式(文中の出現順)。 */
  equations: LcDeclaredEquation[];
  /** ★向きの突き合わせ用(書式②+③・文中の出現順)。v0.9.83 で追加。 */
  sideClaims: LcSideClaim[];
}

/** 1レッグぶんの突き合わせ結果(記録専用)。 */
export interface LcDeclarationCheck {
  /** どのレッグか。 */
  leg: LcLegName;
  /** AI が出したエントリー価格。 */
  entry: number;
  /** AI が出した損切り価格。 */
  stopLoss: number;
  /** 実際の幅 |entry − stopLoss|。 */
  actualYen: number;
  /** 根拠文で申告された幅。読み取れなければ null。 */
  declaredYen: number | null;
  /** ★「一致」と「未申告」を混ぜないための3値。undeclared=根拠文から読み取れなかった。 */
  status: 'match' | 'mismatch' | 'undeclared';
  /** 申告値をどの形から読んだか(width=書式① / equation=書式② / sole=文中唯一の申告からの推定)。 */
  source?: 'width' | 'equation' | 'sole';
  /** 書式②の右辺として書かれた損切り価格(あれば)。実際の stopLoss と比べられる。 */
  declaredStopLoss?: number;
  /** 書式②の算術が AI 自身の中で閉じているか(a op w === b)。式が無ければ未設定。 */
  equationSelfConsistent?: boolean;
  // ─── ★v0.9.83: 根拠文が書いた損切りの **向き**(幅の一致=status とは完全に独立の観測) ───
  //   ★キー自体が無い = 向きを判定できる形(式/引き算)が根拠文に無かった。「一致」ではない。
  //   ★値の語彙をわざと status(match/mismatch/undeclared)と重ならない語にしてある。
  //     台帳を SQL で数えるとき `lc_audit_json LIKE '%sideReversed%'` が status と衝突しないため。
  /** 'sideOk'=建値に対して正しい側 / 'sideReversed'=逆側(同値=幅0 もここ) /
   *  'sideUnknownDirection'=材料はあったが direction が渡らず判定できなかった。 */
  declaredSide?: 'sideOk' | 'sideReversed' | 'sideUnknownDirection';
  /** 上の判定に使った、根拠文が **建値として** 書いた数。 */
  declaredSideEntry?: number;
  /** 上の判定に使った、根拠文が **損切りとして** 書いた数。 */
  declaredSideStop?: number;
  /** その材料をどの形から読んだか。 */
  declaredSideFrom?: 'equation' | 'subtraction';
}

/** 見出し(レッグ名)。★長い語を先に置く=「逆指値」の中の「指値」を拾わない。
 *  ★v0.9.70: 損切りの契約が「価格(stopLossFor…)」→「幅(lcWidthFor…)」に変わったので、
 *   新しいフィールド名も見出しとして拾う。足さないと、AI が新しい名前で書いた根拠文の申告幅が
 *   どのレッグにも割り当たらず(unassigned)、突き合わせが **無言で undeclared に落ちる**。
 *   旧名は残す(旧形式で書いてくる回も読めるように=フォールバックと同じ理由)。 */
const HEADING_RE = /ブレイク新規|逆指値レッグ|逆指値|lcWidthForStop|stopLossForStop|stopEntry|指値レッグ|指値|lcWidthForLimit|stopLossForLimit|limitEntry/g;

/** 幅の数値。**括弧で囲んだ形も同じ1つの申告として読む**(2026-08-17 に塞いだ穴の片方)。
 *  ★実測(generator_proposals 複製 7,790レッグ): この枝を足したことで undeclared → 136行が読めるようになった
 *    (match 117 / mismatch 19)。136行は **全て** 括弧形(「LC幅は(55)円」「LC=(55)円」)由来で、
 *    既に読めていた 5,761行の申告値・source・status は **1行も変わっていない**(回帰なしを実データで確認)。
 *  ★偽陽性ガード (?!\d) は **括弧の内側でも外側でも** 数値の直後に置く。外すと「LC=65400」から
 *    先頭3桁「654」を幅として拾う(実データで確認済み)。
 *  ★捕獲グループは交替のうち1つしか埋まらない。読み出し側は m.slice(1).find(g => g !== undefined) で足りる。 */
const WIDTH_NUM = '(?:[（(]\\s*(\\d{1,3})(?!\\d)\\s*[)）]|(\\d{1,3})(?!\\d))';

/** 書式①(幅の申告)。書き方の交替を1回だけ走査する(=拾う順序が文の順序と一致する)。
 *  ★v0.9.70(保険): 新契約のフィールド名で幅を申告する形(`lcWidthForStop = 60円` / `lcWidth: 60`)も読む。
 *   プロンプトの例文は「LC幅は N円」に揃えたが、モデルが自分のフィールド名で書く回は必ず出る。
 *   ★長い語を先に置く(`lcWidthForLimit` を `lcWidth` の枝で切らないため)。
 *  ★「LC幅」だけ枝を2本に分けている理由: 括弧付きのときだけ助詞(は/が/=)を **任意** にしたいため
 *   (「LC幅(55)」= 助詞なし・従来から読めた形 / 「LC幅は(55)円」= 助詞あり・今回塞いだ形)。
 *   括弧なしの枝は助詞を **必須のまま** 据え置く=「LC幅55円」を新たに拾い始めて件数が動くことを避ける。 */
const WIDTH_RE = new RegExp(
  [
    `LC\\s*[=＝:：]\\s*${WIDTH_NUM}\\s*円?`,
    `LC幅\\s*(?:は|が|＝|=|:|：)?\\s*[（(]\\s*(\\d{1,3})(?!\\d)\\s*[)）]\\s*円?`,
    'LC幅\\s*(?:は|が|＝|=|:|：)\\s*(\\d{1,3})(?!\\d)\\s*円?',
    `損切り幅\\s*(?:は|が|＝|=|:|：)?\\s*${WIDTH_NUM}\\s*円`,
    `lcWidthFor(?:Limit|Stop)\\s*(?:は|が|＝|=|:|：)\\s*${WIDTH_NUM}\\s*円?`,
    `lcWidth\\s*(?:は|が|＝|=|:|：)\\s*${WIDTH_NUM}\\s*円?`,
  ].join('|'),
  'g',
);

/** 書式②(代入の式)。`65540 + 55 = 65595` / `65015+LC幅(55)=65070` / 全角記号も許す。 */
const EQUATION_RE =
  /(\d{4,6})(?!\d)\s*([+＋\-−ー])\s*(?:LC幅\s*[（(]\s*)?(\d{1,3})(?!\d)\s*[)）]?\s*[=＝]\s*(\d{4,6})(?!\d)/g;

/** 書式③(引き算)。現行プロンプト(scalpPlan.ts の lcWidthDeclarationExample)が書かせる形
 *  「(建値)と(損切りの位置)の引き算 → LC幅は N円」。**幅は持たない**(幅は同じ文の書式①が持つ)。
 *  ここから読むのは A(建値)と B(損切りの位置)= **向きの判定材料** だけ。
 *  ★実データでは両方が括弧付きで来る回がある(「(68870)と(68625)の引き算」)ので括弧を任意にする。 */
const SUBTRACTION_RE =
  /(?:[（(]\s*)?(\d{4,6})(?!\d)(?:\s*[)）])?\s*と\s*(?:[（(]\s*)?(\d{4,6})(?!\d)(?:\s*[)）])?\s*の\s*引き算/g;

/** 全角 ASCII(U+FF01〜U+FF5E)を半角へ写す(1文字→1文字・**長さが変わらない**)。
 *  ★NFKC を使わない理由: 半角カナが合成されて **文字数が縮み**、見出しの割り当て(文字位置で決めている)が
 *   静かにずれる。ここで欲しいのは「ＬＣ＝５５円 → LC=55円」だけなので、狭く自前で写す。 */
export function normalizeFullWidthAscii(s: string): string {
  return s.replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** 見出しの出現位置(文の順)。
 *  ★export している理由: 「どの語がどのレッグを指すか」の語彙をここ1箇所に置くため
 *  (根拠文の別の突き合わせ=rationaleOmission.ts も同じ見出しで割り当てる)。 */
export function headingMarks(text: string): Array<{ at: number; leg: LcLegKind }> {
  const marks: Array<{ at: number; leg: LcLegKind }> = [];
  HEADING_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HEADING_RE.exec(text)) !== null) {
    const w = m[0];
    const leg: LcLegKind =
      (w === 'ブレイク新規' || w.startsWith('逆指値') || w === 'stopEntry' || w === 'stopLossForStop' || w === 'lcWidthForStop') ? 'stop' : 'limit';
    marks.push({ at: m.index, leg });
  }
  return marks;
}

/** 位置 idx の直前にある見出しのレッグ。見出しが1つも無ければ null。 */
function legBefore(marks: ReadonlyArray<{ at: number; leg: LcLegKind }>, idx: number): LcLegKind | null {
  let cur: LcLegKind | null = null;
  for (const m of marks) {
    if (m.at > idx) break;
    cur = m.leg;
  }
  return cur;
}

/** 根拠文から「AI が申告した LC幅」と「向きの判定材料」を読み取る(純関数・例外を投げない)。
 *  ★走査の前に全角 ASCII を半角へ写す(長さは変わらないので index による見出し割り当ては不変)。 */
export function parseLcDeclarations(rationale: string | null | undefined): LcDeclarations {
  const out: LcDeclarations = { limit: [], stop: [], unassigned: [], equations: [], sideClaims: [] };
  if (typeof rationale !== 'string' || rationale === '') return out;
  const text = normalizeFullWidthAscii(rationale);
  const marks = headingMarks(text);

  WIDTH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIDTH_RE.exec(text)) !== null) {
    // 交替のどのグループが埋まったかに関係なく、捕まえた数値は必ず1つ。
    const raw = m.slice(1).find(g => g !== undefined);
    const w = Number(raw);
    if (!Number.isFinite(w) || w <= 0) continue;
    const leg = legBefore(marks, m.index);
    if (leg === 'limit') out.limit.push(w);
    else if (leg === 'stop') out.stop.push(w);
    else out.unassigned.push(w);
  }

  EQUATION_RE.lastIndex = 0;
  let e: RegExpExecArray | null;
  while ((e = EQUATION_RE.exec(text)) !== null) {
    const a = Number(e[1]);
    const w = Number(e[3]);
    const b = Number(e[4]);
    if (![a, w, b].every(v => Number.isFinite(v))) continue;
    const op: '+' | '-' = /[+＋]/.test(e[2] ?? '') ? '+' : '-';
    const leg = legBefore(marks, e.index);
    out.equations.push({ a, op, w, b, selfConsistent: (op === '+' ? a + w : a - w) === b, leg });
    // 式の左辺=建値・右辺=損切り価格。これが向きの判定材料になる。
    out.sideClaims.push({ entry: a, stopLoss: b, from: 'equation', leg, at: e.index });
  }

  SUBTRACTION_RE.lastIndex = 0;
  let s: RegExpExecArray | null;
  while ((s = SUBTRACTION_RE.exec(text)) !== null) {
    const a = Number(s[1]);
    const b = Number(s[2]);
    if (![a, b].every(v => Number.isFinite(v))) continue;
    // 「(建値)と(損切りの位置)の引き算」= 前が建値・後ろが損切り(プロンプトの語順が SSOT)。
    out.sideClaims.push({ entry: a, stopLoss: b, from: 'subtraction', leg: legBefore(marks, s.index), at: s.index });
  }
  out.sideClaims.sort((x, y) => x.at - y.at);
  return out;
}

/** そのレッグについて申告された幅の代表値。
 *  優先順: ①そのレッグの見出しに割り当たった申告 → ②そのレッグの式の幅 → ③文中に申告が1つしか無く
 *  式も無いなら、その唯一の値(=どのレッグの話か曖昧さが無い場合だけの推定)。
 *  ★upper/lower(レンジ脚)は見出しで区別できないので ③ しか当たらない=読めなければ素直に null(未申告)を返す。 */
export function declaredWidthFor(
  d: LcDeclarations, leg: LcLegName,
): { yen: number; source: 'width' | 'equation' | 'sole' } | null {
  const kind: LcLegKind | null = leg === 'limit' || leg === 'stop' ? leg : null;
  if (kind) {
    const direct = kind === 'limit' ? d.limit : d.stop;
    if (direct.length > 0) return { yen: direct[0]!, source: 'width' };
    const eq = d.equations.find(x => x.leg === kind);
    if (eq) return { yen: eq.w, source: 'equation' };
  }
  if (d.limit.length === 0 && d.stop.length === 0 && d.unassigned.length === 1 && d.equations.length === 0) {
    return { yen: d.unassigned[0]!, source: 'sole' };
  }
  return null;
}

/** そのレッグの式(書式②)。無ければ null。 */
function equationFor(d: LcDeclarations, leg: LcLegName): LcDeclaredEquation | null {
  if (leg !== 'limit' && leg !== 'stop') return null;
  return d.equations.find(x => x.leg === leg) ?? null;
}

/** そのレッグの「向きの判定材料」(書式②/③のうち **文中で最初** のもの)。無ければ null。
 *  ★upper/lower(レンジ脚)は見出しで区別できないので必ず null=向きは判定しない。
 *   幅のほうにある `sole`(文中に申告が1つだけなら使う)相当の推定は **わざと入れていない**:
 *   向きを取り違えると台帳が嘘をつくので、曖昧なら「材料なし」に倒す。 */
function sideClaimFor(d: LcDeclarations, leg: LcLegName): LcSideClaim | null {
  if (leg !== 'limit' && leg !== 'stop') return null;
  return d.sideClaims.find(x => x.leg === leg) ?? null;
}

/** 損切りが建値の正しい側にあるか(買い=下・売り=上)。同値(幅0)は正しくない。
 *  ★scalpPlan.ts の stopSideOk と同じ規約。import しないのは scalpPlan がこのモジュールを import しており
 *   循環になるため(このファイルは依存ゼロの純関数群として保つ)。 */
function declaredSideOk(side: 'buy' | 'sell', entry: number, stopLoss: number): boolean {
  return side === 'buy' ? stopLoss < entry : stopLoss > entry;
}

/** レッグ群(AI が出した生の entry/stopLoss)と根拠文を突き合わせる(純関数・RECORD-ONLY)。
 *  ★status は3値。「一致(match)」と「読み取れなかった(undeclared)」を決して混ぜない。
 *  ★v0.9.83: 各レッグの `side`(buy/sell)を **任意で** 受け取る。渡されたときだけ根拠文が書いた
 *   損切りの **向き** を declaredSide に記録する(status には一切影響しない=幅と向きを混ぜない)。
 *   渡されなければ材料があっても 'sideUnknownDirection' と明示して残す(推測で埋めない)。 */
export function auditLcDeclarations(
  rationale: string | null | undefined,
  legs: ReadonlyArray<{ leg: LcLegName; entry?: number | null; stopLoss?: number | null; side?: 'buy' | 'sell' | null }>,
): LcDeclarationCheck[] {
  const d = parseLcDeclarations(rationale);
  const out: LcDeclarationCheck[] = [];
  for (const l of legs) {
    const entry = l.entry;
    const stopLoss = l.stopLoss;
    // 価格が揃っていないレッグ(AI がそもそも出していない)は突き合わせようがない=行を作らない。
    if (entry == null || stopLoss == null || !Number.isFinite(entry) || !Number.isFinite(stopLoss)) continue;
    const actualYen = Math.abs(entry - stopLoss);
    const dec = declaredWidthFor(d, l.leg);
    const row: LcDeclarationCheck = {
      leg: l.leg, entry, stopLoss, actualYen,
      declaredYen: dec ? dec.yen : null,
      status: dec ? (Math.abs(dec.yen - actualYen) < 1e-9 ? 'match' : 'mismatch') : 'undeclared',
    };
    if (dec) row.source = dec.source;
    const eq = equationFor(d, l.leg);
    if (eq) {
      row.declaredStopLoss = eq.b;
      row.equationSelfConsistent = eq.selfConsistent;
    }
    // ★向き(幅とは独立の観測)。材料が無ければキー自体を置かない=「一致」と読み違えられない。
    const claim = sideClaimFor(d, l.leg);
    if (claim) {
      row.declaredSideEntry = claim.entry;
      row.declaredSideStop = claim.stopLoss;
      row.declaredSideFrom = claim.from;
      row.declaredSide = l.side == null
        ? 'sideUnknownDirection'
        : (declaredSideOk(l.side, claim.entry, claim.stopLoss) ? 'sideOk' : 'sideReversed');
    }
    out.push(row);
  }
  return out;
}
