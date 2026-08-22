// server/llm/basedataContext.ts — ★基礎データ(日足)を AI 文脈の1ブロックにする **純関数**(v0.9.98)。
//
// ■ なぜ在るか(2026-08-22 の調査結果)
//   基礎データ(bars_1m の src='base'・約8か月/196,800本)は、これまで **AI に1文字も渡っていなかった**。
//     ・「長い時間軸」ブロック … RICH_BARS_WINDOW_MS = 6時間      → 届かない
//     ・節目ブロック           … fetchSessionsFor(10,20)=24セッション ≒ 12営業日 → 届かない
//     ・kind:'longHL'「長期高安」… その24セッションの高安     → ★名前に反して約2週間
//     ・ADR                    … ADR_SESSIONS = 20 ≒ 10営業日  → 届かない
//     ・日足MA25±σ / 日足MA5/20/50/75 … ★基礎データから **毎ティック計算済み**。ただし
//       用途は **アラートの発火だけ**(detect/registry.ts)で、server/llm/ からの参照は 0 だった。
//   = ★「すでに計算しているのに渡していないもの」を渡すだけ。新しい計算も新しい閾値も作らない。
//
// ■ SSOT
//   数値は アラートが使うのと **同じ関数・同じ系列** から作る(computeDailyMAs / computeDailyBands /
//   dailyCloseSeries)。AI が見る MA25 と、dailyband アラートが抜けたと言う MA25 は **必ず同じ値**。
//
// ■ ★「渡せなかった」を「無い」と分かる形にする(段2 の要件)
//   この関数は **状態を持たない**。呼び出しごとに渡された配列だけから文字列を作るので、
//   ★前回の値が残って古いまま渡ることが **構造的に起こらない**(キャッシュが無い)。
//   その上で、足りないものは黙って消さず **不足の事実を1行で書く**:
//     ・終値が1本も無い          → ブロックごと「取得できず」の1行
//     ・MA75 に本数が足りない    → `MA75=本数不足(終値62本)`
//     ・バンドに本数が足りない   → `日足バンド=本数不足(終値24本)`
//     ・日足OHLC が無い          → `日足OHLC=取得できず`
//   ★見出しに **確定日** を必ず書く。collector が止まっていて系列が古いとき、
//   「古い数値が新しい顔で渡る」ことを防ぐ唯一の手段がこれ(値だけ見ても古さは分からない)。
//
// ■ 向きの書き方
//   「上/下」ではなく **不等式** で書く(現在値>MA5 の形)。過去に「外側」という語の衝突で
//   損切りの向きを取り違えた事故があり、式で書くと符号の取り違えが起きにくいと分かっている。

import { computeDailyBands, computeDailyMAs, dailyCloseSeries, DAILY_CLOSES_KEEP } from '../dailyBand.js';

/** 日足1本(取引日=Day セッション)。store の SessionOHLC の部分集合だけを要求する(この層を leaf に保つ)。 */
export interface DailyBar {
  sessionDate: string;
  open: number; high: number; low: number; close: number;
}

export interface BasedataContextInput {
  /** 取引日終値(daily_closes 由来)。★古い→新しい順。進行中の日は含めない(確定終値のみ)。 */
  dailyCloses: number[];
  /** 取引日足 OHLC。★古い→新しい順。長期高安と直近N本の表示に使う。 */
  dailyBars: DailyBar[];
  /** 現在値(NIY=F)。進行中の取引日の終値として系列の末尾に足す=アラートと同じ扱い。 */
  currentPrice: number;
  /** ★どこまで書くか(A/B 分割・A ⊂ B)。
   *   'full'(既定) … 日足MA / 日足バンド / ★長期高安 / 日足OHLC。**B と、分割前の1回呼び出し** はこちら。
   *   'trend'      … 長期高安を **外す**。★A は「トレンド判断に有用なものだけ」で、
   *                  長期高安は **価格の候補**(節目)だから A には渡さない。
   *   ★既定を 'full' にしてあるので、段2 で入れた1回呼び出しの文面は1バイトも変わらない。 */
  scope?: 'full' | 'trend';
}

/** ★表示する日足OHLC の本数。**閾値ではない**(何かを判定する値ではなく、何本印字するかだけ)。 */
export const BASEDATA_RECENT_DAYS = 10;

/** 3桁区切りの整数(文脈の他ブロックと同じ見た目)。 */
const R = (v: number): string => Math.round(v).toLocaleString('en-US');

/** 'YYYY-MM-DD' → 'MM/DD'(日足の行は年を繰り返さない)。読めない値はそのまま返す。 */
const md = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(5).replace('-', '/') : d);

/**
 * 基礎データ(日足)ブロックを組み立てる純関数。★渡された配列だけを見る(DB も時計も触らない)。
 * 何も作れないときは '' を返す(呼び出し側が join で落とす)。
 */
