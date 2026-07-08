// ============================================================================
// LEVEL VALIDITY TEST — does price REACT at 節目価格 more than at random control?
//
// FOUNDATIONAL question (per leader): all prior level-based backtests assumed a
// level set (session H/L + grid) WITHOUT validating that price actually RESPECTS
// those levels. This script tests that directly on NIY=F 1-min bars 2018-2026.
//
// Two complementary, well-posed methods:
//   A) Turning-point clustering (round-number effect): do SWING extrema favour
//      round-number multiples ABOVE the all-bars baseline? (price spends time
//      everywhere; the question is whether TURNS specifically favour levels.)
//   B) Reaction-rate at a level vs control (no look-ahead): when price first
//      touches a candidate level, does it REVERSE more often than at matched
//      random control points (matched by approach direction + local volatility)?
//
// Candidate level sets: round numbers (100/250/500/1000), prior session H/L,
// prior-session close, multi-touch reaction levels. (Volume nodes: noted.)
//
// NOTE ON PRICE GRID: NIY=F trades on a 5-yen tick. 99.9% of closes are exact
// multiples of 5. This MATTERS for Method A controls: the all-bars baseline
// already absorbs the 5-grid, so any round-number excess is measured on the
// SAME grid for turns and bars => fair. (If we compared turns to a continuous
// uniform we'd get a spurious effect purely from the tick grid.)
//
// Point-in-time everywhere relevant; session/gap-aware. Do NOT commit.
// ============================================================================

import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const SYM = 'NIY=F';
const TICK = 5;
const GAP_MS = 5 * 60_000; // > 5min apart => session break

type Bar = { t: number; o: number; h: number; l: number; c: number; sd: string; sess: string; yr: string };

function loadBars(): Bar[] {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare(
    'SELECT session_date sd, session sess, t, o, h, l, c FROM bars_1m WHERE symbol=? ORDER BY t'
  ).all(SYM) as any[];
  db.close();
  return rows.map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, sd: r.sd, sess: r.sess, yr: String(r.sd).slice(0, 4) }));
}

// Split bars into contiguous runs (no gap > GAP_MS). Levels/reactions never
// measured across a session break.
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

// ---------------------------------------------------------------------------
// Swing turning points: bar.h is a swing-high if it's the strict-ish max of
// its +/-W neighbours (within the same run). Symmetric for lows.
// Returns turning-point PRICES (the extreme price) with year tag.
// ---------------------------------------------------------------------------
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

// distance to nearest multiple of G
function distToMult(price: number, G: number): number {
  const r = ((price % G) + G) % G;
  return Math.min(r, G - r);
}

