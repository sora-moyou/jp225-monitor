// core/keywordMatch.ts — 「キーワードが本文に出ているか」の唯一の判定器。
//
// ★なぜ独立したモジュールにしたか:
//   同じ判定を newsImpact.ts と newsConfidence.ts が **別々に持っていた**。
//   newsImpact 側だけ単語境界に直した結果、隣の newsConfidence.sourceTier は素の
//   `includes` のままで、'fed' が "Con**fed**eration of Industry" に当たっていた
//   (= 同じバグが 2 箇所にあり、片方だけ直っていた)。判定器を 1 つにして再発を断つ。
//
// ★判定の設計(ここが今回の肝) ────────────────────────────────────────────
//   旧: 「4文字以上の語は語尾 [a-z]{0,2} を許す」という **一律の規則**。
//       これは誤爆と取りこぼしを同時に生む。規則が「語形変化」ではなく
//       「長さ」を見ているので、意味の違う別語を必ず巻き込む:
//         trump  → trumped / trumpet     recruit → recruits / recruiter
//         gold   → golden                disco   → discord
//         sony   → Sonya
//       逆に語尾が 3 文字以上の正しい語形は取りこぼす:
//         terror → terrorism             inflation → inflationary
//         iran   → Iranian
//   新: **既定は完全一致(語境界)**。語形変化は EN_INFLECTIONS に
//       「そのキーワードに許す語尾」を **明示列挙** する。
//       ・長さではなく語彙ごとの事実を書くので、tariff→tariffs は拾い
//         trump→trumped は拾わない、という区別が正しく書ける。
//       ・語尾 3 文字以上(terror→terrorism)も書けるので取りこぼしも塞がる。
//       ・「新しいキーワードを足したら黙って複数形を落とす」危険は残るが、
//         誤爆(= 無関係な記事が最高重み帯に入る)より **落ちる方が安全** で、
//         かつ落ちたことは EN_INFLECTIONS を見れば説明できる(無言の失敗にならない)。
//
// ★大文字小文字: キーワードに大文字が 1 文字でも含まれていれば **原文に対して大小を区別** して
//   当てる。英語の代名詞 "us" と国名 "US" を分けるために要る(小文字化した面だけを見ると
//   "Join us for a live Q&A" が米国ニュース扱いになる = 実測した誤爆)。
//
// ★日本語(非ASCII)は語分割が無いので従来どおり部分一致。ただし「その語形の中では数えない」
//   除外文脈を JA_EXCLUSIONS に持てるようにした(南米/欧米/新米 の「米」など)。

/** 判定対象のテキスト。原文(大小を保つ)と小文字化した面の両方を持つ。 */
export interface MatchText {
  readonly raw: string;
  readonly lower: string;
}

/** 判定面を作る。複数の断片は空白で連結する(title + source など)。 */
export function matchText(...parts: readonly string[]): MatchText {
  const raw = parts.join(' ');
  return { raw, lower: raw.toLowerCase() };
}

/**
 * ASCII キーワードごとに許す語尾。**ここに書いていない語尾は当たらない**(既定=完全一致)。
 * ★所有格("Powell's")はアポストロフィが語境界になるので、ここに書かなくても当たる。
 */
export const EN_INFLECTIONS: Readonly<Record<string, readonly string[]>> = {
  // ── 政策・イベント(複数形・過去形が普通に使われるもの) ──
  // ★'ed' を落とすと "Goods were tariffed at 25%" が **関税(最高重み帯)を丸ごと失う**。
  //   関税はこの機能の中心語なので、動詞用法も必ず拾う。
  'tariff': ['s', 'ed'],
  'rate hike': ['s'],
  'rate cut': ['s'],
  'trade war': ['s'],
  'currency intervention': ['s'],
  'payroll': ['s'],
  // "sanctioned" は「承認した」の意味もあるが、金融ニュースでは制裁の意味が圧倒的。
  'sanction': ['s', 'ed'],
  'missile': ['s'],
  'ceasefire': ['s'],
  'selloff': ['s'],
  'crash': ['es', 'ed'],
  'plunge': ['s', 'd'],
  'surge': ['s', 'd'],
  'war': ['s'],
  'yield': ['s', 'ed'],   // 動詞用法 "Treasury yielded 4.5%"
  'american': ['s'],
  'prime minister': ['s'],
  // ── 国・地域の形容詞形。★旧規則(語尾2文字まで)では拾えなかった取りこぼし ──
  'russia': ['n', 'ns'],
  'iran': ['ian', 'ians'],
  'israel': ['i', 'is'],
  'gaza': ['n', 'ns'],
  'north korea': ['n', 'ns'],
  'ukrainian': ['s'],
  'terror': ['s', 'ism', 'ist', 'ists'],
  // ── 経済 ──
  'inflation': ['ary'],
  'economic': ['s', 'ally'],
  // "S&P500"(空白なし表記)。数字は語境界にならないので明示する。
  's&p': ['500'],
};

