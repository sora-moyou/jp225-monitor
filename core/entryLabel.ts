// core/entryLabel.ts — **エントリー脚(指値/逆指値)の位置の規約の唯一の権威**(monitor 内)。
//
// ■ 規約(1行で)
//     指値(limit)は現在値の **手前** に置く(買い=下 / 売り=上)。
//     逆指値(stop)は現在値の **向こう** に置く(買い=上 / 売り=下)。
//     境界(entry === refPrice = 距離0)は **不正**(=置いた瞬間に約定する。指値でも逆指値でもない)。
//
// ■ このファイルが在る理由
//   この規約は既に `server/llm/scalpPlan.ts` の `entrySideOk` として実装され、parse/enforce の
//   レッグ落とし判定に使われていた(= **実在の権威**)。同じ規約を2つ持つのは `core/stopGeometry.ts` が
//   集約したのと同じ形の事故の芽なので、**実体をこちらへ移し、scalpPlan.ts は再輸出にした**
//   (複製ではなく import)。server も web も同じ1つの関数を見る。
//
// ■ このファイルの制約
//   ★**依存ゼロの葉モジュールであること**(何も import しない)。web(signalPanel)からも
//     server(scalpPlan)からも引く。core/stopGeometry.ts と同じ流儀。
//   ★ゆえに **トレンドの向きは引数で受け取る**(core から server/signalTrade/regime.ts を import しない)。
//
// ■ ★順張り/逆張りの決め方(2026-08-19 の裁定。**以前の版は誤っていた**)
//   初版は「指値=逆張り / 逆指値=順張り」と **脚の種別から** 決めていた。これは誤りだった:
//   押し目買いは古典的にも順張りであり、プロンプト側のラベル定義
//   (`server/llm/scalpPlan.ts` の SCALP_STRATEGY_LABEL_DEFS「トレンド押し目・戻り … **順張りで**、
//   節目まで引きつけて入る」)とも画面上で正面から矛盾していた(実際に同じパネルの上下2行に
//   「買い目線・トレンド押し目・戻り」と「指値 押し目買い・逆張り」が並んでいた)。
//
//   真因は **2つの別の軸を1つに潰していたこと**。分けると矛盾は消える:
//
//     ┌ 脚の型(執行の形) … `direction × kind` で決まる … 押し目買い / 戻り売り / ブレイク新規
//     └ 順張り/逆張り(相場観) … **トレンドの向き × 売買の向き** で決まる
//
//       上昇トレンド + 買い → 順張り(押し目買いもブレイク買いも順張り)
//       上昇トレンド + 売り → 逆張り
//       下降トレンド + 売り → 順張り / 下降トレンド + 買い → 逆張り
//       トレンドが無い・横這い・判定不能 → ★**どちらでもない。語を出さない**
//
//   ★最後の1行がこのファイルの要。「分からないものを断定しない」がこのプロジェクトの規範なので、
//     トレンドが取れない回は stance を undefined にし、text にも語を足さない(無理に付けない)。
//
// ■ text の語彙の出所(★新しい語を1つも作っていない)
//     「押し目買い」「戻り売り」 … server/alertEngine.ts:87(グランビル注記)→ web/main.ts:500 で画面に出る
//     「ブレイク新規」    … web/components/signalPanel.ts / server/llm/scalpPlan.ts:996(逆指値レッグの呼び名)
//     「順張り」「逆張り」 … server/llm/scalpPlan.ts:1236「ブレイク順張り」/ :1237「節目の逆張り」
//     区切りの「・」      … web/components/signalPanel.ts の withStrategyLabel(ドテン表示と同じ文字)
//
// ■ text に「買い/売り」を入れなかった判断
//   指値側は「押し目買い」「戻り売り」の語そのものが向きを含むので足す必要が無い。
//   逆指値側(ブレイク新規)は向きを含まないが、画面のメイン行が既に
//   「買い 68,780 逆指値 (LC …)」と向きを出しており、同じ枠の中でもう一度書くのは重複。
//   → **向きは side フィールドで持ち、text には入れない**(表示側が必要なら足せる)。

