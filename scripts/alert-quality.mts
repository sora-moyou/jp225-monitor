// アラート品質バックテスト: 記録済みアラート(=ライブ閾値の実績)について、発火後の前進リターンを測る。
// 「閾値が適当か」= そのアラートが本当に方向を当てているか(ノイズでないか)を種別別に評価する。
// 使い方: npx tsx scripts/alert-quality.mts [horizonMin=20]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const HZ = Number(process.argv[2] ?? 20);            // 前進ホライズン(分)
const SYMBOL = 'NIY=F';
const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });

const bars = db.prepare('SELECT t,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; h: number; l: number; c: number }>;
const bt = bars.map(b => b.t);
function idxAtOrAfter(t: number): number { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bt[m]! < t) lo = m + 1; else hi = m; } return lo; }

const alerts = db.prepare(
  `SELECT triggered_at, detection_kind, direction, price FROM alerts WHERE symbol=? AND triggered_at IS NOT NULL ORDER BY triggered_at`
).all(SYMBOL) as Array<{ triggered_at: number; detection_kind: string; direction: 'up' | 'down'; price: number }>;

interface Agg { n: number; fwd: number[]; hit: number; mfe: number[]; mae: number[]; }
const byKind: Record<string, Agg> = {};
const all: Agg = { n: 0, fwd: [], hit: 0, mfe: [], mae: [] };

for (const a of alerts) {
  const i0 = idxAtOrAfter(a.triggered_at);
  if (i0 >= bars.length) continue;
  const p0 = bars[i0]!.c;
  const endT = a.triggered_at + HZ * 60000;
  let mfe = 0, mae = 0, last = p0;     // 方向符号つき: favorable=方向に有利, adverse=不利(正値で記録)
  for (let i = i0; i < bars.length && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    const favH = a.direction === 'up' ? b.h - p0 : p0 - b.l;   // 方向に最も有利な行き
    const advH = a.direction === 'up' ? p0 - b.l : b.h - p0;   // 方向に最も不利な行き
    if (favH > mfe) mfe = favH;
    if (advH > mae) mae = advH;
    last = b.c;
  }
  const fwd = a.direction === 'up' ? last - p0 : p0 - last;     // ホライズン終端の方向リターン(円)
  const g = (byKind[a.detection_kind] ??= { n: 0, fwd: [], hit: 0, mfe: [], mae: [] });
  for (const t of [g, all]) { t.n++; t.fwd.push(fwd); t.hit += fwd > 0 ? 1 : 0; t.mfe.push(mfe); t.mae.push(mae); }
}

const mean = (xs: number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const med = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]!; };

console.log(`\n=== アラート品質(${SYMBOL}, 前進 ${HZ}分, 記録済み ${alerts.length}件 / バー期間で評価)===`);
console.log(`kind        n    勝率   平均fwd  中央fwd   平均MFE  平均MAE  MFE/MAE`);
const order = Object.keys(byKind).sort((a, b) => byKind[b]!.n - byKind[a]!.n);
for (const k of order) {
  const g = byKind[k]!;
  const win = (100 * g.hit / g.n).toFixed(0);
  const ratio = mean(g.mae) ? (mean(g.mfe) / mean(g.mae)).toFixed(2) : '–';
  console.log(`${k.padEnd(10)} ${String(g.n).padStart(4)}  ${win.padStart(3)}%  ${mean(g.fwd).toFixed(0).padStart(6)}  ${med(g.fwd).toFixed(0).padStart(6)}   ${mean(g.mfe).toFixed(0).padStart(6)}   ${mean(g.mae).toFixed(0).padStart(6)}    ${ratio}`);
}
const win = (100 * all.hit / all.n).toFixed(0);
console.log(`${'ALL'.padEnd(10)} ${String(all.n).padStart(4)}  ${win.padStart(3)}%  ${mean(all.fwd).toFixed(0).padStart(6)}  ${med(all.fwd).toFixed(0).padStart(6)}   ${mean(all.mfe).toFixed(0).padStart(6)}   ${mean(all.mae).toFixed(0).padStart(6)}`);
console.log(`\n読み方: 平均fwd>0 かつ 勝率>50% かつ MFE/MAE>1 なら方向エッジあり(閾値が機能)。`);
console.log(`        戦略は 50円損切り/150円利確(3R)。MFE が 150 に届かず MAE が 50 を超える種別は、その水準設定では不利。`);
db.close();
