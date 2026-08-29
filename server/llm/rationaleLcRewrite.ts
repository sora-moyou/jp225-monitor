// ═══ 理由欄に書かれた「旧LC幅」を新しい幅へ書き換える ═══════════════════════════════
//
// ■ ユーザー指示(逐語・2026-08-26):
//     「LCずらしは、シグナル書き換えとともに、理由欄に旧LC幅が記載されていた場合、
//       その幅の値もずらしてください。」
//
// ■ なぜ要るか
//   建値だけをずらす(損切りは動かさない)ので、幅が5円変わる。AI は理由文に
//   「（LC幅60円）押し安値の…」のように **自分が申告した幅** を書いている。
//   書き換えないと、画面と台帳に **実際には置かれていない幅** が残る
//   (このプロジェクトが繰り返し踏んできた「申告と実物の食い違い」そのもの)。
//
// ■ ★書き換えるのは 幅の数値だけ。**価格は書き換えない**。
//   価格をずらすことは 執行の都合であって相場の判断ではなく、
//   「70,000のブレイクを狙う」という理由と 70,005 の発注は矛盾しない(仕様・ユーザー確定)。
//   幅だけが「申告と実物」の食い違いを生むので、幅だけを直す。
//
// ■ ★測定を壊さないこと(重要)
//   lcAudit(根拠文の申告 vs 実際の幅)は parseScalpPlan の中で **ずらしの前** に採られている。
//   よってここで書き換えても、台帳の lc_audit_json は **AI の生の申告** のまま残る。
//   ★順序を入れ替えると、私たちの5円が「AI の食い違い」として記録され、測定が汚れる。
//
// ■ ★なぜ core/ ではなく server/llm/ に置くのか(2026-08-26・移設)
//   脚の割り当て(どの見出しがどちらのレッグか)の **権威は server/llm/rationaleLc.ts の
//   headingMarks** で、core は server を import できない(理由は core/rationaleDisplay.ts 冒頭)。
//   core に置くと語彙の写しが3つめになり、実測で欠陥が出た(下の headingMarks の項を見よ)。
//   applyPivotNudge は元から server/llm/scalpPlan.ts に在るので、ここに置けば import で共有できる。

import { headingMarks, type LcLegKind } from './rationaleLc.js';

/** 幅のラベル(planVariants.ts の WIDTH_LABEL と同じ語彙。★裸の「幅」は入れない=「値幅80円」を誤読するため)。 */
const LC_LABEL_SRC = '(?:LC幅|損切り幅|損切幅|ロスカット幅|LC)';
/** ラベルと数値の間に来うるもの(「LC幅は」「LC=」「LC幅(」…)。 */
const LC_SEP_SRC = '\\s*(?:は|が|[:：=＝])?\\s*[(（]?\\s*';

/** 1件ぶんの書き換え結果。 */
export interface ReasonRewrite {
  text: string;
  /** 書き換えた箇所の数(0 なら文中に旧幅の申告が無かった)。 */
  hits: number;
}

/**
 * ★式の中の幅は書き換えない。
 *   「65015+LC幅(55)=65070」のような代入の式では、幅だけ直すと式が **算術的に嘘** になる
 *   (建値はずらしても損切りは動かさないので、両辺のどちらも直せない)。
 *   よって「直前が + / −」または「直後が =」の申告は **触らずに残す**。
 */
function inArithmetic(text: string, labelStart: number, numEnd: number): boolean {
  const before = text.slice(Math.max(0, labelStart - 3), labelStart).replace(/\s/g, '');
  if (/[+\-＋－]$/.test(before)) return true;
  const after = text.slice(numEnd, numEnd + 4).replace(/\s/g, '');
  return /^[)）]?円?[=＝]/.test(after);
}

/**
 * 文中の「LC幅=<oldW>」を「LC幅=<newW>」に置き換える(ラベル付きの申告だけ)。
 * ★数値の前後に数字が続く形は拾わない(「LC=65400」= 価格を書いた形から 654 を拾う偽陽性を避ける)。
 */
