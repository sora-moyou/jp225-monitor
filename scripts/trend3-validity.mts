/**
 * trend3-validity.mts — Adversarial validation of jp225-Trade computeTrend3.
 *
 * Question: does the up/down/neutral label predict FORWARD raw price direction,
 * across regimes, BEYOND market beta (drift)? This gates trendGate/trend-flip/doten.
 *
 * Faithful replica of jp225-Trade/src/strategy/levelBracket.ts:95-108 (computeTrend3).
 * Data: backtest-multiyear.db bars_1m, NIY=F, 1-min bars 2018-2026.
 *
 * Point-in-time: label at bar i uses only closes <= i.
 * Gap-aware: forward returns + the closes ring are confined to a "continuous run"
 *   = consecutive 1-min bars with timestamp gap <= 5min AND same session_date+session.
 *   Resetting the ring per run avoids contaminating the MA/slope with pre-gap prices
 *   (the conservative, defensible choice). Forward windows never cross a run boundary.
 *
 * Run:  npx tsx scripts/trend3-validity.mts
 */
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const TICK = 5;
const SYMBOL = 'NIY=F';
const MAX_GAP_MS = 5 * 60_000; // >5min gap breaks a continuous run
const HORIZONS = [15, 30, 60];  // minutes (== bars, since 1 bar = 1 min)

// ---- faithful computeTrend3 (levelBracket.ts:95-108) ----
type Trend = 'up' | 'down' | 'neutral';
function computeTrend3(closes: number[], maBars: number, neutralBandTicks: number): Trend | null {
  if (closes.length < maBars) return null;
  const window = closes.slice(-maBars);
  const ma = window.reduce((a, c) => a + c, 0) / window.length;
  const last = window[window.length - 1]!;
  const band = neutralBandTicks * TICK;
  const priceDir: Trend = last > ma + band ? 'up' : last < ma - band ? 'down' : 'neutral';
  if (closes.length < 21) return priceDir;
  const mean = (arr: number[]): number => arr.reduce((a, x) => a + x, 0) / arr.length;
  const slope = mean(closes.slice(-20)) - mean(closes.slice(-21, -1));
  if (priceDir === 'up' && slope > 0) return 'up';
  if (priceDir === 'down' && slope < 0) return 'down';
  return 'neutral';
}

// ---- load bars ----
const db = new DatabaseSync(DB);
type Bar = { t: number; c: number; sd: string; ses: string };
const rows = db.prepare(
  `SELECT t, c, session_date AS sd, session AS ses FROM bars_1m WHERE symbol=? ORDER BY t ASC`
).all(SYMBOL) as Bar[];
console.error(`loaded ${rows.length} bars`);

// ---- segment into continuous runs ----
type Run = Bar[];
const runs: Run[] = [];
let cur: Run = [];
for (let i = 0; i < rows.length; i++) {
  const b = rows[i]!;
  if (cur.length === 0) { cur = [b]; continue; }
  const prev = cur[cur.length - 1]!;
  const sameSession = prev.sd === b.sd && prev.ses === b.ses;
  const gapOk = b.t - prev.t <= MAX_GAP_MS && b.t - prev.t > 0;
  if (sameSession && gapOk) cur.push(b);
  else { runs.push(cur); cur = [b]; }
}
if (cur.length) runs.push(cur);
console.error(`segmented into ${runs.length} continuous runs`);

const yearOf = (t: number): number => new Date(t).getUTCFullYear(); // year by UTC; session_date is JST date but year boundary diffs are negligible for binning
// use JST date string year to bin (more faithful to session_date)
const yearOfBar = (b: Bar): number => Number(b.sd.slice(0, 4));

// ---- accumulator ----
interface Acc { n: number; sum: number[]; pos: number[]; vals: number[][]; }
const mkAcc = (): Acc => ({ n: 0, sum: [0, 0, 0], pos: [0, 0, 0], vals: [[], [], []] });

interface Stat { n: number; mean: number[]; median: number[]; hit: number[]; }
function finalize(a: Acc): Stat {
  const mean = a.sum.map(s => (a.n ? s / a.n : NaN));
  const hit = a.pos.map(p => (a.n ? p / a.n : NaN));
  const median = a.vals.map(v => {
    if (!v.length) return NaN;
    const s = [...v].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  });
  return { n: a.n, mean, median, hit };
}

