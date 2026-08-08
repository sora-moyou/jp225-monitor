import { describe, it, expect } from 'vitest';
import type { NewsItem } from './types.js';
import {
  matchText, needleHit, hitKeyword, acceptedForms, EN_INFLECTIONS, JA_EXCLUSIONS,
} from './keywordMatch.js';
import {
  scoreNewsImpact, classifyNews,
  PERSON_WEIGHTS, EVENT_WEIGHTS, HEAVYWEIGHT_TIER1, HEAVYWEIGHT_TIER2,
  BREAKING_KEYWORDS, US_KEYWORDS, COMMODITY_KEYWORDS, GEOPOLITICS_KEYWORDS, ECONOMY_KEYWORDS,
} from './newsImpact.js';
import { PRIMARY_SOURCES, WIRE_SOURCES } from './newsConfidence.js';

const NOW = 1_800_000_000_000;
function n(title: string, lang: 'ja' | 'en' = 'en', source = lang === 'ja' ? 'Yahoo News' : 'Test'): NewsItem {
  return { id: `t:${title}`, title, source, lang, url: 'https://x/', publishedAt: NOW - 5 * 60_000 };
}
/** 「海外ソース(+3)」以外の加点が入っていない = 何も誤検知していない。 */
function noiseOnly(title: string, lang: 'ja' | 'en' = 'en'): number {
  return scoreNewsImpact(n(title, lang), NOW).contentScore;
}

/** 全キーワード表を 1 本にまとめる(機械走査の対象)。 */
const ALL_KEYWORDS: ReadonlyMap<string, string[]> = (() => {
  const groups: Array<[string, readonly string[]]> = [
    ['PERSON_WEIGHTS', PERSON_WEIGHTS.flatMap(([, w]) => w)],
    ['EVENT_WEIGHTS', EVENT_WEIGHTS.flatMap(([, w]) => w)],
    ['HEAVYWEIGHT_TIER1', HEAVYWEIGHT_TIER1],
    ['HEAVYWEIGHT_TIER2', HEAVYWEIGHT_TIER2],
    ['BREAKING_KEYWORDS', BREAKING_KEYWORDS],
    ['US_KEYWORDS', US_KEYWORDS],
    ['COMMODITY_KEYWORDS', COMMODITY_KEYWORDS],
    ['GEOPOLITICS_KEYWORDS', GEOPOLITICS_KEYWORDS],
    ['ECONOMY_KEYWORDS', ECONOMY_KEYWORDS],
    ['PRIMARY_SOURCES', PRIMARY_SOURCES],
    ['WIRE_SOURCES', WIRE_SOURCES],
  ];
  const m = new Map<string, string[]>();
  for (const [g, ws] of groups) for (const w of ws) m.set(w, [...(m.get(w) ?? []), g]);
  return m;
})();

