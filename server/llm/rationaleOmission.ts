// 根拠文の「そのレッグは出さない」という **表明** と、実際に発注されるレッグを突き合わせる純関数群
// (RECORD-ONLY)。
//
// ■ なぜ要るか(実測 2026-08-08 / 運用機の台帳)
//   AI は根拠文に「ブレイク新規は下限に届かないので省略した」と書きながら、JSON には **下限を満たす
//   有効な価格対** を入れてくることがある。この場合コードは何も落とさない(落ちるのは lcFloor / stopSide に
//   掛かったときだけ)ので、そのレッグは **そのまま発注される**。
//   つまり「AI が出さないと言ったレッグが実際には出る」= 意図と注文が食い違ったまま素通りする。
//   ★ここは lc_audit(rationaleLc.ts)と同じ思想: JSON だけ見ても(有効な対に見える)、根拠文だけ見ても
//     (正しく省略したと読める)検出できない。**両方を突き合わせて初めて** 見える故障。
//
// ■ 検出は判定に使わない
//   ここで出す値は台帳(signal_plans.omission_audit_json / proposals.omission_audit_json)に載せるだけ。
//   採否・価格・noneReason・legDrops の意味は1バイトも変えない。落としも直しもしない
//   (落とせば機会損失が増え、直せば『AI が直ったのか、コードが隠しているだけか』が分からなくなる)。
//   まず **頻度を測る**。
//
// ■ 誤検出をどう避けるか(ここが要点)
//   「指値レッグは出したが、ブレイク新規は省略した」という **正しい表明** を拾ってはいけない。
//   だから表明の語(省略/見送 等)を見つけたら、**同じ文の中で直前にある見出し**(指値/ブレイク新規)の
//   レッグにだけ割り当てる。見出しが同じ文に無ければ **どのレッグとも言えない** ので捨てる(推測しない)。
//   見出しの語彙は rationaleLc.ts の headingMarks を再利用する(同じ知識を2箇所に置かない)。
//   さらに否定形(「省略しない」「見送らない」)は表明ではないので除く。

import { headingMarks, type LcLegKind } from './rationaleLc.js';

/** 表明の対象になりうるレッグ(方向レッグの2本)。
 *  ★レンジ脚(upper/lower)を含めない理由: 根拠文の見出し(指値/ブレイク新規)では上下を区別できず、
 *    無理に割り当てると誤検出になる。読めないものを読めたことにはしない。 */
export type OmissionLegName = LcLegKind;

/** 「出さない」と述べた表明1件。 */
export interface OmissionClaim {
  /** どのレッグについての表明か(同じ文の直前の見出しで決める)。 */
  leg: OmissionLegName;
  /** 実際に本文にあった表明の語(省略 / 見送 / 出さない …)。 */
  word: string;
}

/** 表明と実際の発注の突き合わせ1件(記録専用)。 */
export interface OmissionClaimCheck extends OmissionClaim {
  /** そのレッグが **最終プランに在る**(= 実際に発注される)か。 */
  present: boolean;
  /** consistent = 表明どおり出していない / contradiction = 出さないと述べたのに発注される。 */
  status: 'consistent' | 'contradiction';
}

/** 表明の語と、その直後に来たら **否定** になる形。
 *  ★「省略しない」「見送らない」は表明ではない(むしろ逆)ので、必ず除く。 */
const CLAIM_WORDS: ReadonlyArray<{ word: string; negation?: RegExp }> = [
  { word: '省略', negation: /^(?:し(?:ない|ません|なかった)|せ(?:ず|ぬ))/ },
  { word: '見送', negation: /^(?:ら(?:ない|ず)|りません)/ },
  { word: '出さない' },
  { word: '出しません' },
  { word: '提示しない' },
  { word: '提示せず' },
  { word: '出力しない' },
  { word: '出力せず' },
];

/** 文の切れ目(ここを跨いだ見出しは「同じ文」ではない)。 */
const SENTENCE_BREAK = /[。．\.\n\r]/;

