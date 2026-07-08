// 9-year point-in-time validation of PRICE-CHANGE ACCELERATION (2nd derivative) on NIY=F.
//
// Context: prior arcs proved price POSITION (price vs MA) and VELOCITY (MA slope / 1st derivative)
// trend judgments are non-predictive (coincident-with-beta) across 9y / all timeframes. The MISSING
// dimension is ACCELERATION (2nd derivative): is the move speeding up or slowing down? Crucial new
// claim to test: does DECELERATION catch TURNS (tops/bottoms) that velocity/trend lagged — INCLUDING
// tops in BULL years, where the long-only trend signals stayed long into the top?
//
// Features (point-in-time, no look-ahead; every value at bar t uses ONLY bars <= t):
//   MA(t)        = simple moving average of close over `maLen` bars ending at t.
//   velocity(t)  = MA(t) - MA(t-k).                         (1st derivative; slope)
//   accel(t)     = MA(t) - 2*MA(t-k) + MA(t-2k).            (2nd derivative)
//   accel_norm   = accel / (vol scale) where vol = stdev of 1-bar close returns * price * sqrt(k)
//                  so the normaliser has the same units as a k-bar MA change.
//
// Sweep: maLen in {20,60}, k in {5,20}. Also resample to 15min and 60min closes and compute the same
// thing there (user stressed timeframe matters). Horizons 15/30/60min (+240min on higher TFs).
//
// Gap-aware: features never span a >5min gap (the 2k+maLen window must be contiguous in time);
// forward returns never measured across a >5min gap (session break).

import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const SYM = 'NIY=F';
const GAP_MS = 5 * 60_000;
const TICK = 5;
const COST_YEN = 10;
const SLIP_TICKS = 1;

type Bar = { t: number; o: number; h: number; l: number; c: number };

function loadBars(): Bar[] {
  const db = new DatabaseSync(DB);
  const rows = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYM) as any[];
  db.close();
  return rows.map(r => ({ t: r.t as number, o: r.o as number, h: r.h as number, l: r.l as number, c: r.c as number }));
}

function yearOf(t: number): number { return new Date(t).getUTCFullYear(); }

