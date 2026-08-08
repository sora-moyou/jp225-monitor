// core/newsConfidence.ts — ニュースの「確度」推定。★インパクトとは独立した軸。
//
// ★設計の核心(ユーザー指示):
//   「一番最初に出たソースは確認出来ない場合もありますが重要なものは鮮度が大切」
//   第一報は裏が取れていないのが普通で、しかも第一報こそ相場が動く。
//   したがって **裏が取れていない項目を落とさない・順位も下げない**。
//   代わりに「未確認」という **属性** を表示するだけにする。
//
// ★だから確度はスコアに混ぜない。
//   混ぜると「未確認 = 減点」になり、第一報が沈む=ユーザーの意図と正反対になる。
//   並びは core/newsImpact.ts の「インパクト × 鮮度」のまま。ここは表示専用の軸。
//   ただし **記録には両方残す**(DB の confidence 列)。後から
//   「未確認のまま出した第一報が実際どれだけ当たっていたか」を測れるようにするため。
//
// ★時間で変わること:
//   第一報は単独でも 30 分後には複数ソースに出る。判定は「その時点のニュースプール全体」に対して
//   行う純関数にし、取得のたびに評価し直す(永続化側は upsert で上書きする)。

import type { NewsItem } from './types.js';
import { bigramOverlap } from './textBigrams.js';
import { matchText, hitKeyword } from './keywordMatch.js';

export type NewsConfidenceLevel = 'confirmed' | 'unconfirmed';

/** どういう根拠でその確度になったか。★階層を細かくしすぎない(4 値まで)。 */
export type NewsConfidenceBasis =
  | 'primary'        // 一次情報(発表主体そのもの)。単独でも確認済み扱い。
  | 'wire'           // 通信社・主要報道機関。単独でも確認済み扱い。
  | 'corroborated'   // 別ソースにも同じ出来事が出ている(裏取り成立)。
  | 'single';        // 単独ソースかつ上のどれにも当たらない = 未確認。

export interface NewsConfidence {
  level: NewsConfidenceLevel;
  basis: NewsConfidenceBasis;
  /** 裏取りできた別ソース名(basis==='corroborated' のとき 1 件以上)。 */
  corroboratedBy: string[];
}

// ── ソースの階層 ──────────────────────────────────────────────────────────
// ★2 段だけにする(細かくしない)。判定できないものは 'single' = 未確認でよい。
//
// PRIMARY = 発表主体そのもの。ここが出したなら、それが一次情報そのもの。
//   Fed / ホワイトハウス / 米経済指標(発表値そのもの)。
//   ★ここは **ソース名の完全一致**(小文字化・trim のみ)で照合する。sourceTier のコメント参照。
//     server/config.ts の RSS_FEEDS に書いた name と一字一句同じにすること
//     (server/sources/rssAggregator.test.ts が突合して守る)。
export const PRIMARY_SOURCES: readonly string[] = [
  'fed', 'fed speeches', 'white house', 'ホワイトハウス', '米経済指標',
];

// WIRE = 通信社・自前取材の報道機関。単独報でも「裏取りなし」とは言わない。
//   ★ここに入れていないのは、集約・まとめ・論説・速報ブログ系(ZeroHedge / SeekingAlpha /
//     Benzinga / Investing.com / ForexLive / The Hill / 各種まとめ)。それらは単独だと 'single'。
//     速いのが取り柄のソースを落とさずに「未確認」と表示するのが、この機能の目的そのもの。
export const WIRE_SOURCES: readonly string[] = [
  'nhk', '共同', '朝日', '毎日', '日経', 'yahoo news', 'yahoo!ニュース',
  'cnbc', 'nyt', 'bbc', 'al jazeera', 'marketwatch', 'reuters', 'ロイター', '東洋経済',
];

/**
 * 裏取り成立とみなす見出しの重なり率。
 * ★0.5 の根拠: 同じ出来事の別社見出しは、固有名詞(日銀/トランプ/関税)と数値が共通するので
 *   短い方のバイグラムの過半は一致する。0.3 まで下げると「日銀」だけ共通の別ニュースが
 *   裏取り扱いになり、0.7 まで上げると要約と詳報が別物になる(実データで確認して調整すること)。
 */
export const CORROBORATION_THRESHOLD = 0.5;

/**
 * ソース名を階層に落とす。
 *
 * ★primary は **名前の完全一致**(前後の空白と大小だけ無視)。
 *   理由: primary = 「発表主体そのもの」。どのフィードが発表主体かは server/config.ts で
 *   こちらが決めており、名前は完全に既知(Fed / Fed Speeches / White House / 米経済指標)。
 *   一方 nikkei225jp 経由の source は **上流が付けた任意の文字列** が入る。部分一致だと
 *   "Fed Watch Blog" や "Confederation of Industry" のような第三者ブログが
 *   「一次情報」を名乗れてしまう(素の includes では実際に primary になっていた)。
 *   一次情報の看板は詐称できてはいけないので、ここだけは完全一致にする。
 *
 * ★wire は語境界つきの部分一致。取得元の表示名に接尾辞が付く('NHK ビジネス' / 'CNBC Top News')
 *   ため完全一致にはできない。ただし素の includes ではなく単語境界で当てる
 *   (= 'nhk' が別語の一部に埋もれて当たることがない)。
 */
export function sourceTier(source: string): 'primary' | 'wire' | 'other' {
  const name = source.trim().toLowerCase();
  if (PRIMARY_SOURCES.includes(name)) return 'primary';
  if (hitKeyword(matchText(source), WIRE_SOURCES) !== null) return 'wire';
  return 'other';
}

