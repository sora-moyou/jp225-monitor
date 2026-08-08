// core/newsImpact.ts — ニュースの「インパクト推定」と「カテゴリ分類」。
//
// ★設計方針(なぜ LLM を使わないか):
//   ニュースの並び順は「後から検証できる」必要がある。LLM に採点させると (a) 毎回結果が変わり
//   (b) 課金され (c)「なぜこれが1位なのか」を再現できない。ここは決定的な純関数にして、
//   採点の内訳(breakdown)を残す。内訳が残っていれば「なぜ上位に来たか」を画面と DB の両方で
//   説明でき、重みの調整も測って行える(このプロジェクトの「測れること」重視に合わせる)。
//
// ★server/config.ts の FINANCE_RELEVANCE_KEYWORDS 等とは役割が違う:
//   あちらは「捨てるか通すか」の二値フィルタ(取り込み段)。ここは「通ったものの序列」(表示段)。
//   二値の閾値を動かすと取り込み自体が変わってしまうので、重み付けは別の語彙として独立させる。
//
// ★依存は core/types.ts のみ。server も web も import できる(非循環・core 境界の最下層)。

import type { NewsItem } from './types.js';

// ── カテゴリ(画面のチップ) ───────────────────────────────────────────────
// 判定できないものには **ラベルを付けない**(null)。無理に分類すると、チップが意味を失って
// 「全部に何かしら付いている」= 情報量ゼロの飾りになる。
export type NewsCategory =
  | 'breaking'      // 速報 / BREAKING / 緊急
  | 'economy'       // 金融政策・経済指標・要人発言・為替
  | 'commodity'     // 原油・金・穀物・OPEC
  | 'geopolitics'   // 有事・攻撃・制裁・戦争
  | 'stock';        // 個別株(値がさ株中心)

/** チップの表示文言。画面(web)と、後から DB を読む解析の両方でここを唯一の定義にする。 */
export const NEWS_CATEGORY_LABELS: Record<NewsCategory, string> = {
  breaking: 'BREAKING',
  economy: '経済',
  commodity: 'コモディティ',
  geopolitics: '地政学',
  stock: '個別株',
};

/** 採点の内訳 1 件。label=何で加点されたか / points=何点入ったか。 */
export interface ImpactReason {
  label: string;
  points: number;
}

export interface NewsImpact {
  /** 最終スコア(= content × 鮮度減衰 + 新着ボーナス)。並び替えのキー。 */
  score: number;
  /** 鮮度を掛ける前の素点(材料の強さそのもの)。減衰と分離して残すと後から検証しやすい。 */
  contentScore: number;
  /** 適用した鮮度係数(0.25〜1.0)。 */
  decay: number;
  /** 主カテゴリ。判定できなければ null。 */
  category: NewsCategory | null;
  /** 海外(英語ソース or 日本語ソースの海外ニュース)。カテゴリとは独立のフラグ。 */
  overseas: boolean;
  /** 何で何点入ったかの全内訳(減衰・新着ボーナスも 1 行として含む)。 */
  reasons: ImpactReason[];
}

// ── 重みの根拠 ────────────────────────────────────────────────────────────
// 日経225先物の「数分〜数十分の値動き」に効く順に並べた。序列の根拠は
// このリポジトリに既にある HIGH_IMPACT_KEYWORDS の設計思想(要人・中銀・指標・地政学)を踏襲しつつ、
// 「二値で拾う」だけだったものを **効きの大きさ順に段付け** したもの。
//
//   14: 為替介入・利上げ利下げの決定 … 発表の瞬間に先物が数百円動く区分
//   12: 大統領/財務長官/FRB議長 の新規発言 … ユーザーが名指しした最重要区分
//   10: 関税、FOMC/日銀の会合、主要指標(CPI/雇用統計)
//    8: 地政学(攻撃・侵攻・制裁)
//    6: その他要人(首相・財務相・ECB)、速報タグ
//    5〜7: 値がさ株(指数寄与の大きさで 2 段)
//
// ★同一グループ内は「最大値のみ採用」にする。理由: 1本の記事に "トランプ" と "大統領" が
//   両方入っているだけで倍の点が入るのは、内容ではなく語彙の重複を測っていることになる。

