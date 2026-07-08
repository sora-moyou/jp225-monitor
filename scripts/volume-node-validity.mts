// ============================================================================
// VOLUME-NODE VALIDITY TEST — are HVN (high-volume nodes) real S/R on NIY=F?
//
// CONTEXT (per leader): all prior level backtests used {session H/L + 250 grid}
// which level-validity.mts proved are NOT respected above a fair control. The ONE
// untested level type is VOLUME NODES (volume-profile HVN/LVN) — a different data
// dimension (volume, not price). This script:
//   Part 1: build point-in-time HVN/LVN (no look-ahead) replicating the LIVE
//           computeVolumeProfile (server/volumeProfile.ts) over trailing windows.
//   Part 2: validate HVN/LVN as S/R using level-validity.mts's FAIR methods —
//           turning-point clustering vs baseline + reaction-rate vs MATCHED control
//           (sparse control: random 5-grid points avoiding real nodes, stratified
//           by approach dir + vol bucket). Per-type, per-year, with significance.
//   Part 3: IF HVN valid → re-run level interactions (fade/break/bounce bracket)
//           on HVN, net of cost, vs random + long/short + buy&hold beta control.
//
// Control rigor REUSED verbatim from level-validity.mts (the phase-shift/sparse
// control + stratified matching that fixed the round-number baseline bug). HVN are
// sparse point levels => sparse control (like prevSess/multitouch), NOT grid.
//
// Point-in-time everywhere. Session/gap-aware. node:sqlite. Do NOT commit.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const SYM = 'NIY=F';
const TICK = 5;
const GAP_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; sd: string; sess: string; yr: string };

function loadBars(): Bar[] {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(
    'SELECT session_date sd, session sess, t, o, h, l, c, volume v FROM bars_1m WHERE symbol=? ORDER BY t'
  ).all(SYM) as any[];
  db.close();
  return rows.map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v || 0, sd: r.sd, sess: r.sess, yr: String(r.sd).slice(0, 4) }));
}

