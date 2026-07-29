// レジーム/勢いの数値化(純関数・テスト可能)。
// 実データ診断: AI が「少し前のトレンド像」を語って直近の値動きに逆張りする(強トレンドを「レンジ」と
// 誤読して両側フェード / 転換後も古いトレンド観を引きずる)。対策として、直近の勢いを数値で持ち、
// scalp-plan の技術文脈へ注入(A)+コードの trend veto(B・openai.ts enforcePlanConstraints)へ同じ値を渡す。
//
// このモジュールは時計/IO を持たない完全な純関数。`now` は呼び出し側が与える。

export interface Regime {
  ret10: number | null;      // close(now) − close(now−10分)。足不足は null。★鮮度上限なし(理由は MAX_STALE_MS)。
  ret30: number | null;      // close(now) − close(now−30分)。足不足/鮮度切れは null。
  ma20Slope: number | null;  // MA20(now) − MA20(now−5分)。20 本未満/鮮度切れは null。
  swingHigh: number | null;  // 直近30分の高値。窓に足が無ければ null。
  swingLow: number | null;   // 直近30分の安値。窓に足が無ければ null。
  posPct: number | null;     // レンジ内位置(%)。レンジ幅0/足不足は null。
  dir: 'up' | 'down' | 'flat';
  strong: boolean;           // dir !== 'flat'。ret10 が閾値未満/null なら false(=veto しない)。
  /** ★表示専用の合議ラベル(ret10/ret30/ma20Slope の合議)。dir とは別物で、trend veto には一切使わない。
   *  'conflict' = 直近10分と長い時間軸が逆向き(戻り/押し目)。どちらとも断定しない。
   *  'stale'    = ret10 の比較先が古く「10分の勢い」が寄り付きギャップに化けている。何も断定しない。 */
  trendDir: 'up' | 'down' | 'flat' | 'conflict' | 'stale';
  /** ★表示専用: 長い時間軸(ret30/ma20Slope)だけの合議方向。'conflict' 表示で「長期はどちらか」を示すのに使う。 */
  longDir: 'up' | 'down' | 'flat';
  /** ★表示専用の強弱。trendDir の根拠が2つ以上一致 or ret10 が閾値超え(=veto 発火)なら true。
   *  ただし 'conflict' は断定しない=常に false(弱)。 */
  trendStrong: boolean;
  /** ★表示専用: ret10 の比較先の足が鮮度上限を超えて古いときの「遅れ」[分]。新鮮/算出不能は null。
   *  ret10 自体は据え置き(ゲート不変)なので、値は正しくないまま渡る=注記で嘘だと分かるようにする。 */
  ret10StaleMin: number | null;
}

/** 1分足(OHLC)。リアルタイム足は close のみなので呼び出し側で o/h/l/c=close にマップして渡す。 */
export interface RegimeBar { t: number; o: number; h: number; l: number; c: number; }

const MIN = 60_000;

/** 参照足の鮮度上限[ms]。目標時刻(now−N分)から これ以上離れた足しか無ければ「データ無し」とみなす。
 *  実データ(jp225.db の NIY=F 1分足 179,188 本)では、参照足のズレは「2分以内(=ほぼ全て)」か
 *  「30分超(=セッション跨ぎ)」の二極で、2〜30分の中間はゼロ本だった。ゆえに 3分(足3本ぶん)で
 *  「足の小さな欠測は許容」「セッション跨ぎは拒否」を綺麗に分離できる。
 *
 *  ★意図的な非対称: 鮮度上限を課すのは ret30 / ma20Slope /(scalpContext の長い時間軸)だけで、
 *    ret10 には課さない。ret10 は dir/strong を決め、それが enforcePlanConstraints のトレンド veto
 *    (エントリーの通し方)を駆動しているため、鮮度上限で null が増えると flat が増え veto の発火頻度が
 *    変わる=ゲート変更になってしまう。本改修は「AI に見せる情報を正す」までが範囲で、ゲートは1ビットも
 *    変えないという方針のため、ret10 は従来どおり(古い足とも比較する)据え置く。 */
const MAX_STALE_MS = 3 * MIN;

/** t<=time のうち最大 t を持つバーの close(c)。該当なしは null(=その時点のデータ不足)。
 *  maxStaleMs を渡すと、採用したバーが time から それ以上離れている場合も null(=鮮度切れ)にする。 */
