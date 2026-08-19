// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  pass6a: 位置指定の質問を **構造化出力(JSON)** に載せ替える契約
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ 語彙は本番に寄せる(本番ファイルは1バイトも変更していない。読んで写しただけ)
//   本番 server/llm/scalpPlan.ts の scalpJsonInstruction は、レンジ両面のとき **まさにこの形** を使う:
//       "range": {
//         "upper": { "side": "buy"|"sell", "type": "limit"|"stop", "entry": number, "lcWidth": number },
//         "lower": { ... }
//       }
//   位置(上/下)で1レッグずつ求める今回の質問文と構造が一致するので、**同じフィールド名**を使う。
//   本番へ移すときの差分は「upper/lower を range の下に置くか直下に置くか」だけになる。
//
// ■ 本番と **意図的に違える** ところ(ここが pass6a の測定対象)
//   本番の JSON には **レッグごとの理由フィールドが無い**。全体の rationale 1本と strategyWhy 1行だけ。
//   実測ではその rationale が LC幅の検算に埋め尽くされ、理由が 0字 になっていた。
//   → ここでは **各レッグに why を、全体に biasWhy を** 持たせ、「箱を分ければ理由が生き残るか」を測る。
//
// ■ SL は幅と価格の両方を求める
//   本番は lcWidth(幅)だけで、向きはコードが付ける(向きの取り違えが原理的に起きない設計)。
//   ここでは lcWidth に加えて slPrice も求め、**AI 自身の幅と価格が一致するか** を測る
//   (一致しないなら、価格を出させる設計は危ういという証拠になる)。

/** 本番の scalpJsonInstruction の書き出しと同じ文言(語彙を揃えるため)。 */
const HEAD = '最終的な回答は、次のスキーマに厳密に一致する JSON オブジェクトのみを出力してください'
  + '(前後の説明文・コードフェンス・マークダウンは一切付けない)。';

/** 上下1レッグずつの JSON 契約。★質問文の本体には手を触れず、これを後ろに足すだけ。 */
export function positionJsonContract(): string {
  const leg = (name: string, note: string): string =>
    `  "${name}": {                 // ${note}\n`
    + '    "side": "buy" | "sell",    // 売買\n'
    + '    "type": "limit" | "stop",  // limit=指値注文 / stop=逆指値注文\n'
    + '    "entry": number,           // エントリー価格\n'
    + '    "lcWidth": number,         // 損切りの幅[円](正の数)\n'
    + '    "slPrice": number,         // 損切りの価格\n'
    + '    "why": string              // この価格にした説明(日本語)\n'
    + '  }';
  return HEAD + '\n'
    + '{\n'
    + '  "bias": "buy" | "sell" | "range",  // 今の相場の目線\n'
    + '  "biasWhy": string,           // なぜその目線なのか(日本語)\n'
    + leg('upper', '現在値より上の価格の1レッグ') + ',\n'
    + leg('lower', '現在値より下の価格の1レッグ') + '\n'
    + '}\n'
    + '数値はすべて円単位の実数(引用符なし)。';
}

/** ★pass6a2: 理由が痩せた原因の仮説「箱が1つに潰れた」を1点だけ変えて試す版。
 *
 *  ■ 何を変えたか(1つだけ)
 *    why(1フィールド) → entryWhy / slWhy(2フィールド)。**それ以外は pass6a と同一**
 *    (質問文の本体・他のフィールド名・順序・型・コメントの文体は変えない)。
 *
 *  ■ なぜそこを疑ったか(推測ではなく散文の構造の実測)
 *    散文(pass4)は 1レッグにつき必ず **2つ** の説明を書いていた:
 *        ・エントリー根拠(なぜその価格に置くか)
 *        ・SL根拠(なぜその位置で切るか)
 *    pass6a の JSON はそれを why 1本に潰していた。1レッグの説明が 211字 → 59字(-72%)に
 *    痩せたのは **箱を1つ減らしたから** ではないか、という仮説。
 *    このプロジェクトの既知の知見(1つの箱に2つの仕事を入れると片方が押し出される)と同じ形。 */