function splitRuns(bars: Bar[]): Bar[][] {
  const runs: Bar[][] = [];
  let cur: Bar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    if (cur.length && b.t - cur[cur.length - 1]!.t > GAP_MS) { runs.push(cur); cur = []; }
    cur.push(b);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

// ===========================================================================
// PART 1 — point-in-time volume nodes (replicates server/volumeProfile.ts)
// ===========================================================================
// computeVolumeProfile: bin volume by price (binYen), each bar's volume spread
// uniformly across its h..l bins. HVN = local maxima with vol >= pocVol*minRel.
// We ALSO emit LVN (local minima / volume troughs) for the LVN theory test.
type VolBar = { h: number; l: number; v: number };
type Node = { price: number; rel: number; isPoc: boolean };

function volumeProfile(bars: VolBar[], binYen: number, topN: number, minRel: number): { hvn: Node[]; lvn: Node[] } {
  if (bars.length === 0 || binYen <= 0) return { hvn: [], lvn: [] };
  const hist = new Map<number, number>();
  for (const b of bars) {
    if (!(b.v > 0) || !(b.h >= b.l) || b.l <= 0) continue;
    const loBin = Math.floor(b.l / binYen), hiBin = Math.floor(b.h / binYen);
    const n = hiBin - loBin + 1;
    const per = b.v / n;
    for (let k = loBin; k <= hiBin; k++) hist.set(k, (hist.get(k) ?? 0) + per);
  }
  if (hist.size === 0) return { hvn: [], lvn: [] };
  const pocVol = Math.max(...hist.values());
  const hvn: Node[] = [];
  const lvn: Node[] = [];
  // determine the contiguous occupied bin range for LVN troughs
  const ks = [...hist.keys()].sort((a, b) => a - b);
  const minK = ks[0]!, maxK = ks[ks.length - 1]!;
  for (const [k, v] of hist) {
    const lo = hist.get(k - 1) ?? 0, hi = hist.get(k + 1) ?? 0;
    // HVN: local max (>= both neighbours) AND >= minRel of POC  (live logic)
    if (v >= lo && v >= hi && v >= pocVol * minRel) {
      hvn.push({ price: Math.round(k * binYen + binYen / 2), rel: v / pocVol, isPoc: v === pocVol });
    }
  }
  // LVN: interior local minima (volume troughs) — theorized as fast move-through.
  // Only interior bins (both neighbours occupied) with v <= both neighbours and
  // v below a fraction of POC (a genuine valley, not the profile edge).
  for (const k of ks) {
    if (k <= minK || k >= maxK) continue;
    const v = hist.get(k)!;
    const lo = hist.get(k - 1) ?? 0, hi = hist.get(k + 1) ?? 0;
    if (lo === 0 || hi === 0) continue; // need real neighbours on both sides
    if (v <= lo && v <= hi && v <= pocVol * 0.35) {
      lvn.push({ price: Math.round(k * binYen + binYen / 2), rel: v / pocVol, isPoc: false });
    }
  }
  hvn.sort((a, b) => b.rel - a.rel);
  lvn.sort((a, b) => a.rel - b.rel);
  return { hvn: hvn.slice(0, topN), lvn: lvn.slice(0, topN) };
}

// Build, for each run, the active HVN/LVN as of the run's start, from a trailing
// window of bars STRICTLY BEFORE the run (no look-ahead).
//   window 'sess' = the single prior run (session)
//   window '1d'   = all bars in [runStart-1day, runStart)
//   window '5d'   = all bars in [runStart-5day, runStart)
// All bars used satisfy t < run[0].t.
function buildNodeLevels(
  bars: Bar[], runs: Bar[][], window: 'sess' | '1d' | '5d',
  binYen: number, topN: number, minRel: number
): { hvn: number[]; lvn: number[]; relByPrice: Map<number, number> }[] {
  const out: { hvn: number[]; lvn: number[]; relByPrice: Map<number, number> }[] = [];
  // For '1d'/'5d' we need fast lookups of bars before a timestamp — bars is sorted by t.
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    const startT = run[0]!.t;
    let src: VolBar[] = [];
    if (window === 'sess') {
      const prev = runs[i - 1];
      if (prev) src = prev.map(b => ({ h: b.h, l: b.l, v: b.v }));
    } else {
      const span = window === '1d' ? DAY_MS : 5 * DAY_MS;
      const lo = startT - span;
      // binary scan: bars sorted by t. collect bars with lo <= t < startT
      // (linear from a cursor would be faster but per-run binary is fine here)
      let a = 0, b = bars.length;
      while (a < b) { const m = (a + b) >> 1; if (bars[m]!.t < lo) a = m + 1; else b = m; }
      for (let j = a; j < bars.length && bars[j]!.t < startT; j++) {
        const bb = bars[j]!;
        src.push({ h: bb.h, l: bb.l, v: bb.v });
      }
    }
    const { hvn, lvn } = volumeProfile(src, binYen, topN, minRel);
    const relByPrice = new Map<number, number>();
    for (const n of hvn) relByPrice.set(Math.round(n.price / TICK) * TICK, n.rel);
    out.push({
      hvn: hvn.map(n => Math.round(n.price / TICK) * TICK),
      lvn: lvn.map(n => Math.round(n.price / TICK) * TICK),
      relByPrice,
    });
  }
  return out;
}

// ===========================================================================
// Turning points (verbatim from level-validity.mts)
// ===========================================================================
function swingTurns(runs: Bar[][], W: number): { price: number; yr: string; dir: 'H' | 'L' }[] {
  const out: { price: number; yr: string; dir: 'H' | 'L' }[] = [];
  for (const run of runs) {
    for (let i = W; i < run.length - W; i++) {
      const b = run[i]!;
      let isH = true, isL = true;
      for (let k = i - W; k <= i + W; k++) {
        if (k === i) continue;
        if (run[k]!.h >= b.h) isH = false;
        if (run[k]!.l <= b.l) isL = false;
      }
      if (isH) out.push({ price: b.h, yr: b.yr, dir: 'H' });
      if (isL) out.push({ price: b.l, yr: b.yr, dir: 'L' });
    }
  }
  return out;
}

// ===========================================================================
// Reaction machinery (verbatim from level-validity.mts)
// ===========================================================================
type Touch = { rev: boolean; resolved: boolean; dir: 'below' | 'above'; volBucket: number; yr: string };

