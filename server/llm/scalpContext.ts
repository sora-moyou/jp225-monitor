// scalp-plan の「構造化データ厚盛り」ブロックを組み立てる純関数(IO/時計なし=テスト可能)。
//
// 方針(ユーザー哲学): AI には画像＋我々の事前判定だけでなく、生の数値(実OHLC/節目強度/ボラ/スイング/
// アラート結果/成績)を広く渡し、AI 自身に相場を読ませる。ここは DB を触らず、runner が取得した
// bars/levels/alerts/trades を受け取り、コンパクトな日本語ブロックに整形するだけ。
//
// 各サブブロックは try で囲み、入力欠落・計算失敗はそのブロックを省略する(scalp-plan を壊さない)。
// トークン節約のためコンパクトに(足は1行に横並び・節目は近い順 上位のみ)。

import type { Bar1m, AlertRow, SignalTradeRow, SessionOHLC } from '../db/store.js';
import type { LevelsResult } from '../levels.js';
import { rowKind } from '../alertHistory.js';
import { classifySession, minutesFromOpen } from '../../collector/session.js';
import { extractSwingPivots } from '../swingPivots.js';

const MIN = 60_000;

/** JST の HH:MM。 */
function hhmm(t: number): string {
  return new Date(t).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
}

const R = (n: number): number => Math.round(n);

interface OHLCBar { t: number; o: number; h: number; l: number; c: number; }

/** 1分足(昇順)を tfMs 足へ集約(O=最初/H=最大/L=最小/C=最後)。5分足生成に使う。 */
function aggregateBars(bars: OHLCBar[], tfMs: number): OHLCBar[] {
  const m = new Map<number, OHLCBar>();
  for (const b of bars) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    const e = m.get(k);
    if (!e) m.set(k, { t: k, o: b.o, h: b.h, l: b.l, c: b.c });
    else { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; e.c = b.c; }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

/** ATR(14) を 1分足の真のレンジ平均で算出。バー2本未満は null。 */
function computeAtr14(bars: OHLCBar[]): number | null {
  if (!bars || bars.length < 2) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!, prev = bars[i - 1]!;
    trs.push(Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c)));
  }
  const last = trs.slice(-14);
  if (last.length === 0) return null;
  return last.reduce((a, b) => a + b, 0) / last.length;
}

export interface ScalpMarketDataInput {
  /** DB の実 OHLC(o/h/l/c)。昇順(t 昇順)。realtime の close-only ではなく getRecentBars を渡す。 */
  bars: Bar1m[];
  /** getLevelsSnapshot() の節目。null/空は当該ブロック省略。 */
  levels: LevelsResult | null;
  /** getRecentAlerts()。新しい順。ret5/15/30 があれば「その後」を併記。 */
  alerts: AlertRow[];
  now: number;
  /** 現在値(NIY=F)。距離/位置計算に使う。 */
  currentPrice: number;
  /** 本日セッション OHLC(getSessionOHLC[0])。あれば本日高安を正として使う(無ければ bars から近似)。 */
  session?: SessionOHLC | null;
}

/** 構造化された市場データ(数値主軸)ブロックをコンパクトな日本語で組み立てる純関数。
 *  足/節目/ボラ/スイング/アラート結果/セッションを各サブブロックにまとめ、欠落は省略。全欠落は ''。 */