/** 脚の種別。limit=指値(引きつけ) / stop=逆指値(ブレイク新規)。 */
export type EntryKind = 'limit' | 'stop';

/** トレンドの向き(★引数で受け取る=core は server に依存しない)。
 *  `server/signalTrade/regime.ts` の `Regime.trendDir` をそのまま渡せる形にしてある:
 *  'up' | 'down' が **断定** で、'flat'(横這い)/'conflict'(短期と長期が逆)/'stale'(材料が古い)は
 *  **どれも「どちらとも言えない」** = 順張り/逆張りを決めない。undefined(材料なし)も同じ扱い。 */
export type EntryTrendDir = 'up' | 'down' | 'flat' | 'conflict' | 'stale';

/** 脚1本のラベル。 */
export type EntryLabel = {
  /** 売買の向き(direction そのもの)。 */
  side: 'buy' | 'sell';
  /** ★相場観。trend=順張り / counter=逆張り。**トレンドが断定できない回は undefined**(語を出さない)。 */
  stance?: 'trend' | 'counter';
  /** その脚が現在値より **上** に置かれるか(買い逆指値 / 売り指値 が true)。 */
  above: boolean;
  /** 画面に出す日本語。stance が決まらない回は脚の型の語だけ(「押し目買い」等)。 */
  text: string;
};

/** 脚の型(執行の形)の語。★`direction × kind` だけで決まり、トレンドには依存しない。 */
const KIND_TEXT: Record<'buy' | 'sell', Record<EntryKind, string>> = {
  buy:  { limit: '押し目買い', stop: 'ブレイク新規' },
  sell: { limit: '戻り売り',   stop: 'ブレイク新規' },
};

/** 相場観の語。★出所は SCALP_STRATEGY_LABELS(「ブレイク順張り」「節目の逆張り」)。 */
const STANCE_TEXT: Record<'trend' | 'counter', string> = { trend: '順張り', counter: '逆張り' };

/** ★順張り/逆張りを「トレンドの向き × 売買の向き」で決める(純関数)。
 *  トレンドが断定できない('flat'/'conflict'/'stale'/未指定)なら **undefined**(決めない)。
 *
 *  ■ ★語が出る率の実測
 *    ★出所は **すべて同じ**: 実運用ホストの足(`Documents/trade/prices_kabu.db` の複製・
 *      195,609本・〜2026-08-18)に computeRegime を実際に回したもの。
 *      ※以前ここには開発機の足(7/31 で切れていた)由来の数字が混ざっていた。**出所を混ぜないこと**。
 *
 *      ★**ARM 時刻(実シグナル・A系) 45.8%**(n=561・95%CI 41.7〜49.9%)
 *      (先行して測った n=28 の 46.4%[CI 28〜65%]から標本を20倍にしたもの。結論は動かなかった)
 *    ⇒ **画面に出る瞬間ではおよそ半分**。裏を返すと **半分の回は語が出ない**(ARM 時刻の未確定 54.2%=過半)。
 *    ⇒ ★これが「稀な縮退」ではなく **標準的な見え方** なので、語が出ない回には
 *      **なぜ出ないのかを1語** 添える(下の entryStanceUnknownReason)。無言にしない。
 *    内訳: 出ない理由の圧倒的多数は flat 62.5% / conflict 1.4% / stale 0.83%
 *      (★stale は 17時台に100%集中・日中 0.0% = ナイトの寄り付きギャップ判定という設計どおり)。
 *
 *  ■ ★この率は **閾値に従属する**(重要な留保)
 *    scalpTrendVetoYen を 50 ↔ 200 に動かすと 全時刻で 55.5% ↔ 15.8% と **3倍以上** 変わる。
 *    ★**ARM 時刻ではもっと効く**: 50円 69.6% / 100円(既定) 51.4% / 150円 31.6% / 200円 21.3%。
 *      = 設定を1つ変えるだけで、画面に語が出る回が 7割 にも 2割 にもなる。
 *    ★その閾値は **veto(取引を止めるか)のために選ばれた値** で、表示ラベルのために選ばれていない。
 *    = ここで出る「順張り/逆張り」の頻度は、表示の都合とは無関係な設定に握られている。
 *
 *  ■ ★日ごとのばらつきが大きい: 標準偏差 16.8pt・最小の日 **0.0%**・最大 79.3%。
 *    「一日中まったく語が出ない日」が実在するので、ユーザーが「表示が壊れた」と誤解しうる。
 *    出ない理由の1語は、その誤解を防ぐためのものでもある。
 *
 *  ■ ★目線行の strategy ラベルを落とす機構は「ほとんど発火しない安全側」になっている(実測・A系)
 *    最初の実装は trendDir を見ずに落としていたため、**44%の回で情報を消していた**のに、
 *    その機構が実際に矛盾を防いだ回は ★**0件**(全件でも 代償24件 対 便益1件 = 24倍の持ち出し)。
 *    ⇒ 現在の条件(stance が確定している回だけ落とす)は、その 44% を画面へ返したうえで、
 *      矛盾が起きうる場面だけに効く。**発火しないのが正常** で、頻繁に発火し始めたら
 *      それは「AI の自己申告とコードの測定が食い違い始めた」という観測結果として読む。 */