function localVol(run: Bar[], idx: number, look = 30): number {
  let s = 0, n = 0;
  for (let k = Math.max(1, idx - look); k <= idx; k++) { s += Math.abs(run[k]!.c - run[k - 1]!.c); n++; }
  return n ? s / n : 0;
}
function volBucketOf(v: number): number {
  if (v < 8) return 0; if (v < 15) return 1; if (v < 25) return 2; if (v < 40) return 3; return 4;
}
function evalReaction(run: Bar[], touchIdx: number, L: number, dir: 'below' | 'above', R: number, N: number): { resolved: boolean; rev: boolean } {
  const end = Math.min(run.length - 1, touchIdx + N);
  for (let k = touchIdx + 1; k <= end; k++) {
    const b = run[k]!;
    if (dir === 'below') {
      if (b.l <= L - R) return { resolved: true, rev: true };
      if (b.h >= L + R) return { resolved: true, rev: false };
    } else {
      if (b.h >= L + R) return { resolved: true, rev: true };
      if (b.l <= L - R) return { resolved: true, rev: false };
    }
  }
  return { resolved: false, rev: false };
}

// levels are supplied PER RUN INDEX (precomputed node sets). tol = touch window.
function reactionAtLevels(runs: Bar[][], levelsByRun: number[][], tol: number, R: number, N: number, warmup: number): Touch[] {
  const touches: Touch[] = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!;
    if (run.length < warmup + N + 2) continue;
    const levels = levelsByRun[ri] || [];
    if (!levels.length) continue;
    const touched = new Set<number>();
    for (let i = warmup; i < run.length - 1; i++) {
      const b = run[i]!;
      for (const L of levels) {
        if (touched.has(L)) continue;
        if (Math.abs(b.c - L) <= tol || (b.l <= L && b.h >= L)) {
          const prev = run[i - 1]!.c;
          const dir: 'below' | 'above' = prev <= L ? 'below' : 'above';
          const vb = volBucketOf(localVol(run, i));
          const r = evalReaction(run, i, L, dir, R, N);
          touches.push({ rev: r.rev, resolved: r.resolved, dir, volBucket: vb, yr: b.yr });
          touched.add(L);
        }
      }
    }
  }
  return touches;
}

// SPARSE control: per run, random 5-grid points avoiding ±avoid of any real node
// in that run's set (same approach as level-validity sparseControl for sparse
// level types). perRun matched to ~the count of real nodes touched.
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function reactionAtSparseControl(
  runs: Bar[][], realByRun: number[][], avoid: number, perRun: number,
  tol: number, R: number, N: number, warmup: number, rng: () => number
): Touch[] {
  const touches: Touch[] = [];
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!;
    if (run.length < warmup + N + 2) continue;
    const real = realByRun[ri] || [];
    if (!real.length) continue; // only generate controls for runs that HAVE real nodes (match exposure)
    let lo = Infinity, hi = -Infinity;
    for (const b of run) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!isFinite(lo) || hi <= lo) continue;
    const ctrl: number[] = [];
    let tries = 0;
    while (ctrl.length < perRun && tries < perRun * 40) {
      tries++;
      const L = Math.round((lo + rng() * (hi - lo)) / TICK) * TICK;
      if (L <= lo || L >= hi) continue;
      let near = false;
      for (const rl of real) if (Math.abs(rl - L) <= avoid) { near = true; break; }
      if (near) continue;
      if (ctrl.includes(L)) continue;
      ctrl.push(L);
    }
    const touched = new Set<number>();
    for (let i = warmup; i < run.length - 1; i++) {
      const b = run[i]!;
      for (const L of ctrl) {
        if (touched.has(L)) continue;
        if (Math.abs(b.c - L) <= tol || (b.l <= L && b.h >= L)) {
          const prev = run[i - 1]!.c;
          const dir: 'below' | 'above' = prev <= L ? 'below' : 'above';
          const vb = volBucketOf(localVol(run, i));
          const r = evalReaction(run, i, L, dir, R, N);
          touches.push({ rev: r.rev, resolved: r.resolved, dir, volBucket: vb, yr: b.yr });
          touched.add(L);
        }
      }
    }
  }
  return touches;
}