/** 句の切れ目(読点)。同じ **句** に在る見出しは、その表明の主語とみなしてよい。 */
const CLAUSE_BREAK = /[、，,]/;

/** idx より前で最も近い、re に当たる位置(無ければ -1)。 */
function lastBreakBefore(text: string, idx: number, re: RegExp): number {
  for (let i = idx - 1; i >= 0; i--) {
    if (re.test(text[i]!)) return i;
  }
  return -1;
}

/** 根拠文から「そのレッグは出さない」という表明を読み取る(純関数・例外を投げない)。
 *  同じレッグへの表明が複数あっても1件にまとめる(同じ事実を二重に数えない)。 */
export function parseOmissionClaims(rationale: string | null | undefined): OmissionClaim[] {
  if (typeof rationale !== 'string' || rationale === '') return [];
  const marks = headingMarks(rationale);
  if (marks.length === 0) return [];
  const found = new Map<OmissionLegName, string>();
  for (const { word, negation } of CLAIM_WORDS) {
    let from = 0;
    for (;;) {
      const at = rationale.indexOf(word, from);
      if (at < 0) break;
      from = at + word.length;
      // 否定形(「省略しない」)は表明ではない。
      if (negation && negation.test(rationale.slice(from))) continue;
      // ★同じ文の中で **直前** にある見出しにだけ割り当てる。無ければ捨てる(推測しない)。
      const sentence = lastBreakBefore(rationale, at, SENTENCE_BREAK);
      const clause = Math.max(sentence, lastBreakBefore(rationale, at, CLAUSE_BREAK));
      let leg: OmissionLegName | null = null;
      const seen = new Set<OmissionLegName>();
      for (const m of marks) {
        if (m.at >= at) break;
        if (m.at > sentence) { leg = m.leg; seen.add(m.leg); }
      }
      if (!leg) continue;
      // ★どちらのレッグの表明か決められるか(決められないものは捨てる=推測しない):
      //   (a) **同じ句** に見出しが1種類だけ在る(「ブレイク新規は省略した」)= 表明の主語そのもの。
      //       「指値レッグは出したが、ブレイク新規は省略した」も、句が切れるのでここで正しく stop になる。
      //   (b) 同じ句に見出しが無いなら、その文に先行する見出しが **1種類だけ** のときに限る
      //       (「ブレイク新規レッグ LC=25円で、条件を満たさないため省略」)。
      //   同じ句に2種類ある(「指値やブレイク新規の場面が無いため見送り」)= どちらの話でもあるので捨てる。
      const clauseLegs = new Set(marks.filter(m => m.at > clause && m.at < at).map(m => m.leg));
      const decided = clauseLegs.size === 1 || (clauseLegs.size === 0 && seen.size === 1);
      if (!decided) continue;
      if (!found.has(leg)) found.set(leg, word);
    }
  }
  // 出現順ではなくレッグの固定順で返す(台帳の JSON が回ごとに並び替わらない)。
  const out: OmissionClaim[] = [];
  for (const leg of ['limit', 'stop'] as const) {
    const word = found.get(leg);
    if (word !== undefined) out.push({ leg, word });
  }
  return out;
}

/** 表明と **最終プランに残ったレッグ**(= 実際に発注されるレッグ)を突き合わせる(純関数・RECORD-ONLY)。
 *  present は呼び出し側が最終 plan から渡す(この関数は plan の形を知らない)。
 *  表明が1件も無ければ空配列(呼び出し側は空なら列に何も書かない)。 */
export function auditOmissionClaims(
  rationale: string | null | undefined,
  present: { limit: boolean; stop: boolean },
): OmissionClaimCheck[] {
  return parseOmissionClaims(rationale).map(c => {
    const p = c.leg === 'limit' ? present.limit : present.stop;
    return { ...c, present: p, status: p ? 'contradiction' : 'consistent' };
  });
}
