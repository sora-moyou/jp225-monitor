// 実態モデル(早目2回目版): 各S/Rレベルを A/B に分岐。
//   A 確認ブレイク: 価格が L±60 に到達=逆指値約定 → ランナー決済(SL∓40, +ACT起動, トレールTRAIL)。
//   B だまし→早目2回目: L を抜けたが L±60 未到達で L の内側へ戻った(だまし) → 逆指値キャンセル →
//       押し安値(高値)から RETR 円戻した所で早目・深く入場(=反転確認 (b)/(c) 式) → 固定利確(着実・TP2), SL∓40。
//   ※ Bは「L+60やL再ブレイクを待たず、反転の戻りで深く入る」ので目標まで利確幅が取れる、という意図。
//   レベル=直近セッションH/L + 250節目。費用=逆指値/ストップ系20, 指値利確15。
// 使い方: npx tsx scripts/sr-fakeout-early2nd.mts [SL=40] [ACT=80] [TRAIL=150] [maxHold=240] [reWin=30] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const SL = Number(process.argv[2] ?? 40);
const ACT = Number(process.argv[3] ?? 80);
const TRAIL = Number(process.argv[4] ?? 150);
const MAXHOLD = Number(process.argv[5] ?? 240);
const REWIN = Number(process.argv[6] ?? 30);
const LOOKBACK = Number(process.argv[7] ?? 10);
const RETR = Number(process.argv[8] ?? 10);    // B: 押し安値(高値)からこの円戻したら早目エントリー=深く拾う(小さいほど深い)
const SLBELOW = Number(process.argv[9] ?? 15); // B: ストップを押し安値(高値)の外側この円に置く(タイト・構造的)
const OFFSET = 60, TOL = 20, TICK = 5, MARGIN = 5, SLIP = TICK;
const COST_STOP = MARGIN * 2 + SLIP * 2;   // 逆指値入場+ストップ/トレール = 20
const COST_LIM = MARGIN * 2 + SLIP;        // 入場+指値利確 = 15(Bの固定利確勝ち)
const GRID = 250, GRID_NEAR = 1500;
const SYMBOL = 'NIY=F', MS = 60_000;
const MINTP = Number(process.argv[10] ?? 20);  // B: レベル手前利確の最低利確幅(これ未満なら room無し=見送り)
const BEFORES = [0, 15, 30];               // B利確を L の手前 この円に置く(0=レベルちょうど)を掃引

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;

// トレンドフィルタ: 単純MA(close)。up=価格>MA かつ MA上向き / down=逆。
const MA_WIN = Number(process.argv[11] ?? 90);    // MA本数(分)
const SLOPE_LB = Number(process.argv[12] ?? 30);  // MA傾きの比較本数
const ma = new Array<number>(N).fill(NaN);
{ let sum = 0; for (let i = 0; i < N; i++) { sum += bars[i]!.c; if (i >= MA_WIN) sum -= bars[i - MA_WIN]!.c; if (i >= MA_WIN - 1) ma[i] = sum / MA_WIN; } }
function trendOk(iEntry: number, dir: 'up' | 'down'): boolean {
  if (iEntry - SLOPE_LB < 0 || Number.isNaN(ma[iEntry]!) || Number.isNaN(ma[iEntry - SLOPE_LB]!)) return false;
  const c = bars[iEntry]!.c;
  return dir === 'up' ? (c > ma[iEntry]! && ma[iEntry]! > ma[iEntry - SLOPE_LB]!)
    : (c < ma[iEntry]! && ma[iEntry]! < ma[iEntry - SLOPE_LB]!);
}

interface Sess { key: string; date: string; hi: number; lo: number; s: number; e: number; }
const sessions: Sess[] = []; let cur: Sess | null = null;
for (let i = 0; i < N; i++) {
  const si = classifySession(bars[i]!.t); if (!si) continue;
  const key = `${si.sessionDate}|${si.session}`;
  if (!cur || cur.key !== key) { if (cur) sessions.push(cur); cur = { key, date: si.sessionDate, hi: bars[i]!.h, lo: bars[i]!.l, s: i, e: i }; }
  else { cur.hi = Math.max(cur.hi, bars[i]!.h); cur.lo = Math.min(cur.lo, bars[i]!.l); cur.e = i; }
}
if (cur) sessions.push(cur);

function runner(iEntry: number, dir: 'up' | 'down', ent: number): number {
  let stop = dir === 'up' ? ent - SL : ent + SL; let hwm = ent, act = false;
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= stop) return (stop - ent) - COST_STOP; hwm = Math.max(hwm, b.h); if (!act && hwm - ent >= ACT) act = true; if (act) stop = Math.max(stop, hwm - TRAIL); }
    else { if (b.h >= stop) return (ent - stop) - COST_STOP; hwm = Math.min(hwm, b.l); if (!act && ent - hwm >= ACT) act = true; if (act) stop = Math.min(stop, hwm + TRAIL); }
  }
  let last = ent; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  return (dir === 'up' ? last - ent : ent - last) - COST_STOP;
}
// B用: 構造的ストップ(slPrice=押し安値直下)＋固定利確(+tpY)。ent= 深い反転入場。
function fixedSL(iEntry: number, dir: 'up' | 'down', ent: number, slPrice: number, tpY: number): number {
  const slDist = dir === 'up' ? ent - slPrice : slPrice - ent;
  const tp = dir === 'up' ? ent + tpY : ent - tpY;
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= slPrice) return -slDist - COST_STOP; if (b.h >= tp) return tpY - COST_LIM; }
    else { if (b.h >= slPrice) return -slDist - COST_STOP; if (b.l <= tp) return tpY - COST_LIM; }
  }
  let last = ent; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  return (dir === 'up' ? last - ent : ent - last) - COST_STOP;
}

