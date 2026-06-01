import { barsFor } from './loops/alertLoop.js';
import { computeContext } from './alertDetector.js';
import type { Bar } from './correlation.js';

const NIKKEI = 'NIY=F';
const GRID = 250; // 節目(round number)グリッド(円)

interface Level { price: number; d: number; label: string; reversal?: boolean; accel?: boolean; }

// getBars はテスト用に注入可(既定は本物の barsCache 読み取り)。
// 15〜60 分(約30分足)の時間軸でのテクニカル要約を返す。
// 上昇/下落の目途は「構造的レベル(1時間・4時間・本日の高安)+ 250円節目」から
// 複数候補を近い順に列挙し、各値は現在値からの距離(5円丸め)で示す。
// さらに節目に、現在トレンドをブレイクで否定する「トレンド転換」と、
// 同方向にブレイクで勢いづく「トレンド加速」のラベルを付与する。
// v0.3.36: バー蓄積中(再起動直後など)でも、現在価格(fallbackPrice)から最低限の節目メドを
// 返せるようにする。以前は 62 本未満で null を返し、AI が「上値メドのデータなし」になっていた。
function gridOnly(cur: number): string {
  const fp = (v: number): string => Math.round(v).toLocaleString('en-US');
  const up1 = Math.ceil((cur + 5) / GRID) * GRID, up2 = up1 + GRID;
  const dn1 = Math.floor((cur - 5) / GRID) * GRID, dn2 = dn1 - GRID;
  return `■ 日経225先物 (NIY=F) テクニカル(簡易: 分足を蓄積中):\n` +
    `現値 ${fp(cur)}円\n` +
    `上昇目途候補(節目): ${fp(up1)}円 / ${fp(up2)}円\n` +
    `下落目途候補(節目): ${fp(dn1)}円 / ${fp(dn2)}円`;
}

export function buildNikkeiTechnical(
  getBars: (symbol: string) => Bar[] = barsFor,   // v0.3.32: 既定をリアルタイム足優先に
  fallbackPrice?: number,                         // v0.3.36: バー不足時に節目メドを出す現在価格
): string | null {
  const bars = getBars(NIKKEI);
  if (bars.length < 62) {
    // バー不足(再起動直後の蓄積中など): 現在価格から節目だけの簡易メドを返す。
    // 以前はここで null を返し AI が「上値メドのデータなし」になっていた。
    const cur = bars.length ? bars[bars.length - 1]!.close : fallbackPrice;
    return cur !== undefined && cur > 0 ? gridOnly(cur) : null;
  }
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
  const fmtPrice = (v: number): string => Math.round(v).toLocaleString('en-US');   // 67,000

  const dayHigh = Math.max(...closes);
  const dayLow = Math.min(...closes);
  const h4 = closes.slice(-240);          // 直近 4 時間(<240本なら取得分すべて)
  const fourHigh = Math.max(...h4);
  const fourLow = Math.min(...h4);
  const gridUp1 = Math.ceil((cur + 5) / GRID) * GRID;
  const gridUp2 = gridUp1 + GRID;
  const gridDown1 = Math.floor((cur - 5) / GRID) * GRID;
  const gridDown2 = gridDown1 - GRID;
  // 4時間高値の上の節目(上抜け方向)/ 4時間安値の下の節目(下抜け方向)。
  const revUp = Math.ceil(fourHigh / GRID) * GRID;
  const revDown = Math.floor(fourLow / GRID) * GRID;
  // 下降寄り: 上抜け=転換(revUp), 下抜け=加速(revDown)。
  // 上昇寄り: 下抜け=転換(revDown), 上抜け=加速(revUp)。

  const upCandidates: (Level | null)[] = [
    range1h ? { price: range1h.high, d: dist(range1h.high), label: '1時間高値' } : null,
    { price: fourHigh, d: dist(fourHigh), label: '4時間高値' },
    { price: dayHigh, d: dist(dayHigh), label: '本日高値' },
    { price: gridUp1, d: dist(gridUp1), label: '節目' },
    { price: gridUp2, d: dist(gridUp2), label: '節目' },
    trend === '下降寄り' ? { price: revUp, d: dist(revUp), label: '節目', reversal: true } : null,
    trend === '上昇寄り' ? { price: revUp, d: dist(revUp), label: '節目', accel: true } : null,
  ];
  const upRaw = upCandidates.filter((x): x is Level => x !== null && x.d > 0);
  const downCandidates: (Level | null)[] = [
    range1h ? { price: range1h.low, d: dist(range1h.low), label: '1時間安値' } : null,
    { price: fourLow, d: dist(fourLow), label: '4時間安値' },
    { price: dayLow, d: dist(dayLow), label: '本日安値' },
    { price: gridDown1, d: dist(gridDown1), label: '節目' },
    { price: gridDown2, d: dist(gridDown2), label: '節目' },
    trend === '上昇寄り' ? { price: revDown, d: dist(revDown), label: '節目', reversal: true } : null,
    trend === '下降寄り' ? { price: revDown, d: dist(revDown), label: '節目', accel: true } : null,
  ];
  const downRaw = downCandidates.filter((x): x is Level => x !== null && x.d < 0);

  // 距離で重複除去(転換/加速フラグはマージ)、|距離|昇順、最大3件。
  // 転換・加速ノードは上位に入らなくても必ず含める。
  const pick = (raw: Level[]): Level[] => {
    const byD = new Map<number, Level>();
    for (const lv of raw) {
      if (lv.d === 0) continue;
      const ex = byD.get(lv.d);
      if (ex) { if (lv.reversal) ex.reversal = true; if (lv.accel) ex.accel = true; }
      else byD.set(lv.d, { ...lv });
    }
    const all = [...byD.values()].sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
    const out = all.slice(0, 3);
    for (const special of all) {
      if ((special.reversal || special.accel) && !out.includes(special)) out.push(special);
    }
    return out;
  };
  // v0.3.35: 価格を主体に表示 (例「67,000円(節目, あと+80円)」)。距離は補助で括弧内に。
  const fmtLevel = (l: Level): string => {
    const tag = l.reversal ? '：トレンド転換' : l.accel ? '：トレンド加速' : '';
    return `${fmtPrice(l.price)}円(${l.label}, あと${fmt(l.d)})${tag}`;
  };
  const upStr = pick(upRaw).map(fmtLevel).join(' / ') || '(上値候補なし)';
  const downStr = pick(downRaw).map(fmtLevel).join(' / ') || '(下値候補なし)';

  const pct = (v: number | null, n: number): string | null =>
    v !== null ? `${n}分変化率 ${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : null;
  const chgLine = [pct(chg30, 30), pct(chg60, 60)].filter((x): x is string => x !== null).join(' / ');

  const lines = [
    `現値 ${fmtPrice(cur)}円`,
    chgLine !== '' ? chgLine : null,
    `中期(15分平均) ${fmtPrice(sma15)}円 (現在値 ${fmt(dist(sma15))}) / 長期(60分平均) ${fmtPrice(sma60)}円 (現在値 ${fmt(dist(sma60))}) → 傾向: ${trend}`,
    `上昇目途候補: ${upStr}`,
    `下落目途候補: ${downStr}`,
  ].filter((x): x is string => x !== null);
  return `■ 日経225先物 (NIY=F) テクニカル(15〜60分):\n${lines.join('\n')}`;
}