describe('needleHit — 既定は完全一致(語尾は明示したものだけ)', () => {
  it('語境界の内側には当たらない(先頭・末尾とも)', () => {
    expect(needleHit(matchText('citing socialism'), 'ism')).toBe(false);
    expect(needleHit(matchText('ISM manufacturing'), 'ism')).toBe(true);
    expect(needleHit(matchText('a deep discount'), 'disco')).toBe(false);
    expect(needleHit(matchText('the company said'), 'ny')).toBe(false);
  });

  it('★宣言した語尾だけが当たる(trump は語尾を許さない)', () => {
    expect(acceptedForms('trump')).toEqual(['trump']);
    expect(needleHit(matchText('Value stocks trumped growth'), 'trump')).toBe(false);
    expect(needleHit(matchText('Trumpet maker Yamaha'), 'trump')).toBe(false);
    expect(needleHit(matchText('trump says'), 'trump')).toBe(true);
    // アポストロフィは語境界なので所有格は宣言なしで当たる。
    expect(needleHit(matchText("trump's tariffs"), 'trump')).toBe(true);
  });

  it('★宣言した語尾は 3 文字以上でも当たる(旧「語尾2文字まで」で取りこぼしていた形)', () => {
    expect(needleHit(matchText('terrorism fears'), 'terror')).toBe(true);
    expect(needleHit(matchText('inflationary pressure'), 'inflation')).toBe(true);
    expect(needleHit(matchText('iranian drones'), 'iran')).toBe(true);
    expect(needleHit(matchText('tariffs imposed'), 'tariff')).toBe(true);
  });

  it('★大文字を含むキーワードは大小を区別する(代名詞 us と国名 US)', () => {
    expect(needleHit(matchText('Join us for a live Q&A'), 'US')).toBe(false);
    expect(needleHit(matchText('US payrolls miss badly'), 'US')).toBe(true);
  });

  it('★日本語は部分一致だが、除外文脈の中では数えない', () => {
    expect(needleHit(matchText('南米の資源開発'), '米')).toBe(false);
    expect(needleHit(matchText('中南米市場に資金流入'), '米')).toBe(false);
    expect(needleHit(matchText('新米の作況指数'), '米')).toBe(false);
    // ★「欧米」は除外しない: 欧米 = 欧州と **米国** で米国を含む(判断基準は
    //   「地域名かどうか」ではなく「その語が米国を含むか」)。
    expect(needleHit(matchText('欧米の投資家'), '米')).toBe(true);
    expect(needleHit(matchText('米の追加関税'), '米')).toBe(true);
    expect(needleHit(matchText('南米と米の貿易'), '米')).toBe(true);   // 除外側だけを消す
    expect(needleHit(matchText('株価はダウンサイドリスク'), 'ダウ')).toBe(false);
    expect(needleHit(matchText('NYダウが最高値'), 'ダウ')).toBe(true);
    expect(needleHit(matchText('円高市況で輸出株が軟調'), '高市')).toBe(false);
    expect(needleHit(matchText('高市首相が会見'), '高市')).toBe(true);
  });

  // ★機械走査で見つけた実害(依頼の 19 件には無かったが同種の穴):
  //   日本株の株価は 4 桁が普通なので、銘柄コードと値段が見分けられていなかった。
  it('★数字だけのキーワード(銘柄コード)は値段に当たらない', () => {
    expect(needleHit(matchText('日経平均は6146円高'), '6146')).toBe(false);
    expect(needleHit(matchText('トヨタ株は4568円で引け'), '4568')).toBe(false);
    expect(needleHit(matchText('初値は9983円'), '9983')).toBe(false);
    expect(needleHit(matchText('日経平均は6146.5円高'), '6146')).toBe(false);   // 小数も値段
    // コードとして書かれている形は従来どおり拾う
    expect(needleHit(matchText('ディスコ<6146>が上昇'), '6146')).toBe(true);
    expect(needleHit(matchText('第一三共(4568)が上昇'), '4568')).toBe(true);
    expect(needleHit(matchText('6146 東証プライム'), '6146')).toBe(true);
  });

  // ★回帰(実際に壊した): 単位ガードに `\s*` を許したせいで、
  //   月/日/人/社/件/台/時/分/年 のように **日本語で語頭に来やすい** 語が
  //   空白を跨いでガードに掛かり、正しい用法が全滅していた。直後だけを見ること。
  it.each([
    ['6857', '6857 月次売上が好調'],
    ['9984', '9984 社債を発行'],
    ['6146', '6146 日足で三角持ち合い'],
    ['4568', '4568 年初来高値'],
    ['6098', '6098 人員採用を拡大'],
    ['8035', '8035 台の装置を出荷'],
    ['6971', '6971 件の受注'],
    ['6146', '6146 時価総額が拡大'],
    ['6857', '6857 分割を発表'],
    ['6146', '6146 円建てで調達'],
  ])('★銘柄コード %s は空白を挟んだ語には当たり続ける: "%s"', (code, title) => {
    expect(needleHit(matchText(title), code)).toBe(true);
  });

  it('hitKeyword は当たった語を返す(内訳ラベルに使うため)', () => {
    expect(hitKeyword(matchText('opec cuts output'), ['gold', 'opec'])).toBe('opec');
    expect(hitKeyword(matchText('nothing here'), ['gold', 'opec'])).toBeNull();
  });
});