export function buildScalpMarketData(input: ScalpMarketDataInput): string {
  const { levels, alerts, now, currentPrice } = input;
  const bars: OHLCBar[] = Array.isArray(input.bars) ? input.bars : [];
  const blocks: string[] = [];

  // A. 直近の足(数値・実OHLC)。1分足 直近15本 + 5分足 直近8本を横並びで。
  try {
    if (bars.length > 0) {
      const fmt = (b: OHLCBar): string => `${hhmm(b.t)} ${R(b.o)}/${R(b.h)}/${R(b.l)}/${R(b.c)}`;
      const last1m = bars.slice(-15);
      const bars5 = aggregateBars(bars, 5 * MIN).slice(-8);
      const lines: string[] = [];
      if (bars5.length > 0) lines.push('5分足: ' + bars5.map(fmt).join(' | '));
      lines.push('1分足: ' + last1m.map(fmt).join(' | '));
      blocks.push('直近の足(時刻 O/H/L/C):\n' + lines.join('\n'));
    }
  } catch { /* 省略 */ }

  // B. 節目(強度つき)。up=レジスタンス/down=サポート。現在値に近い順 上位8。
  try {
    if (levels && (levels.up.length > 0 || levels.down.length > 0)) {
      const all = [
        ...levels.up.map(l => ({ l, kind: 'レジ' })),
        ...levels.down.map(l => ({ l, kind: 'サポ' })),
      ];
      const near = all
        .map(x => ({ ...x, ad: Math.abs(x.l.price - currentPrice) }))
        .sort((a, b) => a.ad - b.ad)
        .slice(0, 8);
      const lines = near.map(({ l, kind }) => {
        const d = l.price - currentPrice;
        const star = l.tier >= 2 ? ' ★★' : l.tier >= 1 ? ' ★' : '';
        const lab = l.labels && l.labels.length > 0 ? ` ${l.labels[0]}` : '';
        return `${R(l.price)} ${kind} ${d >= 0 ? '+' : ''}${R(d)}円${star} s${l.score.toFixed(1)}${lab}`;
      });
      blocks.push('主要節目(現在値からの距離・強度 ★/s=スコア):\n' + lines.join('\n'));
    }
  } catch { /* 省略 */ }

  // C. ボラ/レンジ。ATR14 + 本日高安 + レンジ内位置 + 高安までの距離。
  try {
    const atr = computeAtr14(bars);
    const sess = input.session ?? null;
    let hi: number | null = sess ? sess.high : null;
    let lo: number | null = sess ? sess.low : null;
    if ((hi === null || lo === null) && bars.length > 0) {
      hi = Math.max(...bars.map(b => b.h));
      lo = Math.min(...bars.map(b => b.l));
    }
    const parts: string[] = [];
    if (atr !== null) parts.push(`ATR14(1分)≈${R(atr)}円`);
    if (hi !== null && lo !== null && hi > lo && currentPrice > 0) {
      const pos = ((currentPrice - lo) / (hi - lo)) * 100;
      parts.push(`本日高安 ${R(hi)}〜${R(lo)}(レンジ内位置${R(pos)}%)`);
      parts.push(`高値まで+${R(hi - currentPrice)}円 / 安値まで-${R(currentPrice - lo)}円`);
    }
    if (parts.length > 0) blocks.push('ボラ/レンジ: ' + parts.join(' / '));
  } catch { /* 省略 */ }

  // D. スイング構造。確定スイングピボット 直近3。
  try {
    if (bars.length > 0 && currentPrice > 0) {
      const reclaim = Math.max(1, Math.round(currentPrice * 0.003));
      const piv = extractSwingPivots(bars.map(b => ({ t: b.t, h: b.h, l: b.l })), reclaim).slice(-3);
      if (piv.length > 0) {
        const s = piv.map(p => `${p.kind === 'low' ? '安値' : '高値'}${R(p.price)}(${hhmm(p.t)})`).join(' → ');
        blocks.push('直近スイング: ' + s);
      }
    }
  } catch { /* 省略 */ }

  // E. 直近アラート＋その後(ret5/15/30 の実結果)。
  try {
    const recent = (alerts ?? []).slice(0, 5);
    if (recent.length > 0) {
      const lines = recent.map(a => {
        const arrow = a.direction === 'up' ? '▲' : a.direction === 'down' ? '▼' : '';
        const price = a.price != null ? R(a.price) : '-';
        const out: string[] = [];
        if (a.ret5 != null) out.push(`5分${a.ret5 >= 0 ? '+' : ''}${a.ret5.toFixed(2)}%`);
        if (a.ret15 != null) out.push(`15分${a.ret15 >= 0 ? '+' : ''}${a.ret15.toFixed(2)}%`);
        if (a.ret30 != null) out.push(`30分${a.ret30 >= 0 ? '+' : ''}${a.ret30.toFixed(2)}%`);
        const tail = out.length > 0 ? ' → ' + out.join('/') : '';
        return `${hhmm(a.triggered_at)} ${rowKind(a.detection_kind, a.window_seconds)} ${arrow}${price}${tail}`;
      });
      blocks.push('直近アラートとその後(発火後の実リターン):\n' + lines.join('\n'));
    }
  } catch { /* 省略 */ }

  // F. セッション/時刻。
  try {
    const jst = new Date(now).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });
    const s = classifySession(now);
    if (s) {
      const mo = minutesFromOpen(now);
      const sessJa = s.session === 'Day' ? '日中' : 'ナイト';
      blocks.push(`セッション/時刻: ${sessJa} ${jst}${mo != null ? `(寄付から${mo}分)` : ''}`);
    } else {
      blocks.push(`セッション/時刻: 取引時間外 ${jst}`);
    }
  } catch { /* 省略 */ }

  if (blocks.length === 0) return '';
  return '■ 構造化データ(数値主軸・最優先の判断材料):\n' + blocks.join('\n\n');
}

