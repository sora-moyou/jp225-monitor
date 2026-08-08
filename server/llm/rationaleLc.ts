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
// ■ 対応する2書式(プロンプトの版で書き方が変わってきたので両方に出る)
//   ① 幅の申告   「指値レッグ LC=55円」「LC幅(55)」「LC幅は55円」「損切り幅は55円」
//   ② 代入の式   「指値レッグ 65540 + 55 = 65595」「65015+LC幅(55)=65070」(v0.9.62 以降に増えた形)
//   ★①で数値の後に必ず (?!\d) を置く。置かないと「LC=65400」(幅ではなく **価格** を書いた形)から
//     先頭3桁「654」を幅として拾い、食い違い件数を水増しする(実データで確認済みの偽陽性)。
//
// ■ レッグへの割り当て
//   文中の見出し(「指値」「ブレイク新規」「逆指値」)の位置でテキストを区切り、各数値を **直前の見出し** の
//   レッグに割り当てる。見出しより前に出た数値は unassigned(どちらとも言えない)に置く=無理に割り当てない。
//   ★「逆指値」は文字列として「指値」を含むため、必ず長い語から先に照合する(順序が逆だと全部 limit になる)。

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
}

/** 見出し(レッグ名)。★長い語を先に置く=「逆指値」の中の「指値」を拾わない。 */
const HEADING_RE = /ブレイク新規|逆指値レッグ|逆指値|stopLossForStop|stopEntry|指値レッグ|指値|stopLossForLimit|limitEntry/g;

/** 書式①(幅の申告)。4つの書き方を1つの交替で1回だけ走査する(=拾う順序が文の順序と一致する)。 */
const WIDTH_RE = new RegExp(
  [
    'LC\\s*[=＝:：]\\s*(\\d{1,3})(?!\\d)\\s*円?',
    'LC幅\\s*[（(]\\s*(\\d{1,3})(?!\\d)\\s*[)）]',
    'LC幅\\s*(?:は|が|＝|=|:|：)\\s*(\\d{1,3})(?!\\d)\\s*円?',
    '損切り幅\\s*(?:は|が|＝|=|:|：)?\\s*(\\d{1,3})(?!\\d)\\s*円',
  ].join('|'),
  'g',
);

/** 書式②(代入の式)。`65540 + 55 = 65595` / `65015+LC幅(55)=65070` / 全角記号も許す。 */
const EQUATION_RE =
  /(\d{4,6})(?!\d)\s*([+＋\-−ー])\s*(?:LC幅\s*[（(]\s*)?(\d{1,3})(?!\d)\s*[)）]?\s*[=＝]\s*(\d{4,6})(?!\d)/g;

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
      (w === 'ブレイク新規' || w.startsWith('逆指値') || w === 'stopEntry' || w === 'stopLossForStop') ? 'stop' : 'limit';
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

/** 根拠文から「AI が申告した LC幅」を読み取る(純関数・例外を投げない)。 */
export function parseLcDeclarations(rationale: string | null | undefined): LcDeclarations {
  const out: LcDeclarations = { limit: [], stop: [], unassigned: [], equations: [] };
  if (typeof rationale !== 'string' || rationale === '') return out;
  const marks = headingMarks(rationale);

  WIDTH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIDTH_RE.exec(rationale)) !== null) {
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
  while ((e = EQUATION_RE.exec(rationale)) !== null) {
    const a = Number(e[1]);
    const w = Number(e[3]);
    const b = Number(e[4]);
    if (![a, w, b].every(v => Number.isFinite(v))) continue;
    const op: '+' | '-' = /[+＋]/.test(e[2] ?? '') ? '+' : '-';
    out.equations.push({ a, op, w, b, selfConsistent: (op === '+' ? a + w : a - w) === b, leg: legBefore(marks, e.index) });
  }
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

/** レッグ群(AI が出した生の entry/stopLoss)と根拠文を突き合わせる(純関数・RECORD-ONLY)。
 *  ★status は3値。「一致(match)」と「読み取れなかった(undeclared)」を決して混ぜない。 */
export function auditLcDeclarations(
  rationale: string | null | undefined,
  legs: ReadonlyArray<{ leg: LcLegName; entry?: number | null; stopLoss?: number | null }>,
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
    out.push(row);
  }
  return out;
}