/** 人物・機関。ユーザー要望の中核=トランプ / ベッセント(財務長官)の新規発言を必ず拾う。 */
export const PERSON_WEIGHTS: readonly (readonly [number, readonly string[]])[] = [
  // 米: 政権中枢。トランプは SNS 発言だけで先物が動く実績があるため単独で最上位帯。
  [12, ['トランプ', 'trump', '米大統領', 'president trump', 'white house', 'ホワイトハウス']],
  // 米財務長官(ベッセント)。表記ゆれ「ベッセント/ベセント/ベッサント」を全部拾う。
  [12, ['ベッセント', 'ベセント', 'ベッサント', 'bessent', '米財務長官', 'treasury secretary']],
  // FRB議長。金融政策の一次情報源。
  [12, ['パウエル', 'powell', 'frb議長', 'fed chair', 'fed chairman']],
  // 中銀そのもの(会合・声明・議事要旨)。
  [10, ['fomc', 'frb', 'fed', '米連邦準備', '連邦公開市場委員会']],
  [10, ['日銀', '日本銀行', 'boj', '植田', 'ueda']],
  // その他の要人。相場は動かすが上の 3 者ほどではない。
  [6, ['ecb', 'ラガルド', 'lagarde', 'boe', 'イングランド銀行']],
  [6, ['首相', '官房長官', '財務相', '財務大臣', '経済再生相', '高市', '石破', 'prime minister']],
  [6, ['イエレン', 'yellen', 'ウォラー', 'waller', 'ウィリアムズ', 'williams', 'ハセット', 'hassett']],
  // 副大統領・通商代表など。単独では相場を動かしにくいが、地政学/通商の発言主体として拾う。
  // ('vance' は先頭境界があるので "advance" には当たらない)
  [6, ['バンス', 'vance', 'ルビオ', 'rubio', 'ラトニック', 'lutnick', 'グリア', 'greer']],
];

/** イベント。指標発表・政策・地政学。 */
export const EVENT_WEIGHTS: readonly (readonly [number, readonly string[]])[] = [
  // 為替介入は日経先物にとって最も瞬発力のある単語。
  [14, ['為替介入', '円買い介入', 'ドル売り介入', 'currency intervention', '覆面介入']],
  [14, ['利上げ', '利下げ', 'rate hike', 'rate cut', '追加緩和', '政策金利']],
  [10, ['関税', 'tariff', '貿易戦争', 'trade war', '通商', '報復措置']],
  [10, ['金融政策決定会合', '政策決定会合', 'fomc議事', 'jackson hole', 'ジャクソンホール', '声明文']],
  // 主要指標。★「発表後の評価」を拾うため、結果語(上振れ/下振れ/予想を)も同居させる。
  [10, ['cpi', '消費者物価', '雇用統計', 'nonfarm', 'non-farm', 'payroll', 'ppi', 'pce', '失業率']],
  [8,  ['gdp', 'ism', 'pmi', '小売売上', 'retail sales', '国内総生産', '鉱工業生産']],
  [8,  ['上振れ', '下振れ', '予想を上回', '予想を下回', 'beat expectations', 'missed expectations']],
  // 地政学。
  [8,  ['制裁', 'sanction', '空爆', '攻撃', '侵攻', 'missile', 'ミサイル', '有事', '停戦', 'ceasefire', '戦争']],
  [8,  ['opec', '減産', '増産', 'ホルムズ', '海峡封鎖']],
  // 相場そのものの急変を報じるもの。
  [6,  ['急騰', '急落', '暴落', '暴騰', 'サーキットブレーカー', 'plunge', 'surge', 'crash', 'selloff']],
];

