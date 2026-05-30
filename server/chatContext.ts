import { getCachedBars } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';
const GRID = 250; // 節目(round number)グリッド(円)

interface Level { d: number; label: string; reversal?: boolean; }

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
// 15〜60 分(約30分足)の時間軸でのテクニカル要約を返す。
// 上昇/下落の目途は「構造的レベル(1時間・4時間・本日の高安)+ 250円節目」から
// 複数候補を近い順に列挙し、各値は現在値からの距離(5円丸め)で示す。
// さらに、現在トレンドをブレイクで否定する節目を「トレンド転換」として付与する。
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
  const h4 = closes.slice(-240);          // 直近 4 時間(<240本なら取得分すべて)
  const fourHigh = Math.max(...h4);
  const fourLow = Math.min(...h4);
  const gridUp1 = Math.ceil((cur + 5) / GRID) * GRID;
  const gridUp2 = gridUp1 + GRID;
  const gridDown1 = Math.floor((cur - 5) / GRID) * GRID;
  const gridDown2 = gridDown1 - GRID;
  // トレンド転換の節目: 下降寄りなら直近4時間高値の上の節目(ブレイクで上昇転換)、
  // 上昇寄りなら4時間安値の下の節目(ブレイクで下降転換)。
  const revUp = Math.ceil(fourHigh / GRID) * GRID;
  const revDown = Math.floor(fourLow / GRID) * GRID;

  const upRaw: Level[] = [
    range1h ? { d: dist(range1h.high), label: '1時間高値' } : null,
    { d: dist(fourHigh), label: '4時間高値' },
    { d: dist(dayHigh), label: '本日高値' },
    { d: dist(gridUp1), label: `節目${gridUp1}` },
    { d: dist(gridUp2), label: `節目${gridUp2}` },
    trend === '下降寄り' ? { d: dist(revUp), label: `節目${revUp}`, reversal: true } : null,
  ].filter((x): x is Level => x !== null && x.d > 0);
  const downRaw: Level[] = [
    range1h ? { d: dist(range1h.low), label: '1時間安値' } : null,
    { d: dist(fourLow), label: '4時間安値' },
    { d: dist(dayLow), label: '本日安値' },
    { d: dist(gridDown1), label: `節目${gridDown1}` },
    { d: dist(gridDown2), label: `節目${gridDown2}` },
    trend === '上昇寄り' ? { d: dist(revDown), label: `節目${revDown}`, reversal: true } : null,
  ].filter((x): x is Level => x !== null && x.d < 0);

  // 距離で重複除去(転換フラグはマージ)、|距離|昇順、最大3件。転換ノードは必ず含める。
  const pick = (raw: Level[]): Level[] => {
    const byD = new Map<number, Level>();
    for (const lv of raw) {
      if (lv.d === 0) continue;
      const ex = byD.get(lv.d);
      if (ex) { if (lv.reversal) ex.reversal = true; }
      else byD.set(lv.d, { ...lv });
    }
    const all = [...byD.values()].sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const out = all.slice(0, 3);
    const rev = all.find(l => l.reversal);
    if (rev && !out.includes(rev)) out.push(rev);
    return out;
  };
  const fmtLevel = (l: Level): string => `${fmt(l.d)}(${l.label})${l.reversal ? '：トレンド転換' : ''}`;
  const upStr = pick(upRaw).map(fmtLevel).join(' / ') || '(上値候補なし)';
  const downStr = pick(downRaw).map(fmtLevel).join(' / ') || '(下値候補なし)';

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