function stratifiedRevRate(level: Touch[], control: Touch[]): { levRate: number; ctrlRate: number; nLev: number; nCtrl: number } {
  const lev = level.filter(t => t.resolved);
  const ctrl = control.filter(t => t.resolved);
  const key = (t: Touch) => `${t.dir}|${t.volBucket}`;
  const levCount = new Map<string, number>();
  for (const t of lev) levCount.set(key(t), (levCount.get(key(t)) || 0) + 1);
  const nLev = lev.length;
  const ctrlByK = new Map<string, Touch[]>();
  for (const t of ctrl) { const k = key(t); if (!ctrlByK.has(k)) ctrlByK.set(k, []); ctrlByK.get(k)!.push(t); }
  let levRev = 0; for (const t of lev) if (t.rev) levRev++;
  let matched = 0, wsum = 0;
  for (const [k, w] of levCount) {
    const cs = ctrlByK.get(k);
    if (!cs || !cs.length) continue;
    let cr = 0; for (const t of cs) if (t.rev) cr++;
    matched += (w / nLev) * (cr / cs.length);
    wsum += w / nLev;
  }
  const ctrlRate = wsum > 0 ? matched / wsum : NaN;
  return { levRate: nLev ? levRev / nLev : NaN, ctrlRate, nLev, nCtrl: ctrl.length };
}
function propZ(p1: number, n1: number, p2: number, n2eff: number): number {
  if (!isFinite(p1) || !isFinite(p2) || n1 < 5 || n2eff < 5) return NaN;
  const p = (p1 * n1 + p2 * n2eff) / (n1 + n2eff);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2eff));
  return se > 0 ? (p1 - p2) / se : NaN;
}

// distance to nearest member of a sorted level array
function distToNearest(price: number, levels: number[]): number {
  let best = Infinity;
  for (const L of levels) { const d = Math.abs(price - L); if (d < best) best = d; }
  return best;
}

// ===========================================================================
// PART 2A — turning-point clustering at HVN/LVN vs all-bars baseline
// For each turn, is it within tol of an active node (as of that turn's run)?
// Baseline = fraction of all-bar CLOSES within tol of their run's active node.
// (Same fair construction as Method A: turns vs bars on the SAME node geometry.)
// ===========================================================================
function part2A_clustering(
  bars: Bar[], runs: Bar[][], nodeByRun: { hvn: number[]; lvn: number[] }[],
  W: number, tol: number, pick: 'hvn' | 'lvn'
) {
  // map each bar to its run index
  const runOfBar = new Map<number, number>(); // not needed; iterate per run
  // turns per run with their run index
  const years = [...new Set(bars.map(b => b.yr))].sort();
  // accumulate per year: turnHit, turnTot, baseHit, baseTot
  const acc = new Map<string, { th: number; tt: number; bh: number; bt: number }>();
  for (const y of years) acc.set(y, { th: 0, tt: 0, bh: 0, bt: 0 });
  const all = { th: 0, tt: 0, bh: 0, bt: 0 };

  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!;
    const lv = pick === 'hvn' ? nodeByRun[ri]!.hvn : nodeByRun[ri]!.lvn;
    if (!lv.length) continue;
    // baseline: all closes in run
    for (const b of run) {
      const hit = distToNearest(b.c, lv) <= tol ? 1 : 0;
      all.bt++; all.bh += hit;
      const a = acc.get(b.yr)!; a.bt++; a.bh += hit;
    }
    // turns in run
    for (let i = W; i < run.length - W; i++) {
      const b = run[i]!;
      let isH = true, isL = true;
      for (let k = i - W; k <= i + W; k++) { if (k === i) continue; if (run[k]!.h >= b.h) isH = false; if (run[k]!.l <= b.l) isL = false; }
      if (isH) { const hit = distToNearest(b.h, lv) <= tol ? 1 : 0; all.tt++; all.th += hit; const a = acc.get(b.yr)!; a.tt++; a.th += hit; }
      if (isL) { const hit = distToNearest(b.l, lv) <= tol ? 1 : 0; all.tt++; all.th += hit; const a = acc.get(b.yr)!; a.tt++; a.th += hit; }
    }
  }
  const pB = all.bt ? all.bh / all.bt : NaN;
  const pT = all.tt ? all.th / all.tt : NaN;
  const exp = all.tt * pB;
  const z = (all.th - exp) / Math.sqrt(exp * (1 - pB) + 1e-9);
  console.log(`  ALL: nTurn=${all.tt} pBase=${(pB * 100).toFixed(2)}% pTurn=${(pT * 100).toFixed(2)}% lift=${(pT / pB).toFixed(3)} z=${z.toFixed(1)}`);
  for (const y of years) {
    const a = acc.get(y)!;
    if (!a.tt || !a.bt) continue;
    const pb = a.bh / a.bt, pt = a.th / a.tt;
    const e = a.tt * pb;
    const zz = (a.th - e) / Math.sqrt(e * (1 - pb) + 1e-9);
    console.log(`    ${y}: nTurn=${String(a.tt).padStart(5)} pBase=${(pb * 100).toFixed(2)}% pTurn=${(pt * 100).toFixed(2)}% lift=${(pt / pb).toFixed(3)} z=${zz.toFixed(1)}`);
  }
}