export function rewriteLcWidth(text: string, oldW: number, newW: number): ReasonRewrite {
  if (!text || oldW === newW || !Number.isFinite(oldW) || !Number.isFinite(newW)) {
    return { text, hits: 0 };
  }
  const re = new RegExp(`${LC_LABEL_SRC}${LC_SEP_SRC}(${oldW})(?!\\d)`, 'g');
  let hits = 0;
  const out = text.replace(re, (m, num: string, off: number) => {
    const numEnd = off + m.length;
    if (inArithmetic(text, off, numEnd)) return m;
    hits++;
    return m.slice(0, m.length - num.length) + String(newW);
  });
  return { text: out, hits };
}

/** 理由文を注文タイプの見出しで区切ったときの1区間。 */
interface KindSpan { start: number; end: number; kind: LcLegKind | null }

/**
 * ★見出しでレッグに割り当てる。
 *
 * ■ ★語彙は自前で持たない: **server/llm/rationaleLc.ts の headingMarks が唯一の権威**。
 *   ここで自前の `/逆指値|指値/` を使っていたのが実データで壊れた(2026-08-26・実測):
 *     signal_plans 2,685件 のうち 2脚の根拠文 1,105件で、**84.8%(937件)** が「逆指値」の語を
 *     含まず、AI は逆指値レッグを **「ブレイク新規」**(81.1%/896件)と書いていた。
 *     その結果 根拠文全体が「指値の区間」に入り、
 *       指値側の書き換えが2箇所以上に当たった = 596件(53.9%)
 *       逆指値側の書き換えが0箇所           = 1,012件(91.6%)
 *   ★headingMarks は「ブレイク新規 / 逆指値レッグ / lcWidthForStop / …」まで見る。
 *     長い語から先に照合する順序も向こうが担保している(「逆指値」の中の「指値」を拾わない)。
 * ■ 見出しより前の文は null(どちらとも言えない)。
 */
export function kindSpans(text: string): KindSpan[] {
  const marks = headingMarks(text);
  if (!marks.length) return [{ start: 0, end: text.length, kind: null }];
  const spans: KindSpan[] = [];
  if (marks[0]!.at > 0) spans.push({ start: 0, end: marks[0]!.at, kind: null });
  for (let i = 0; i < marks.length; i++) {
    spans.push({ start: marks[i]!.at, end: marks[i + 1]?.at ?? text.length, kind: marks[i]!.leg });
  }
  return spans;
}

/**
 * ★1脚ぶんの書き換え。**その脚に割り当てられた区間だけ** を直す。
 *
 *  - `own` が true(entryWhyForLimit のように **その脚専用の箱**)なら 文全体を直す。
 *  - 共有の根拠文(rationale)は 見出しで割り当てた区間だけを直す。
 *    見出しが1つも無い文は、`soleLeg` が true(残った脚がその1本だけ)のときに限り 全体を直す。
 *    ★どちらでもなければ **触らない**。取り違えて直すくらいなら、直さずに残すほうが良い
 *      (誤った書き換えは 台帳から「AI が何と言ったか」を永久に消す)。
 */
export function rewriteLcWidthForLeg(
  text: string | undefined,
  kind: LcLegKind,
  oldW: number,
  newW: number,
  opts: { own?: boolean; soleLeg?: boolean } = {},
): ReasonRewrite {
  if (!text) return { text: text ?? '', hits: 0 };
  if (opts.own) return rewriteLcWidth(text, oldW, newW);
  const spans = kindSpans(text);
  if (spans.length === 1 && spans[0]!.kind === null) {
    return opts.soleLeg ? rewriteLcWidth(text, oldW, newW) : { text, hits: 0 };
  }
  let out = '';
  let hits = 0;
  for (const s of spans) {
    const chunk = text.slice(s.start, s.end);
    if (s.kind !== kind) { out += chunk; continue; }
    const r = rewriteLcWidth(chunk, oldW, newW);
    out += r.text;
    hits += r.hits;
  }
  return { text: out, hits };
}
