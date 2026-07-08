// 地合い自己検出+戦略自己修正(メタ適応): 各オーバーシュート事象(価格が L±60 到達)で、
//   「直近W事象で“追随(breakout)”と“フェード(fade)”どちらが効いていたか」を【過去だけ】で評価し、
//   良かった側を今回採用する。地合いが変われば実績が変わり、向きが自動反転=自己修正。先読み無し。
//   比較: 適応 vs 常に追随 vs 常にフェード。
// 使い方: npx tsx scripts/adaptive-regime.mts [SL=40] [TP=100] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const SL = Number(process.argv[2] ?? 40);
const TP = Number(process.argv[3] ?? 100);
const LOOKBACK = Number(process.argv[4] ?? 10);
const OFFSET = 60, TOL = 20, TICK = 5, MAXHOLD = 90;
const COST_BREAK = 20, COST_FADE = 15;     // 追随=逆指値(slip) / フェード=指値(低コスト)
const GRID = 250, GRID_NEAR = 1500;
const SYMBOL = process.argv[5] ?? 'NIY=F';   // 銘柄(多地合いスカウト用)
const MS = 60_000;
const WINDOWS = [10, 20, 40, 80];          // 適応の振り返り事象数を掃引

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;

interface Sess { key: string; hi: number; lo: number; s: number; e: number; }
const sessions: Sess[] = []; let cur: Sess | null = null;
for (let i = 0; i < N; i++) {
  const si = classifySession(bars[i]!.t); if (!si) continue;
  const key = `${si.sessionDate}|${si.session}`;
  if (!cur || cur.key !== key) { if (cur) sessions.push(cur); cur = { key, hi: bars[i]!.h, lo: bars[i]!.l, s: i, e: i }; }
  else { cur.hi = Math.max(cur.hi, bars[i]!.h); cur.lo = Math.min(cur.lo, bars[i]!.l); cur.e = i; }
}
if (cur) sessions.push(cur);

// 追随(continuation)方向の gross 損益。fade はこの符号反転。
function breakoutGross(iEntry: number, dir: 'up' | 'down', ent: number): number {
  const upLevel = dir === 'up' ? ent + TP : ent + SL;
  const dnLevel = dir === 'up' ? ent - SL : ent - TP;
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    // 訂正(2026-06-14): down は upLevel=ent+SL(損切)/dnLevel=ent-TP(利確)。継続=+TP・反転=-SL。
    if (b.h >= upLevel) return dir === 'up' ? +TP : -SL;     // 上到達: up=利確 / down=損切(上優先=保守)
    if (b.l <= dnLevel) return dir === 'up' ? -SL : +TP;     // 下到達: up=損切 / down=利確
  }
  let last = ent; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  return dir === 'up' ? last - ent : ent - last;
}
function reachIdx(from: number, untilT: number, dir: 'up' | 'down', ent: number): number {
  for (let i = from; i < N && bars[i]!.t <= untilT; i++) { const b = bars[i]!; if (dir === 'up' ? b.h >= ent : b.l <= ent) return i; }
  return -1;
}

// 事象を時刻順に収集(g=追随gross)。
interface Ev { t: number; g: number; }
const evs: Ev[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  const ev: { i: number; dir: 'up' | 'down'; ent: number }[] = [];
  for (const L of bundle(resraw)) { if (ref >= L) continue; const ent = L + OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'up', ent); if (i1 >= 0) ev.push({ i: i1, dir: 'up', ent }); }
  for (const L of bundle(supraw)) { if (ref <= L) continue; const ent = L - OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'down', ent); if (i1 >= 0) ev.push({ i: i1, dir: 'down', ent }); }
  for (const e of ev) evs.push({ t: bars[e.i]!.t, g: breakoutGross(e.i, e.dir, e.ent) });
}
evs.sort((a, b) => a.t - b.t);

function stat(a: number[]) { const n = a.length, tot = a.reduce((x, y) => x + y, 0), w = a.filter(x => x > 0).length, gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0); return `n=${n} 勝率=${(w / n * 100).toFixed(0)}% 平均=${(tot / n).toFixed(1)} 合計=${tot >= 0 ? '+' : ''}${Math.round(tot)} PF=${(gl > 0 ? gp / gl : Infinity).toFixed(2)}`; }

const breakNet = evs.map(e => e.g - COST_BREAK);
const fadeNet = evs.map(e => -e.g - COST_FADE);
console.log(`事象 ${evs.length} (${new Date(evs[0]!.t + 9 * 3.6e6).toISOString().slice(0, 10)}..)  SL=${SL} TP=${TP} 費用 追随${COST_BREAK}/フェード${COST_FADE}\n`);
console.log(`常に追随(breakout)   ${stat(breakNet)}`);
console.log(`常にフェード(fade)    ${stat(fadeNet)}`);
console.log('\n--- 適応(直近W事象の実績で向きを自己選択・先読み無し) ---');
for (const W of WINDOWS) {
  const realized: number[] = []; const chooseFade: boolean[] = [];
  let flips = 0, prev = true;
  for (let i = 0; i < evs.length; i++) {
    // 直近W事象(< i)の各モード実績で判断。warmup(=W未満)はフェード既定(レンジ前提)。
    let mode: 'break' | 'fade';
    if (i < W) mode = 'fade';
    else {
      let rb = 0, rf = 0;
      for (let j = i - W; j < i; j++) { rb += breakNet[j]!; rf += fadeNet[j]!; }
      mode = rb > rf ? 'break' : 'fade';
    }
    realized.push(mode === 'break' ? breakNet[i]! : fadeNet[i]!);
    const f = mode === 'fade'; chooseFade.push(f); if (i > 0 && f !== prev) flips++; prev = f;
  }
  const fadePct = (chooseFade.filter(Boolean).length / chooseFade.length * 100).toFixed(0);
  console.log(`W=${String(W).padStart(2)}  ${stat(realized)}  (フェード採用${fadePct}% / 切替${flips}回)`);
}
console.log('\n単位=円。適応が「常に追随/常にフェード」を上回れば、地合い自己検出+自己修正に価値。');