// ===========================================================================
// PART 3 — bracket P&L of level interactions on HVN (only if valid)
// fade: enter opposite to approach at node. break: enter WITH break (+brkY beyond).
// bounce == fade here (reversal off node). bracket SL/TP, cost = 1-tick slip*2 + 10.
// long/short split, plus buy&hold beta over same holding horizon.
// ===========================================================================
function evalBracket(run: Bar[], i: number, entry: number, isShort: boolean, slY: number, tpY: number): { net: number; bars: number } | null {
  const tp = isShort ? entry - tpY : entry + tpY;
  const sl = isShort ? entry + slY : entry - slY;
  for (let k = i + 1; k < run.length; k++) {
    const b = run[k]!;
    if (isShort) {
      if (b.h >= sl) return { net: -slY, bars: k - i };       // pessimistic: SL first if both
      if (b.l <= tp) return { net: tpY, bars: k - i };
    } else {
      if (b.l <= sl) return { net: -slY, bars: k - i };
      if (b.h >= tp) return { net: tpY, bars: k - i };
    }
  }
  return null;
}

type StratStat = { n: number; sumNet: number; wins: number; nL: number; sumNetL: number; nS: number; sumNetS: number; sumBH: number; nBH: number };
function emptyStat(): StratStat { return { n: 0, sumNet: 0, wins: 0, nL: 0, sumNetL: 0, nS: 0, sumNetS: 0, sumBH: 0, nBH: 0 }; }

function runStrategy(
  runs: Bar[][], levelsByRun: number[][], mode: 'fade' | 'break',
  tol: number, slY: number, tpY: number, brkY: number, cost: number, warmup: number
): StratStat {
  const st = emptyStat();
  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri]!;
    if (run.length < warmup + 5) continue;
    const levels = levelsByRun[ri] || [];
    if (!levels.length) continue;
    const touched = new Set<number>();
    for (let i = warmup; i < run.length - 1; i++) {
      const b = run[i]!;
      for (const L of levels) {
        if (touched.has(L)) continue;
        if (Math.abs(b.c - L) <= tol || (b.l <= L && b.h >= L)) {
          touched.add(L);
          const prev = run[i - 1]!.c;
          const dir: 'below' | 'above' = prev <= L ? 'below' : 'above';
          let isShort: boolean, entry: number;
          if (mode === 'fade') {
            // approached from below (rising into L) => fade short at L
            isShort = dir === 'below'; entry = L;
          } else {
            // break: trade WITH the break. from below rising => expect break up => LONG at L+brk
            isShort = dir === 'above'; entry = isShort ? L - brkY : L + brkY;
            // only take if the break trigger is actually reached later; entry simulated as a stop
            // find first bar at/after i that reaches entry
            let trig = -1;
            for (let k = i; k < run.length; k++) {
              const bb = run[k]!;
              if (!isShort && bb.h >= entry) { trig = k; break; }
              if (isShort && bb.l <= entry) { trig = k; break; }
            }
            if (trig < 0) continue;
            const r = evalBracket(run, trig, entry, isShort, slY, tpY);
            if (!r) continue;
            const net = r.net - cost;
            st.n++; st.sumNet += net; if (net > 0) st.wins++;
            if (isShort) { st.nS++; st.sumNetS += net; } else { st.nL++; st.sumNetL += net; }
            const bh = run[Math.min(run.length - 1, trig + r.bars)]!.c - entry;
            st.sumBH += isShort ? -bh : bh; st.nBH++;
            continue;
          }
          const r = evalBracket(run, i, entry, isShort, slY, tpY);
          if (!r) continue;
          const net = r.net - cost;
          st.n++; st.sumNet += net; if (net > 0) st.wins++;
          if (isShort) { st.nS++; st.sumNetS += net; } else { st.nL++; st.sumNetL += net; }
          // buy&hold beta: same direction, held r.bars bars, no level
          const exitC = run[Math.min(run.length - 1, i + r.bars)]!.c;
          const bh = exitC - entry;
          st.sumBH += isShort ? -bh : bh; st.nBH++;
        }
      }
    }
  }
  return st;
}