// Resample 1-min bars to a coarser timeframe (tfMin minutes). A higher-TF bar is the set of 1-min
// bars within the same floor(t / tfMs) bucket; close = last 1-min close in the bucket; t = bucket end.
// Buckets straddling a >GAP_MS gap are split (a gap ends the current bucket). Returns coarse bars with
// a back-pointer `srcIdx` to the 1-min bar index they close on (for forward measurement on 1-min grid).
type CBar = { t: number; c: number; h: number; l: number; srcIdx: number };
function resample(bars: Bar[], tfMin: number): CBar[] {
  const tfMs = tfMin * 60_000;
  const out: CBar[] = [];
  let curBucket = -1;
  let cur: CBar | null = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const gap = i > 0 && b.t - bars[i - 1]!.t > GAP_MS;
    const bucket = Math.floor(b.t / tfMs);
    if (cur === null || bucket !== curBucket || gap) {
      if (cur) out.push(cur);
      cur = { t: b.t, c: b.c, h: b.h, l: b.l, srcIdx: i };
      curBucket = bucket;
    } else {
      cur.c = b.c; cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.srcIdx = i; cur.t = b.t;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---- forward return on the 1-MIN grid (gap-aware), measured in SIGNED yen (later - now). ----
// Always measured as raw price change (NOT direction-adjusted) so quadrant means are comparable.
function fwdReturn(bars: Bar[], i: number, hBars: number): number {
  const j = i + hBars;
  if (j >= bars.length) return NaN;
  for (let k = i + 1; k <= j; k++) if (bars[k]!.t - bars[k - 1]!.t > GAP_MS) return NaN;
  return bars[j]!.c - bars[i]!.c;
}

// ---- stats ----
function mean(xs: number[]): number { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; }
function hitPos(xs: number[]): number { const v = xs.filter(Number.isFinite); return v.length ? v.filter(x => x > 0).length / v.length : NaN; }
function hitNeg(xs: number[]): number { const v = xs.filter(Number.isFinite); return v.length ? v.filter(x => x < 0).length / v.length : NaN; }
function std(xs: number[]): number { const v = xs.filter(Number.isFinite); if (v.length < 2) return NaN; const m = mean(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1)); }

// =====================================================================================
// Core: build features on a (close[],t[],srcIdx[]) series at a given TF, then categorize.
// =====================================================================================
type Feat = {
  srcIdx: number;   // 1-min bar index to anchor forward returns
  t: number;
  v: number;        // velocity
  a: number;        // accel (raw)
  an: number;       // accel vol-normalized
  contiguous: boolean; // whether the maLen+2k window ending here is gap-free (in TF terms)
};

// Build features for closes[] with timestamps ts[] (already TF-resampled). maLen,k in TF bars.
function buildFeatures(closes: number[], ts: number[], srcIdx: number[], tfMs: number, maLen: number, k: number): Feat[] {
  const n = closes.length;
  // MA(t) over maLen
  const ma = new Array<number>(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i]!;
    if (i >= maLen) sum -= closes[i - maLen]!;
    if (i >= maLen - 1) ma[i] = sum / maLen;
  }
  // rolling stdev of 1-bar returns over a 60-bar window (for vol normalization)
  const rets = new Array<number>(n).fill(NaN);
  for (let i = 1; i < n; i++) rets[i] = closes[i]! - closes[i - 1]!;
  const VOLWIN = 60;
  const feats: Feat[] = [];
  // need window span = maLen + 2k TF-bars contiguous; track contiguity via gaps in ts
  for (let i = 0; i < n; i++) {
    const i_k = i - k, i_2k = i - 2 * k;
    if (i_2k < 0) continue;
    if (!Number.isFinite(ma[i]!) || !Number.isFinite(ma[i_k]!) || !Number.isFinite(ma[i_2k]!)) continue;
    // Contiguity guards no-look-ahead validity of the derivative, NOT economic continuity. For 1-min
    // we demand a truly gap-free window (intraday session). For higher TFs the resampled series
    // inherently chains sessions across overnight/lunch breaks, so we only reject ABNORMAL multi-day
    // data holes (missing weeks): tolerance = max(tfMs+GAP_MS, ~4 calendar days). The full smoothing
    // window (maLen+2k) is checked for 1-min; for higher TFs only the derivative span (i-2k..i) is
    // checked, since the MA is mere smoothing and only the v/a endpoints must be on a coherent series.
    const SESSION_GAP = tfMs + GAP_MS;                 // 1-min: real session-break threshold
    const HOLE = 4 * 24 * 60 * 60_000;                 // higher-TF: reject only >4-day data holes
    const gapTol = tfMs <= 60_000 ? SESSION_GAP : HOLE;
    const start = tfMs <= 60_000 ? Math.max(0, i - 2 * k - maLen + 1) : Math.max(0, i_2k);
    let contig = true;
    for (let j = start + 1; j <= i; j++) {
      if (ts[j]! - ts[j - 1]! > gapTol) { contig = false; break; }
    }
    const v = ma[i]! - ma[i_k]!;
    const a = ma[i]! - 2 * ma[i_k]! + ma[i_2k]!;
    // vol scale: stdev of 1-bar returns over last VOLWIN, scaled by sqrt(k) to match a k-step MA delta
    const lo = Math.max(1, i - VOLWIN + 1);
    const win: number[] = [];
    for (let j = lo; j <= i; j++) if (Number.isFinite(rets[j]!)) win.push(rets[j]!);
    const sd = std(win);
    const volScale = Number.isFinite(sd) && sd > 0 ? sd * Math.sqrt(k) : NaN;
    const an = Number.isFinite(volScale) ? a / volScale : NaN;
    feats.push({ srcIdx: srcIdx[i]!, t: ts[i]!, v, a, an, contiguous: contig });
  }
  return feats;
}

// Quadrant label from velocity & accel signs (with a small dead-zone on accel to avoid noise=0).
type Quad = 'up_acc' | 'up_dec' | 'dn_dec' | 'dn_acc' | 'flat';
function quadrant(v: number, a: number, aDead: number): Quad {
  if (Math.abs(a) < aDead) return 'flat';
  if (v > 0) return a > 0 ? 'up_acc' : 'up_dec';
  if (v < 0) return a < 0 ? 'dn_acc' : 'dn_dec';
  return 'flat';
}