/**
 * 日本語ニードルの「除外文脈」。この語形の中に現れた出現は数えない。
 * ★日本語は語分割が無いので単語境界が使えない。代わりに **実際に踏む誤爆の語形だけ** を挙げる。
 */
export const JA_EXCLUSIONS: Readonly<Record<string, readonly string[]>> = {
  // 「米」= 米国 の意味でだけ使いたい。**米国を含まない**地域名と、穀物のコメを除く。
  //
  // ★「欧米」は意図的に除外しない(一度除外してから戻した)。
  //   欧米 = 欧州 **と米国** で、米国を含む。「欧米市場は総じて堅調」は米国市場の話でもあるので、
  //   米国重み(+2)が付くのが正しい。「地域名だから除く」と一括りにすると、
  //   含意まで一緒に捨ててしまう。
  // ★「南米 / 中南米」は除外する。こちらはラテンアメリカで **米国を含まない**
  //   (「南米の資源開発」に米国重みが乗るのは誤り)。
  //   つまり判断基準は「地域名かどうか」ではなく「その語が米国を含むか」。
  '米': ['南米', '中南米', '新米', '古米', '玄米', '白米', '精米', '米価', '米作', '米農', '米粉'],
  // 「ダウ」(NYダウ) が「ダウン」に当たる。dow→down の日本語版。
  'ダウ': ['ダウン'],
  // 「連邦」(米連邦) が「ロシア連邦」等に当たる。
  '連邦': ['ロシア連邦', 'ソ連邦', 'アラブ首長国連邦', 'ドイツ連邦', 'スイス連邦'],
  // 「高市」(首相) が「円高市況」の中に当たる。
  '高市': ['円高市', '株高市', '高市場'],
  // 「テロ」が「テロップ」に当たる。
  'テロ': ['テロップ'],
  // 「銅」が「銅メダル」に当たる。
  '銅': ['銅メダル'],
};

/**
 * ★数字だけのキーワード(銘柄コード)は「値段」と見分けが付かない。
 *   全キーワードを機械走査していて見つけた実害:
 *     「日経平均は6146円高」  → 6146 = ディスコ    → cat=個別株 +5
 *     「トヨタ株は4568円で引け」→ 4568 = 第一三共  → cat=個別株 +5
 *   日本株の株価は 4 桁が普通なので、これは珍しい見出しではない。
 *   コードとして書かれるとき(＜6146＞ / (6146) / 6146 東証)は直後に単位が来ないので、
 *   **数字の直後が数量の単位ならコードとみなさない** とするだけで分離できる。
 *
 * ★空白を跨がせないこと(直後だけを見る)。
 *   最初の実装は `\s*` を許していたが、単位に挙げた 月/日/人/社/件/台/時/分/年 は
 *   日本語で **語頭に来る頻度が高い** ため、ガードが過剰になって正しい用法を全滅させた:
 *     「6857 月次売上が好調」「9984 社債を発行」「6146 日足で三角持ち合い」
 *     「4568 年初来高値」「6098 人員採用を拡大」…(実測10件が MISS)
 *   単位は数字に **くっついて** 書かれるのが普通なので、直後だけを見る形にした。
 *
 * ★ただし副作用がある(受け入れたトレードであって、無害ではない)。
 *   空白を挟んだ値段は素通りする:
 *     「終値 9983 円」「日経平均 9983 円高で引け」「売上高 9983 億円に拡大」
 *     「およそ 9983 人が来場」…(全角空白・NBSP でも同じ)
 *   加えて、判定面は `title + ' ' + source` なので、タイトル末尾が裸の4桁で
 *   ソース名の先頭が単位文字のときも素通りする:
 *     「日経平均、終値は3万9983」+ ソース「日本経済新聞」/「時事通信」(頭の 日 / 時)
 *   `\s*` を許せばこれらは防げるが、上の10件(「6857 月次売上」等)が全滅する。
 *   **10件の正しい用法を守る方を選んだ。** 誤爆側の影響はニュースの点数とチップに
 *   閉じており、発火条件も「値段の下4桁が監視中のコードと一致」+「空白区切り」で狭い。
 *
 * ★既知の限界(潰していない・潰せていない書き方):
 *     「株価は6146」「日経平均は6146高」… 単位が付かない裸の4桁。
 *   これは直後だけを見ても区別できず、区別するには「株価は」等の **前方文脈** を読む必要がある。
 *   キーワード照合器の仕事の範囲を超える(前方の語を並べ始めると、今度はそちらが過剰になる)ので、
 *   ここでは踏み込まない。なお「6146の株価は上昇」は誤爆ではなく **正しい一致**
 *   (銘柄コードで銘柄を指す普通の書き方)。
 */