// ===========================================================================
// METHOD A — turning-point clustering vs all-bars baseline
// ===========================================================================
function methodA(bars: Bar[], runs: Bar[][]) {
  const Gs = [100, 250, 500, 1000];
  const tols = [10, 25]; // +/- yen
  const Ws = [10, 30];

  // baseline reference price set = ALL bar closes (price spends time everywhere).
  // We compute, per G/tol, the fraction of all-bar-closes within tol of a multiple.
  // On a 5-grid this is the FAIR null for turns.
  const closes = bars.map(b => ({ price: b.c, yr: b.yr }));

  console.log('\n================= METHOD A: TURNING-POINT CLUSTERING =================');
  console.log('Excess mass of swing turns near round-number multiples vs ALL-BARS baseline.');
  console.log('lift = P(turn within tol of mult) / P(close within tol of mult). lift>1 => turns favour round numbers.');
  console.log('z = (obs - exp) / sqrt(exp*(1-pBase)) , exp = nTurns*pBase. (binomial approx)\n');

  for (const W of Ws) {
    const turns = swingTurns(runs, W);
    console.log(`\n----- W=${W} (swing window +/-${W} bars); nTurns=${turns.length} -----`);
    for (const G of Gs) {
      for (const tol of tols) {
        if (tol >= G / 2) continue;
        // baseline fraction (all closes)
        let baseHit = 0;
        for (const c of closes) if (distToMult(c.price, G) <= tol) baseHit++;
        const pBase = baseHit / closes.length;
        // turns fraction
        let turnHit = 0;
        for (const t of turns) if (distToMult(t.price, G) <= tol) turnHit++;
        const pTurn = turnHit / turns.length;
        const exp = turns.length * pBase;
        const z = (turnHit - exp) / Math.sqrt(exp * (1 - pBase) + 1e-9);
        const lift = pTurn / pBase;
        console.log(
          `G=${String(G).padStart(4)} tol=${String(tol).padStart(2)} | pBase=${(pBase * 100).toFixed(2)}% pTurn=${(pTurn * 100).toFixed(2)}% | lift=${lift.toFixed(3)} | obs=${turnHit} exp=${exp.toFixed(0)} z=${z.toFixed(1)}`
        );
      }
    }
    // Per-year stability for the most-watched config: G=500, tol=25
    {
      const G = 500, tol = 25;
      console.log(`  per-year stability (G=${G}, tol=${tol}):`);
      const years = [...new Set(bars.map(b => b.yr))].sort();
      for (const y of years) {
        const cs = closes.filter(c => c.yr === y);
        const ts = turns.filter(t => t.yr === y);
        if (!cs.length || !ts.length) continue;
        let bh = 0; for (const c of cs) if (distToMult(c.price, G) <= tol) bh++;
        let th = 0; for (const t of ts) if (distToMult(t.price, G) <= tol) th++;
        const pB = bh / cs.length, pT = th / ts.length;
        const exp = ts.length * pB;
        const z = (th - exp) / Math.sqrt(exp * (1 - pB) + 1e-9);
        console.log(`    ${y}: nTurn=${String(ts.length).padStart(5)} pBase=${(pB * 100).toFixed(2)}% pTurn=${(pT * 100).toFixed(2)}% lift=${(pT / pB).toFixed(3)} z=${z.toFixed(1)}`);
      }
    }
    // Also test 1000-granularity per year (G=1000 tol=25) — bigger rounds usually stronger
    {
      const G = 1000, tol = 25;
      console.log(`  per-year stability (G=${G}, tol=${tol}):`);
      const years = [...new Set(bars.map(b => b.yr))].sort();
      for (const y of years) {
        const cs = closes.filter(c => c.yr === y);
        const ts = turns.filter(t => t.yr === y);
        if (!cs.length || !ts.length) continue;
        let bh = 0; for (const c of cs) if (distToMult(c.price, G) <= tol) bh++;
        let th = 0; for (const t of ts) if (distToMult(t.price, G) <= tol) th++;
        const pB = bh / cs.length, pT = th / ts.length;
        const exp = ts.length * pB;
        const z = (th - exp) / Math.sqrt(exp * (1 - pB) + 1e-9);
        console.log(`    ${y}: nTurn=${String(ts.length).padStart(5)} pBase=${(pB * 100).toFixed(2)}% pTurn=${(pT * 100).toFixed(2)}% lift=${(pT / pB).toFixed(3)} z=${z.toFixed(1)}`);
      }
    }
  }
}

// ===========================================================================
// METHOD B — reaction rate at a level vs control (no look-ahead)
//
// For each candidate level L active over a run, find the FIRST touch (bar comes
// within +/- tol of L). Record approach direction (from above / from below) and
// local volatility (ATR of prior ~30 bars). Then measure forward reaction over
// the next N bars: did price move >= R away from L in the approach-OPPOSING
// direction (i.e. the level "held"/bounced) BEFORE moving >= R through it?
//   - approach from below (price rising into L): reversal = drops >= R below L
//     before rising >= R above L.
//   - approach from above: reversal = rises >= R above L before dropping R below.
// reversal = level held. break = pushed through.
//
// CONTROL: random non-level price points in the SAME run, matched by approach
// direction and volatility bucket, processed identically. The lift = reversal
// rate at levels / reversal rate at matched controls.
// ===========================================================================

type Touch = { rev: boolean; resolved: boolean; dir: 'below' | 'above'; volBucket: number; yr: string };

