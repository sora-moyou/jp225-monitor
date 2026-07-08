// 「負ける手法の逆を取れば勝てるか」を実測。ブレイク(逆指値@L±60)のエントリーで、
//   元方向(順張りロング/ショート) と 同値・逆ポジ(同じ価格バリアで反対側を持つ) の損益を比較。
//   両建て損益和 = -2×費用 になる(費用の二重取られ)ことを数字で確認する。
// 使い方: npx tsx scripts/invert-test.mts [SL=40] [TP=80] [LOOKBACK=10]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const SL = Number(process.argv[2] ?? 40);
const TP = Number(process.argv[3] ?? 80);
const LOOKBACK = Number(process.argv[4] ?? 10);
const COST = Number(process.argv[5] ?? 20);  // 費用/トレード(逆ポジを指値フェードで組むと低コスト=12-15)
const OFFSET = 60, TOL = 20, TICK = 5;
const GRID = 250, GRID_NEAR = 1500, MAXHOLD = 90;
const SYMBOL = 'NIY=F', MS = 60_000;

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

// 価格バリア loLevel(下) / hiLevel(上) を最初に触れた方で決済。エントリー ent。
// 元ロング: TP=ent+TP(上), SL=ent-SL(下)。逆ショート(同値): その同じ2本の価格で反対損益。
function pair(iEntry: number, dir: 'up' | 'down', ent: number): { orig: number; inv: number } {
  const upLevel = dir === 'up' ? ent + TP : ent + SL;   // 上のバリア
  const dnLevel = dir === 'up' ? ent - SL : ent - TP;   // 下のバリア
  const endT = bars[iEntry]!.t + MAXHOLD * MS;
  let hitUp = false, hitDn = false;
  const upFirst = process.argv[6] === 'upfirst';   // 同一足の優先: 既定=下優先 / upfirst=上優先(フェードに不利=保守)
  for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (upFirst) { if (b.h >= upLevel) { hitUp = true; break; } if (b.l <= dnLevel) { hitDn = true; break; } }
    else { if (b.l <= dnLevel) { hitDn = true; break; } if (b.h >= upLevel) { hitUp = true; break; } }
  }
  // 元方向の損益(gross)
  let gOrig: number;
  // 訂正(2026-06-14): down は upLevel=ent+SL(損切)/dnLevel=ent-TP(利確)。継続=利確で+TP・反転=損切で-SL。
  if (hitUp) gOrig = dir === 'up' ? +TP : -SL;        // 上到達: up=利確+TP / down=損切-SL
  else if (hitDn) gOrig = dir === 'up' ? -SL : +TP;   // 下到達: up=損切-SL / down=利確+TP
  else { let last = ent; for (let i = iEntry + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c; gOrig = dir === 'up' ? last - ent : ent - last; }
  return { orig: gOrig - COST, inv: -gOrig - COST };   // 逆ポジ=grossの符号反転、費用は同じだけ掛かる
}

function reachIdx(from: number, untilT: number, dir: 'up' | 'down', ent: number): number {
  for (let i = from; i < N && bars[i]!.t <= untilT; i++) { const b = bars[i]!; if (dir === 'up' ? b.h >= ent : b.l <= ent) return i; }
  return -1;
}

const orig: number[] = [], inv: number[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.s]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  for (const L of bundle(resraw)) { if (ref >= L) continue; const ent = L + OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'up', ent); if (i1 >= 0) { const p = pair(i1, 'up', ent); orig.push(p.orig); inv.push(p.inv); } }
  for (const L of bundle(supraw)) { if (ref <= L) continue; const ent = L - OFFSET; const i1 = reachIdx(S.s, bars[S.e]!.t, 'down', ent); if (i1 >= 0) { const p = pair(i1, 'down', ent); orig.push(p.orig); inv.push(p.inv); } }
}

function agg(a: number[]) { const n = a.length, tot = a.reduce((x, y) => x + y, 0), w = a.filter(x => x > 0).length, gp = a.filter(x => x > 0).reduce((x, y) => x + y, 0), gl = -a.filter(x => x < 0).reduce((x, y) => x + y, 0); return `n=${n} 勝率=${(w / n * 100).toFixed(0)}% 平均=${(tot / n).toFixed(1)} 合計=${Math.round(tot)} PF=${(gl > 0 ? gp / gl : Infinity).toFixed(2)}`; }
console.log(`ブレイク 逆指値@±${OFFSET} SL=${SL} TP=${TP} 費用=${COST}/trade  n=${orig.length}\n`);
console.log(`元方向(順張り)        ${agg(orig)}`);
console.log(`同値・逆ポジ(逆張り)  ${agg(inv)}`);
console.log(`\n両建て合計(=元+逆)= ${Math.round(orig.reduce((a, b) => a + b, 0) + inv.reduce((a, b) => a + b, 0))}円 ≒ -2×費用×n = ${-2 * COST * orig.length}`);
console.log('→ 逆が勝つのは「元の負けが 2×費用 を超える=強い負けエッジ」がある時だけ。費用ぶんの負けは逆でも取り戻せない。');