function closeAtOrBefore(bars: RegimeBar[], time: number, maxStaleMs?: number): number | null {
  let bestT = -Infinity;
  let bestC: number | null = null;
  for (const b of bars) {
    if (b.t <= time && b.t >= bestT) { bestT = b.t; bestC = b.c; }
  }
  if (bestC !== null && maxStaleMs !== undefined && time - bestT > maxStaleMs) return null;
  return bestC;
}

/** t<=time で採用される足が time からどれだけ古いか[分]。鮮度上限内/該当なしは null。
 *  ★ret10 用の「表示だけの」鮮度判定。値(ret10)も dir/strong も一切変えない=ゲート不変。 */
function staleMinutesAtOrBefore(bars: RegimeBar[], time: number): number | null {
  let bestT = -Infinity;
  for (const b of bars) if (b.t <= time && b.t >= bestT) bestT = b.t;
  if (bestT === -Infinity) return null;
  const lag = time - bestT;
  return lag > MAX_STALE_MS ? Math.round(lag / MIN) : null;
}

/** t<=time で終わる直近 20 本 close の単純平均(MA20)。20 本未満は null。
 *  ★鮮度: 最新足が time から離れすぎ(>MAX_STALE_MS)、または 20 本が 19分+許容 より長い期間に
 *  散らばっている(=セッション跨ぎ/大穴)場合も null。連続でない足を平均すると、実在しない傾きになるため。 */
function ma20At(bars: RegimeBar[], time: number): number | null {
  const upto = bars.filter(b => b.t <= time).sort((a, b) => a.t - b.t);
  if (upto.length < 20) return null;
  const last20 = upto.slice(-20);
  if (time - last20[19]!.t > MAX_STALE_MS) return null;
  if (last20[19]!.t - last20[0]!.t > 19 * MIN + MAX_STALE_MS) return null;
  let sum = 0;
  for (const b of last20) sum += b.c;
  return sum / 20;
}

/** 合議ラベルで「MA20傾きがトレンド級」とみなす下限[円/5分]。実データ(NIY=F 1分足)の |ma20Slope| は
 *  p50=14.5 / p75=29.3 / p90=51.8 のため、20 は概ね上位4割=「明確に傾いている」帯を指す。
 *  単独では使わず、必ず ret30 が同方向に閾値以上のときの補強としてのみ使う(偽陽性を抑える)。 */
const TREND_SLOPE_YEN = 20;

/** 直近の勢い/レジームを算出する純関数。
 *  - ret10/ret30: now と now−N分の「その時点以前で最後」の close の差。どちらか欠落は null。
 *    ret30 は鮮度上限つき(セッション跨ぎの偽の「30分−790円」を出さない)。ret10 は据え置き(MAX_STALE_MS 参照)。
 *  - ma20Slope: MA20(now)−MA20(now−5分)。20 本未満/鮮度切れは null。
 *  - swingHigh/Low: 直近30分の高安。posPct: (close−安)/(高−安)×100(レンジ0/足不足は null)。
 *  - dir: ret10≥+T→'up' / ret10≤−T→'down' / それ以外(null 含む)→'flat'。strong=(dir≠'flat')。
 *    ★dir/strong はコードの trend veto(enforcePlanConstraints)の入力なので、ret10 のみで決める実装を変えない。
 *  - trendDir/trendStrong: AI へ見せるラベル専用の合議(ret10/ret30/ma20Slope)。veto には使わない。
 *  堅牢: 入力欠落はそのフィールドを null にし、ret10 が null なら dir='flat'・strong=false(=veto しない)。 */
