// scalp-plan の「構造化データ厚盛り」ブロックを組み立てる純関数(IO/時計なし=テスト可能)。
//
// 方針(ユーザー哲学): AI には画像＋我々の事前判定だけでなく、生の数値(実OHLC/節目強度/ボラ/スイング/
// アラート結果/成績)を広く渡し、AI 自身に相場を読ませる。ここは DB を触らず、runner が取得した
// bars/levels/alerts/trades を受け取り、コンパクトな日本語ブロックに整形するだけ。
//
// 各サブブロックは try で囲み、入力欠落・計算失敗はそのブロックを省略する(scalp-plan を壊さない)。
// トークン節約のためコンパクトに(足は1行に横並び・節目は近い順 上位のみ)。

import type { AlertRow, SignalTradeRow, SessionOHLC } from '../db/store.js';
import type { LevelsResult } from '../levels.js';
import type { SignalSettingsSnapshot } from '../types.js';
import { rowKind } from '../alertHistory.js';
import { classifySession, minutesFromOpen } from '../../core/session.js';
import { extractSwingPivots } from '../swingPivots.js';
import { computeIndicators } from '../indicators.js';

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
  /** 実 OHLC(o/h/l/c)の1分足。昇順(t 昇順)。runner は collectRecentBars(DBの bars_1m ∪ メモリ内ライブ足)を渡す
   *  (DB だけだと collector 未稼働の環境で0本になり、足/ボラ/スイング/テクニカルの各ブロックが消えるため)。
   *  型は OHLC の構造だけを要求する(Bar1m もそのまま渡せる)。 */
  bars: OHLCBar[];
  /** getLevelsSnapshot() の節目。null/空は当該ブロック省略。 */
  levels: LevelsResult | null;
  /** getRecentAlerts()。新しい順。ret5/15/30 があれば「その後」を併記。 */
  alerts: AlertRow[];
  now: number;
  /** 現在値(NIY=F)。距離/位置計算に使う。 */
  currentPrice: number;
  /** 本日セッション OHLC(getSessionOHLC[0])。あれば本日高安を正として使う(無ければ bars から近似)。 */
  session?: SessionOHLC | null;
  /** ★テクニカル指標ブロック(G)を出すか。未指定は true(既定ON)。false でブロック G を省略する
   *  (indicatorsEnabled=false のとき runner が渡す=AI へテクニカルを供給しない)。 */
  indicatorsEnabled?: boolean;
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

  // G. テクニカル指標(RSI/SMA/BB・5分足)。確定足(形成中の最後の1本を除く)で算出=安定値。直近推移も渡す。
  //    indicatorsEnabled=false のときは省略(AI へテクニカルを供給しない)。数値は SSOT の computeIndicators。
  try {
    if ((input.indicatorsEnabled ?? true) && bars.length > 0) {
      const bars5 = aggregateBars(bars, 5 * MIN);
      const closes = bars5.map(b => b.c).slice(0, -1);          // 形成中足を除く確定 close
      const times = bars5.map(b => b.t).slice(0, -1);
      if (closes.length >= 15) {
        const ind = computeIndicators(closes, times);
        const parts: string[] = [];
        if (ind.rsi != null) parts.push(`RSI14=${ind.rsi.toFixed(1)}${ind.rsi >= 70 ? '(買われすぎ)' : ind.rsi <= 30 ? '(売られすぎ)' : ''}`);
        if (ind.sma != null) parts.push(`SMA14=${R(ind.sma)}`);
        if (ind.bbLower != null && ind.bbUpper != null) parts.push(`BB[±1.5σ]=${R(ind.bbLower)}〜${R(ind.bbUpper)}`);
        if (ind.pctB != null) parts.push(`%B=${ind.pctB.toFixed(2)}(${ind.pctB >= 0.8 ? 'バンド上寄り' : ind.pctB <= 0.2 ? 'バンド下寄り' : '中央'})`);
        const lines: string[] = [];
        if (parts.length > 0) lines.push('現在値: ' + parts.join(' / '));
        // 直近12点の RSI 推移(過熱の推移を AI に見せる)。
        const tail = ind.series.slice(-12);
        const rsiSeq = tail.map(p => p.rsi != null ? String(Math.round(p.rsi)) : '—').join(' ');
        if (rsiSeq.trim()) lines.push(`RSI推移(直近${tail.length}点・古→新): ${rsiSeq}`);
        if (lines.length > 0) blocks.push('テクニカル指標(5分足・RSI14/SMA14/BB±1.5σ):\n' + lines.join('\n'));
      }
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
      // 符号は距離の向きをそのまま出す(通常は 高値=+ / 安値=−)。現値が高安を外れた場合も
      // 「+-118円」のような壊れた表記にならないよう、符号を二重に付けない。
      // ★挙動差はレンジ外の壊れた表記の解消のみ。レンジ内はバイト同一で、現値がちょうど高値/安値に
      //   一致する境界2点だけ「+0円 / -0円」→「0円」になる(意図した差・実害なし)。
      const toHigh = R(hi - currentPrice);
      const toLow = R(lo - currentPrice);
      const sgn = (v: number): string => `${v > 0 ? '+' : ''}${v}`;
      parts.push(`高値まで${sgn(toHigh)}円 / 安値まで${sgn(toLow)}円`);
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

/** ★v0.7.56: signal_trades.meta(JSON文字列)から実効設定スナップショットを取り出す純関数。
 *  meta 無し/壊れ/settings 欠落は null(=旧世代の記録=従来フォーマットにフォールバック)。 */
export function parseTradeSettings(meta: string | null): SignalSettingsSnapshot | null {
  if (!meta) return null;
  try {
    const o = JSON.parse(meta) as { settings?: unknown };
    const s = o?.settings;
    if (!s || typeof s !== 'object') return null;
    return s as SignalSettingsSnapshot;
  } catch { return null; }
}

/** knob モードの短ラベル。ai→'AI' / manual→'手動'。 */
function modeJa(m: 'manual' | 'ai' | undefined): string {
  return m === 'ai' ? 'AI' : '手動';
}

/** 1トレードの設定つき短要約。例「buy LC=120(AI) veto=AI bias=手動long → +65」。 */
function fmtTradeWithSettings(t: SignalTradeRow, s: SignalSettingsSnapshot, sgn: (v: number) => string): string {
  const lc = s.lcCeiling;
  const lcv = lc.value !== undefined ? String(lc.value) : '—';
  const biasV = s.bias.mode === 'manual' && typeof s.bias.value === 'string' ? s.bias.value : '';
  const biasLab = `bias=${modeJa(s.bias.mode)}${biasV && biasV !== 'none' ? biasV : ''}`;
  return `${t.dir} LC=${lcv}(${modeJa(lc.mode)}) veto=${modeJa(s.trendVeto.mode)} ${biasLab} → ${sgn(t.pnl)}`;
}

/** このシグナルエンジン自身の直近成績(勝率/pnl・方向別/mode別・直近の負け例)を組み立てる純関数。
 *  ★v0.7.56: meta.settings がある世代は「設定つき要約」と「委任別成績」も併記し、AI に「どの設定が効いたか」を学ばせる。
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
  // ★現在の連敗数(直近=trades[0] から負けが続く本数。getSignalTrades は exit_t DESC=新しい順)。
  //   range=AI 委任時に「単方向が機能していない→レンジ両面(range)が有効か」を AI が判断する材料。
  let lossStreak = 0;
  for (const t of trades) { if (t.pnl < 0) lossStreak++; else break; }
  if (lossStreak >= 2) lines.push(`★現在 ${lossStreak}連敗中(単方向が機能していない可能性→レンジ両面(range)への切替が有効か検討)`);

  // ★v0.7.56: 設定つき成績。meta.settings を持つトレードだけ集計/要約する(旧世代は従来行のみ)。
  const withSettings = trades
    .map(t => ({ t, s: parseTradeSettings(t.meta) }))
    .filter((x): x is { t: SignalTradeRow; s: SignalSettingsSnapshot } => x.s !== null);
  if (withSettings.length > 0) {
    // 委任別成績: knob の mode(ai/manual)で分けて勝率/pnl を出す(どの委任が効いたかを学ばせる)。
    const delegAgg = (pick: (s: SignalSettingsSnapshot) => 'manual' | 'ai'): { ai: HistGroup; manual: HistGroup } => {
      const g = (mode: 'manual' | 'ai'): HistGroup => {
        const rows = withSettings.filter(x => pick(x.s) === mode);
        return { n: rows.length, wr: wr(rows.filter(x => x.t.pnl > 0).length, rows.length), pnl: rows.reduce((a, x) => a + x.t.pnl, 0) };
      };
      return { ai: g('ai'), manual: g('manual') };
    };
    const fmtDeleg = (label: string, a: { ai: HistGroup; manual: HistGroup }): string => {
      const parts: string[] = [];
      if (a.ai.n > 0) parts.push(`AI n=${a.ai.n} 勝率${a.ai.wr}% ${sgn(a.ai.pnl)}`);
      if (a.manual.n > 0) parts.push(`手動 n=${a.manual.n} 勝率${a.manual.wr}% ${sgn(a.manual.pnl)}`);
      return `${label}: ${parts.join(' / ')}`;
    };
    lines.push(fmtDeleg('LC委任別', delegAgg(s => s.lcCeiling.mode)));
    lines.push(fmtDeleg('トレンドveto委任別', delegAgg(s => s.trendVeto.mode)));
    lines.push(fmtDeleg('バイアス委任別', delegAgg(s => s.bias.mode)));
    // 設定つき直近(最大5件)。「どの設定でエントリーしたか」を具体で示す。
    const recent = withSettings.slice(0, 5).map(x => fmtTradeWithSettings(x.t, x.s, sgn));
    if (recent.length > 0) lines.push(`設定つき直近: ${recent.join(' / ')}`);
  }

  return '■ 直近のあなた(本シグナルエンジン)の紙トレード成績。同じ失敗を繰り返さないよう改善に使え。\n'
    + lines.join('\n');
}
