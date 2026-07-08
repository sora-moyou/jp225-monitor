// 実態モデル: エントリー=逆指値 @ レベル±60(確認ブレイク)。SL=エントリー∓40。TPは掃引。
//   上抜けロング: 買い逆指値 @ L+60(high≥L+60で約定), SL=L+20, TP=L+60+TPy。
//   下抜けショート: 売り逆指値 @ L-60(low≤L-60で約定), SL=L-20, TP=L-60-TPy。
//   1回目が-40で損切(だまし)になったら、同レベルへ L+60 再到達で2回目を同条件で入れる。
//   費用: 逆指値入場=入場スリッページ。勝ち(TP指値)=margin10+入場slip5=15。負け/時間切れ(ストップ/成行)=+exit slip5=20。
//   比較: Ⓐ 1回目のみ vs Ⓑ 1回目+再エントリー。レベル=直近セッションH/L + 250節目。
// 使い方: npx tsx scripts/sr-stop60-reentry.mts [OFFSET=60] [SL=40] [maxHold=90] [reWin=30] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const OFFSET = Number(process.argv[2] ?? 60);     // エントリー= レベル±OFFSET
const SL = Number(process.argv[3] ?? 40);
const MAXHOLD = Number(process.argv[4] ?? 90);
const REWIN = Number(process.argv[5] ?? 30);
const LOOKBACK = Number(process.argv[6] ?? 10);
const TOL = 20, TICK = 5, MARGIN = 5, SLIP = TICK;
const COST_WIN = MARGIN * 2 + SLIP;               // 入場逆指値slip + 利確指値 = 15
const COST_LOSS = MARGIN * 2 + SLIP * 2;          // 入場 + ストップ両slip = 20
const GRID = 250, GRID_NEAR = 1500;
const SYMBOL = 'NIY=F', MS = 60_000;
const TPS = [40, 60, 80, 100, 120];               // 利確掃引(エントリーからの円)

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

// エントリー価格 ent(=L±OFFSET)に約定済(bar iEntry)。SL/TP(円)まで保有。entry=ent。
function trade(iEntry: number, dir: 'up' | 'down', ent: number, slY: number, tpY: number) {
  const sl = dir === 'up' ? ent - slY : ent + slY, tp = dir === 'up' ? ent + tpY : ent - tpY;
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= sl) return { pnl: -slY - COST_LOSS, outcome: 'loss' as const, exitIdx: i }; if (b.h >= tp) return { pnl: tpY - COST_WIN, outcome: 'win' as const, exitIdx: i }; }
    else { if (b.h >= sl) return { pnl: -slY - COST_LOSS, outcome: 'loss' as const, exitIdx: i }; if (b.l <= tp) return { pnl: tpY - COST_WIN, outcome: 'win' as const, exitIdx: i }; }
  }
  let last = ent, ei = iEntry; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) { last = bars[i]!.c; ei = i; }
  return { pnl: (dir === 'up' ? last - ent : ent - last) - COST_LOSS, outcome: 'timeout' as const, exitIdx: ei };
}

// 逆指値到達(ent)の最初の足を [from, until] で探す。up:high>=ent / down:low<=ent。
function reachIdx(from: number, untilT: number, dir: 'up' | 'down', ent: number): number {
  for (let i = from; i < N && bars[i]!.t <= untilT; i++) { const b = bars[i]!; if (dir === 'up' ? b.h >= ent : b.l <= ent) return i; }
  return -1;
}

// 各 TP について Ⓐ/Ⓑ を集計。エントリー検出は TP 非依存なので (level,dir,iEntry1,...) を一度作る。
interface Setup { dir: 'up' | 'down'; ent: number; i1: number; iSess: number; }
const setups: Setup[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  for (const L of bundle(resraw)) { if (ref >= L) continue; const ent = L + OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'up', ent); if (i1 >= 0) setups.push({ dir: 'up', ent, i1, iSess: s }); }
  for (const L of bundle(supraw)) { if (ref <= L) continue; const ent = L - OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'down', ent); if (i1 >= 0) setups.push({ dir: 'down', ent, i1, iSess: s }); }
}
console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  逆指値@レベル±${OFFSET} SL=${SL} hold=${MAXHOLD}m reWin=${REWIN}m 費用 勝${COST_WIN}/負${COST_LOSS}`);
console.log(`1回目エントリー(逆指値到達) ${setups.length} 件\n`);

function agg(a: number[]) {
  const n = a.length, tot = a.reduce((x, y) => x + y, 0), wins = a.filter(x => x > 0).length;
  const gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0);
  return { n, win: n ? wins / n : 0, avg: n ? tot / n : 0, tot, pf: gl > 0 ? gp / gl : Infinity };
}

console.log('TP(円)   Ⓐ1回目のみ(勝率/平均/合計/PF)        Ⓑ1回目+再エントリー(同)           再Cover%');
for (const TP of TPS) {
  const fo: number[] = [], cb: number[] = []; let reN = 0, cov = 0;
  for (const su of setups) {
    const t1 = trade(su.i1, su.dir, su.ent, SL, TP);
    fo.push(t1.pnl); let combo = t1.pnl;
    if (t1.outcome === 'loss') {
      const i2 = reachIdx(t1.exitIdx + 1, bars[t1.exitIdx]!.t + REWIN * MS, su.dir, su.ent);
      if (i2 >= 0) { const t2 = trade(i2, su.dir, su.ent, SL, TP); combo += t2.pnl; reN++; if (t1.pnl + t2.pnl > 0) cov++; }
    }
    cb.push(combo);
  }
  const A = agg(fo), B = agg(cb);
  const f = (x: { win: number; avg: number; tot: number; pf: number }) => `${(x.win * 100).toFixed(0)}% ${x.avg >= 0 ? '+' : ''}${x.avg.toFixed(0)} ${x.tot >= 0 ? '+' : ''}${Math.round(x.tot)} PF${x.pf.toFixed(2)}`;
  console.log(`${String(TP).padStart(4)}    ${f(A).padEnd(30)}  ${f(B).padEnd(30)}  ${reN ? (cov / reN * 100).toFixed(0) : 0}%`);
}
console.log('\n単位=円。Ⓑ>Ⓐ なら再エントリーが効く。PF>1 で利益。TP=エントリーからの利確幅。');
