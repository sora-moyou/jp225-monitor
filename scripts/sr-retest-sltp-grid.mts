// S/R＋リテスト入場の「1回目 vs だまし後2回目」を、損切(SL)×利確(TP)のグリッドで掃引する。
//   エントリー検出は sr-retest-backtest と同じ(直近セッションH/L+250節目・リテスト保持)。
//   SL/TP は入場価格からの固定幅(円)。各セルで PF を出し、①と②を並べて比較。PF>1 は [*] 印。
// 使い方: npx tsx scripts/sr-retest-sltp-grid.mts [LOOKBACK=10] [tol=20] [maxHoldMin=90]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../core/session.js';

const LOOKBACK = Number(process.argv[2] ?? 10);
const TOL = Number(process.argv[3] ?? 20);
const MAXHOLD = Number(process.argv[4] ?? 90);
const FAKE_MAX = Number(process.argv[5] ?? 40);    // だまし圏(円): 1回目のレベル超の最大行き & 戻りの深さ上限。これを超えたら「深い反転」=除外。
const FAKE_WIN = Number(process.argv[6] ?? 20);    // 1回目ブレイクが失敗するまでの最大時間(分)。遅い失敗=だましでない=除外。
const TICK = 5, COST = 5 * 2 + 1 * TICK;       // 15円/トレード
const GRID = 250, GRID_NEAR = 1500, RETEST_WIN = 60, K_GUARD = 30;
const SYMBOL = 'NIY=F', MS = 60_000;
const STOPS = [10, 15, 20, 30, 40, 60];        // 損切幅(円)
const TPS = [20, 30, 45, 60, 90, 120];         // 利確幅(円・すべて費用15超)

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;

interface Sess { key: string; date: string; hi: number; lo: number; startIdx: number; endIdx: number; }
const sessions: Sess[] = []; let cur: Sess | null = null;
for (let i = 0; i < N; i++) {
  const si = classifySession(bars[i]!.t); if (!si) continue;
  const key = `${si.sessionDate}|${si.session}`;
  if (!cur || cur.key !== key) { if (cur) sessions.push(cur); cur = { key, date: si.sessionDate, hi: bars[i]!.h, lo: bars[i]!.l, startIdx: i, endIdx: i }; }
  else { cur.hi = Math.max(cur.hi, bars[i]!.h); cur.lo = Math.min(cur.lo, bars[i]!.l); cur.endIdx = i; }
}
if (cur) sessions.push(cur);

// --- エントリー検出(1回目/2回目)。SL/TPに依存しないので一度だけ。 ---
interface Entry { i0: number; dir: 'up' | 'down'; }
const first: Entry[] = [], second: Entry[] = [];
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!, ref = bars[S.startIdx]!.c;
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) (g >= ref ? resraw : supraw).push(g);
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const o: number[] = []; for (const v of a) if (!o.length || v - o.at(-1)! > TOL) o.push(v); return o.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  const run = (levels: number[], dir: 'up' | 'down') => {
    for (const L of levels) {
      let st = 0, brokeAtT = 0, maxExc = 0, maxDip = 0;
      for (let i = S.startIdx; i <= S.endIdx; i++) {
        const b = bars[i]!, c = b.c;
        const broke = dir === 'up' ? c > L : c < L, back = dir === 'up' ? c < L : c > L;
        const exc = dir === 'up' ? b.h - L : L - b.l;   // レベル超の行き(ヒゲ含む)
        const dip = dir === 'up' ? L - b.l : b.h - L;   // レベル割れの深さ
        const touched = dir === 'up' ? (b.l <= L + TOL && c > L) : (b.h >= L - TOL && c < L);
        if (st === 0 && broke) { st = 1; brokeAtT = b.t; maxExc = Math.max(0, exc); }
        else if (st === 1) {
          maxExc = Math.max(maxExc, exc);
          if (back) {
            // だまし=浅く速い失敗のみ採用。深く行った/遅い失敗は「反転」であって だまし でない→このレベルを②から除外。
            if (maxExc <= FAKE_MAX && b.t - brokeAtT <= FAKE_WIN * MS) { st = 2; maxDip = 0; } else st = 9;
          } else if (touched && b.t - brokeAtT <= RETEST_WIN * MS) { first.push({ i0: i, dir }); st = 9; }
        }
        else if (st === 2) {
          maxDip = Math.max(maxDip, dip);
          if (maxDip > FAKE_MAX) st = 9;                // 戻りが深い=深いところでの反転→除外
          else if (broke) { st = 3; brokeAtT = b.t; }
        }
        else if (st === 3) { if (touched && b.t - brokeAtT <= RETEST_WIN * MS) { second.push({ i0: i, dir }); break; } if (back) break; }
      }
    }
  };
  run(bundle(resraw), 'up'); run(bundle(supraw), 'down');
}
console.log(`sessions ${sessions.length} (${sessions[0]?.date}..${sessions.at(-1)?.date})  入場: 1回目=${first.length} 2回目=${second.length}  cost=${COST} hold=${MAXHOLD}m\n`);