// ── 値がさ株(日経平均への寄与が大きい銘柄) ──────────────────────────────
// ★なぜこの銘柄か: 日経平均は **株価加重(price-weighted)** なので、「株価が高い銘柄 = 指数寄与が大きい」。
//   時価総額ではない。したがって選定基準は「みなし額面調整後の株価が高い N225 採用銘柄」。
//   1銘柄で日経を数十〜百円動かす力があるのは実質この 20 銘柄前後に限られる。
//
//   TIER1 = 指数寄与が突出している 5 銘柄(ユーザーが例示した顔ぶれと一致)。
//           ファーストリテイリングは単独で指数の 1 割前後を占める(構成比 1 位が長い)。
//   TIER2 = 寄与上位だが TIER1 ほどではない銘柄。個社ニュースが指数に波及しうる範囲。
//
//   ★注意(正直な但し書き): 構成比の順位は株価で日々動くので、ここは「順位表」ではなく
//     「寄与上位の集合」として持つ。厳密な比率が要る用途にはこの定数を使わないこと。
export const HEAVYWEIGHT_TIER1: readonly string[] = [
  'ファーストリテイリング', 'ファストリ', 'fast retailing', 'ユニクロ', 'uniqlo', '9983',
  '東京エレクトロン', '東エレク', 'tokyo electron', '8035',
  'アドバンテスト', 'advantest', '6857',
  'ソフトバンクグループ', 'ソフトバンクg', 'softbank group', 'sbg', '9984',
  '信越化学', 'shin-etsu', '4063',
];
export const HEAVYWEIGHT_TIER2: readonly string[] = [
  'ディスコ', 'disco', '6146',
  'tdk', '6762',
  'リクルート', 'recruit', '6098',
  'ダイキン', 'daikin', '6367',
  'ファナック', 'fanuc', '6954',
  'テルモ', 'terumo', '4543',
  'kddi', '9433',
  '京セラ', 'kyocera', '6971',
  '中外製薬', 'chugai', '4519',
  '第一三共', 'daiichi sankyo', '4568',
  '村田製作所', 'murata', '6981',
  'レーザーテック', 'lasertec', '6920',
  '東京海上', 'tokio marine', '8766',
  '富士通', 'fujitsu', '6702',
  '日東電工', 'nitto denko', '6988',
  'トレンドマイクロ', 'trend micro', '4704',
  'キオクシア', 'kioxia', '285a',
  'smc', '6273',
  // ★キーエンスは「値がさ」だが日経225の採用銘柄ではない(TOPIX側)。指数を直接動かさないので
  //   TIER2 に置き、TIER1 には入れない。ただし半導体/FA のセンチメント材料にはなる。
  'キーエンス', 'keyence', '6861',
  'ソニーグループ', 'sony', '6758',
  '任天堂', 'nintendo', '7974',
];

/** 速報タグ。 */
export const BREAKING_KEYWORDS: readonly string[] = [
  '速報', '【速報】', 'breaking', 'breaking news', '緊急', 'just in', '一報', '号外',
];

/** 米国色。★日本語ソースの米国ニュースも拾えるよう、英単語だけに頼らない。 */
export const US_KEYWORDS: readonly string[] = [
  '米国', '米株', '米', 'ニューヨーク', 'ny', 'ナスダック', 'nasdaq', 'ダウ', 'dow',
  's&p', 'sp500', 'ワシントン', 'washington', 'wall street', 'ウォール街',
  'u.s.', 'us', 'american', '連邦', '米政権', '米議会',
];

/** コモディティ判定語。 */
export const COMMODITY_KEYWORDS: readonly string[] = [
  '原油', 'wti', 'crude', 'oil', 'ブレント', 'brent', '金価格', 'ゴールド', 'gold', '金相場',
  '銀価格', 'silver', '銅', 'copper', '天然ガス', 'natural gas', 'lng', 'opec', '穀物', '小麦',
  'コモディティ', 'commodity', '商品市況', '1オンス', 'オンス当た',
];

/** 地政学判定語(カテゴリ用。EVENT_WEIGHTS とは目的が違うので別に持つ)。 */
export const GEOPOLITICS_KEYWORDS: readonly string[] = [
  '制裁', 'sanction', '空爆', '攻撃', '侵攻', 'ミサイル', 'missile', '有事', '停戦', 'ceasefire',
  '戦争', 'war', 'ウクライナ', 'ukraine', 'ロシア', 'russia', 'イラン', 'iran', 'イスラエル', 'israel',
  'ガザ', 'gaza', '北朝鮮', 'north korea', '台湾有事', 'テロ', 'terror',
];

/** 経済判定語(カテゴリ用)。 */
export const ECONOMY_KEYWORDS: readonly string[] = [
  '金利', '利上げ', '利下げ', '金融政策', 'fomc', 'frb', 'fed', '日銀', 'boj', 'ecb',
  'cpi', '消費者物価', '雇用統計', '失業率', 'gdp', 'ism', 'pmi', 'インフレ', 'inflation',
  '為替', '円安', '円高', 'ドル円', '関税', 'tariff', '景気', '経済', 'economy', '国債', '債券',
  'yield', '物価', '財政', '予算', '株価', '日経平均', '相場',
];

// ── 鮮度の減衰 ────────────────────────────────────────────────────────────
// 形: 半減期つき指数減衰 + 下限。理由:
//   ・線形減衰(既存 scoreNews)は「窓の外に出た瞬間ゼロ」になり、境界で順位が飛ぶ。
//   ・純粋な指数減衰は古い大材料を消しすぎる。関税発表は 3 時間経っても板の前提であり続ける。
//   → 下限 0.25 を置いて「古い大材料 > 新しい些事」を保ちつつ、同点なら新しい方が勝つようにする。
export const IMPACT_HALF_LIFE_MIN = 90;   // この分数で減衰幅が半分になる
export const IMPACT_DECAY_FLOOR = 0.25;   // どれだけ古くてもここまでしか下がらない
/** 新着ボーナスの上限と、その効果が消えるまでの分数。 */
export const IMPACT_FRESH_BONUS = 4;
export const IMPACT_FRESH_WINDOW_MIN = 20;