// =====================================================================================
// MAIN
// =====================================================================================
const bars = loadBars();
console.error(`loaded ${bars.length} bars ${new Date(bars[0]!.t).toISOString().slice(0, 10)}..${new Date(bars[bars.length - 1]!.t).toISOString().slice(0, 10)}`);

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
// regime labels (from prior arcs / buy&hold): bull = drift up, bear/crash = drift down/volatile
const REGIME: Record<number, string> = {
  2018: 'bear', 2019: 'bull', 2020: 'crash', 2021: 'range', 2022: 'bear',
  2023: 'bull', 2024: 'range', 2025: 'bull', 2026: 'range',
};

// ---- Buy&hold drift per year (the beta we must control for) ----
console.log('===== BUY&HOLD per year (NIY=F close YoY, 円) + regime =====');
for (const yr of YEARS) {
  const yb = bars.filter(b => yearOf(b.t) === yr);
  if (yb.length < 2) continue;
  const d = yb[yb.length - 1]!.c - yb[0]!.c;
  console.log(`  ${yr} [${REGIME[yr]}]: ${yb[0]!.c} -> ${yb[yb.length - 1]!.c}  (${d >= 0 ? '+' : ''}${d.toFixed(0)}円)`);
}

// Configurations to sweep
type Cfg = { tfMin: number; maLen: number; k: number; horizons: { name: string; bars: number }[] };
const HZ_1M = [{ name: 'r15', bars: 15 }, { name: 'r30', bars: 30 }, { name: 'r60', bars: 60 }];
const HZ_HI = [{ name: 'r15', bars: 15 }, { name: 'r30', bars: 30 }, { name: 'r60', bars: 60 }, { name: 'r240', bars: 240 }];
const CFGS: Cfg[] = [
  { tfMin: 1, maLen: 20, k: 5, horizons: HZ_1M },
  { tfMin: 1, maLen: 20, k: 20, horizons: HZ_1M },
  { tfMin: 1, maLen: 60, k: 5, horizons: HZ_1M },
  { tfMin: 1, maLen: 60, k: 20, horizons: HZ_1M },
  { tfMin: 15, maLen: 20, k: 5, horizons: HZ_HI },
  { tfMin: 15, maLen: 60, k: 5, horizons: HZ_HI },
  { tfMin: 60, maLen: 20, k: 5, horizons: HZ_HI },
];

// precompute resamples
const resampleCache = new Map<number, CBar[]>();
function getSeries(tfMin: number) {
  if (tfMin === 1) {
    return { closes: bars.map(b => b.c), ts: bars.map(b => b.t), srcIdx: bars.map((_, i) => i), tfMs: 60_000 };
  }
  let cb = resampleCache.get(tfMin);
  if (!cb) { cb = resample(bars, tfMin); resampleCache.set(tfMin, cb); }
  return { closes: cb.map(b => b.c), ts: cb.map(b => b.t), srcIdx: cb.map(b => b.srcIdx), tfMs: tfMin * 60_000 };
}

// For each config: build features, choose accel dead-zone = 0.3 * std(accel) (per-config, computed
// on a contiguous subset). Then for each (year, quadrant, horizon) report mean fwd / hit / n.
const QUADS: Quad[] = ['up_acc', 'up_dec', 'dn_dec', 'dn_acc'];
const QLAB: Record<Quad, string> = {
  up_acc: 'up+accel ', up_dec: 'up+DECEL ', dn_dec: 'dn+DECEL ', dn_acc: 'dn+accel ', flat: 'flat     ',
};

type QuadRow = { n: number; fwd: number[] };