// config sweep
const VARIANTS = [
  { maBars: 30, band: 10, tag: 'DEFAULT (maBars=30, band=10)' }, // live default
  { maBars: 20, band: 0, tag: 'maBars=20, band=0' },
  { maBars: 20, band: 2, tag: 'maBars=20, band=2' },
  { maBars: 20, band: 5, tag: 'maBars=20, band=5' },
  { maBars: 60, band: 0, tag: 'maBars=60, band=0' },
  { maBars: 60, band: 5, tag: 'maBars=60, band=5' },
];

type Label = 'up' | 'down' | 'neutral';
const LABELS: Label[] = ['up', 'down', 'neutral'];

for (const V of VARIANTS) {
  // per-year per-label acc, plus full-span, plus unconditional baseline
  const byYearLabel = new Map<number, Record<Label, Acc>>();
  const fullLabel: Record<Label, Acc> = { up: mkAcc(), down: mkAcc(), neutral: mkAcc() };
  const baseYear = new Map<number, Acc>();
  const baseFull = mkAcc();
  // lag/persistence: run-length of labels, and label-stream for monotonic transitions
  const runLenByLabel: Record<Label, number[]> = { up: [], down: [], neutral: [] };

  // bracket sim accumulators (with-trend vs random), per year + full
  const brkYear = new Map<number, { tt: number; wins: number; gp: number; gl: number; eq: number; peak: number; mdd: number }>();
  const brkFull = { tt: 0, wins: 0, gp: 0, gl: 0, eq: 0, peak: 0, mdd: 0 };
  const rndFull = { tt: 0, wins: 0, gp: 0, gl: 0, eq: 0, peak: 0, mdd: 0 };
  const brkYearRnd = new Map<number, { tt: number; wins: number; gp: number; gl: number; eq: number; peak: number; mdd: number }>();

  // deterministic PRNG for random baseline (reproducible)
  let seed = 123456789;
  const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const SL = 40 * TICK; // 40 ticks stop
  const TP = 60 * TICK; // 60 ticks target
  const COST = 1 * TICK + 10; // 1-tick slippage + 10 yen, per trade (entry+exit lumped)

  for (const run of runs) {
    const closes: number[] = []; // ring, reset per run
    let prevLabel: Label | null = null;
    let curRunLen = 0;
    const labels: (Label | null)[] = new Array(run.length).fill(null);

    for (let i = 0; i < run.length; i++) {
      closes.push(run[i]!.c);
      if (closes.length > V.maBars * 2) closes.shift();
      const lab = computeTrend3(closes, V.maBars, V.band);
      labels[i] = lab;
    }

    for (let i = 0; i < run.length; i++) {
      const lab = labels[i];
      const yr = yearOfBar(run[i]!);
      const c0 = run[i]!.c;

      // persistence run-length tracking (only over non-null labels)
      if (lab) {
        if (lab === prevLabel) curRunLen++;
        else { if (prevLabel) runLenByLabel[prevLabel].push(curRunLen); curRunLen = 1; prevLabel = lab; }
      }

      // forward returns require i+h within SAME run (already guaranteed: loop is within run)
      for (let hi = 0; hi < HORIZONS.length; hi++) {
        const h = HORIZONS[hi]!;
        if (i + h >= run.length) continue;
        const fwd = run[i + h]!.c - c0; // RAW signed forward return
        // baseline (unconditional)
        if (hi === 0) { /* count baseline once per (bar that has 15m fwd) — but to keep n comparable we accumulate per-horizon */ }
        // accumulate baseline per horizon
        baseFull.n += 0; // placeholder; handled below
        // label-conditional
        if (lab) {
          const acc = fullLabel[lab];
          if (hi === 0) acc.n++;
          acc.sum[hi]! += fwd;
          if (fwd > 0) acc.pos[hi]!++;
          acc.vals[hi]!.push(fwd);
          let yl = byYearLabel.get(yr);
          if (!yl) { yl = { up: mkAcc(), down: mkAcc(), neutral: mkAcc() }; byYearLabel.set(yr, yl); }
          const ya = yl[lab];
          if (hi === 0) ya.n++;
          ya.sum[hi]! += fwd;
          if (fwd > 0) ya.pos[hi]!++;
          ya.vals[hi]!.push(fwd);
        }
        // baseline accumulation (all bars regardless of label)
        {
          if (hi === 0) baseFull.n++;
          baseFull.sum[hi]! += fwd;
          if (fwd > 0) baseFull.pos[hi]!++;
          baseFull.vals[hi]!.push(fwd);
          let ba = baseYear.get(yr);
          if (!ba) { ba = mkAcc(); baseYear.set(yr, ba); }
          if (hi === 0) ba.n++;
          ba.sum[hi]! += fwd;
          if (fwd > 0) ba.pos[hi]!++;
          ba.vals[hi]!.push(fwd);
        }
      }
    }
    if (prevLabel) runLenByLabel[prevLabel].push(curRunLen);

    // ---- bracket sim on this run ----
    // Enter at next bar's close when label is up(long)/down(short); skip neutral/null.
    // No pyramiding: only one position at a time; while in a trade, ignore new signals.
    // Exit on SL/TP (intrabar approximated by close-to-close path: check each subsequent bar's close
    //   against SL/TP from entry; whichever hit first by close). Conservative: if both within a bar's
    //   close move we can't tell — but with close-only we test threshold crossing on closes.
    const simulate = (signalFn: (i: number) => 1 | -1 | 0): { tt: number; wins: number; gp: number; gl: number; mdd: number; eq: number; perYear: Map<number, { tt: number; wins: number; gp: number; gl: number }> } => {
      let i = 0;
      let tt = 0, wins = 0, gp = 0, gl = 0, eq = 0, peak = 0, mdd = 0;
      const perYear = new Map<number, { tt: number; wins: number; gp: number; gl: number }>();
      while (i < run.length - 1) {
        const sig = signalFn(i);
        if (sig === 0) { i++; continue; }
        const entry = run[i + 1]!.c; // enter at next bar close
        const dir = sig; // +1 long, -1 short
        let exitIdx = -1, pnl = 0;
        for (let j = i + 2; j < run.length; j++) {
          const move = (run[j]!.c - entry) * dir; // favorable positive
          if (move <= -SL) { pnl = -SL; exitIdx = j; break; }
          if (move >= TP) { pnl = TP; exitIdx = j; break; }
        }
        if (exitIdx < 0) { // run ended: close at last bar (mark-to-market)
          exitIdx = run.length - 1;
          pnl = (run[exitIdx]!.c - entry) * dir;
        }
        pnl -= COST;
        tt++; if (pnl > 0) wins++; if (pnl > 0) gp += pnl; else gl += -pnl;
        eq += pnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq;
        const yr = yearOfBar(run[i + 1]!);
        let py = perYear.get(yr); if (!py) { py = { tt: 0, wins: 0, gp: 0, gl: 0 }; perYear.set(yr, py); }
        py.tt++; if (pnl > 0) { py.wins++; py.gp += pnl; } else py.gl += -pnl;
        i = exitIdx; // resume after exit
      }
      return { tt, wins, gp, gl, mdd, eq, perYear };
    };

    const withTrend = simulate((i) => { const l = labels[i]; return l === 'up' ? 1 : l === 'down' ? -1 : 0; });
    // random baseline: same entry CADENCE — wherever with-trend would have a non-neutral signal,
    // random picks a random direction. This isolates "direction skill" from "entry timing/frequency".
    const randomDir = simulate((i) => { const l = labels[i]; if (l !== 'up' && l !== 'down') return 0; return rnd() < 0.5 ? 1 : -1; });

    for (const [tag, S, full, yrMap] of [
      ['wt', withTrend, brkFull, brkYear] as const,
      ['rnd', randomDir, rndFull, brkYearRnd] as const,
    ]) {
      full.tt += S.tt; full.wins += S.wins; full.gp += S.gp; full.gl += S.gl;
      full.eq += S.eq; if (full.eq > full.peak) full.peak = full.eq; if (full.peak - full.eq > full.mdd) full.mdd = full.peak - full.eq;
      for (const [yr, py] of S.perYear) {
        let y = yrMap.get(yr); if (!y) { y = { tt: 0, wins: 0, gp: 0, gl: 0, eq: 0, peak: 0, mdd: 0 }; yrMap.set(yr, y); }
        y.tt += py.tt; y.wins += py.wins; y.gp += py.gp; y.gl += py.gl;
      }
    }
  }

  // ---------- REPORT ----------
  console.log('\n' + '='.repeat(100));
  console.log('VARIANT:', V.tag);
  console.log('='.repeat(100));

  const fmt = (x: number, d = 1): string => (Number.isFinite(x) ? x.toFixed(d) : 'NaN');
  const pct = (x: number): string => (Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'NaN');

  // full-span baseline
  const bFull = finalize(baseFull);
  console.log(`\n[FULL-SPAN UNCONDITIONAL BASELINE (drift/beta)]  n=${bFull.n}`);
  console.log(`  mean raw fwd  15m=${fmt(bFull.mean[0]!,2)}  30m=${fmt(bFull.mean[1]!,2)}  60m=${fmt(bFull.mean[2]!,2)}   (yen)`);
  console.log(`  hit P(fwd>0)  15m=${pct(bFull.hit[0]!)}  30m=${pct(bFull.hit[1]!)}  60m=${pct(bFull.hit[2]!)}`);

  // full-span label table
  const fin: Record<Label, Stat> = { up: finalize(fullLabel.up), down: finalize(fullLabel.down), neutral: finalize(fullLabel.neutral) };
  const totalN = fin.up.n + fin.down.n + fin.neutral.n;
  console.log(`\n[FULL-SPAN LABEL-CONDITIONAL RAW FWD]  (share by 15m-eligible n; total=${totalN})`);
  console.log('  label   |   n      share | mean15  med15  hit15 | mean30  med30  hit30 | mean60  med60  hit60');
  for (const L of LABELS) {
    const s = fin[L];
    const share = totalN ? s.n / totalN : 0;
    console.log(`  ${L.padEnd(7)} | ${String(s.n).padStart(8)} ${pct(share).padStart(6)} | ` +
      `${fmt(s.mean[0]!,2).padStart(6)} ${fmt(s.median[0]!,0).padStart(6)} ${pct(s.hit[0]!).padStart(6)} | ` +
      `${fmt(s.mean[1]!,2).padStart(6)} ${fmt(s.median[1]!,0).padStart(6)} ${pct(s.hit[1]!).padStart(6)} | ` +
      `${fmt(s.mean[2]!,2).padStart(6)} ${fmt(s.median[2]!,0).padStart(6)} ${pct(s.hit[2]!).padStart(6)}`);
  }
  // discrimination + beta control (full)
  console.log('\n[VALIDITY TESTS — FULL SPAN]');
  for (let h = 0; h < 3; h++) {
    const sp = fin.up.mean[h]! - fin.down.mean[h]!;
    const upB = fin.up.mean[h]! - bFull.mean[h]!;
    const dnB = fin.down.mean[h]! - bFull.mean[h]!;
    console.log(`  ${HORIZONS[h]}m: spread(up-down)=${fmt(sp,2)}  up-base=${fmt(upB,2)}  down-base=${fmt(dnB,2)}  ` +
      `down<0? ${fin.down.mean[h]! < 0 ? 'YES' : 'NO'} (down mean=${fmt(fin.down.mean[h]!,2)})  ` +
      `monotone up>neu>dn? ${(fin.up.mean[h]! > fin.neutral.mean[h]! && fin.neutral.mean[h]! > fin.down.mean[h]!) ? 'YES' : 'NO'}`);
  }

  // per-year table (focus on 30m horizon for compactness, plus spread/beta)
  console.log('\n[PER-YEAR — 30m horizon]  (mean raw fwd in yen; share by 15m-eligible n)');
  console.log('  year | base30 |  up: n  share mean30 hit | down: n  share mean30 hit | neu mean30 | spread(u-d) up-base down-base | bear-down<0?');
  const years = [...byYearLabel.keys()].sort((a, b) => a - b);
  for (const yr of years) {
    const yl = byYearLabel.get(yr)!;
    const su = finalize(yl.up), sd = finalize(yl.down), sn = finalize(yl.neutral);
    const ba = finalize(baseYear.get(yr)!);
    const tot = su.n + sd.n + sn.n;
    const sh = (x: number): string => pct(tot ? x / tot : 0).padStart(5);
    const sp = su.mean[1]! - sd.mean[1]!;
    const upB = su.mean[1]! - ba.mean[1]!;
    const dnB = sd.mean[1]! - ba.mean[1]!;
    const isBear = yr === 2018 || yr === 2020 || yr === 2022;
    const downNeg = sd.mean[1]! < 0;
    console.log(`  ${yr} | ${fmt(ba.mean[1]!,1).padStart(6)} | ` +
      `${String(su.n).padStart(6)} ${sh(su.n)} ${fmt(su.mean[1]!,1).padStart(6)} ${pct(su.hit[1]!).padStart(5)} | ` +
      `${String(sd.n).padStart(6)} ${sh(sd.n)} ${fmt(sd.mean[1]!,1).padStart(6)} ${pct(sd.hit[1]!).padStart(5)} | ` +
      `${fmt(sn.mean[1]!,1).padStart(6)} | ` +
      `${fmt(sp,1).padStart(6)} ${fmt(upB,1).padStart(6)} ${fmt(dnB,1).padStart(6)} | ` +
      `${isBear ? (downNeg ? 'BEAR ok(down<0)' : 'BEAR FAIL(down>=0)') : (downNeg ? 'down<0' : 'down>=0')}`);
  }

  // persistence
  const meanArr = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
  console.log('\n[PERSISTENCE — avg label run-length (bars=min)]  ' +
    `up=${fmt(meanArr(runLenByLabel.up),1)} (n=${runLenByLabel.up.length})  ` +
    `down=${fmt(meanArr(runLenByLabel.down),1)} (n=${runLenByLabel.down.length})  ` +
    `neutral=${fmt(meanArr(runLenByLabel.neutral),1)} (n=${runLenByLabel.neutral.length})`);

  // bracket result
  const pf = (g: { gp: number; gl: number }): number => (g.gl > 0 ? g.gp / g.gl : Infinity);
  console.log('\n[WITH-TREND BRACKET vs RANDOM-DIR (same entry cadence)]  SL40/TP60 ticks, 1-tick slip +10yen/trade');
  console.log(`  WITH-TREND full: trades=${brkFull.tt}  win%=${pct(brkFull.tt ? brkFull.wins / brkFull.tt : NaN)}  ` +
    `PF=${fmt(pf(brkFull),2)}  net=${fmt(brkFull.eq,0)}  maxDD=${fmt(brkFull.mdd,0)}`);
  console.log(`  RANDOM-DIR full: trades=${rndFull.tt}  win%=${pct(rndFull.tt ? rndFull.wins / rndFull.tt : NaN)}  ` +
    `PF=${fmt(pf(rndFull),2)}  net=${fmt(rndFull.eq,0)}  maxDD=${fmt(rndFull.mdd,0)}`);
  console.log('  per-year (WITH-TREND): year trades win% PF net   |  (RANDOM): win% PF net');
  for (const yr of [...brkYear.keys()].sort((a, b) => a - b)) {
    const w = brkYear.get(yr)!;
    const r = brkYearRnd.get(yr);
    const wnet = w.gp - w.gl, rnet = r ? r.gp - r.gl : NaN;
    console.log(`    ${yr}: ${String(w.tt).padStart(5)} ${pct(w.tt ? w.wins / w.tt : NaN).padStart(6)} ${fmt(pf(w),2).padStart(5)} ${fmt(wnet,0).padStart(8)}   |  ` +
      `${r ? pct(r.tt ? r.wins / r.tt : NaN).padStart(6) : '  -  '} ${r ? fmt(pf(r),2).padStart(5) : ' - '} ${r ? fmt(rnet,0).padStart(8) : ' - '}`);
  }
}
