import { getCachedBars } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
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
  const smaShort = sma(5);
  const smaLong = sma(60);
  const { change15min, range1h } = computeContext(bars);
  const trend =
    cur > smaShort && smaShort > smaLong ? '上昇寄り' :
    cur < smaShort && smaShort < smaLong ? '下降寄り' : 'レンジ/もみ合い';
  const lines = [
    `現値 ${cur.toFixed(1)}`,
    range1h ? `1時間 高値 ${range1h.high.toFixed(1)} / 安値 ${range1h.low.toFixed(1)}` : null,
    change15min !== null ? `15分変化率 ${change15min >= 0 ? '+' : ''}${change15min.toFixed(2)}%` : null,
    `短期(5分平均) ${smaShort.toFixed(1)} / 長期(60分平均) ${smaLong.toFixed(1)} → 傾向: ${trend}`,
  ].filter((x): x is string => x !== null);
  return `■ 日経225先物 (NIY=F) テクニカル:\n${lines.join('\n')}`;
}
