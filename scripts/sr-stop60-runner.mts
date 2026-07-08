// 実態モデル(ランナー決済版): エントリー=逆指値 @ レベル±60。SL=エントリー∓40。
//   利確: 固定せず「+ACT(=80)に到達したらトレーリング起動→ピークから TRAIL 円下/上に建値ストップを引き上げて伸ばす」。
//   1回目が損切(だまし)になったら、同レベルへ ±60 再到達で2回目を同条件で入れる。
//   費用: 逆指値入場+ストップ/トレール決済とも成行系 → 入場slip+決済slip+margin = 20円。
//   比較: Ⓐ 1回目のみ vs Ⓑ 1回目+再エントリー。TRAIL を掃引。
// 使い方: npx tsx scripts/sr-stop60-runner.mts [OFFSET=60] [SL=40] [ACT=80] [maxHold=180] [reWin=30] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const OFFSET = Number(process.argv[2] ?? 60);
const SL = Number(process.argv[3] ?? 40);
const ACT = Number(process.argv[4] ?? 80);        // この含み益でトレーリング起動(=最低利確の狙い)
const MAXHOLD = Number(process.argv[5] ?? 180);   // ランナーなので保有を長めに(分)
const REWIN = Number(process.argv[6] ?? 30);
const LOOKBACK = Number(process.argv[7] ?? 10);
const TOL = 20, TICK = 5, MARGIN = 5, SLIP = TICK;
const COST = MARGIN * 2 + SLIP * 2;               // 20円(入場逆指値+決済ストップ/トレール)
const GRID = 250, GRID_NEAR = 1500;
const SYMBOL = 'NIY=F', MS = 60_000;
const TRAILS = [60, 80, 100, 120, 150];           // トレール幅(ピークからの戻し許容)掃引=大きめ

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;

interface Sess { key: string; date: string; hi: number; lo: number; s: number; e: number; }
const sessions: Sess[] = []; let cur: Sess | null = null;
for (let i = 0; i < N; i++) {
  const si = classifySession(bars[i]!.t); if (!si) continue;
  const key = `${si.sessionDate}|${si.session}`;
  if (!cur || cur.key !== key) { if (cur) sessions.push(cur); cur = { key, date: si.sessionDate, hi: bars[i]!.h, lo: bars[i]!.l, s: i, e: i }; }
  else { cur.hi = Math.max(cur.hi, bars[i]!.h); cur.lo = Math.min(cur.lo, bars[i]!.l); cur.e = i; }
}
if (cur) sessions.push(cur);

// ランナー決済。entry=ent(約定済 iEntry)。初期stop=ent∓SL。含み益≥ACTでトレール起動、ピーク∓TRAILへstop引上げ。
function runner(iEntry: number, dir: 'up' | 'down', ent: number, trailY: number) {
  let stop = dir === 'up' ? ent - SL : ent + SL;
  let hwm = ent, activated = false;
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') {
      if (b.l <= stop) return { pnl: (stop - ent) - COST, outcome: stop >= ent ? 'win' as const : 'loss' as const, exitIdx: i };
      hwm = Math.max(hwm, b.h);
      if (!activated && hwm - ent >= ACT) activated = true;
      if (activated) stop = Math.max(stop, hwm - trailY);
    } else {
      if (b.h >= stop) return { pnl: (ent - stop) - COST, outcome: stop <= ent ? 'win' as const : 'loss' as const, exitIdx: i };
      hwm = Math.min(hwm, b.l);
      if (!activated && ent - hwm >= ACT) activated = true;
      if (activated) stop = Math.min(stop, hwm + trailY);
    }
  }
  let last = ent, ei = iEntry; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) { last = bars[i]!.c; ei = i; }
  const raw = dir === 'up' ? last - ent : ent - last;
  return { pnl: raw - COST, outcome: raw > 0 ? 'win' as const : 'loss' as const, exitIdx: ei };
}

function reachIdx(from: number, untilT: number, dir: 'up' | 'down', ent: number): number {
  for (let i = from; i < N && bars[i]!.t <= untilT; i++) { const b = bars[i]!; if (dir === 'up' ? b.h >= ent : b.l <= ent) return i; }
  return -1;
}

interface Setup { dir: 'up' | 'down'; ent: number; i1: number; }
const setups: Setup[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  for (const L of bundle(resraw)) { if (ref >= L) continue; const ent = L + OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'up', ent); if (i1 >= 0) setups.push({ dir: 'up', ent, i1 }); }
  for (const L of bundle(supraw)) { if (ref <= L) continue; const ent = L - OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'down', ent); if (i1 >= 0) setups.push({ dir: 'down', ent, i1 }); }
}
console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  逆指値@±${OFFSET} SL=${SL} 起動+${ACT} hold=${MAXHOLD}m 費用${COST}`);
console.log(`1回目エントリー ${setups.length} 件\n`);

function agg(a: number[]) { const n = a.length, tot = a.reduce((x, y) => x + y, 0), w = a.filter(x => x > 0).length, gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0); return { n, win: n ? w / n : 0, avg: n ? tot / n : 0, tot, pf: gl > 0 ? gp / gl : Infinity }; }
const f = (x: { win: number; avg: number; tot: number; pf: number }) => `${(x.win * 100).toFixed(0)}% ${x.avg >= 0 ? '+' : ''}${x.avg.toFixed(0)} ${x.tot >= 0 ? '+' : ''}${Math.round(x.tot)} PF${x.pf.toFixed(2)}`;

console.log('TRAIL   Ⓐ1回目のみ(勝率/平均/合計/PF)        Ⓑ1回目+再エントリー(同)           再Cover%');
for (const TR of TRAILS) {
  const fo: number[] = [], cb: number[] = []; let reN = 0, cov = 0;
  for (const su of setups) {
    const t1 = runner(su.i1, su.dir, su.ent, TR);
    fo.push(t1.pnl); let combo = t1.pnl;
    if (t1.outcome === 'loss') {
      const i2 = reachIdx(t1.exitIdx + 1, bars[t1.exitIdx]!.t + REWIN * MS, su.dir, su.ent);
      if (i2 >= 0) { const t2 = runner(i2, su.dir, su.ent, TR); combo += t2.pnl; reN++; if (t1.pnl + t2.pnl > 0) cov++; }
    }
    cb.push(combo);
  }
  console.log(`${String(TR).padStart(4)}    ${f(agg(fo)).padEnd(30)}  ${f(agg(cb)).padEnd(30)}  ${reN ? (cov / reN * 100).toFixed(0) : 0}%`);
}
console.log('\n単位=円。Ⓑ>Ⓐ なら再エントリーが効く。PF>1 で利益。ランナー=+80起動・ピークからTRAIL戻しで決済。');
