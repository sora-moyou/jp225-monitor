// 「1回目ブレイクは取る(だまし=約50円で損切)→ 2回目で再エントリーし約60円取って1回目をカバー」を、
//   連続2手の合算損益で検証する。比較対象 = 「1回目のみ(再エントリーしない)」。
//   入場 = S/Rレベル(直近セッションH/L+250節目)のブレイク直入場(終値)。SL/TPは円固定。
//   2手目は、1手目が損切(=だまし)になった後に同レベルを再ブレイクした所で入る。
// 使い方: npx tsx scripts/break-reentry-recovery.mts [SL=50] [TP=60] [TP2=60] [maxHold=90] [reWin=30] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const SL = Number(process.argv[2] ?? 50);          // 損切幅(円)=だまし許容
const TP = Number(process.argv[3] ?? 60);          // 1手目利確(円)
const TP2 = Number(process.argv[4] ?? 60);         // 2手目利確(円)
const MAXHOLD = Number(process.argv[5] ?? 90);     // 1手の最大保有(分)
const REWIN = Number(process.argv[6] ?? 30);       // 損切後、何分以内の再ブレイクを2手目として認めるか
const LOOKBACK = Number(process.argv[7] ?? 10);
const TOL = 20, TICK = 5, COST = 5 * 2 + 1 * TICK; // 15円/トレード
const GRID = 250, GRID_NEAR = 1500;
const SYMBOL = 'NIY=F', MS = 60_000;

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

// 1トレード(ブレイク直入場 i0, 方向 dir, SL/TP 円)。{pnl, outcome, exitIdx}。
function trade(i0: number, dir: 'up' | 'down', slY: number, tpY: number) {
  const p0 = bars[i0]!.c;
  const sl = dir === 'up' ? p0 - slY : p0 + slY, tp = dir === 'up' ? p0 + tpY : p0 - tpY;
  const endT = bars[i0]!.t + MAXHOLD * MS;
  for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= sl) return { pnl: -slY - COST, outcome: 'loss' as const, exitIdx: i }; if (b.h >= tp) return { pnl: tpY - COST, outcome: 'win' as const, exitIdx: i }; }
    else { if (b.h >= sl) return { pnl: -slY - COST, outcome: 'loss' as const, exitIdx: i }; if (b.l <= tp) return { pnl: tpY - COST, outcome: 'win' as const, exitIdx: i }; }
  }
  let last = p0, ei = i0; for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) { last = bars[i]!.c; ei = i; }
  const raw = dir === 'up' ? last - p0 : p0 - last;
  return { pnl: raw - COST, outcome: 'timeout' as const, exitIdx: ei };
}

const firstOnly: number[] = [];     // 1手目のみ
const combined: number[] = [];      // 1手目 + (損切後)2手目
let reN = 0, reTot = 0, covered = 0; // 再エントリー統計

for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };

  const run = (levels: number[], dir: 'up' | 'down') => {
    for (const L of levels) {
      // 1手目: セッション内で初めて close がレベルを抜けた所。
      let i1 = -1;
      for (let i = S.s; i <= S.e; i++) { const c = bars[i]!.c; if (dir === 'up' ? c > L : c < L) { i1 = i; break; } }
      if (i1 < 0) continue;
      const t1 = trade(i1, dir, SL, TP);
      firstOnly.push(t1.pnl);
      let combo = t1.pnl;
      if (t1.outcome === 'loss') {
        // だまし(損切)後、REWIN 内に同レベルを再ブレイクした最初の足で2手目。
        const lossT = bars[t1.exitIdx]!.t;
        let backInside = false, i2 = -1;
        for (let i = t1.exitIdx + 1; i < N && bars[i]!.t <= lossT + REWIN * MS; i++) {
          const c = bars[i]!.c; const inside = dir === 'up' ? c < L : c > L; const broke = dir === 'up' ? c > L : c < L;
          if (inside) backInside = true;
          if (backInside && broke) { i2 = i; break; }
        }
        if (i2 >= 0) { const t2 = trade(i2, dir, SL, TP2); combo += t2.pnl; reN++; reTot += t2.pnl; if (t1.pnl + t2.pnl > 0) covered++; }
      }
      combined.push(combo);
    }
  };
  run(bundle(resraw), 'up'); run(bundle(supraw), 'down');
}

function rep(label: string, a: number[]) {
  if (!a.length) { console.log(`${label.padEnd(22)} n=0`); return; }
  const n = a.length, tot = a.reduce((x, y) => x + y, 0), wins = a.filter(x => x > 0).length;
  const gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0);
  console.log(`${label.padEnd(22)} n=${String(n).padStart(4)}  勝率=${(wins / n * 100).toFixed(1)}%  平均=${(tot / n) >= 0 ? '+' : ''}${(tot / n).toFixed(1)}  合計=${tot >= 0 ? '+' : ''}${Math.round(tot)}  PF=${(gl > 0 ? gp / gl : Infinity).toFixed(2)}`);
}

console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  SL=${SL} TP=${TP} TP2=${TP2} hold=${MAXHOLD}m reWin=${REWIN}m cost=${COST}\n`);
console.log('=== 1手目ブレイクの母集団(同じレベル群) ===');
rep('Ⓐ 1手目のみ', firstOnly);
rep('Ⓑ 1手目+再エントリー', combined);
console.log(`\n再エントリー: 発生 ${reN} 回 / 2手目合計 ${reTot >= 0 ? '+' : ''}${Math.round(reTot)} / 1回目を含めプラス転換(カバー成功) ${covered}/${reN} = ${reN ? (covered / reN * 100).toFixed(0) : 0}%`);
console.log(`単位=円。Ⓑ>Ⓐ なら「再エントリーで1回目をカバーして上回る」=仮説支持。費用 ${COST}/trade 込み。`);