export function computeRegime(bars: RegimeBar[], now: number, thresholdYen = 100): Regime {
  const safe = Array.isArray(bars)
    ? bars.filter(b => b && Number.isFinite(b.t) && Number.isFinite(b.c))
    : [];

  // ret10 / ret30: close(now) − close(now−N分)。どちらかの時点にデータが無ければ null。
  // ★ret10 は鮮度上限なし(ゲート不変のため)/ ret30 は鮮度上限あり(表示専用なので偽の数値を出さない)。
  const cNow = closeAtOrBefore(safe, now);
  const c10 = closeAtOrBefore(safe, now - 10 * MIN);
  const c30 = closeAtOrBefore(safe, now - 30 * MIN, MAX_STALE_MS);
  const ret10 = cNow !== null && c10 !== null ? cNow - c10 : null;
  const ret30 = cNow !== null && c30 !== null ? cNow - c30 : null;
  // ★ret10 の比較先が古い(=寄り付き直後は前セッション終値と比べている)ことを表示用に露出する。
  //   毎セッションの寄り後10分間、「10分−400円」の中身が寄り付きギャップだった(実データで 1.6% の点・
  //   その 99.6% が 8時台/17時台に集中)。値も dir/strong も変えず、注記だけで嘘だと分かるようにする。
  const ret10StaleMin = ret10 !== null ? staleMinutesAtOrBefore(safe, now - 10 * MIN) : null;

  // ma20Slope: MA20(now) − MA20(now−5分)。どちらか 20 本未満/鮮度切れは null。
  const maNow = ma20At(safe, now);
  const maPrev = ma20At(safe, now - 5 * MIN);
  const ma20Slope = maNow !== null && maPrev !== null ? maNow - maPrev : null;

  // swingHigh/Low: 直近30分の高安(h の最大 / l の最小)。posPct: レンジ内位置。
  const win = safe.filter(b =>
    b.t <= now && b.t >= now - 30 * MIN && Number.isFinite(b.h) && Number.isFinite(b.l));
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (const b of win) {
    if (swingHigh === null || b.h > swingHigh) swingHigh = b.h;
    if (swingLow === null || b.l < swingLow) swingLow = b.l;
  }
  let posPct: number | null = null;
  if (swingHigh !== null && swingLow !== null && cNow !== null && swingHigh > swingLow) {
    posPct = ((cNow - swingLow) / (swingHigh - swingLow)) * 100;
  }

  // dir/strong: ret10 が閾値以上で up/down。ret10 が null(足不足)なら flat=veto しない。
  // ★ここは trend veto(enforcePlanConstraints)の入力=エントリーの通し方そのもの。ret10 のみで決める実装を変えない。
  let dir: 'up' | 'down' | 'flat' = 'flat';
  if (ret10 !== null) {
    if (ret10 >= thresholdYen) dir = 'up';
    else if (ret10 <= -thresholdYen) dir = 'down';
  }
  const strong = dir !== 'flat';

  // trendDir/longDir/trendStrong: ★表示専用の合議ラベル(veto には使わない)。
  //   ret10 だけで決めていた従来のラベルは、30分で−1,200円 下げている最中でも「横ばい」と表示し、
  //   AI が自己レジームを range と答えて下降中に買いを出す原因になっていた(実データで確認)。
  //   そこで ret10(短期)と ret30/ma20Slope(長期)の合議でラベルだけを正す。
  //   長期の条件(下降・上昇は符号反転の対称): ret30≤−2T / (ma20Slope≤−20 かつ ret30≤−T)
  //
  //   ★競合(短期↑ かつ 長期↓ など)は どちらとも断定しない 'conflict' にする。
  //     以前は ret10 を優先して「上昇トレンド(強)」等と断定していたが、実データ検証で
  //     競合点(全体の約1.4%)はラベル方向の的中率が15分48.2%/30分50.0%=情報量ゼロで、
  //     「上昇トレンド」表示の後 15分で平均−8.9円と むしろ逆に動いていた(=新しい嘘を作っていた)。
  //     断定を避けて「戻り/押し目」と示し、強弱は必ず「弱」にする。
  const longVotes = (sign: 1 | -1): number => {
    let n = 0;
    if (ret30 !== null && sign * ret30 >= 2 * thresholdYen) n++;
    if (ma20Slope !== null && sign * ma20Slope >= TREND_SLOPE_YEN
      && ret30 !== null && sign * ret30 >= thresholdYen) n++;
    return n;
  };
  const upLong = longVotes(1);
  const downLong = longVotes(-1);
  // 長期方向は一意に決まる(ret30≤−2T と ret30≥+2T は排他・傾き条件も ret30 の符号で排他)。
  const longDir: 'up' | 'down' | 'flat' = upLong > 0 ? 'up' : downLong > 0 ? 'down' : 'flat';
  // 競合の判定は「長期合議(2T/傾き)」より緩い基準を使う: 短期がトレンドなのに 30分が閾値(T)以上 逆向きなら
  // もう断定しない。長期合議(2T)だけを基準にすると、10分+120円/30分−150円 のような弱い矛盾が
  // 「上昇トレンド(強)」のまま残る(実データで 792点・的中率49.9%=情報量ゼロ)。longDir が非 flat の競合は
  // この条件に必ず含まれる(2T も 傾き条件も |ret30|≥T を含むため)=より広い安全側の判定。
  const opposedRet30 = dir !== 'flat' && ret30 !== null
    && (dir === 'up' ? ret30 <= -thresholdYen : ret30 >= thresholdYen);
  let trendDir: 'up' | 'down' | 'flat' | 'conflict' | 'stale';
  // ★最優先: ret10 の比較先が古いとき(寄り付き直後)は「10分の勢い」ではなく寄り付きギャップなので、
  //   その数値からトレンドを名乗らない。注記で「信頼できない」と言いながら断定するのは自己矛盾であり、
  //   本プロジェクトの9年バックテスト(ギャップ埋め/反転追随/継続追随の3戦略とも期待値マイナス=
  //   ギャップの大小に方向エッジ無し)とも正面から矛盾する。ret30 が生きていても断定はしない
  //   (数値そのものは行内に出るので、AI は生の数字から自分で判断できる=情報は落とさない)。
  if (ret10StaleMin !== null) trendDir = 'stale';
  else if (opposedRet30) trendDir = 'conflict';
  else if (dir !== 'flat') trendDir = dir;      // 短期がトレンド(長期は同方向 or 中立)
  else trendDir = longDir;                      // 短期は静かだが長期が動いている/どちらも静か
  // 強弱: 根拠が2つ以上一致、または ret10 が閾値超え(=veto が実際に効いている)なら「強」。
  //       競合(conflict)/ギャップ由来(stale)は断定しないので常に「弱」。
  const asserted = trendDir === 'up' || trendDir === 'down';
  const trendVotes = (trendDir === 'up' ? upLong : trendDir === 'down' ? downLong : 0)
    + (asserted && dir === trendDir ? 1 : 0);
  const trendStrong = asserted && (trendVotes >= 2 || dir !== 'flat');

  return {
    ret10, ret30, ma20Slope, swingHigh, swingLow, posPct,
    dir, strong, trendDir, longDir, trendStrong, ret10StaleMin,
  };
}