/** 年齢[分] → 減衰係数(1.0 → IMPACT_DECAY_FLOOR)。 */
export function recencyDecay(ageMin: number): number {
  const a = Math.max(0, ageMin);
  const half = Math.pow(2, -a / IMPACT_HALF_LIFE_MIN);
  return IMPACT_DECAY_FLOOR + (1 - IMPACT_DECAY_FLOOR) * half;
}

// ★英数字だけのキーワードは「単語境界」で当てる(部分一致にしない)。
//   実データで踏んだ誤検知: 'ism'(ISM景況指数)が "social**ism**" に当たって政治記事が
//   経済指標として加点されていた。同種の地雷は 'dow'→"**dow**n" / 'disco'→"**disco**unt" /
//   'war'→"to**war**d" / 'ny'→"compa**ny**" / 'oil'→"b**oil**" と多く、素の includes では必ず壊れる。
//   日本語は語分割が無いので従来どおり部分一致(「関税」は「対中関税措置」に当たってほしい)。
//
// ★ただし境界を厳密にしすぎると英語の語形変化を落とす。実際 'tariff' を完全一致にしたら
//   "Trump's 50% **tariffs**" が当たらなくなった(実データで確認)。そこで:
//     - 4文字以上の語 … 後ろに [a-z]{0,2} の語尾を許す(tariff**s** / russia**n** / israel**i**)。
//       "disco"+"unt" は語尾 3 文字なので通らない=誤検知は防げる。
//     - 3文字以下の語 … 語尾を一切許さない(dow/ism/war/ny/us は短すぎて語尾を許すと必ず誤爆する)。
//   先頭側は常に厳密(socialism の ism / toward の war / company の ny をここで落とす)。
//   アポストロフィは [a-z0-9] ではないので "Powell's" 等は語尾規則なしでそのまま当たる。
const RE_CACHE = new Map<string, RegExp>();
function needleHit(hay: string, needle: string): boolean {
  if (/[^\x00-\x7F]/.test(needle)) return hay.includes(needle);   // 非ASCII混じり=日本語→部分一致
  let re = RE_CACHE.get(needle);
  if (!re) {
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tail = needle.length >= 4 ? '[a-z]{0,2}' : '';
    re = new RegExp(`(?<![a-z0-9])${esc}${tail}(?![a-z0-9])`);
    RE_CACHE.set(needle, re);
  }
  return re.test(hay);   // hay は呼び出し側で小文字化済み
}

function hit(hay: string, needles: readonly string[]): string | null {
  for (const n of needles) if (needleHit(hay, n)) return n;
  return null;
}

/** グループ内は最大 1 件だけ採用する(語彙の重複で二重加点しない)。 */
function bestOf(
  hay: string,
  table: readonly (readonly [number, readonly string[]])[],
): { points: number; word: string } | null {
  let best: { points: number; word: string } | null = null;
  for (const [points, words] of table) {
    const w = hit(hay, words);
    if (w && (best === null || points > best.points)) best = { points, word: w };
  }
  return best;
}

/** 英語ソース名の簡易判定に使う。source は取得元の表示名(config の name)。 */
function isOverseasSource(item: NewsItem): boolean {
  if (item.lang === 'en') return true;
  // 日本語ソースでも米国ニュース枠は海外扱い(nikkei225jp の NY 面など)。
  // ★ここも単語境界で当てる。素の includes だと "mo**ney**world" が 'ny' に当たって
  //   国内ソースが海外扱いになる(実データで確認)。
  const s = item.source.toLowerCase();
  return needleHit(s, 'ny') || needleHit(s, 'us') || s.includes('米') || s.includes('海外');
}

/**
 * ニュース 1 件のインパクトを推定する純関数。
 * 入力が同じなら出力は必ず同じ(now を引数で受けるのはそのため)。
 */
