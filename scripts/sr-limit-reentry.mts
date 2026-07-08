// 実態に合わせた検証: 入場=レベル価格に「指値」(レベル到達=リテストで約定・約定価格=レベル)。
//   SL≈-40, TP≈+60(レベル基準)。1回目がだまし(ストップ)になったら、同レベルの2回目ブレイクで再エントリー(同条件)。
//   費用: 指値約定(入場/利確)=マージンのみ、ストップ/時間切れ=マージン+スリッページ。
//   比較: Ⓐ 1回目のみ  vs  Ⓑ 1回目+再エントリー。
// 使い方: npx tsx scripts/sr-limit-reentry.mts [SL=40] [TP=60] [TP2=60] [maxHold=90] [retestWin=30] [reWin=30] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const SL = Number(process.argv[2] ?? 40);
const TP = Number(process.argv[3] ?? 60);
const TP2 = Number(process.argv[4] ?? 60);
const MAXHOLD = Number(process.argv[5] ?? 90);
const RETESTWIN = Number(process.argv[6] ?? 30);   // ブレイク後この分内にレベルへリテストして約定
const REWIN = Number(process.argv[7] ?? 30);       // 1回目ストップ後この分内の2回目ブレイクを認める
const LOOKBACK = Number(process.argv[8] ?? 10);
const TOL = 20, TICK = 5;
const MARGIN = 5, SLIP = TICK;
const COST_LIMIT = MARGIN * 2;                     // 入場・利確とも指値 = 10円
const COST_STOP = MARGIN * 2 + SLIP;               // ストップ/時間切れ決済 = 15円
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

// レベル価格 L に指値約定(リテスト)後、SL/TP まで保有。entry=L。
function tradeAtLevel(iFill: number, dir: 'up' | 'down', L: number, slY: number, tpY: number) {
  const sl = dir === 'up' ? L - slY : L + slY, tp = dir === 'up' ? L + tpY : L - tpY;
  const endT = bars[iFill]!.t + MAXHOLD * MS;
  for (let i = iFill + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= sl) return { pnl: -slY - COST_STOP, outcome: 'loss' as const, exitIdx: i }; if (b.h >= tp) return { pnl: tpY - COST_LIMIT, outcome: 'win' as const, exitIdx: i }; }
    else { if (b.h >= sl) return { pnl: -slY - COST_STOP, outcome: 'loss' as const, exitIdx: i }; if (b.l <= tp) return { pnl: tpY - COST_LIMIT, outcome: 'win' as const, exitIdx: i }; }
  }
  let last = L, ei = iFill; for (let i = iFill + 1; i < N && bars[i]!.t <= endT; i++) { last = bars[i]!.c; ei = i; }
  const raw = dir === 'up' ? last - L : L - last;
  return { pnl: raw - COST_STOP, outcome: 'timeout' as const, exitIdx: ei };
}

// ブレイク(iBreak)後、retestWin 内にレベルへ到達(指値約定)した最初の足。無ければ -1。
function fillIdx(iBreak: number, dir: 'up' | 'down', L: number): number {
  const endT = bars[iBreak]!.t + RETESTWIN * MS;
  for (let i = iBreak + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up' ? b.l <= L : b.h >= L) return i;   // レベルへ到達=指値約定
  }
  return -1;
}

const firstOnly: number[] = [], combined: number[] = [];
let entered = 0, reN = 0, reTot = 0, covered = 0;

for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };

  const run = (levels: number[], dir: 'up' | 'down') => {
    for (const L of levels) {
      // 1回目ブレイク(セッション内で最初に close がレベルを抜ける)
      let iBreak = -1;
      for (let i = S.s; i <= S.e; i++) { const c = bars[i]!.c; if (dir === 'up' ? c > L : c < L) { iBreak = i; break; } }
      if (iBreak < 0) continue;
      const iFill = fillIdx(iBreak, dir, L);
      if (iFill < 0) continue;                 // リテスト指値が約定しなかった=見送り(エントリー無し)
      entered++;
      const t1 = tradeAtLevel(iFill, dir, L, SL, TP);
      firstOnly.push(t1.pnl);
      let combo = t1.pnl;
      if (t1.outcome === 'loss') {
        // 2回目ブレイク(ストップ後、内側へ戻ってから再度レベルを抜ける)→ 再びレベル指値
        const lossT = bars[t1.exitIdx]!.t; let inside = false, iBreak2 = -1;
        for (let i = t1.exitIdx + 1; i < N && bars[i]!.t <= lossT + REWIN * MS; i++) {
          const c = bars[i]!.c; if (dir === 'up' ? c < L : c > L) inside = true;
          if (inside && (dir === 'up' ? c > L : c < L)) { iBreak2 = i; break; }
        }
        if (iBreak2 >= 0) { const iFill2 = fillIdx(iBreak2, dir, L); if (iFill2 >= 0) { const t2 = tradeAtLevel(iFill2, dir, L, SL, TP2); combo += t2.pnl; reN++; reTot += t2.pnl; if (t1.pnl + t2.pnl > 0) covered++; } }
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

console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  指値入場 SL=${SL} TP=${TP} TP2=${TP2} hold=${MAXHOLD}m retestWin=${RETESTWIN}m reWin=${REWIN}m 費用 指値${COST_LIMIT}/ストップ${COST_STOP}\n`);
console.log(`レベル指値が約定した回数(=1回目エントリー) ${entered}`);
console.log('=== 指値(レベル)入場・リテスト ===');
rep('Ⓐ 1回目のみ', firstOnly);
rep('Ⓑ 1回目+再エントリー', combined);
console.log(`\n再エントリー: 発生 ${reN} 回 / 2回目合計 ${reTot >= 0 ? '+' : ''}${Math.round(reTot)} / カバー成功(1+2>0) ${covered}/${reN} = ${reN ? (covered / reN * 100).toFixed(0) : 0}%`);
console.log(`Ⓑ>Ⓐ なら「再エントリーで1回目をカバーして上回る」=仮説支持。`);