export function entryStance(
  direction: 'buy' | 'sell', trendDir?: EntryTrendDir,
): 'trend' | 'counter' | undefined {
  if (trendDir !== 'up' && trendDir !== 'down') return undefined;
  const withTrend = trendDir === 'up' ? direction === 'buy' : direction === 'sell';
  return withTrend ? 'trend' : 'counter';
}

/** 順張り/逆張りが決まらなかったときの **理由の語**(★新しい語彙を作らない)。
 *  出所はすべて server/signalTrade/regime.ts の formatMomentumLine(=AI に見せている勢いの行と同じ語):
 *    'flat'     → 「横ばい」                 … regime.ts:227(label の既定枝)
 *    'conflict' → 「方向不一致」             … regime.ts:220/222(conflictKind と conflictLabel の dir='flat' 枝)
 *    'stale'    → 「判定保留(寄り付きギャップ)」… regime.ts:226
 *  ★conflict について: 画面の勢いの行は本来「戻り(長期は下降)」「押し目(長期は上昇)」と書き分けるが、
 *    その書き分けには dir / longDir が要る。ここに来るのは trendDir だけなので、
 *    **書き分けられない分は言い過ぎない**(同じ関数が dir='flat' のときに使う「方向不一致」を採る)。 */
const STANCE_UNKNOWN_REASON: Partial<Record<EntryTrendDir, string>> = {
  flat: '横ばい',
  conflict: '方向不一致',
  stale: '判定保留(寄り付きギャップ)',
};

/** ★順張り/逆張りが出ない回の「なぜ出ないか」を1語で返す(純関数)。決まっている回は undefined。
 *  ★trendDir が **欠落** している回も undefined を返す(語を作らない)。そこは
 *    「トレンドが判定できなかった」ではなく **「トレンドの情報がそもそも届いていない」**(旧版の server /
 *    凍結再生の標本)で、formatMomentumLine に対応する語が無い。表示側は注記ごと出さない
 *    = 旧い記録では従来と byte 一致になる(理由の箱の規約①と同じ)。 */
export function entryStanceUnknownReason(trendDir?: EntryTrendDir): string | undefined {
  if (trendDir === 'up' || trendDir === 'down') return undefined;
  return trendDir === undefined ? undefined : STANCE_UNKNOWN_REASON[trendDir];
}

/** 脚のラベルを導く(純関数・**AI に聞かない**)。
 *
 *  ■ 仕様
 *    ・脚の型(押し目買い/戻り売り/ブレイク新規)は `direction × kind` から一意。
 *    ・順張り/逆張りは `trendDir × direction` から。断定できなければ **付けない**。
 *    ・位置(above)は `direction × kind` から一意。位置が決まれば種別は1通りしかない
 *      (「買い指値を現在値より上」は置いた瞬間に約定するので存在しない)。
 *
 *  ★脚の型・above は入力の言い換えでしかない。情報を持つのは
 *    stance(トレンドという **別の観測** を混ぜる)と entryPositionOk(実データを当てる)のほう。 */