/** Regime を scalp-plan の技術文脈へ注入する日本語 1 行に整形する(純関数)。
 *  null フィールドは「—」で表示。format:
 *  `直近の勢い: 10分{±X}円 / 30分{±Y}円 / MA20傾き{±Z} / 直近30分高安[{L}-{H}]内{pos}% → {ラベル}({強|弱})`
 *
 *  ★ラベルは dir/strong ではなく trendDir/trendStrong(表示専用の合議)を使う。
 *  ★競合(trendDir='conflict')は「戻り/押し目」と示して断定しない(必ず弱)。
 *  ★ret10 の比較先が古い(寄り付きギャップ)ときは 10分の値に注記を足す(値そのものは据え置き)。
 *  ★rangeEnabled: レンジ両面(direction:"range")が許可されている設定かどうか。横ばい判定のときだけ
 *    「レンジ両面を出してよい」旨を添える(トレンド/競合のときは決して添えない=レンジへ誘導しない)。
 *    純関数を保つため config は読まず引数で受ける。既定 false=安全側(レンジへ誘導しない)。
 *    呼び出し側は system prompt の rangeLine と同じ実効値を渡すこと(食い違うと AI が混乱する)。 */
export function formatMomentumLine(r: Regime, rangeEnabled = false): string {
  const yen = (v: number | null): string =>
    v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}円`;
  const slope = r.ma20Slope === null || !Number.isFinite(r.ma20Slope)
    ? '—' : `${r.ma20Slope >= 0 ? '+' : ''}${r.ma20Slope.toFixed(1)}`;
  const lo = r.swingLow === null || !Number.isFinite(r.swingLow) ? '—' : String(Math.round(r.swingLow));
  const hi = r.swingHigh === null || !Number.isFinite(r.swingHigh) ? '—' : String(Math.round(r.swingHigh));
  const pos = r.posPct === null || !Number.isFinite(r.posPct) ? '—' : String(Math.round(r.posPct));
  // ★寄り付きギャップ注記: 「10分」と称しているが実際は もっと古い足(前セッション終値)との差である旨。
  //   値は据え置き(=dir/strong もそのまま)なので、注記で「この数字は10分の勢いではない」と分かるようにする。
  const staleNote = r.ret10StaleMin !== null && Number.isFinite(r.ret10StaleMin)
    ? `(※比較先は${Math.round(r.ret10StaleMin)}分前の足=寄り付きギャップ/欠測)` : '';
  // 競合(短期↔長期が逆)は断定しない。短期が上=長期の下降に対する「戻り」/ 短期が下=「押し目」。
  // ★括弧内は事実に合わせる: 長期合議(±2倍閾値/MA20傾き)が成立していれば「長期は下降/上昇」、
  //   30分が逆向きなだけ(合議未成立)なら「30分は逆向き」と書く=言い過ぎない。
  const conflictKind = r.dir === 'up' ? '戻り' : r.dir === 'down' ? '押し目' : '方向不一致';
  const conflictWhy = r.longDir === 'down' ? '長期は下降' : r.longDir === 'up' ? '長期は上昇' : '30分は逆向き';
  const conflictLabel = r.dir === 'flat' ? '方向不一致' : `${conflictKind}(${conflictWhy})`;
  const label = r.trendDir === 'up' ? '上昇トレンド'
    : r.trendDir === 'down' ? '下降トレンド'
    : r.trendDir === 'conflict' ? conflictLabel
    : r.trendDir === 'stale' ? '判定保留(寄り付きギャップ)'
    : '横ばい';
  // 強弱は「断定したとき」だけ添える。判定保留(stale)に強弱は無意味なので付けない。
  const strength = r.trendDir === 'stale' ? '' : `(${r.trendStrong ? '強' : '弱'})`;
  // 競合の行動指針: veto は「dir に逆行する側」=ちょうど長期方向の順張り側を落とす。つまり長期に乗る新規は
  // そもそも通らず、通るのは長期に逆らう側だけ。よって見送りが最も整合的である旨を明示する。
  const conflictNote = r.trendDir === 'conflict'
    ? ' ※直近10分と長い時間軸が逆向きです。どちらのトレンドとも断定できません。'
      + 'コード側の見送り判定(veto)は直近10分に逆行する新規=長い時間軸に順張りする側を落とすため、'
      + '長期方向へ乗る計画は通りません。direction:"none"(見送り)が最も整合的です'
    : '';
  // 横ばい かつ レンジ両面が有効な設定のときだけ、range を出してよいことを明示する
  // (system prompt の rangeLine「direction:"range" を返してよい」と同じ許可を、場面判断として補強する)。
  // ★2択(fade=両側指値の組 / breakout=両側ブレイク新規の組)のどちらも選べることを明示する。狭い横這いでは
  //   逆張りの利幅が損切り幅を上回らないため breakout が正しい(幅の具体的な基準は system prompt 側)。
  //   ★SSOT: 語彙と使い分けは system prompt の rangeLine と揃える(食い違うと AI が矛盾した指示を受ける)。
  // ★競合(conflict)は横ばいではないので、ここには入らない=レンジを勧めない。
  const rangeNote = r.trendDir === 'flat' && rangeEnabled
    ? ' ※レンジ両面が有効な設定です。上下に反応帯(節目)があるレンジだと判断できるなら direction:"range"(両面ストラドル)を出してよい局面'
      + '(上下幅が広ければ fade=両側指値の組 / 狭い横這いなら breakout=両側ブレイク新規の組。組は混ぜない。幅の基準は上の制約を参照)'
    : '';
  // ギャップ由来の行動指針。system prompt の【検証済みの知見】(9年バックテストでギャップ戦略3種を全否定)と
  // 同じ向きの指示にする(勢い行が「ギャップ由来のトレンド」を注入して禁止条項と食い違う状態を作らない)。
  const staleGuide = r.trendDir === 'stale'
    ? ' ※「10分」の比較先が古い足(前セッション終値)のため、この値は直近10分の勢いではなく寄り付きギャップです。'
      + '本プロジェクトの9年バックテストでギャップの大小に方向のエッジは無いと確認済みのため、この値を根拠に方向を決めないこと。'
      + '方向は『長い時間軸』の数値・節目・アラートで判断し、それらに明確な根拠が無ければ direction:"none"(見送り)にすること'
    : '';
  return `直近の勢い: 10分${yen(r.ret10)}${staleNote} / 30分${yen(r.ret30)} / MA20傾き${slope} / `
    + `直近30分高安[${lo}-${hi}]内${pos}% → ${label}${strength}${conflictNote}${staleGuide}${rangeNote}`;
}