interface HistGroup { n: number; wr: number; pnl: number; }

/** このシグナルエンジン自身の直近成績(勝率/pnl・方向別/mode別・直近の負け例)を組み立てる純関数。
 *  結果から学ばせるフィードバック。件数が少ない(<3)/空は '' を返す(省略)。now は将来の経過表示用に受ける。 */
export function buildScalpTradeHistory(trades: SignalTradeRow[], now: number): string {
  void now;   // 予約(将来: 直近何時間の成績かを明示)。現状は件数ベースで集計。
  if (!Array.isArray(trades) || trades.length < 3) return '';
  const n = trades.length;
  const wr = (w: number, tot: number): number => tot > 0 ? Math.round((w / tot) * 100) : 0;
  const sgn = (v: number): string => `${v >= 0 ? '+' : ''}${Math.round(v)}`;
  const grp = (pred: (t: SignalTradeRow) => boolean): HistGroup => {
    const g = trades.filter(pred);
    return { n: g.length, wr: wr(g.filter(t => t.pnl > 0).length, g.length), pnl: g.reduce((a, t) => a + t.pnl, 0) };
  };
  const wins = trades.filter(t => t.pnl > 0).length;
  const net = trades.reduce((a, t) => a + t.pnl, 0);
  const buy = grp(t => t.dir === 'buy');
  const sell = grp(t => t.dir === 'sell');
  // mode: NULL/未指定は directional 扱い(後方互換)。
  const dir = grp(t => (t.mode ?? 'directional') !== 'range');
  const rng = grp(t => t.mode === 'range');
  const losers = trades.filter(t => t.pnl < 0).slice(0, 4)
    .map(t => `${t.dir} ${R(t.entry_price)}→${R(t.exit_price)} ${sgn(t.pnl)}`);

  const lines: string[] = [];
  lines.push(`全体: ${n}件 勝率${wr(wins, n)}% 純損益${sgn(net)}pt`);
  lines.push(`方向別: buy ${buy.n}件 勝率${buy.wr}% ${sgn(buy.pnl)} / sell ${sell.n}件 勝率${sell.wr}% ${sgn(sell.pnl)}`);
  lines.push(`mode別: directional ${dir.n}件 勝率${dir.wr}% ${sgn(dir.pnl)} / range ${rng.n}件 勝率${rng.wr}% ${sgn(rng.pnl)}`);
  if (losers.length > 0) lines.push(`直近の負け: ${losers.join(' / ')}`);

  return '■ 直近のあなた(本シグナルエンジン)の紙トレード成績。同じ失敗を繰り返さないよう改善に使え。\n'
    + lines.join('\n');
}