// ★エバリュエーターが実測した誤爆コーパス。19 件すべてが「加点なし」に戻ること。
//   score ではなく contentScore で見るのは、鮮度減衰を挟まず「何点入ったか」を直接見るため。
describe('★誤爆コーパス(実測19件) — 加点もカテゴリも付かないこと', () => {
  it.each([
    ['Value stocks trumped growth in July', 'trump→trumped が最高重み帯(+12)に入っていた'],
    ['Trumpet maker Yamaha lifts guidance', 'trump→trumpet'],
    ['Toyota recruits 3,000 engineers for EV', 'recruit→recruits'],
    ['Top recruiter says hiring has cooled', 'recruit→recruiter'],
    ['Discord raises $500 million', 'disco→discord'],
    ['Golden Week travel spending hits record', 'gold→golden'],
    ['A golden opportunity for value investors', 'gold→golden'],
    ['Sonya Bell named CFO', 'sony→Sonya'],
    ['Here is what the housing slowdown means for us', '英語の代名詞 us'],
    ['Join us for a live Q&A on markets', '英語の代名詞 us'],
    // 旧実装で既に塞いだ分の回帰(再発していないこと)
    ['Maher says the party drifted further left, citing socialism', 'ism→socialism'],
    ['Nikkei futures drift down in thin trade', 'dow→down'],
    ['Retailer offers a deep discount on winter stock', 'disco→discount'],
    ['Investors move toward safer assets', 'war→toward'],
    ['The company reported quarterly results', 'ny→company'],
  ])('英語: "%s" (%s)', (title) => {
    expect(noiseOnly(title)).toBe(3);            // 海外ソース +3 のみ
    expect(classifyNews(n(title))).toBeNull();
  });

  it.each([
    ['南米の資源開発に日本企業が参画'],
    ['中南米市場に資金流入'],
    ['新米の作況指数は平年並み'],
  ])('日本語: "%s" の「米」は米国扱いにしない', (title) => {
    const s = scoreNewsImpact(n(title, 'ja'), NOW);
    expect(s.reasons.some(r => r.label.startsWith('米国関連'))).toBe(false);
  });

  // ★「欧米」は当初エバリュエーターの推奨で除外したが、再検証の指摘を受けて **戻した**。
  //   欧米は米国を含むので、米国重みが付くのが正しい(理由はコード側のコメント参照)。
  it.each([
    ['欧米市場は総じて堅調'],
    ['欧米の投資家が慎重姿勢'],
  ])('日本語: "%s" の「欧米」は米国扱いにする(米国を含むため)', (title) => {
    const s = scoreNewsImpact(n(title, 'ja'), NOW);
    expect(s.reasons.some(r => r.label.startsWith('米国関連'))).toBe(true);
  });

  // ★正直な但し書き: この 1 件だけは加点が残る。ただし残るのは recruit ではなく
  //   **見出しに実在する単語 "Fed"** による加点で、これは正しい一致(誤爆ではない)。
  it('"How the Fed recruited its next generation" は recruit では加点されない(Fed のみ)', () => {
    const s = scoreNewsImpact(n('How the Fed recruited its next generation'), NOW);
    expect(s.reasons.some(r => r.label.includes('値がさ株'))).toBe(false);   // 旧: 個別株に誤分類
    expect(s.reasons.find(r => r.label.startsWith('要人・機関'))?.label).toBe('要人・機関: fed');
    expect(classifyNews(n('How the Fed recruited its next generation'))).toBe('economy');
  });
});