export function positionJsonContractSplit(): string {
  const leg = (name: string, note: string): string =>
    `  "${name}": {                 // ${note}\n`
    + '    "side": "buy" | "sell",    // 売買\n'
    + '    "type": "limit" | "stop",  // limit=指値注文 / stop=逆指値注文\n'
    + '    "entry": number,           // エントリー価格\n'
    + '    "lcWidth": number,         // 損切りの幅[円](正の数)\n'
    + '    "slPrice": number,         // 損切りの価格\n'
    + '    "entryWhy": string,        // なぜエントリーをその価格に置いたのか(日本語)\n'
    + '    "slWhy": string            // なぜ損切りをその価格に置いたのか(日本語)\n'
    + '  }';
  return HEAD + '\n'
    + '{\n'
    + '  "bias": "buy" | "sell" | "range",  // 今の相場の目線\n'
    + '  "biasWhy": string,           // なぜその目線なのか(日本語)\n'
    + leg('upper', '現在値より上の価格の1レッグ') + ',\n'
    + leg('lower', '現在値より下の価格の1レッグ') + '\n'
    + '}\n'
    + '数値はすべて円単位の実数(引用符なし)。';
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
//  pass7: 本番に実装された契約文で測る —「(1行・日本語)」が長さのアンカーになっていないか
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// ■ 何を写したか(本番 server/llm/scalpPlan.ts の scalpJsonInstruction を **読んで** 写した。書いてはいない)
//   ・フィールド名と並び順、各行のコメント文言を本番のまま
//   ・5つの理由フィールド: directionWhy / entryWhyForLimit / entryWhyForStop / lcWhyForLimit / lcWhyForStop
//   ・rationale の「LC検算(引き算)を必ず含める」要求も **そのまま**(検算が rationale に残るかを測るため)
//   ・lcNote(正の数の幅・LC幅55〜65円・…)も本番の既定値のまま
//
// ■ 本番から **落とした** もの(落とした理由を書く。黙って落とさない)
//   regime / confidence / strategy / strategyWhy / limitLevel / stopLevel と、レンジ両面の range ブロック。
//   strategy を入れると **戦略ラベル7語の一覧** が復活し、動かす変数が増える(この案件で既に測り終えた軸)。
//   limitLevel/stopLevel は「使った節目の価格」で、今回のデータは節目なしなので宛先が無い。
//   ★よって「箱の数=5」は **理由の箱が5つ** という意味であって、本番の全フィールド数ではない。
//
// ■ pass7a と pass7b の違いは **4文字だけ**
//   5つの理由フィールドの `(1行・日本語)` → `(日本語)`。それ以外は1文字も変えない。

/** 本番の lcNote(既定値 55/65 のときの文言)。 */
const LC_NOTE = '正の数の幅[円]・LC幅55〜65円・55円未満は不可・レッグ独立で65円超は出さない'
  + '・エントリーからの固定距離(建値の隣のティック等)で決めない';

/** 本番同型の契約。oneLine=false のときだけ 5つの理由フィールドから「1行・」を落とす。 */
export function productionLikeContract(refPrice: number, oneLine: boolean): string {
  const w = oneLine ? '(1行・日本語)' : '(日本語)';
  return HEAD + '\n'
    + '{\n'
    + '  "direction": "buy" | "sell" | "none",  // none=見送り(良い場面が無い)。none の時は下の4フィールドは不要(rationale と refPrice のみ)\n'
    + `  "directionWhy": string,      // なぜその direction にしたか${w}\n`
    + '  "limitEntry": number,        // 指値(押し目/戻り側の新規)。none または指値レッグ不採用(ブレイク新規のみ)の時は省略(lcWidthForLimit と対で省く)\n'
    + `  "entryWhyForLimit": string,  // なぜ limitEntry をその価格にしたか${w}。limitEntry と対で省略\n`
    + '  "stopEntry": number,         // ブレイク新規(ブレイク側の新規エントリー。損切りではない)。none またはブレイク新規レッグ不採用(指値のみ)の時は省略(lcWidthForStop と対で省く)\n'
    + `  "entryWhyForStop": string,   // なぜ stopEntry をその価格にしたか${w}。stopEntry と対で省略\n`
    + `  "lcWidthForLimit": number,   // 指値約定時の損切りの幅(${LC_NOTE})。指値レッグを出さない/none の時は limitEntry と対で省略\n`
    + `  "lcWhyForLimit": string,     // なぜ lcWidthForLimit をその幅にしたか${w}。lcWidthForLimit と対で省略\n`
    + `  "lcWidthForStop": number,    // ブレイク新規約定時の損切りの幅(${LC_NOTE})。ブレイク新規レッグを出さない/none の時は stopEntry と対で省略\n`
    + `  "lcWhyForStop": string,      // なぜ lcWidthForStop をその幅にしたか${w}。lcWidthForStop と対で省略\n`
    + '  "rationale": string,         // 判断理由(日本語)。none の時は見送り理由。'
    + '★出したレッグごとに、幅を出した引き算(例「指値レッグ (エントリー価格)と(損切りの位置)の引き算 → LC幅は(幅)円」)を必ず含め、'
    + 'その答えを上の lcWidthFor… と一致させる。★「省略」と述べたレッグは そのキー自体を出力しない\n'
    + `  "refPrice": number           // 計画時に見た現在値(${refPrice})\n`
    + '}\n'
    + `refPrice は ${refPrice} を使うこと。数値はすべて円単位の実数(引用符なし)。`;
}