/**
 * プール全体に対して確度を判定する純関数(同じ入力なら必ず同じ出力)。
 * 裏取りは「**別ソース** の見出しと十分に重なるか」で見る。同一ソース内の続報は裏取りではない。
 */
export function assessConfidence(items: readonly NewsItem[]): Map<string, NewsConfidence> {
  const out = new Map<string, NewsConfidence>();
  for (const item of items) {
    const tier = sourceTier(item.source);
    // 裏取り探索は常に行う(basis の決定より先)。記録として「誰が裏を取ったか」を残したいため。
    const corroboratedBy: string[] = [];
    for (const other of items) {
      if (other.id === item.id) continue;
      if (other.source === item.source) continue;   // 同一ソースの続報は裏取りにならない
      if (corroboratedBy.includes(other.source)) continue;
      if (bigramOverlap(item.title, other.title) >= CORROBORATION_THRESHOLD) {
        corroboratedBy.push(other.source);
      }
    }
    const basis: NewsConfidenceBasis =
      tier === 'primary' ? 'primary'
      : tier === 'wire' ? 'wire'
      : corroboratedBy.length > 0 ? 'corroborated'
      : 'single';
    out.set(item.id, {
      level: basis === 'single' ? 'unconfirmed' : 'confirmed',
      basis,
      corroboratedBy,
    });
  }
  return out;
}

/** items に confidence を付けて返す(非破壊)。取得ループはこれを使う。 */
export function withConfidence(items: readonly NewsItem[]): NewsItem[] {
  const map = assessConfidence(items);
  return items.map(n => ({ ...n, confidence: map.get(n.id) }));
}

// ── 確度は前進だけする(降格させない) ──────────────────────────────────────
//
// ★なぜ必要か(実際に起きること):
//   assessConfidence は **その時点のニュースプール(直近200件)** だけを見る。
//   T   : A社の第一報 と B社の後追いが両方プールに居る → A は corroborated = 確認済み
//   T+n : B社の記事が 200件の窓から押し出される       → A は再び single = 未確認
//   つまり「時間経過で再評価する」が **逆方向にも効いてしまう**。
//   ・画面: 一度「確認済み」と読んだ記事が、次の再描画で「？未確認」に戻る。
//   ・DB : upsert が毎回上書きするので、**残したはずの記録まで消える**。
//   後から的中率を検証するのがこの機能の主目的なので、記録が消えるのは機能の否定になる。
//
// ★だから「裏が取れた」という事実は **単調** に扱う。裏取りは一度成立したら取り消されない
//   (相手の記事が窓から出ただけで、報じられた事実そのものは無かったことにならない)。
//   逆に単独→裏取り済みへの前進は従来どおり反映する。
const CONFIRMED_BASES: readonly NewsConfidenceBasis[] = ['primary', 'wire', 'corroborated'];

/** その根拠が「確認済み」を意味するか。 */
export function isConfirmedBasis(basis: string | null | undefined): boolean {
  return basis != null && (CONFIRMED_BASES as readonly string[]).includes(basis);
}

/**
 * 既知の確度(prev)と今回の判定(next)を統合する純関数。**confirmed からは降格しない**。
 * prev が無ければ next をそのまま返す。
 */
export function mergeConfidence(
  prev: NewsConfidence | undefined,
  next: NewsConfidence,
): NewsConfidence {
  if (!prev || prev.level !== 'confirmed') return next;
  if (next.level === 'confirmed') {
    // 両方 confirmed。裏取り相手の一覧は「今回見つけた分」と「前回の分」の和にする
    // (窓から出た相手の名前を失わない)。
    if (next.basis === 'corroborated' && prev.basis === 'corroborated') {
      const names = [...new Set([...next.corroboratedBy, ...prev.corroboratedBy])];
      return { ...next, corroboratedBy: names };
    }
    return next;
  }
  // next が unconfirmed = 降格。prev を維持する(これが今回の修正の本体)。
  return prev;
}

/**
 * バッジの文言。★警告ではなく **属性** として出す(ユーザー指示)。
 * 赤で大きく出すと「見るな」の意味に読めるが、意図は逆で「速い情報として使いたい」。
 * 確認済みには何も出さない(無印)= 未確認だけが控えめに目印を持つ。
 */
export function confidenceBadgeLabel(c: NewsConfidence | undefined): string | null {
  return c && c.level === 'unconfirmed' ? '？未確認' : null;
}

/** バッジの補足(title 属性)。なぜその判定なのかを画面から辿れるようにする。 */
export function confidenceTooltip(c: NewsConfidence | undefined): string {
  if (!c) return '';
  switch (c.basis) {
    case 'primary': return '一次情報(発表主体そのもの)';
    case 'wire': return '通信社・主要報道機関';
    // ★裏取り相手が一覧から押し出されると名前が残らないことがある。その場合でも
    //   「裏取り済み」という判定自体は取り消さない(降格させない)ので、正直にそう書く。
    case 'corroborated': return c.corroboratedBy.length > 0
      ? `裏取りあり: ${c.corroboratedBy.join(' / ')}`
      : '裏取りあり(別ソースが同じ出来事を報じた。相手の記事は現在の一覧から外れています)';
    case 'single': return '単独ソースのみ。裏取りなし(第一報の可能性)。速報性を優先して表示しています';
  }
}