function runConfig(cfg: Cfg) {
  const { closes, ts, srcIdx, tfMs } = getSeries(cfg.tfMin);
  const feats = buildFeatures(closes, ts, srcIdx, tfMs, cfg.maLen, cfg.k).filter(f => f.contiguous);
  // dead-zone for accel (raw) and accel-norm
  const aDeadRaw = 0.3 * std(feats.map(f => f.a));
  const aDeadNorm = 0.3 * std(feats.map(f => f.an).filter(Number.isFinite));

  console.log(`\n################################################################`);
  console.log(`# CONFIG tf=${cfg.tfMin}min maLen=${cfg.maLen} k=${cfg.k}  (features n=${feats.length}, aDeadRaw=${aDeadRaw.toFixed(2)})`);
  console.log(`################################################################`);

  // Use RAW accel sign for quadrant (vol-norm only changes the dead-zone threshold scale; sign same).
  // Precompute forward returns per feature per horizon.
  const fwdByHz: Record<string, number[]> = {};
  for (const h of cfg.horizons) fwdByHz[h.name] = feats.map(f => fwdReturn(bars, f.srcIdx, h.bars));

  // ---------- 4-quadrant forward table, per year + ALL ----------
  for (const h of cfg.horizons) {
    console.log(`\n  --- horizon ${h.name} (${h.bars}min fwd, SIGNED 円: later_close - close) ---`);
    console.log('  year[reg]  base_mean |  up+accel(n)      up+DECEL(n)      dn+DECEL(n)      dn+accel(n)');
    for (const yr of ['ALL', ...YEARS] as (number | 'ALL')[]) {
      const idxs: number[] = [];
      for (let fi = 0; fi < feats.length; fi++) { if (yr === 'ALL' || yearOf(feats[fi]!.t) === yr) idxs.push(fi); }
      if (idxs.length === 0) continue;
      const baseFwd = idxs.map(fi => fwdByHz[h.name]![fi]!);
      const baseMean = mean(baseFwd);
      const cells: Record<Quad, QuadRow> = { up_acc: { n: 0, fwd: [] }, up_dec: { n: 0, fwd: [] }, dn_dec: { n: 0, fwd: [] }, dn_acc: { n: 0, fwd: [] }, flat: { n: 0, fwd: [] } };
      for (const fi of idxs) {
        const f = feats[fi]!;
        const q = quadrant(f.v, f.a, aDeadRaw);
        if (q === 'flat') continue;
        cells[q].n++; cells[q].fwd.push(fwdByHz[h.name]![fi]!);
      }
      const cell = (q: Quad) => {
        const m = mean(cells[q].fwd);
        return `${(Number.isFinite(m) ? (m >= 0 ? '+' : '') + m.toFixed(1) : '  na').padStart(7)}(${String(cells[q].n).padStart(6)})`;
      };
      const regTag = yr === 'ALL' ? '   ' : `[${REGIME[yr as number]?.slice(0, 3)}]`;
      console.log(`  ${String(yr).padEnd(5)}${regTag} ${(baseMean >= 0 ? '+' : '') + baseMean.toFixed(1).padStart(7)} | ${cell('up_acc')}  ${cell('up_dec')}  ${cell('dn_dec')}  ${cell('dn_acc')}`);
    }
  }

  return { feats, fwdByHz, aDeadRaw, aDeadNorm };
}

const configResults = new Map<string, ReturnType<typeof runConfig>>();
for (const cfg of CFGS) {
  configResults.set(`${cfg.tfMin}_${cfg.maLen}_${cfg.k}`, runConfig(cfg));
}

