// アラート品質をトレンド整合別に分解。閾値を上げるべきか/文脈フィルタで絞るべきかを判断する。
// 各アラート発火時に MA(N) を計算し、アラート方向がトレンドと「整合/逆行/中立」かで前進リターンを層別。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const HZ = Number(process.argv[2] ?? 20);
const MA = Number(process.argv[3] ?? 30);     // MAバー数(分)
const BAND = Number(process.argv[4] ?? 50);   // 中立帯(円)
const SYMBOL = 'NIY=F';
const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; h: number; l: number; c: number }>;
const bt = bars.map(b => b.t);
const idxAtOrAfter = (t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bt[m]! < t) lo = m + 1; else hi = m; } return lo; };

const alerts = db.prepare(`SELECT triggered_at, detection_kind, direction FROM alerts WHERE symbol=? AND triggered_at IS NOT NULL ORDER BY triggered_at`).all(SYMBOL) as Array<{ triggered_at: number; detection_kind: string; direction: 'up' | 'down' }>;

type Bucket = { n: number; sumFwd: number; hit: number };
const init = (): Bucket => ({ n: 0, sumFwd: 0, hit: 0 });
const data: Record<string, { aligned: Bucket; counter: Bucket; neutral: Bucket }> = {};

for (const a of alerts) {
  const i0 = idxAtOrAfter(a.triggered_at);
  if (i0 < MA || i0 >= bars.length) continue;
  const p0 = bars[i0]!.c;
  const maWin = bars.slice(i0 - MA, i0);
  const ma = maWin.reduce((s, b) => s + b.c, 0) / maWin.length;
  const trend = p0 > ma + BAND ? 'up' : p0 < ma - BAND ? 'down' : 'neutral';
  const endT = a.triggered_at + HZ * 60000;
  let last = p0;
  for (let i = i0; i < bars.length && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  const fwd = a.direction === 'up' ? last - p0 : p0 - last;
  const bucket = trend === 'neutral' ? 'neutral' : trend === a.direction ? 'aligned' : 'counter';
  const g = (data[a.detection_kind] ??= { aligned: init(), counter: init(), neutral: init() });
  const b = g[bucket]; b.n++; b.sumFwd += fwd; b.hit += fwd > 0 ? 1 : 0;
}

const fmt = (b: Bucket): string => b.n ? `n=${String(b.n).padStart(3)} 勝率${String(Math.round(100 * b.hit / b.n)).padStart(3)}% fwd${String(Math.round(b.sumFwd / b.n)).padStart(5)}` : 'n=  0';
console.log(`\n=== トレンド整合別 品質(${SYMBOL}, 前進${HZ}分, MA${MA}, 中立帯±${BAND}円)===`);
console.log(`kind        | 整合(trend一致)         | 逆行(counter)           | 中立(neutral)`);
for (const k of ['break', 'shock', 'slope', 'ma_sr', 'granville', 'level_sr']) {
  const g = data[k]; if (!g) continue;
  console.log(`${k.padEnd(10)} | ${fmt(g.aligned).padEnd(23)} | ${fmt(g.counter).padEnd(23)} | ${fmt(g.neutral)}`);
}
console.log(`\n読み: 「整合だけ勝率>50%・fwd>0」かつ「逆行/中立は負/ゼロ」なら、閾値ではなく"トレンド文脈フィルタ"が正解。`);
db.close();