// ★誤爆だけ潰して取りこぼしを放置すると片手落ちになる。反対側も測る。
describe('★取りこぼしコーパス — 正しい語形は拾えること', () => {
  it.each([
    ['Iranian drones strike a tanker', 'geopolitics'],
    ['Ukrainian forces advance near Kharkiv', 'geopolitics'],
    ['Terrorism fears grip European markets', 'geopolitics'],
    ['Inflationary pressure builds again', 'economy'],
    ['US economic outlook darkens', 'economy'],
    ['Commodities rally as the dollar slips', 'commodity'],
  ])('"%s" → cat=%s (旧実装は score だけ付いて cat=null だった)', (title, cat) => {
    expect(classifyNews(n(title))).toBe(cat);
  });

  it.each([
    ["Canada offers concessions to avoid Trump's 50% tariffs", 20],
    ['New sanctions imposed on Russian banks', 8],
    ['US sanctioned two more banks', 8],
    ['US payrolls miss badly', 10],
    ['North Korean missiles land in the sea', 8],
    ['Oil prices surge on OPEC cut', 8],
    ['ISM manufacturing PMI beats', 8],
  ])('"%s" は少なくとも %i 点入る(語形変化で落とさない)', (title, min) => {
    expect(noiseOnly(title)).toBeGreaterThanOrEqual(min + 3);
  });

  // 'war' は加点表ではなくカテゴリ表にしかない語(複数形は旧実装では当たらなかった)。
  it('複数形 "wars" も地政学に分類される', () => {
    expect(classifyNews(n('Wars and rumors of wars unsettle markets'))).toBe('geopolitics');
  });
});

// ★「推奨された 4 語を直す」で終わらせず、全キーワードを機械走査する。
describe('★全キーワードの機械走査(同種の穴が残っていないこと)', () => {
  const ASCII = [...ALL_KEYWORDS.keys()].filter(w => !/[^\x00-\x7F]/.test(w));
  // 実データの誤爆を生んだ変形(ed/s/er/et/ord/unt/en/a …)を含む、機械的な語尾・接頭辞。
  const SUFFIXES = ['ed', 's', 'es', 'er', 'ers', 'ing', 'et', 'y', 'ly', 'a', 'an', 'en', 'd',
    'ment', 'ism', 'ist', 'ion', 'ary', 'ic', 'ord', 'unt', 'ket', 'n', 'i', 'ish', 'ings', 'or', 'al'];
  const PREFIXES = ['un', 'de', 're', 'con', 'pre', 'anti', 'social', 'to', 'com', 'b', 'mo', 'a'];

  it(`ASCII キーワード全件 × 変形で、宣言していない形には当たらない`, () => {
    const bad: string[] = [];
    for (const w of ASCII) {
      const ok = new Set(acceptedForms(w).map(s => s.toLowerCase()));
      for (const suf of SUFFIXES) {
        const form = w + suf;
        if (ok.has(form.toLowerCase())) continue;
        if (needleHit(matchText(`headline ${form} today`), w)) bad.push(`${w} -> ${form}`);
      }
      for (const pre of PREFIXES) {
        if (needleHit(matchText(`headline ${pre + w} today`), w)) bad.push(`${w} -> ${pre + w}`);
      }
    }
    expect(bad).toEqual([]);
    expect(ASCII.length * (SUFFIXES.length + PREFIXES.length)).toBeGreaterThan(5000);   // 走査量の担保
  });

  it('EN_INFLECTIONS / JA_EXCLUSIONS に死んだエントリが無い(表の腐敗を検知)', () => {
    expect(Object.keys(EN_INFLECTIONS).filter(k => !ALL_KEYWORDS.has(k))).toEqual([]);
    expect(Object.keys(JA_EXCLUSIONS).filter(k => !ALL_KEYWORDS.has(k))).toEqual([]);
  });

  // ★これはほぼ恒真(エスケープ事故しか捕まえない)。本命は下の「レビュー台帳」。
  it('宣言した語尾は必ずそのキーワード自身に当たる(表と実装の食い違いを検知)', () => {
    for (const [w, forms] of Object.entries(EN_INFLECTIONS)) {
      for (const f of forms) {
        expect(needleHit(matchText(`x ${w}${f} y`), w), `${w}+${f}`).toBe(true);
      }
    }
  });
});