// =====================================================================================
// DECISIVE TEST 2: bull-year top detection by up+DECEL, with a beta-control summary.
// A real edge: up+DECEL fwd < baseline (ideally < 0) in BULL years, AND dn+DECEL fwd > baseline in
// BEAR/crash. A beta artifact: quadrant fwd just tracks the prevailing drift sign.
// =====================================================================================
console.log(`\n\n================ DECISIVE TEST 2: cross-regime beta control ================`);
console.log('For each config, BULL years up+DECEL (top-detect: want <baseline/<0) and');
console.log('BEAR/crash dn+DECEL (bottom-detect: want >baseline/>0) at r60.');
const BULL = [2019, 2023, 2025];
const BEARCRASH = [2018, 2020, 2022];
for (const cfg of CFGS) {
  const key = `${cfg.tfMin}_${cfg.maLen}_${cfg.k}`;
  const res = configResults.get(key)!;
  const { feats, fwdByHz, aDeadRaw } = res;
  const hz = cfg.horizons.find(h => h.name === 'r60')!;
  console.log(`\n  CONFIG tf=${cfg.tfMin} maLen=${cfg.maLen} k=${cfg.k}  (r60)`);
  const lineFor = (yrs: number[], q: Quad, want: string) => {
    for (const yr of yrs) {
      const f1: number[] = [], base: number[] = [];
      for (let fi = 0; fi < feats.length; fi++) {
        if (yearOf(feats[fi]!.t) !== yr) continue;
        base.push(fwdByHz['r60']![fi]!);
        const f = feats[fi]!;
        if (quadrant(f.v, f.a, aDeadRaw) === q) f1.push(fwdByHz['r60']![fi]!);
      }
      const m = mean(f1), bm = mean(base);
      const diff = m - bm;
      const ok = want === 'below' ? (m < 0 ? 'YES(<0)' : diff < 0 ? 'weak(<base)' : 'NO') : (m > 0 ? 'YES(>0)' : diff > 0 ? 'weak(>base)' : 'NO');
      console.log(`    ${yr}[${REGIME[yr]}] ${QLAB[q]} mean=${(m >= 0 ? '+' : '') + m.toFixed(1)} base=${(bm >= 0 ? '+' : '') + bm.toFixed(1)} diff=${(diff >= 0 ? '+' : '') + diff.toFixed(1)} n=${f1.length} -> ${ok}`);
    }
  };
  console.log('   [BULL years] up+DECEL should be BELOW baseline / <0 (top detection):');
  lineFor(BULL, 'up_dec', 'below');
  console.log('   [BEAR/crash] dn+DECEL should be ABOVE baseline / >0 (bottom detection):');
  lineFor(BEARCRASH, 'dn_dec', 'above');
  console.log('   [BEAR/crash] dn+accel should be BELOW baseline / <0 (crash continuation):');
  lineFor(BEARCRASH, 'dn_acc', 'below');
}

// =====================================================================================
// DECISIVE TEST 3: ACCELERATION as a TURN DETECTOR.
// Signal: at bar t, velocity v>0 but accel just FLIPPED negative (a[t]<0 & a[t-1]>=0) => predict
// price LOWER in horizon (turn down). Symmetric for v<0 & accel flips positive => predict higher.
// Report hit-rate (fraction where the predicted direction is realized) vs unconditional base rate.
// =====================================================================================
console.log(`\n\n================ DECISIVE TEST 3: turn detector (accel sign-flip vs velocity) ================`);
console.log('decel-while-up -> predict DOWN ; accel-fall-slowing(while-down) -> predict UP.');
console.log('hit = fraction predicted dir realized at horizon; base = unconditional P(that dir).');
for (const cfg of CFGS) {
  const { closes, ts, srcIdx, tfMs } = getSeries(cfg.tfMin);
  const feats = buildFeatures(closes, ts, srcIdx, tfMs, cfg.maLen, cfg.k).filter(f => f.contiguous);
  // need a[t-1]; rebuild a sequential view: feats are in order, but gaps removed. Use index-adjacent
  // pairs where contiguous AND consecutive in original (t diff ~ tf spacing).
  const hzName = cfg.tfMin === 1 ? 'r60' : 'r240';
  const hzBars = cfg.horizons.find(h => h.name === hzName)!.bars;
  let upTurnN = 0, upTurnHit = 0;   // up & accel flips neg -> predict down
  let dnTurnN = 0, dnTurnHit = 0;   // down & accel flips pos -> predict up
  let baseDownN = 0, baseDown = 0;  // unconditional P(fwd<0)
  for (let i = 1; i < feats.length; i++) {
    const f = feats[i]!, p = feats[i - 1]!;
    if (f.t - p.t > tfMs + GAP_MS) continue; // not consecutive
    const fwd = fwdReturn(bars, f.srcIdx, hzBars);
    if (!Number.isFinite(fwd)) continue;
    baseDownN++; if (fwd < 0) baseDown++;
    // up & accel flips negative
    if (f.v > 0 && f.a < 0 && p.a >= 0) { upTurnN++; if (fwd < 0) upTurnHit++; }
    // down & accel flips positive (fall slowing)
    if (f.v < 0 && f.a > 0 && p.a <= 0) { dnTurnN++; if (fwd > 0) dnTurnHit++; }
  }
  const baseP = baseDownN ? baseDown / baseDownN : NaN;
  console.log(`  tf=${cfg.tfMin} maLen=${cfg.maLen} k=${cfg.k} (${hzName}):`);
  console.log(`     up+decel-flip -> DOWN: hit=${upTurnN ? (100 * upTurnHit / upTurnN).toFixed(1) : 'na'}% (n=${upTurnN})  | base P(down)=${(100 * baseP).toFixed(1)}%  edge=${upTurnN ? (100 * (upTurnHit / upTurnN - baseP)).toFixed(1) : 'na'}pp`);
  console.log(`     dn+accel-flip -> UP  : hit=${dnTurnN ? (100 * dnTurnHit / dnTurnN).toFixed(1) : 'na'}% (n=${dnTurnN})  | base P(up)  =${(100 * (1 - baseP)).toFixed(1)}%  edge=${dnTurnN ? (100 * (dnTurnHit / dnTurnN - (1 - baseP))).toFixed(1) : 'na'}pp`);
}