// ATR-ish local vol: mean(|c[i]-c[i-1]|) over prior `look` bars within run.
function localVol(run: Bar[], idx: number, look = 30): number {
  let s = 0, n = 0;
  for (let k = Math.max(1, idx - look); k <= idx; k++) {
    s += Math.abs(run[k]!.c - run[k - 1]!.c); n++;
  }
  return n ? s / n : 0;
}

function volBucketOf(v: number): number {
  // buckets by yen of avg 1-min move
  if (v < 8) return 0;
  if (v < 15) return 1;
  if (v < 25) return 2;
  if (v < 40) return 3;
  return 4;
}

// Evaluate a single touch's forward reaction. Returns rev (held) / break / unresolved.
function evalReaction(run: Bar[], touchIdx: number, L: number, dir: 'below' | 'above', R: number, N: number): { resolved: boolean; rev: boolean } {
  const end = Math.min(run.length - 1, touchIdx + N);
  for (let k = touchIdx + 1; k <= end; k++) {
    const b = run[k]!;
    if (dir === 'below') {
      // approached from below (rising into L). reversal = drop R below L; break = rise R above L.
      if (b.l <= L - R) return { resolved: true, rev: true };
      if (b.h >= L + R) return { resolved: true, rev: false };
    } else {
      if (b.h >= L + R) return { resolved: true, rev: true };
      if (b.l <= L - R) return { resolved: true, rev: false };
    }
  }
  return { resolved: false, rev: false };
}