// ★「新語を足すと複数形が黙って落ちる」を **loud failure に変える** ための台帳。
//
//   既定を完全一致にした代償は、新しいキーワードを足した人が EN_INFLECTIONS を
//   書き忘れると、その語の複数形・過去形が **無言で** 落ちること。
//   実際、この設計に切り替えた最初の版で tariff→tariffed / yield→yielded を落としていた
//   (tariff は関税=この機能の中心語で、最高重み帯を丸ごと失っていた)。
//
//   そこで「語尾を落としうる形をした語」= 単一の小文字英単語で 4 文字以上 を候補として抽出し、
//   **EN_INFLECTIONS に書くか、この台帳に載せるかの二択** を強制する。
//   新しいキーワードを足すとこのテストが落ちるので、必ずどちらかを選ぶことになる。
//   (数字コード・3文字以下の略号・複合語・記号入りは、語尾変化を持ちようがないので候補外)
describe('★語形変化のレビュー台帳(語尾を黙って落とさないための歯止め)', () => {
  // 完全一致のままでよいと **確認済み** の語。分類の理由を種別ごとに並べる。
  const EXACT_BY_DESIGN: readonly string[] = [
    // ── 固有名詞(人名・企業名・ブランド)。語尾変化しない ──
    'advantest', 'bessent', 'chugai', 'daikin', 'fanuc', 'fujitsu', 'greer', 'hassett',
    'keyence', 'kioxia', 'kyocera', 'lagarde', 'lasertec', 'lutnick', 'murata', 'nintendo',
    'powell', 'rubio', 'terumo', 'ueda', 'uniqlo', 'vance', 'waller', 'washington',
    'williams', 'yellen', 'ukraine',
    // ── 略号・固有の指数名・媒体名 ──
    'cnbc', 'fomc', 'kddi', 'marketwatch', 'nasdaq', 'opec', 'reuters', 'nonfarm',
    // ── ★語尾を許すと別語になるので **意図的に** 完全一致(今回の修正の本体) ──
    //    trump→trumped/trumpet, gold→golden, disco→discord, sony→Sonya, recruit→recruiter
    'trump', 'gold', 'disco', 'sony', 'recruit',
    // ── 語尾変化を suffix では作れない語(別語として表に持っている) ──
    //    economy→economic / commodity→commodities は別エントリで拾う
    'economy', 'commodity', 'commodities',
    // ── 不可算・銘柄名の物質名。市況記事で複数形にならない ──
    'crude', 'copper', 'silver', 'brent',
    // ── 既に -ing 形。'breakings' は存在しない ──
    'breaking',
  ];

  const ASCII_WORDS = [...ALL_KEYWORDS.keys()]
    .filter(w => /^[a-z]+$/.test(w) && w.length >= 4);

  it('4文字以上の英単語キーワードは、語尾を宣言するか台帳に載せるかのどちらか', () => {
    const unclassified = ASCII_WORDS
      .filter(w => !(w in EN_INFLECTIONS) && !EXACT_BY_DESIGN.includes(w)).sort();
    expect(unclassified, '★このキーワードは語形変化のレビューがされていない。'
      + 'EN_INFLECTIONS に語尾を書くか、完全一致でよい理由を確認して EXACT_BY_DESIGN に足すこと')
      .toEqual([]);
  });

  it('台帳に死んだエントリが無い(表から消えた語が居座らない)', () => {
    expect(EXACT_BY_DESIGN.filter(w => !ALL_KEYWORDS.has(w))).toEqual([]);
    expect(EXACT_BY_DESIGN.filter(w => w in EN_INFLECTIONS)).toEqual([]);   // 二重分類も検知
  });

  // ★動詞は過去形を落とすと痛い(tariffed を落として最高重み帯を失った実例)。
  it('動詞として使われるキーワードは過去形を拾う', () => {
    for (const [base, past] of [['tariff', 'tariffed'], ['yield', 'yielded'],
      ['sanction', 'sanctioned'], ['crash', 'crashed'], ['plunge', 'plunged'], ['surge', 'surged']]) {
      expect(needleHit(matchText(`markets ${past} today`), base!), past).toBe(true);
    }
  });
});