export function scoreNewsImpact(item: NewsItem, now: number): NewsImpact {
  // 判定面は「タイトル + ソース名」。本文は取得できないソースがあり、あるものだけ有利になると
  // ソース間で不公平な序列になるため、全ソースで必ず揃う面だけを使う。
  const hay = `${item.title} ${item.source}`.toLowerCase();
  const reasons: ImpactReason[] = [];
  let content = 0;

  const person = bestOf(hay, PERSON_WEIGHTS);
  if (person) { content += person.points; reasons.push({ label: `要人・機関: ${person.word}`, points: person.points }); }

  const event = bestOf(hay, EVENT_WEIGHTS);
  if (event) { content += event.points; reasons.push({ label: `イベント: ${event.word}`, points: event.points }); }

  const t1 = hit(hay, HEAVYWEIGHT_TIER1);
  const t2 = t1 ? null : hit(hay, HEAVYWEIGHT_TIER2);
  if (t1) { content += 7; reasons.push({ label: `値がさ株(寄与上位): ${t1}`, points: 7 }); }
  else if (t2) { content += 5; reasons.push({ label: `値がさ株: ${t2}`, points: 5 }); }

  const brk = hit(hay, BREAKING_KEYWORDS);
  if (brk) { content += 6; reasons.push({ label: `速報: ${brk}`, points: 6 }); }

  const overseas = isOverseasSource(item);
  const us = hit(hay, US_KEYWORDS);
  // ★米国重み。ユーザー指示「ソースは米国に重きを置き」。ソース側(+3)と本文側(+2)を分けて
  //   持つのは、日本語ソースが報じる米国ニュースも同じだけ拾えるようにするため。
  if (overseas) { content += 3; reasons.push({ label: '海外ソース', points: 3 }); }
  if (us) { content += 2; reasons.push({ label: `米国関連: ${us.trim()}`, points: 2 }); }

  const ageMin = (now - item.publishedAt) / 60_000;
  const decay = recencyDecay(ageMin);
  const fresh = ageMin <= IMPACT_FRESH_WINDOW_MIN && ageMin >= 0
    ? IMPACT_FRESH_BONUS * (1 - ageMin / IMPACT_FRESH_WINDOW_MIN)
    : 0;

  const score = content * decay + fresh;
  reasons.push({ label: `鮮度減衰 (${Math.max(0, Math.round(ageMin))}分前 ×${decay.toFixed(2)})`, points: Math.round((content * decay - content) * 10) / 10 });
  if (fresh > 0) reasons.push({ label: '新着ボーナス', points: Math.round(fresh * 10) / 10 });

  return {
    score: Math.round(score * 100) / 100,
    contentScore: content,
    decay: Math.round(decay * 1000) / 1000,
    category: classifyNews(item),
    overseas,
    reasons,
  };
}

/**
 * カテゴリ分類(純関数)。優先順は「速報 > コモディティ > 地政学 > 個別株 > 経済」。
 * ★どれにも当たらなければ null を返す。無理にラベルを付けないこと(チップの意味を保つため)。
 *
 * 速報を最優先にするのは、画像のとおり速報が最も目を引くべき区分だから。
 * コモディティを経済より先に見るのは、原油・金の記事はほぼ必ず「相場」「価格」を含み、
 * 経済判定に先に吸われてしまうため(より具体的な方を勝たせる)。
 */
export function classifyNews(item: NewsItem): NewsCategory | null {
  const hay = `${item.title} ${item.source}`.toLowerCase();
  if (hit(hay, BREAKING_KEYWORDS)) return 'breaking';
  if (hit(hay, COMMODITY_KEYWORDS)) return 'commodity';
  if (hit(hay, GEOPOLITICS_KEYWORDS)) return 'geopolitics';
  if (hit(hay, HEAVYWEIGHT_TIER1) || hit(hay, HEAVYWEIGHT_TIER2)) return 'stock';
  if (hit(hay, ECONOMY_KEYWORDS)) return 'economy';
  return null;
}

/**
 * インパクト×鮮度で並べ替え、各件に impact を付けて返す(非破壊)。
 * 同点は新しい方を上にする(決定的な順序にするため id で最終タイブレーク)。
 */
export function rankNewsByImpact(items: readonly NewsItem[], now: number): NewsItem[] {
  return items
    .map(n => ({ ...n, impact: scoreNewsImpact(n, now) }))
    .sort((a, b) =>
      b.impact.score - a.impact.score
      || b.publishedAt - a.publishedAt
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 相対時刻の表示文言(「22分前」「1時間前」)。画面と解析で同じ文言になるよう純関数で持つ。 */
export function relativeTimeLabel(publishedAt: number, now: number): string {
  const sec = Math.floor((now - publishedAt) / 1000);
  if (sec < 60) return 'たった今';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  return `${Math.floor(hour / 24)}日前`;
}