export function entryLabel(
  direction: 'buy' | 'sell', kind: EntryKind, trendDir?: EntryTrendDir,
): EntryLabel {
  // 現在値より上に置くのは「買いの逆指値」と「売りの指値」。= entryPositionOk と同じ1本の式から出す
  //   (2箇所で別々に書くと、片方だけ直す事故がこのファイルの中に生まれる)。
  const above = !wantsBelow(direction, kind);
  const stance = entryStance(direction, trendDir);
  const label: EntryLabel = {
    side: direction,
    above,
    text: stance ? `${KIND_TEXT[direction][kind]}・${STANCE_TEXT[stance]}` : KIND_TEXT[direction][kind],
  };
  // ★決まらなかったときは **キーごと付けない**(undefined を「決めた」ように見せない)。
  if (stance) label.stance = stance;
  return label;
}

/** その脚が現在値より **下** に置かれる契約か(★位置の規約はこの1行だけ)。
 *  buy 指値=下 / buy 逆指値=上 / sell 指値=上 / sell 逆指値=下。 */
function wantsBelow(direction: 'buy' | 'sell', kind: EntryKind): boolean {
  return kind === 'limit' ? direction === 'buy' : direction === 'sell';
}

/** entry が refPrice に対して規則どおりの側にあるか(幾何・純関数)。
 *  false = 置いた瞬間に約定する(即約定)か、そもそも逆側に置かれている不正な配置。
 *
 *  ■ ★実データでの発火実績: **11,859レッグ / 不正 0本**(2026-08-19 時点)。
 *    しかも偶然ではなく **構造的に発火しない**: ARM 前に checkStaleLegs が現在値から
 *    MIN_ENTRY_DISTANCE_YEN(=10円)未満のレッグを落とし、`armedPrice` にはその判定に使った
 *    同じ live 価格を焼き付けるため、画面が当てる基準に対して逆側になる隙間が無い(10 > 5)。
 *    ⇒ ★**「実データで検証した検出器」として数えないこと。** 実力は測っていない。
 *    ⇒ ★それでも消さない理由: これは **発生源(parse/enforce/ARM ガード)が壊れたときの検出器**。
 *      0件であることは「上流が効いている」証拠であって、不要である証拠ではない。
 *      発火したら「上流のどこかが壊れた」と読む(そのつもりで画面に印を出している)。
 *
 *  ■ 境界(entry === refPrice)の扱い → **false(不正)に倒した**。理由は2つ:
 *    ① 実務: 距離0の指値/逆指値は「置いた瞬間に約定する」=引きつけでも抜け追随でもない。
 *       どちらの脚としても契約を満たしていないので、通してはいけない。
 *    ② 流儀: core/stopGeometry.ts の stopSideOk が同じ判断をしている
 *       (境界 stopLoss===entry = 幅0 は「実質ストップにならない」ので不正)。
 *       同種の幾何検査で境界の倒し方が逆だと、読む側が毎回どちらか思い出す必要が出る。
 *
 *  ■ refPrice が非有限のときは **判定しない(true を返す)**。
 *    fail-safe の規約(判定材料が無いときに落とさない)。★これは server/llm/scalpPlan.ts の
 *    entrySideOk が元から持っていた挙動で、そこには「価格が取れなかっただけでレッグを落とす」と
 *    取引が止まる、という実運用上の理由がある。移設にあたって挙動を1ビットも変えていない。
 *    ★呼び出し側(画面)は「refPrice が無い/非有限なら検査そのものを出さない」で受けること。
 *      true を「検査に通った」と読ませると、材料が無いのに合格の顔をする=無言の失敗になる。 */
export function entryPositionOk(
  direction: 'buy' | 'sell', kind: EntryKind, entry: number, refPrice: number,
): boolean {
  if (!Number.isFinite(refPrice)) return true;
  return wantsBelow(direction, kind) ? entry < refPrice : entry > refPrice;
}