const NUMERIC_NEEDLE = /^\d{3,4}[a-z]?$/;
//  (?!\.\d) … 「6146.5円高」のように小数が続くのは値段。コードに小数は付かないので安全に切れる。
const NUMERIC_UNIT_GUARD =
  '(?!\\.\\d)(?!(?:円|銭|ドル|ユーロ|％|%|ポイント|pt|倍|億|万|兆|年|月|日|人|件|社|台|時|分))';

const NON_ASCII = /[^\x00-\x7F]/;
const RE_CACHE = new Map<string, RegExp>();

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function regexFor(needle: string): RegExp {
  let re = RE_CACHE.get(needle);
  if (!re) {
    const forms = EN_INFLECTIONS[needle] ?? [];
    const tail = forms.length > 0 ? `(?:${forms.map(escapeRe).join('|')})?` : '';
    // 大文字を含むニードルは原文(大小あり)に当てる = 大小を区別する。
    const caseSensitive = /[A-Z]/.test(needle);
    const cls = caseSensitive ? 'A-Za-z0-9' : 'a-z0-9';
    const guard = NUMERIC_NEEDLE.test(needle) ? NUMERIC_UNIT_GUARD : '';
    re = new RegExp(`(?<![${cls}])${escapeRe(needle)}${tail}(?![${cls}])${guard}`);
    RE_CACHE.set(needle, re);
  }
  return re;
}

const NUL = String.fromCharCode(0);

function japaneseHit(lower: string, needle: string): boolean {
  const ex = JA_EXCLUSIONS[needle];
  if (!ex || ex.length === 0) return lower.includes(needle);
  // 除外語形を NUL に置換してから探す(削除ではなく置換にするのは、
  // 前後が繋がって新しい一致が生まれるのを防ぐため)。
  let s = lower;
  for (const e of ex) if (s.includes(e)) s = s.split(e).join(NUL);
  return s.includes(needle);
}

/** キーワード 1 語が当たるか。text は matchText() で作る(文字列を渡した場合は原文=小文字扱い)。 */
export function needleHit(text: MatchText | string, needle: string): boolean {
  const t = typeof text === 'string' ? { raw: text, lower: text } : text;
  if (NON_ASCII.test(needle)) return japaneseHit(t.lower, needle);
  const caseSensitive = /[A-Z]/.test(needle);
  return regexFor(needle).test(caseSensitive ? t.raw : t.lower);
}

/** 最初に当たったキーワードを返す(当たらなければ null)。ラベルに使うので「どれが当たったか」を返す。 */
export function hitKeyword(text: MatchText | string, needles: readonly string[]): string | null {
  for (const n of needles) if (needleHit(text, n)) return n;
  return null;
}

/** そのニードルが受け入れる表層形をすべて列挙する(監査・テスト用)。 */
export function acceptedForms(needle: string): string[] {
  if (NON_ASCII.test(needle)) return [needle];
  return [needle, ...(EN_INFLECTIONS[needle] ?? []).map(s => needle + s)];
}