// =====================================================================================
// DECISIVE TEST 4: NET BRACKET of the most-promising accel rule, vs random baseline, per regime.
// Two rules tested:
//   (A) MOMENTUM: long on up+accel, short on dn+accel (continuation).
//   (B) EXHAUSTION/REVERSAL: short on up+DECEL, long on dn+DECEL (fade the slowing move = turn).
// Entry at close[srcIdx], SL/TP in yen, max-hold, 1-tick slip + 10yen cost. Compare to random
// entries (same count, same long/short ratio). Per regime aggregate.
// =====================================================================================
console.log(`\n\n================ DECISIVE TEST 4: net bracket vs random (per regime) ================`);

function bracket(i: number, dir: 1 | -1, sl: number, tp: number, maxHold: number): number | null {
  const ent = bars[i]!.c + dir * SLIP_TICKS * TICK;
  for (let kk = i + 1; kk <= i + maxHold && kk < bars.length; kk++) {
    if (bars[kk]!.t - bars[kk - 1]!.t > GAP_MS) { const exit = bars[kk - 1]!.c; return dir * (exit - ent) - COST_YEN; }
    const hiFav = dir === 1 ? bars[kk]!.h - ent : ent - bars[kk]!.l;
    const loAdv = dir === 1 ? bars[kk]!.l - ent : ent - bars[kk]!.h;
    if (loAdv <= -sl) return -sl - SLIP_TICKS * TICK - COST_YEN;
    if (hiFav >= tp) return tp - SLIP_TICKS * TICK - COST_YEN;
  }
  const j = Math.min(i + maxHold, bars.length - 1);
  let jj = j;
  for (let kk = i + 1; kk <= j; kk++) if (bars[kk]!.t - bars[kk - 1]!.t > GAP_MS) { jj = kk - 1; break; }
  return dir * (bars[jj]!.c - ent) - COST_YEN;
}
function pf(pnls: number[]) {
  let gp = 0, gl = 0, tot = 0, wins = 0, peak = 0, dd = 0, cum = 0;
  for (const p of pnls) { if (p > 0) { gp += p; wins++; } else gl -= p; tot += p; cum += p; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n: pnls.length, pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0), tot, win: pnls.length ? wins / pnls.length : 0, dd };
}