export function buildBasedataContext(input: BasedataContextInput): string {
  const price = input.currentPrice;
  if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) return '';
  const closes = (Array.isArray(input.dailyCloses) ? input.dailyCloses : [])
    .filter(c => Number.isFinite(c) && c > 0);
  const bars = (Array.isArray(input.dailyBars) ? input.dailyBars : [])
    .filter(b => b && Number.isFinite(b.high) && Number.isFinite(b.low) && b.high > 0 && b.low > 0);

  // ★確定日: 系列がいつまでのものかを見出しに出す(古い系列が新しい顔で渡るのを防ぐ)。
  //   日足OHLC が取れていればその最終日、無ければ「不明」と書く(捏造しない)。
  const asOf = bars.length > 0 ? bars[bars.length - 1]!.sessionDate : null;
  const head = `基礎データ(日足・確定 ${asOf ?? '不明'} まで / 最大${DAILY_CLOSES_KEEP}営業日):`;

  if (closes.length === 0 && bars.length === 0) {
    // ★黙って消さない。「このサイクルでは基礎データを渡していない」と書く。
    return `${head}\n取得できず(このサイクルでは基礎データを渡していません)`;
  }

  const lines: string[] = [];

  // ① 日足MA(MA5/20/50/75) — アラートと同じ系列(確定終値 + 現在値)・同じ関数。
  if (closes.length > 0) {
    const series = dailyCloseSeries(closes, price, 75);
    const mas = computeDailyMAs(series);
    const got = new Set(mas.map(m => m.period));
    const parts = mas.map(m => `現在値${price > m.price ? '>' : price < m.price ? '<' : '='}${m.label}(${R(m.price)})`);
    // ★算出できなかった期間は黙って消さず、不足だと書く(「線が無い」と「線を出せない」を分ける)。
    const missing = [5, 20, 50, 75].filter(p => !got.has(p));
    if (missing.length > 0) parts.push(`${missing.map(p => 'MA' + p).join('/')}=本数不足(終値${series.length}本)`);
    lines.push('日足MA: ' + parts.join(' / '));
  } else {
    lines.push('日足MA=取得できず(取引日終値0本)');
  }

  // ② 日足バンド(MA25 ±1σ/±2σ) — 同上。位置は不等式で書く。
  if (closes.length > 0) {
    const series = dailyCloseSeries(closes, price);
    const bands = computeDailyBands(series);
    if (bands.length === 0) {
      lines.push(`日足バンド=本数不足(終値${series.length}本)`);
    } else {
      const sorted = [...bands].sort((a, b) => a.price - b.price);
      lines.push('日足バンド: ' + sorted.map(b => `${b.label}=${R(b.price)}`).join(' / '));
      // 現在値がどの2本の間にあるか(下から数えて最初に上回る水準の手前)。
      const below = sorted.filter(b => b.price <= price).at(-1);
      const above = sorted.find(b => b.price > price);
      const pos = below && above ? `${below.label} < 現在値 < ${above.label}`
        : above ? `現在値 < ${above.label}`
          : below ? `${below.label} < 現在値` : null;
      if (pos) lines.push('現在値の位置: ' + pos);
    }
  }

  // ③ ★本当の長期高安 — 取れた取引日足 **全体** の最高値/最安値と、その日付。
  //   ★節目ブロックの kind:'longHL'(24セッション ≒ 2週間)とは別物。名前が同じでも中身が違う。
  //   ★scope='trend'(A 向け)では **出さない**: これは価格の候補=節目であって、トレンドの判断材料ではない。
  if (input.scope === 'trend') {
    // ★黙って消すのではなく、消したことも書かない。A の文面に「長期高安」という語を
    //   1文字も出さないのが目的(A に価格の候補を見せない)。ここでは何も push しない。
  } else if (bars.length > 0) {
    const hi = bars.reduce((a, b) => (b.high > a.high ? b : a));
    const lo = bars.reduce((a, b) => (b.low < a.low ? b : a));
    lines.push(
      `長期高安(取引日足${bars.length}本): 高=${R(hi.high)}(${md(hi.sessionDate)}) / 安=${R(lo.low)}(${md(lo.sessionDate)})`,
    );
  } else {
    lines.push('長期高安=取得できず(取引日足0本)');
  }

  // ④ 日足OHLC 直近N本。
  if (bars.length > 0) {
    const recent = bars.slice(-BASEDATA_RECENT_DAYS);
    lines.push(
      `日足OHLC 直近${recent.length}本(日付 O/H/L/C): `
      + recent.map(b => `${md(b.sessionDate)} ${R(b.open)}/${R(b.high)}/${R(b.low)}/${R(b.close)}`).join(' | '),
    );
  } else {
    lines.push('日足OHLC=取得できず');
  }

  return head + '\n' + lines.join('\n');
}
