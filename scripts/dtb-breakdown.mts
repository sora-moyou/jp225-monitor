// dtb(ダブル天底・旧種別)の前進リターンを条件別に切り分け、「どんな時に良いか」を根拠付きで示す。
// 負エッジ(逆方向を当てる)が一様なのか、特定の条件(トレンド整合/方向/セッション)に偏るのかを見る。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const KIND = process.argv[2] ?? 'dtb';
const HZ = Number(process.argv[3] ?? 20);
const MA = 30, BAND = 50;
const SYMBOL = 'NIY=F';
const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; h: number; l: number; c: number }>;
const bt = bars.map(b => b.t);
const idx = (t: number): number => { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bt[m]! < t) lo = m + 1; else hi = m; } return lo; };
const rows = db.prepare(`SELECT triggered_at, direction FROM alerts WHERE symbol=? AND detection_kind=? AND triggered_at IS NOT NULL ORDER BY triggered_at`).all(SYMBOL, KIND) as Array<{ triggered_at: number; direction: 'up' | 'down' }>;

interface Rec { dir: 'up' | 'down'; trend: string; session: string; date: string; fwd: number; mfe: number; mae: number; }
const recs: Rec[] = [];
for (const a of rows) {
  const i0 = idx(a.triggered_at); if (i0 < MA || i0 >= bars.length) continue;
  const p0 = bars[i0]!.c;
  const ma = bars.slice(i0 - MA, i0).reduce((s, b) => s + b.c, 0) / MA;
  const trend = p0 > ma + BAND ? 'up' : p0 < ma - BAND ? 'down' : 'neutral';
  const align = trend === 'neutral' ? 'neutral' : trend === a.direction ? 'aligned' : 'counter';
  const endT = a.triggered_at + HZ * 60000; let last = p0, mfe = 0, mae = 0;
  for (let i = i0; i < bars.length && bars[i]!.t <= endT; i++) { const b = bars[i]!; const f = a.direction === 'up' ? b.h - p0 : p0 - b.l; const ad = a.direction === 'up' ? p0 - b.l : b.h - p0; if (f > mfe) mfe = f; if (ad > mae) mae = ad; last = b.c; }
  const s = classifySession(a.triggered_at);
  recs.push({ dir: a.direction, trend: align, session: s?.session ?? 'other', date: new Date(a.triggered_at + 9 * 3600000).toISOString().slice(0, 10), fwd: a.direction === 'up' ? last - p0 : p0 - last, mfe, mae });
}

const agg = (rs: Rec[]): string => { if (!rs.length) return 'n=  0'; const n = rs.length; const win = Math.round(100 * rs.filter(r => r.fwd > 0).length / n); const fwd = Math.round(rs.reduce((s, r) => s + r.fwd, 0) / n); const fadeWin = Math.round(100 * rs.filter(r => r.fwd < 0).length / n); return `n=${String(n).padStart(3)} 素勝率${String(win).padStart(3)}% fwd${String(fwd).padStart(5)} | フェード勝率${String(fadeWin).padStart(3)}%`; };

console.log(`\n=== ${KIND} 条件別 前進${HZ}分(MA${MA}/帯±${BAND}) 総${recs.length}件 ===`);
console.log(`[全体]            ${agg(recs)}`);
console.log(`\n[トレンド整合別]`);
for (const t of ['aligned', 'counter', 'neutral']) console.log(`  ${t.padEnd(8)}        ${agg(recs.filter(r => r.trend === t))}`);
console.log(`\n[方向別]`);
for (const d of ['up', 'down']) console.log(`  ${d.padEnd(8)}        ${agg(recs.filter(r => r.dir === d))}`);
console.log(`\n[セッション別]`);
for (const s of ['Day', 'Night', 'other']) console.log(`  ${s.padEnd(8)}        ${agg(recs.filter(r => r.session === s))}`);
console.log(`\n[トレンド×方向]`);
for (const t of ['aligned', 'counter', 'neutral']) for (const d of ['up', 'down']) console.log(`  ${(t + '/' + d).padEnd(16)}${agg(recs.filter(r => r.trend === t && r.dir === d))}`);
console.log(`\n読み: 素勝率<50%(fwd<0)= 逆張り(フェード)有利。条件で偏るなら「その条件のdtbだけフェード」が根拠ある運用。`);
console.log(`注: ${KIND}=dtb は旧種別。記録期間=${recs[0]?.date}〜${recs[recs.length - 1]?.date}(現行は emit 減)。`);
db.close();