function pf(es: Entry[], stopYen: number, tpYen: number): { pf: number; win: number; tot: number; n: number } {
  let gp = 0, gl = 0, wins = 0, tot = 0, n = 0;
  for (const e of es) {
    const p0 = bars[e.i0]!.c;
    const sl = e.dir === 'up' ? p0 - stopYen : p0 + stopYen;
    const tp = e.dir === 'up' ? p0 + tpYen : p0 - tpYen;
    const endT = bars[e.i0]!.t + MAXHOLD * MS; let pnl: number | null = null;
    for (let i = e.i0 + 1; i < N && bars[i]!.t <= endT; i++) {
      const b = bars[i]!;
      if (e.dir === 'up') { if (b.l <= sl) { pnl = -stopYen - COST; break; } if (b.h >= tp) { pnl = tpYen - COST; break; } }
      else { if (b.h >= sl) { pnl = -stopYen - COST; break; } if (b.l <= tp) { pnl = tpYen - COST; break; } }
    }
    if (pnl === null) { let last = p0; for (let i = e.i0 + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c; const raw = e.dir === 'up' ? last - p0 : p0 - last; pnl = raw - COST; }
    n++; tot += pnl; if (pnl > 0) { gp += pnl; wins++; } else gl -= pnl;
  }
  return { pf: gl > 0 ? gp / gl : Infinity, win: n ? wins / n : 0, tot, n };
}

function matrix(label: string, es: Entry[]) {
  console.log(`### ${label} (PF / [*]=PF>1 / 行=損切, 列=利確) ###`);
  console.log('  SL\\TP  ' + TPS.map(t => String(t).padStart(8)).join(''));
  for (const sl of STOPS) {
    const cells = TPS.map(tp => { const r = pf(es, sl, tp); const mark = r.pf > 1 ? '*' : ' '; return (r.pf === Infinity ? '∞' : r.pf.toFixed(2)).padStart(7) + mark; });
    console.log(String(sl).padStart(5) + '   ' + cells.join(''));
  }
  console.log();
}
// ランダムベースライン(① と同数・両方向・任意時刻)。同じSL/TPグリッドで評価。
let seed = 7919; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randEntries: Entry[] = [];
for (let k = 0; k < first.length; k++) randEntries.push({ i0: K_GUARD + Math.floor(rnd() * (N - 2 * K_GUARD)), dir: rnd() < 0.5 ? 'up' : 'down' });

matrix('① 1回目ブレイク', first);
matrix('② 2回目(だまし後)ブレイク', second);
matrix('③ ランダム入場(ベースライン)', randEntries);
console.log('単位=円。各セル=そのSL/TPでのProfitFactor。PF>1(=利益)に [*]。①>③なら実エッジ、②>①なら仮説支持。');
