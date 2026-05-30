import { getCachedBars } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';
const GRID = 250; // 節目(round number)グリッド(円)

interface Level { d: number; label: string; }

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
// 15〜60 分(約30分足)の時間軸でのテクニカル要約を返す。
// 上昇/下落の目途は「構造的レベル(1時間高安・本日高安)+ 250円節目」から
// 複数候補を近い順に列挙し、各値は現在値からの距離(5円丸め)で示す。
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

  const round5 = (v: number): number => Math.round(v / 5) * 5;
  const dist = (level: number): number => round5(level - cur);
  const fmt = (d: number): string => `${d >= 0 ? '+' : ''}${d}円`;

  const dayHigh = Math.max(...closes);
  const dayLow = Math.min(...closes);
  const gridUp1 = Math.ceil((cur + 5) / GRID) * GRID;
  const gridUp2 = gridUp1 + GRID;
  const gridDown1 = Math.floor((cur - 5) / GRID) * GRID;
  const gridDown2 = gridDown1 - GRID;

  // 構造的レベルを先に並べ(ラベル優先)、距離で重複除去・|距離|昇順・最大3件。
  const pick = (raw: Level[]): Level[] => {
    const seen = new Set<number>();
    const out: Level[] = [];
    for (const lv of raw) {
      if (lv.d === 0 || seen.has(lv.d)) continue;
      seen.add(lv.d);
      out.push(lv);
    }
    out.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    return out.slice(0, 3);
  };

  const upRaw: Level[] = [
    range1h ? { d: dist(range1h.high), label: '1時間高値' } : null,
    { d: dist(dayHigh), label: '本日高値' },
    { d: dist(gridUp1), label: `節目${gridUp1}` },
    { d: dist(gridUp2), label: `節目${gridUp2}` },
  ].filter((x): x is Level => x !== null && x.d > 0);
  const downRaw: Level[] = [
    range1h ? { d: dist(range1h.low), label: '1時間安値' } : null,
    { d: dist(dayLow), label: '本日安値' },
    { d: dist(gridDown1), label: `節目${gridDown1}` },
    { d: dist(gridDown2), label: `節目${gridDown2}` },
  ].filter((x): x is Level => x !== null && x.d < 0);

  const upStr = pick(upRaw).map(l => `${fmt(l.d)}(${l.label})`).join(' / ') || '(上値候補なし)';
  const downStr = pick(downRaw).map(l => `${fmt(l.d)}(${l.label})`).join(' / ') || '(下値候補なし)';

  const pct = (v: number | null, n: number): string | null =>
    v !== null ? `${n}分変化率 ${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : null;
  const chgLine = [pct(chg30, 30), pct(chg60, 60)].filter((x): x is string => x !== null).join(' / ');

  const lines = [
    `現値 ${cur.toFixed(1)}`,
    chgLine !== '' ? chgLine : null,
    `中期(15分平均) ${sma15.toFixed(1)} (現在値 ${fmt(dist(sma15))}) / 長期(60分平均) ${sma60.toFixed(1)} (現在値 ${fmt(dist(sma60))}) → 傾向: ${trend}`,
    `上昇目途候補: ${upStr}`,
    `下落目途候補: ${downStr}`,
  ].filter((x): x is string => x !== null);
  return `■ 日経225先物 (NIY=F) テクニカル(15〜60分):\n${lines.join('\n')}`;
}