// ★旧実装(語尾2文字まで一律許可)との機械比較を、結論だけ固定したもの。
//   比較は 旧ASCII 148語 × 全1〜2文字語尾703形 = 104,044 件で実施し、
//   「旧で拾えて新で落ちる」形のうち **実在する英語の語形** を手で洗い出した結果が下の 2 表。
//   ・HIT 表 = 旧が拾えていた正しい語形。**1つも落としてはいけない**(tariffed/yielded の回帰はここ)。
//   ・MISS 表 = 旧が拾っていたが **拾ってはいけなかった** 形。新実装が意図的に落とす。
describe('★旧実装との機械比較の結論(実在する語形を落としていないこと)', () => {
  it.each([
    ['tariff', 'tariffs'], ['tariff', 'tariffed'],
    ['sanction', 'sanctions'], ['sanction', 'sanctioned'],
    ['missile', 'missiles'], ['payroll', 'payrolls'], ['ceasefire', 'ceasefires'],
    ['selloff', 'selloffs'], ['crash', 'crashes'], ['crash', 'crashed'],
    ['plunge', 'plunges'], ['plunge', 'plunged'], ['surge', 'surges'], ['surge', 'surged'],
    ['russia', 'russian'], ['russia', 'russians'], ['israel', 'israeli'], ['israel', 'israelis'],
    ['iran', 'iranian'], ['iran', 'iranians'], ['gaza', 'gazan'], ['north korea', 'north korean'],
    ['american', 'americans'], ['rate hike', 'rate hikes'], ['rate cut', 'rate cuts'],
    ['trade war', 'trade wars'], ['currency intervention', 'currency interventions'],
    ['prime minister', 'prime ministers'], ['yield', 'yields'], ['yield', 'yielded'],
    ['terror', 'terrorism'], ['terror', 'terrorist'], ['terror', 'terrorists'],
    ['inflation', 'inflationary'], ['economic', 'economics'], ['economic', 'economically'],
    ['ukrainian', 'ukrainians'], ['war', 'wars'], ['s&p', 's&p500'],
  ])('HIT: %s は "%s" を拾う', (base, form) => {
    expect(needleHit(matchText(`markets ${form} today`), base)).toBe(true);
  });

  it.each([
    // 旧が拾っていたが誤爆だった形(今回の修正の本体)
    ['trump', 'trumped'], ['trump', 'trumps'], ['trump', 'trumpet'],
    ['gold', 'golden'], ['disco', 'discos'], ['sony', 'sonya'],
    ['recruit', 'recruits'], ['recruit', 'recruited'], ['recruit', 'recruiter'],
    // 旧が拾っていたが、語としては当たるべきでなかった形
    ['crude', 'crudely'],      // "crudely put" は原油の話ではない
    ['plunge', 'plunger'],     // 工具
    ['copper', 'coppers'], ['silver', 'silvery'], ['gold', 'golds'],
  ])('MISS: %s は "%s" を拾わない(旧は拾っていた)', (base, form) => {
    expect(needleHit(matchText(`markets ${form} today`), base)).toBe(false);
  });
});