// Generic: given a per-run list of level-prices (constant over the run) OR a
// dynamic level function, find first touches and evaluate.
// We pass levels as a sorted numeric array valid for the whole run.
function reactionAtLevels(
  runs: Bar[][],
  levelsForRun: (run: Bar[]) => number[],
  tol: number, R: number, N: number,
  warmup: number
): Touch[] {
  const touches: Touch[] = [];
  for (const run of runs) {
    if (run.length < warmup + N + 2) continue;
    const levels = levelsForRun(run);
    if (!levels.length) continue;
    const touched = new Set<number>(); // levels already first-touched
    for (let i = warmup; i < run.length - 1; i++) {
      const b = run[i]!;
      for (const L of levels) {
        if (touched.has(L)) continue;
        if (Math.abs(b.c - L) <= tol || (b.l <= L && b.h >= L)) {
          // determine approach dir from prior close
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

// CONTROL: control price points processed identically to level touches, then
// matched by (dir,volBucket) via stratified resampling.
//
// CONTROL FAIRNESS (the crux): a naive "random price avoiding real levels"
// control is BIASED for dense grids — e.g. round-100 forces controls onto the
// xx50 midpoints (a structured, non-random set sitting between two round
// numbers), inflating the control reversal rate. So we use a CONTROL GENERATOR
// per type:
//   - grid types (round-G): a PHASE-SHIFTED grid offset by G/2 (same spatial
//     density & run-coverage, but at non-round prices). For G=100 this lands on
//     xx50; we shift by an additional, finer non-round offset to avoid landing
//     on the next-finer round number where possible.
//   - sparse types (prevSess/multitouch): a few random 5-grid points avoiding
//     only +/-(R+tol) of a real level (small exclusion, not 50).
function reactionAtControls(
  runs: Bar[][],
  realLevelsForRun: (run: Bar[]) => number[],
  ctrlForRun: (run: Bar[], lo: number, hi: number, rng: () => number) => number[],
  tol: number, R: number, N: number, warmup: number,
  rng: () => number
): Touch[] {
  const touches: Touch[] = [];
  for (const run of runs) {
    if (run.length < warmup + N + 2) continue;
    // price span of the run
    let lo = Infinity, hi = -Infinity;
    for (const b of run) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!isFinite(lo) || hi <= lo) continue;
    const ctrl = ctrlForRun(run, lo, hi, rng);
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

// mulberry32 deterministic RNG
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stratified reversal rate: weight controls so their (dir,volBucket) joint
// distribution matches the level touches. Returns matched reversal rate.
function stratifiedRevRate(level: Touch[], control: Touch[]): { levRate: number; ctrlRate: number; nLev: number; nCtrl: number } {
  const lev = level.filter(t => t.resolved);
  const ctrl = control.filter(t => t.resolved);
  const key = (t: Touch) => `${t.dir}|${t.volBucket}`;
  // level joint weights
  const levCount = new Map<string, number>();
  for (const t of lev) levCount.set(key(t), (levCount.get(key(t)) || 0) + 1);
  const nLev = lev.length;
  // control reversal rate per stratum
  const ctrlByK = new Map<string, Touch[]>();
  for (const t of ctrl) { const k = key(t); if (!ctrlByK.has(k)) ctrlByK.set(k, []); ctrlByK.get(k)!.push(t); }
  let levRev = 0; for (const t of lev) if (t.rev) levRev++;
  // matched control rate = sum_k (levWeight_k * ctrlRevRate_k)
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

// 2-proportion z for level vs (matched) control
function propZ(p1: number, n1: number, p2: number, n2eff: number): number {
  if (!isFinite(p1) || !isFinite(p2) || n1 < 5 || n2eff < 5) return NaN;
  const p = (p1 * n1 + p2 * n2eff) / (n1 + n2eff);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2eff));
  return se > 0 ? (p1 - p2) / se : NaN;
}

// ---- candidate level builders (per run) ----

// round-number grid within run span
function roundLevels(G: number) {
  return (run: Bar[]): number[] => {
    let lo = Infinity, hi = -Infinity;
    for (const b of run) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (!isFinite(lo)) return [];
    const out: number[] = [];
    const start = Math.ceil(lo / G) * G;
    for (let L = start; L <= hi; L += G) out.push(L);
    return out;
  };
}

// CONTROL GENERATOR for grid types: phase-shifted grid. Offset by G/2 plus a
// small non-round nudge so controls land at non-round prices but with the SAME
// density and span-coverage as the real grid. (e.g. G=500 -> controls at ...250,
// 750, ... ; we nudge +35 to avoid coinciding with finer round-50/100 lines.)
function gridControl(G: number) {
  const nudge = G >= 1000 ? 135 : G >= 500 ? 135 : G >= 250 ? 60 : 35; // non-round offset on 5-grid
  return (_run: Bar[], lo: number, hi: number): number[] => {
    const out: number[] = [];
    const base = Math.floor(lo / G) * G + G / 2 + nudge;
    for (let L = base; L <= hi; L += G) if (L > lo && L < hi) out.push(Math.round(L / TICK) * TICK);
    return out;
  };
}

// CONTROL GENERATOR for sparse types: a few random 5-grid points avoiding only
// +/-(R+tol) of a real level. perRun controls per run.
function sparseControl(realFor: (run: Bar[]) => number[], avoid: number, perRun: number) {
  return (run: Bar[], lo: number, hi: number, rng: () => number): number[] => {
    const real = realFor(run);
    const out: number[] = [];
    let tries = 0;
    while (out.length < perRun && tries < perRun * 30) {
      tries++;
      const L = Math.round((lo + rng() * (hi - lo)) / TICK) * TICK;
      if (L <= lo || L >= hi) continue;
      let near = false;
      for (const rl of real) if (Math.abs(rl - L) <= avoid) { near = true; break; }
      if (!near) out.push(L);
    }
    return out;
  };
}

// prior-session H/L and close: we need cross-run context. Precompute per run the
// PRIOR run's H/L/close and attach. Build a map run-index -> levels.
function buildPriorSessionLevels(runs: Bar[][]): { hl: number[][]; close: number[][] } {
  const hl: number[][] = [];
  const close: number[][] = [];
  let prevH = NaN, prevL = NaN, prevC = NaN;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;
    hl.push(isFinite(prevH) ? [prevH, prevL] : []);
    close.push(isFinite(prevC) ? [prevC] : []);
    let h = -Infinity, l = Infinity;
    for (const b of run) { if (b.h > h) h = b.h; if (b.l < l) l = b.l; }
    prevH = h; prevL = l; prevC = run[run.length - 1]!.c;
  }
  return { hl, close };
}

// Multi-touch reaction levels: reconstruct from swing pivots PRIOR to the run.
// Simple: gather swing highs+lows from a trailing window of bars (last ~3 runs),
// cluster into 5-yen bands, keep bands with >= K touches. Point-in-time: only
// uses pivots strictly before the current run.
function buildMultiTouchLevels(runs: Bar[][], W: number, K: number, band: number, lookbackRuns: number): number[][] {
  // precompute swing pivots per run (price list)
  const pivotsPerRun: number[][] = runs.map(run => {
    const ps: number[] = [];
    for (let i = W; i < run.length - W; i++) {
      const b = run[i]!;
      let isH = true, isL = true;
      for (let k = i - W; k <= i + W; k++) { if (k === i) continue; if (run[k]!.h >= b.h) isH = false; if (run[k]!.l <= b.l) isL = false; }
      if (isH) ps.push(b.h);
      if (isL) ps.push(b.l);
    }
    return ps;
  });
  const out: number[][] = [];
  for (let i = 0; i < runs.length; i++) {
    const pool: number[] = [];
    for (let j = Math.max(0, i - lookbackRuns); j < i; j++) pool.push(...pivotsPerRun[j]!);
    if (pool.length < K) { out.push([]); continue; }
    // cluster: round to band grid, count
    const cnt = new Map<number, number>();
    for (const p of pool) { const b = Math.round(p / band) * band; cnt.set(b, (cnt.get(b) || 0) + 1); }
    const lv: number[] = [];
    for (const [b, c] of cnt) if (c >= K) lv.push(b);
    out.push(lv);
  }
  return out;
}

function methodB(bars: Bar[], runs: Bar[][]) {
  console.log('\n\n================= METHOD B: REACTION RATE vs CONTROL =================');
  console.log('reversal = level HELD (price moved R away in approach-opposing dir before breaking R through).');
  console.log('lift = levRev / ctrlRev (matched by approach dir + vol bucket). lift>1 => level respected.\n');

  const Rs = [20, 40];
  const Ns = [15, 30];
  const tol = TICK; // touch within 1 tick

  const prior = buildPriorSessionLevels(runs);
  const mtLevels = buildMultiTouchLevels(runs, 10, 3, TICK, 3);

  // helper to index a run -> its position (runs are unique arrays)
  const runIndex = new Map<Bar[], number>();
  runs.forEach((r, i) => runIndex.set(r, i));

  type CtrlGen = (run: Bar[], lo: number, hi: number, rng: () => number) => number[];
  type LType = { name: string; lf: (run: Bar[]) => number[]; cf: CtrlGen; warmup: number };
  const hlF = (r: Bar[]) => prior.hl[runIndex.get(r)!] || [];
  const clF = (r: Bar[]) => prior.close[runIndex.get(r)!] || [];
  const mtF = (r: Bar[]) => mtLevels[runIndex.get(r)!] || [];
  const types: LType[] = [
    { name: 'round-100', lf: roundLevels(100), cf: gridControl(100), warmup: 30 },
    { name: 'round-250', lf: roundLevels(250), cf: gridControl(250), warmup: 30 },
    { name: 'round-500', lf: roundLevels(500), cf: gridControl(500), warmup: 30 },
    { name: 'round-1000', lf: roundLevels(1000), cf: gridControl(1000), warmup: 30 },
    { name: 'prevSess-HL', lf: hlF, cf: sparseControl(hlF, 60, 2), warmup: 5 },
    { name: 'prevSess-close', lf: clF, cf: sparseControl(clF, 60, 2), warmup: 5 },
    { name: 'multitouch-K3', lf: mtF, cf: sparseControl(mtF, 60, 4), warmup: 5 },
  ];

  for (const R of Rs) {
    for (const N of Ns) {
      console.log(`\n----- R=${R}yen, N=${N}bars, tol=${tol} -----`);
      console.log('type'.padEnd(16), 'nLev'.padStart(6), 'lvRev%'.padStart(7), 'ctRev%'.padStart(7), 'lift'.padStart(6), 'z'.padStart(6), 'res%'.padStart(6));
      for (const ty of types) {
        const lev = reactionAtLevels(runs, ty.lf, tol, R, N, ty.warmup);
        const ctrl = reactionAtControls(runs, ty.lf, ty.cf, tol, R, N, ty.warmup, makeRng(12345));
        const s = stratifiedRevRate(lev, ctrl);
        const nEff = Math.min(s.nCtrl, s.nLev); // conservative eff n for matched control
        const z = propZ(s.levRate, s.nLev, s.ctrlRate, nEff);
        const resRate = lev.length ? lev.filter(t => t.resolved).length / lev.length : 0;
        const lift = s.ctrlRate > 0 ? s.levRate / s.ctrlRate : NaN;
        console.log(
          ty.name.padEnd(16),
          String(s.nLev).padStart(6),
          (s.levRate * 100).toFixed(1).padStart(7),
          (s.ctrlRate * 100).toFixed(1).padStart(7),
          (isFinite(lift) ? lift.toFixed(3) : 'na').padStart(6),
          (isFinite(z) ? z.toFixed(1) : 'na').padStart(6),
          (resRate * 100).toFixed(0).padStart(6)
        );
      }
    }
  }

  // Per-year stability for the strongest config (decided after first pass): R=40,N=30
  console.log('\n----- PER-YEAR lift (R=40,N=30): level vs matched control -----');
  const R = 40, N = 30;
  const years = [...new Set(bars.map(b => b.yr))].sort();
  console.log('type'.padEnd(16), years.map(y => y.slice(2)).join('   '));
  for (const ty of types) {
    const lev = reactionAtLevels(runs, ty.lf, tol, R, N, ty.warmup);
    const ctrl = reactionAtControls(runs, ty.lf, ty.cf, tol, R, N, ty.warmup, makeRng(999));
    const cells: string[] = [];
    for (const y of years) {
      const s = stratifiedRevRate(lev.filter(t => t.yr === y), ctrl.filter(t => t.yr === y));
      const lift = s.ctrlRate > 0 ? s.levRate / s.ctrlRate : NaN;
      cells.push((isFinite(lift) ? lift.toFixed(2) : ' na ').padStart(5));
    }
    console.log(ty.name.padEnd(16), cells.join(' '));
  }
}

// ===========================================================================
// METHOD C — net-of-cost tradeability of a fade at validated levels
// Simple bracket: on first touch of level L, FADE (enter opposite to approach),
// SL=R_sl beyond L, TP=R_tp toward approach origin. Net of 1-tick slip + 10yen.
// Compare expectancy at levels vs at controls.
// ===========================================================================
function evalFade(run: Bar[], touchIdx: number, L: number, dir: 'below' | 'above', slY: number, tpY: number): number | null {
  // fade: approached from below (rising into L) => SHORT at L, TP below, SL above.
  // approached from above => LONG at L, TP above, SL below.
  const entry = L;
  const isShort = dir === 'below';
  const tp = isShort ? entry - tpY : entry + tpY;
  const sl = isShort ? entry + slY : entry - slY;
  for (let k = touchIdx + 1; k < run.length; k++) {
    const b = run[k]!;
    if (isShort) {
      // pessimistic: if both hit in same bar, assume SL first
      if (b.h >= sl) return -slY;
      if (b.l <= tp) return tpY;
    } else {
      if (b.l <= sl) return -slY;
      if (b.h >= tp) return tpY;
    }
  }
  return null; // unresolved by end of run -> exclude (or treat as 0)
}

function methodC(runs: Bar[][]) {
  console.log('\n\n================= METHOD C: NET-OF-COST FADE TRADEABILITY =================');
  console.log('Fade at first touch. SL/TP in yen. Net = gross - cost (1-tick slip*2 + 10yen = 20yen).');
  console.log('Compare avg net/trade at levels vs controls. >0 and > control => tradeable.\n');
  const cost = TICK * 2 + 10; // 1-tick slip each side (entry+exit) + 10 yen
  const tol = TICK;
  const configs = [
    { sl: 30, tp: 30 }, { sl: 40, tp: 40 }, { sl: 30, tp: 50 }, { sl: 50, tp: 30 },
  ];
  const prior = buildPriorSessionLevels(runs);
  const runIndex = new Map<Bar[], number>();
  runs.forEach((r, i) => runIndex.set(r, i));
  const mtLevels = buildMultiTouchLevels(runs, 10, 3, TICK, 3);

  const hlF = (r: Bar[]) => prior.hl[runIndex.get(r)!] || [];
  const mtF = (r: Bar[]) => mtLevels[runIndex.get(r)!] || [];
  type CtrlGen = (run: Bar[], lo: number, hi: number, rng: () => number) => number[];
  const types: { name: string; lf: (run: Bar[]) => number[]; cf: CtrlGen; warmup: number }[] = [
    { name: 'round-500', lf: roundLevels(500), cf: gridControl(500), warmup: 30 },
    { name: 'round-1000', lf: roundLevels(1000), cf: gridControl(1000), warmup: 30 },
    { name: 'prevSess-HL', lf: hlF, cf: sparseControl(hlF, 60, 2), warmup: 5 },
    { name: 'multitouch-K3', lf: mtF, cf: sparseControl(mtF, 60, 4), warmup: 5 },
  ];

  function run1(lf: (run: Bar[]) => number[], cf: CtrlGen, warmup: number, sl: number, tp: number, isCtrl: boolean) {
    let n = 0, sumNet = 0, wins = 0;
    const rng = makeRng(4242);
    for (const run of runs) {
      if (run.length < warmup + 5) continue;
      let lo = Infinity, hi = -Infinity;
      for (const b of run) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
      if (!isFinite(lo) || hi <= lo) continue;
      const levels: number[] = isCtrl ? cf(run, lo, hi, rng) : lf(run);
      const touched = new Set<number>();
      for (let i = warmup; i < run.length - 1; i++) {
        const b = run[i]!;
        for (const L of levels) {
          if (touched.has(L)) continue;
          if (Math.abs(b.c - L) <= tol || (b.l <= L && b.h >= L)) {
            touched.add(L);
            const prev = run[i - 1]!.c;
            const dir: 'below' | 'above' = prev <= L ? 'below' : 'above';
            const g = evalFade(run, i, L, dir, sl, tp);
            if (g === null) continue;
            const net = g - cost;
            n++; sumNet += net; if (net > 0) wins++;
          }
        }
      }
    }
    return { n, avg: n ? sumNet / n : NaN, win: n ? wins / n : NaN };
  }

  for (const c of configs) {
    console.log(`\n--- SL=${c.sl} TP=${c.tp} (cost=${cost}yen) ---`);
    console.log('type'.padEnd(16), 'n'.padStart(6), 'LVnet'.padStart(7), 'LVwin%'.padStart(7), '|', 'CTnet'.padStart(7), 'CTwin%'.padStart(7));
    for (const ty of types) {
      const lv = run1(ty.lf, ty.cf, ty.warmup, c.sl, c.tp, false);
      const ct = run1(ty.lf, ty.cf, ty.warmup, c.sl, c.tp, true);
      console.log(
        ty.name.padEnd(16),
        String(lv.n).padStart(6),
        (isFinite(lv.avg) ? lv.avg.toFixed(1) : 'na').padStart(7),
        (isFinite(lv.win) ? (lv.win * 100).toFixed(1) : 'na').padStart(7),
        '|',
        (isFinite(ct.avg) ? ct.avg.toFixed(1) : 'na').padStart(7),
        (isFinite(ct.win) ? (ct.win * 100).toFixed(1) : 'na').padStart(7),
      );
    }
  }
}

// ===========================================================================
function main() {
  const t0 = Date.now();
  console.log('Loading bars...');
  const bars = loadBars();
  const runs = splitRuns(bars);
  console.log(`bars=${bars.length} runs=${runs.length} (gap>${GAP_MS / 60000}min) years=${[...new Set(bars.map(b => b.yr))].sort().join(',')}`);
  // volume note
  console.log('Volume nodes: bars have volume column (~99% populated) but per-price volume profile reconstruction at scale is heavy; SKIPPED this pass (noted for follow-up).');

  methodA(bars, runs);
  methodB(bars, runs);
  methodC(runs);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main();