// pick the 1-min maLen=60 k=20 config as primary (smoothest, lowest-noise accel) + 15min maLen=20 k=5
for (const cfg of [{ tfMin: 1, maLen: 60, k: 20 }, { tfMin: 15, maLen: 20, k: 5 }]) {
  const { closes, ts, srcIdx, tfMs } = getSeries(cfg.tfMin);
  const feats = buildFeatures(closes, ts, srcIdx, tfMs, cfg.maLen, cfg.k).filter(f => f.contiguous);
  const aDead = 0.3 * std(feats.map(f => f.a));
  const SL = cfg.tfMin === 1 ? 60 : 120, TP = cfg.tfMin === 1 ? 120 : 240, HOLD = cfg.tfMin === 1 ? 120 : 480;
  console.log(`\n  === CONFIG tf=${cfg.tfMin} maLen=${cfg.maLen} k=${cfg.k}  SL${SL}/TP${TP}/hold${HOLD} ===`);

  type Sig = { i: number; dir: 1 | -1; t: number };
  const momentum: Sig[] = [], reversal: Sig[] = [];
  for (const f of feats) {
    const q = quadrant(f.v, f.a, aDead);
    if (q === 'up_acc') momentum.push({ i: f.srcIdx, dir: 1, t: f.t });
    else if (q === 'dn_acc') momentum.push({ i: f.srcIdx, dir: -1, t: f.t });
    if (q === 'up_dec') reversal.push({ i: f.srcIdx, dir: -1, t: f.t }); // fade slowing up-move -> short
    else if (q === 'dn_dec') reversal.push({ i: f.srcIdx, dir: 1, t: f.t }); // fade slowing down-move -> long
  }
  // thin signals to non-overlapping (>= HOLD apart) to avoid massive autocorrelated overlap
  function thin(sigs: Sig[]): Sig[] {
    const out: Sig[] = []; let lastI = -1e9;
    for (const s of sigs) { if (s.i - lastI >= HOLD) { out.push(s); lastI = s.i; } }
    return out;
  }
  const mom = thin(momentum), rev = thin(reversal);

  function randomBaseline(n: number, upRatio: number, regimeFilter?: (t: number) => boolean): number[] {
    let seed = 777; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const out: number[] = [];
    let tries = 0;
    while (out.length < n && tries < n * 50) {
      tries++;
      const i = 100 + Math.floor(rnd() * (bars.length - HOLD - 200));
      if (regimeFilter && !regimeFilter(bars[i]!.t)) continue;
      const dir: 1 | -1 = rnd() < upRatio ? 1 : -1;
      const r = bracket(i, dir, SL, TP, HOLD); if (r !== null) out.push(r);
    }
    return out;
  }

  for (const [name, sigs] of [['MOMENTUM(long up+acc/short dn+acc)', mom], ['REVERSAL(short up+dec/long dn+dec)', rev]] as [string, Sig[]][]) {
    // overall
    const pnls = sigs.map(s => bracket(s.i, s.dir, SL, TP, HOLD)).filter((x): x is number => x !== null);
    const o = pf(pnls);
    const upR = sigs.filter(s => s.dir === 1).length / Math.max(1, sigs.length);
    const base = randomBaseline(sigs.length, upR);
    const bo = pf(base);
    console.log(`   ${name}: n=${o.n} pf=${o.pf.toFixed(2)} tot=${o.tot.toFixed(0)}円 win=${(o.win * 100).toFixed(0)}% dd=${o.dd.toFixed(0)} || RANDOM pf=${bo.pf.toFixed(2)} tot=${bo.tot.toFixed(0)} win=${(bo.win * 100).toFixed(0)}%  => ${o.tot > bo.tot && o.tot > 0 ? 'BEATS random&>0' : 'no edge'}`);
    // per regime
    const regimes = ['bull', 'bear', 'crash', 'range'];
    for (const reg of regimes) {
      const inReg = (t: number) => REGIME[yearOf(t)] === reg;
      const rs = sigs.filter(s => inReg(s.t));
      if (rs.length < 10) continue;
      const rp = rs.map(s => bracket(s.i, s.dir, SL, TP, HOLD)).filter((x): x is number => x !== null);
      const rpf = pf(rp);
      const rUpR = rs.filter(s => s.dir === 1).length / Math.max(1, rs.length);
      const rbase = randomBaseline(rs.length, rUpR, inReg);
      const rbpf = pf(rbase);
      console.log(`       [${reg.padEnd(5)}] n=${rpf.n} pf=${rpf.pf.toFixed(2)} tot=${rpf.tot.toFixed(0)} win=${(rpf.win * 100).toFixed(0)}% || rand tot=${rbpf.tot.toFixed(0)} pf=${rbpf.pf.toFixed(2)} => ${rpf.tot > rbpf.tot && rpf.tot > 0 ? 'beats&>0' : 'no'}`);
    }
  }
}

console.log('\n[done]');