function printStat(name: string, st: StratStat, cost: number) {
  const avg = st.n ? st.sumNet / st.n : NaN;
  const win = st.n ? st.wins / st.n : NaN;
  const avgL = st.nL ? st.sumNetL / st.nL : NaN;
  const avgS = st.nS ? st.sumNetS / st.nS : NaN;
  const bh = st.nBH ? st.sumBH / st.nBH : NaN;
  console.log(
    name.padEnd(20),
    String(st.n).padStart(6),
    (isFinite(avg) ? avg.toFixed(1) : 'na').padStart(8),
    (isFinite(win) ? (win * 100).toFixed(1) : 'na').padStart(7),
    (isFinite(avgL) ? avgL.toFixed(1) : 'na').padStart(8),
    (isFinite(avgS) ? avgS.toFixed(1) : 'na').padStart(8),
    (isFinite(bh) ? bh.toFixed(1) : 'na').padStart(8),
  );
}

// ===========================================================================
function main() {
  const t0 = Date.now();
  console.log('Loading bars...');
  const bars = loadBars();
  const runs = splitRuns(bars);
  const years = [...new Set(bars.map(b => b.yr))].sort();
  console.log(`bars=${bars.length} runs=${runs.length} years=${years.join(',')}`);

  // node-set sweep: window × bin × minRel(HVN). topN fixed at 8 (live default).
  const windows: ('sess' | '1d' | '5d')[] = ['sess', '1d', '5d'];
  const bins = [25, 50];            // live default 50; finer 25 (>= 5*tick)
  const minRel = 0.4;               // live default
  const topN = 8;

  // precompute node sets for each (window,bin)
  const nodeSets = new Map<string, ReturnType<typeof buildNodeLevels>>();
  for (const w of windows) for (const bin of bins) {
    nodeSets.set(`${w}|${bin}`, buildNodeLevels(bars, runs, w, bin, topN, minRel));
  }
  // node-count diagnostics
  console.log('\n--- node-set coverage (avg HVN/run, runs with >=1 HVN) ---');
  for (const w of windows) for (const bin of bins) {
    const ns = nodeSets.get(`${w}|${bin}`)!;
    let tot = 0, with1 = 0, lvnTot = 0;
    for (const s of ns) { tot += s.hvn.length; if (s.hvn.length) with1++; lvnTot += s.lvn.length; }
    console.log(`  win=${w} bin=${bin}: avgHVN=${(tot / ns.length).toFixed(2)} runsWithHVN=${with1}/${ns.length} avgLVN=${(lvnTot / ns.length).toFixed(2)}`);
  }

  // =====================================================================
  // PART 2A — turning-point clustering
  // =====================================================================
  console.log('\n\n================= PART 2A: TURNING-POINT CLUSTERING AT HVN/LVN =================');
  console.log('lift = P(turn within tol of node) / P(close within tol of node). lift>1 => turns favour nodes.');
  for (const W of [10, 30]) {
    for (const w of windows) for (const bin of bins) {
      const ns = nodeSets.get(`${w}|${bin}`)!;
      const tol = Math.max(TICK, Math.round(bin / 2));
      console.log(`\n--- HVN  W=${W} win=${w} bin=${bin} tol=${tol} ---`);
      part2A_clustering(bars, runs, ns, W, tol, 'hvn');
    }
  }
  // LVN clustering (theory: LVN are NOT S/R — expect lift ~1 or <1)
  console.log('\n--- LVN clustering (theory: move-through, expect lift<=1) ---');
  for (const w of windows) {
    const bin = 50;
    const ns = nodeSets.get(`${w}|${bin}`)!;
    const tol = Math.max(TICK, Math.round(bin / 2));
    console.log(`\n--- LVN  W=10 win=${w} bin=${bin} tol=${tol} ---`);
    part2A_clustering(bars, runs, ns, 10, tol, 'lvn');
  }

  // =====================================================================
  // PART 2B — reaction rate vs matched sparse control
  // =====================================================================
  console.log('\n\n================= PART 2B: REACTION RATE vs MATCHED CONTROL =================');
  console.log('reversal = node HELD. lift = levRev / ctrlRev (matched approach-dir + vol-bucket).');
  console.log('control = random 5-grid points in same run avoiding ±(R+tol) of real nodes (sparse, fair).');
  const Rs = [20, 40];
  const Ns = [15, 30];
  // store best-config touches for per-year + part 3 reuse
  const bestKey = { w: 'sess' as 'sess' | '1d' | '5d', bin: 50, R: 40, N: 30 };
  for (const R of Rs) {
    for (const N of Ns) {
      const tol = TICK;
      console.log(`\n----- R=${R} N=${N} tol=${tol} -----`);
      console.log('config'.padEnd(18), 'nLev'.padStart(6), 'lvRev%'.padStart(7), 'ctRev%'.padStart(7), 'lift'.padStart(6), 'z'.padStart(6), 'res%'.padStart(6));
      for (const w of windows) for (const bin of bins) {
        const ns = nodeSets.get(`${w}|${bin}`)!;
        const hvnByRun = ns.map(s => s.hvn);
        const lev = reactionAtLevels(runs, hvnByRun, tol, R, N, 5);
        // perRun control count ~ avg nodes per run (cap small)
        const perRun = Math.max(2, Math.round(ns.reduce((a, s) => a + s.hvn.length, 0) / ns.length));
        const ctrl = reactionAtSparseControl(runs, hvnByRun, R + tol, perRun, tol, R, N, 5, makeRng(12345));
        const s = stratifiedRevRate(lev, ctrl);
        const nEff = Math.min(s.nCtrl, s.nLev);
        const z = propZ(s.levRate, s.nLev, s.ctrlRate, nEff);
        const resRate = lev.length ? lev.filter(t => t.resolved).length / lev.length : 0;
        const lift = s.ctrlRate > 0 ? s.levRate / s.ctrlRate : NaN;
        console.log(
          `HVN ${w}/${bin}`.padEnd(18),
          String(s.nLev).padStart(6),
          (s.levRate * 100).toFixed(1).padStart(7),
          (s.ctrlRate * 100).toFixed(1).padStart(7),
          (isFinite(lift) ? lift.toFixed(3) : 'na').padStart(6),
          (isFinite(z) ? z.toFixed(1) : 'na').padStart(6),
          (resRate * 100).toFixed(0).padStart(6),
        );
      }
      // LVN at R/N (expect lift<1 if move-through)
      {
        const ns = nodeSets.get(`sess|50`)!;
        const lvnByRun = ns.map(s => s.lvn);
        const lev = reactionAtLevels(runs, lvnByRun, TICK, R, N, 5);
        const perRun = Math.max(2, Math.round(ns.reduce((a, s) => a + s.lvn.length, 0) / ns.length));
        const ctrl = reactionAtSparseControl(runs, lvnByRun, R + TICK, perRun, TICK, R, N, 5, makeRng(777));
        const s = stratifiedRevRate(lev, ctrl);
        const nEff = Math.min(s.nCtrl, s.nLev);
        const z = propZ(s.levRate, s.nLev, s.ctrlRate, nEff);
        const lift = s.ctrlRate > 0 ? s.levRate / s.ctrlRate : NaN;
        console.log(
          `LVN sess/50`.padEnd(18),
          String(s.nLev).padStart(6),
          (s.levRate * 100).toFixed(1).padStart(7),
          (s.ctrlRate * 100).toFixed(1).padStart(7),
          (isFinite(lift) ? lift.toFixed(3) : 'na').padStart(6),
          (isFinite(z) ? z.toFixed(1) : 'na').padStart(6),
          '-'.padStart(6),
        );
      }
    }
  }

  // per-year lift for each window at R=40 N=30 bin=50
  console.log('\n----- PER-YEAR HVN lift (R=40 N=30 bin=50): level vs matched control -----');
  console.log('window'.padEnd(8), years.map(y => y.slice(2)).join('    '));
  for (const w of windows) {
    const ns = nodeSets.get(`${w}|50`)!;
    const hvnByRun = ns.map(s => s.hvn);
    const lev = reactionAtLevels(runs, hvnByRun, TICK, 40, 30, 5);
    const perRun = Math.max(2, Math.round(ns.reduce((a, s) => a + s.hvn.length, 0) / ns.length));
    const ctrl = reactionAtSparseControl(runs, hvnByRun, 40 + TICK, perRun, TICK, 40, 30, 5, makeRng(999));
    const cells: string[] = [];
    for (const y of years) {
      const s = stratifiedRevRate(lev.filter(t => t.yr === y), ctrl.filter(t => t.yr === y));
      const lift = s.ctrlRate > 0 ? s.levRate / s.ctrlRate : NaN;
      cells.push((isFinite(lift) ? lift.toFixed(2) : ' na ').padStart(5));
    }
    console.log(w.padEnd(8), cells.join(' '));
  }

  // =====================================================================
  // PART 3 — HVN level-interaction bracket P&L (run regardless; gated in verdict)
  // =====================================================================
  console.log('\n\n================= PART 3: HVN LEVEL-INTERACTION BRACKET P&L =================');
  console.log('cols: n | avgNet | win% | avgL(long) | avgS(short) | B&H(beta, same horizon)');
  console.log('cost = 1-tick slip*2 + 10yen = 20yen. Compare HVN vs random-control levels.');
  const cost = TICK * 2 + 10;
  const cfgs = [
    { mode: 'fade' as const, sl: 40, tp: 40, brk: 0 },
    { mode: 'fade' as const, sl: 50, tp: 30, brk: 0 },
    { mode: 'fade' as const, sl: 30, tp: 50, brk: 0 },
    { mode: 'break' as const, sl: 40, tp: 40, brk: 60 },
    { mode: 'break' as const, sl: 40, tp: 60, brk: 60 },
  ];
  // use sess/50 HVN as primary (matches live default bin)
  const primary = nodeSets.get('sess|50')!;
  const hvnByRun = primary.map(s => s.hvn);
  // random control level-set: per run, sparse random points avoiding nodes (same density)
  function controlLevelsByRun(seed: number): number[][] {
    const rng = makeRng(seed);
    const out: number[][] = [];
    for (let ri = 0; ri < runs.length; ri++) {
      const run = runs[ri]!;
      const real = primary[ri]!.hvn;
      if (!real.length || run.length < 10) { out.push([]); continue; }
      let lo = Infinity, hi = -Infinity;
      for (const b of run) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
      const ctrl: number[] = [];
      let tries = 0;
      while (ctrl.length < real.length && tries < real.length * 40) {
        tries++;
        const L = Math.round((lo + rng() * (hi - lo)) / TICK) * TICK;
        if (L <= lo || L >= hi) continue;
        let near = false;
        for (const rl of real) if (Math.abs(rl - L) <= 65) { near = true; break; }
        if (near || ctrl.includes(L)) continue;
        ctrl.push(L);
      }
      out.push(ctrl);
    }
    return out;
  }
  const ctrlByRun = controlLevelsByRun(20240601);
  for (const c of cfgs) {
    console.log(`\n--- ${c.mode} SL=${c.sl} TP=${c.tp}${c.mode === 'break' ? ` brk=${c.brk}` : ''} (cost=${cost}) ---`);
    console.log('set'.padEnd(20), 'n'.padStart(6), 'avgNet'.padStart(8), 'win%'.padStart(7), 'avgL'.padStart(8), 'avgS'.padStart(8), 'B&H'.padStart(8));
    const hvnSt = runStrategy(runs, hvnByRun, c.mode, TICK, c.sl, c.tp, c.brk, cost, 5);
    const ctSt = runStrategy(runs, ctrlByRun, c.mode, TICK, c.sl, c.tp, c.brk, cost, 5);
    printStat('HVN sess/50', hvnSt, cost);
    printStat('control(random)', ctSt, cost);
  }

  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