// 各レベルを分岐判定し、(種別, dir, ent, iEntry) を返す。種別: 'A'|'B'|null。
interface Resolved { kind: 'A' | 'B'; dir: 'up' | 'down'; ent: number; iEntry: number; sl?: number; lvl?: number; }
function resolveLevel(L: number, dir: 'up' | 'down', sStart: number, sEnd: number): Resolved | null {
  // 1st break = close がレベルを抜けた最初の足
  let ib = -1; for (let i = sStart; i <= sEnd; i++) { const c = bars[i]!.c; if (dir === 'up' ? c > L : c < L) { ib = i; break; } }
  if (ib < 0) return null;
  const target = dir === 'up' ? L + OFFSET : L - OFFSET;
  // ib 以降: L±60 到達(A) か、内側へ戻る(=だまし, B) のどちらが先か
  for (let i = ib; i <= sEnd; i++) {
    const b = bars[i]!;
    if (dir === 'up' ? b.h >= target : b.l <= target) return { kind: 'A', dir, ent: target, iEntry: i };  // 確認ブレイク
    if (dir === 'up' ? b.c < L : b.c > L) {
      // だまし: 内側へ戻った。押し安値(高値)から RETR 戻した所で早目・深く入る(反転確認 (b)/(c)式)。
      const failT = b.t;
      let ext = dir === 'up' ? Infinity : -Infinity;   // 押しの極値(up=安値/down=高値)
      for (let j = i; j < N && bars[j]!.t <= failT + REWIN * MS; j++) {
        const bj = bars[j]!;
        if (Number.isFinite(ext) && (dir === 'up' ? bj.h >= ext + RETR : bj.l <= ext - RETR))
          // 深く拾う: 入場=押し極値+RETR、ストップ=押し極値の外側 SLBELOW(タイト)、利確はレベル手前(lvl=L)
          return { kind: 'B', dir, ent: dir === 'up' ? ext + RETR : ext - RETR, iEntry: j, sl: dir === 'up' ? ext - SLBELOW : ext + SLBELOW, lvl: L };
        ext = dir === 'up' ? Math.min(ext, bj.l) : Math.max(ext, bj.h);
      }
      return null;   // 反転の戻り来ず=見送り
    }
  }
  return null;
}

const setups: Resolved[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  for (const L of bundle(resraw)) { if (ref >= L) continue; const r = resolveLevel(L, 'up', S.s, S.e); if (r) setups.push(r); }
  for (const L of bundle(supraw)) { if (ref <= L) continue; const r = resolveLevel(L, 'down', S.s, S.e); if (r) setups.push(r); }
}
const A = setups.filter(x => x.kind === 'A'), B = setups.filter(x => x.kind === 'B');
console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  SL=${SL} 起動+${ACT} TRAIL=${TRAIL} hold=${MAXHOLD}m`);
console.log(`分岐: A 確認ブレイク=${A.length} 件 / B だまし→早目2回目=${B.length} 件\n`);

function agg(a: number[]) { const n = a.length, tot = a.reduce((x, y) => x + y, 0), w = a.filter(x => x > 0).length, gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0); return `n=${String(n).padStart(4)} 勝率=${(n ? w / n * 100 : 0).toFixed(0)}% 平均=${(n ? tot / n : 0) >= 0 ? '+' : ''}${(n ? tot / n : 0).toFixed(0)} 合計=${tot >= 0 ? '+' : ''}${Math.round(tot)} PF=${(gl > 0 ? gp / gl : Infinity).toFixed(2)}`; }

const BEF = 15;   // B利確=レベル手前(固定。トレンド比較用)
const bTrades = (setupsB: Resolved[], filt: boolean): number[] => {
  const out: number[] = [];
  for (const x of setupsB) {
    if (filt && !trendOk(x.iEntry, x.dir)) continue;
    const tpPrice = x.dir === 'up' ? x.lvl! - BEF : x.lvl! + BEF;
    const tpY = x.dir === 'up' ? tpPrice - x.ent : x.ent - tpPrice;
    if (tpY < MINTP) continue;
    out.push(fixedSL(x.iEntry, x.dir, x.ent, x.sl!, tpY));
  }
  return out;
};
const aAll = A.map(x => runner(x.iEntry, x.dir, x.ent));
const aTr = A.filter(x => trendOk(x.iEntry, x.dir)).map(x => runner(x.iEntry, x.dir, x.ent));
const bAll = bTrades(B, false), bTr = bTrades(B, true);

console.log(`MA=${MA_WIN} 傾き${SLOPE_LB}本 / B利確=レベル手前${BEF}\n`);
console.log('                          全部                                  トレンド一致のみ');
console.log(`A 確認ブレイク(ランナー)   ${agg(aAll).padEnd(46)} ${agg(aTr)}`);
console.log(`B 深い反転拾い(手前${BEF})    ${agg(bAll).padEnd(46)} ${agg(bTr)}`);
console.log(`A+B 合算                   ${agg([...aAll, ...bAll]).padEnd(46)} ${agg([...aTr, ...bTr])}`);
console.log('\n単位=円。右列(トレンド一致のみ)で PF>1 になれば、地合い選別で黒字化。');
