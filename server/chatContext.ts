import { getCachedBars } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
// 15〜60 分(約30分足)の時間軸でのテクニカル要約を返す。
// 上値/下値の基準値には「現在値からの距離(5円単位に丸め)」を付け、
// チャットがそのまま『上昇目途/下落目途』として引用できるようにする。
export function buildNikkeiTechnical(
  getBars: (symbol: string) => Bar[] = getCachedBars,
): string | null {
  const bars = getBars(NIKKEI);
  if (bars.length < 62) return null;
  const closes = bars.map(b => b.close);
  const cur = closes[closes.length - 1]!;
  const sma = (n: number): number => {
    const s = closes.slice(-n);
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const pctChange = (n: number): number | null => {
    const p = closes[closes.length - 1 - n];
    return p !== undefined && p > 0 ? ((cur - p) / p) * 100 : null;
  };
  const sma15 = sma(15);
  const sma60 = sma(60);
  const chg30 = pctChange(30);
  const chg60 = pctChange(60);
  const { range1h } = computeContext(bars);
  const trend =
    cur > sma15 && sma15 > sma60 ? '上昇寄り' :
    cur < sma15 && sma15 < sma60 ? '下降寄り' : 'レンジ/もみ合い';
  // 現在値からの距離を 5 円単位に丸めて「+〇〇円 / -〇〇円」形式に。
  const dist = (level: number): string => {
    const d = Math.round((level - cur) / 5) * 5;
    return `${d >= 0 ? '+' : ''}${d}円`;
  };
  const pct = (v: number | null, n: number): string | null =>
    v !== null ? `${n}分変化率 ${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : null;
  const chgLine = [pct(chg30, 30), pct(chg60, 60)].filter((x): x is string => x !== null).join(' / ');
  const lines = [
    `現値 ${cur.toFixed(1)}`,
    chgLine !== '' ? chgLine : null,
    `中期(15分平均) ${sma15.toFixed(1)} (現在値 ${dist(sma15)}) / 長期(60分平均) ${sma60.toFixed(1)} (現在値 ${dist(sma60)}) → 傾向: ${trend}`,
    range1h
      ? `1時間高値 ${range1h.high.toFixed(1)} (現在値 ${dist(range1h.high)}) / 1時間安値 ${range1h.low.toFixed(1)} (現在値 ${dist(range1h.low)})`
      : null,
  ].filter((x): x is string => x !== null);
  return `■ 日経225先物 (NIY=F) テクニカル(15〜60分):\n${lines.join('\n')}`;
}
