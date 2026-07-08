/**
 * swing-core-dipswing.mts
 * LEADER's plan: "Long-biased CORE + dip-swing", MAX 2 units, exposure in {1,2}, NEVER 0.
 *
 * The death mode of the single-unit patient band (swing-accum-backtest.mts) was sitting
 * fully in cash and missing the bull. This plan removes that failure by holding a PERMANENT
 * core long (full BH participation on 1 unit) and swinging only the 2nd unit.
 *
 *  - CORE unit: 1 long at the very first bar open, held to the end, NEVER sold.
 *               (this leg alone == 1-unit BH).
 *  - SWING unit (the 2nd): starts NOT held (exposure = 1). Reference R = last swing high
 *               (initialised to the start price) or last trim price.
 *      ADD  (1->2): when a bar's LOW touches R - D  -> buy 2nd unit AT that level (R-D).
 *                   record addPrice = R - D.
 *      TRIM (2->1): when a bar's HIGH touches addPrice + U -> sell 2nd unit AT that level.
 *                   harvest = U - cost (>=0 gross of slippage handling below). Set R = trim price.
 *      Rebuy-lower (user's rule #3): after a trim, only re-ADD when the new add level
 *                   (R - D) is BELOW the last trim price. (R is the trim price, so R-D < R = trim
 *                   is automatic whenever D>0; the explicit guard below makes it auditable and also
 *                   covers the initial state where R = start price.)
 *      Cap: exposure never > 2, never < 1.
 *
 * Reference R semantics (auditable):
 *   - Initially R = start price (bars[0].o). The first ADD can fire as soon as price dips
 *     D below the start. (No look-ahead: we never use a future high to set R.)
 *   - While holding only the core (exposure 1) and NOT yet added, we track the running
 *     swing HIGH since the last trim/flat: R = max(R, bar.high seen so far). This is the
 *     "last swing high" reference and is strictly backward-looking (uses bars already closed
 *     up to and including the current bar's high, which is known when we test the low-touch
 *     within the SAME bar only via open-relative ordering, see below).
 *   - After a TRIM, R is reset to the trim price (a realised, backward-looking level).
 *
 * No look-ahead / intrabar ordering:
 *   - We process bars in t order. Within a bar we know o,h,l,c but NOT the path. To avoid
 *     using the bar's own high to lower the add trigger and then claim the low filled it in
 *     the same bar (which would be optimistic), the ADD trigger for a given bar uses R as it
 *     stood at the END of the PREVIOUS bar (Rprev). We update the running swing-high R AFTER
 *     resolving this bar's fills. This guarantees the add level is fixed before the bar and a
 *     low-touch fill is honest.
 *   - ADD fills only if bar.low <= addLevel (Rprev - D). TRIM fills only if bar.high >=
 *     trimLevel (addPrice + U). If BOTH could happen in one bar (add then trim same bar),
 *     we resolve in open-relative order: whichever level is nearer the open is touched first;
 *     if the add is nearer, we add then can trim same bar (a fast round trip); if trim nearer
 *     we cannot trim a unit we do not yet hold, so only the add (if its level is also touched)
 *     applies. We cap at one add + one trim per bar to stay conservative.
 *
 * Cost: COST_PT = TICK(5) + COMM(0.5) = 5.5 pt charged on EVERY fill (each add and each trim),
 *       deducted from PnL in points. Core entry also pays COST_PT once.
 *
 * Equity / Sharpe: from the strategy's own marked-to-market PnL (core + swing), daily
 *       (per session_date close). Same metric engine as the BH benchmark for apples-to-apples.
 *
 * Run: npx tsx scripts/swing-core-dipswing.mts
 */
/// <reference path="./node-sqlite-shim.d.ts" />
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const POINT_VALUE = 100; // yen per point per contract
const TICK = 5; // NIY tick in points
const COMM_PT = 0.5;
const COST_PT = TICK + COMM_PT; // 5.5 pt adverse per fill

// ---------- bars ----------
type Bar = { t: number; d: string; o: number; h: number; l: number; c: number };
function loadBars(): Bar[] {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db
    .prepare(`SELECT t, session_date d, o, h, l, c FROM bars_1m WHERE symbol='NIY=F' ORDER BY t`)
    .all() as any[];
  db.close();
  return rows.map((r) => ({ t: r.t, d: r.d, o: r.o, h: r.h, l: r.l, c: r.c }));
}
function sessionCloses(bars: Bar[]): { d: string; idx: number; c: number }[] {
  const out: { d: string; idx: number; c: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === bars.length - 1 || bars[i + 1].d !== bars[i].d) out.push({ d: bars[i].d, idx: i, c: bars[i].c });
  }
  return out;
}

// ---------- metrics from a daily mark-to-market PnL series (points) ----------
type Metrics = {
  totalPt: number;
  yenPnL: number;
  totalRetPct: number;
  sharpe: number;
  mdd: number; // % (negative)
  mddPt: number; // points (negative) drawdown of the raw pnl path
  cagr: number;
  calmar: number;
  nDays: number;
};
// base = capital notional in points used to convert pnl-points to a fractional equity path.
function metricsFromDailyPnL(pnlPath: number[], base: number): Metrics {
  const n = pnlPath.length;
  const eq = pnlPath.map((p) => base + p);
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(eq[i] / eq[i - 1] - 1);
  let peak = eq[0],
    mdd = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = e / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  // also raw-point drawdown of the pnl path (cleaner to read for absolute pt)
  let peakPt = pnlPath[0],
    mddPt = 0;
  for (const p of pnlPath) {
    if (p > peakPt) peakPt = p;
    const dd = p - peakPt;
    if (dd < mddPt) mddPt = dd;
  }
  const totalRet = eq[n - 1] / eq[0] - 1;
  const years = n / 252;
  const cagr = years > 0 ? Math.pow(eq[n - 1] / eq[0], 1 / years) - 1 : 0;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : 0;
  return {
    totalPt: pnlPath[n - 1],
    yenPnL: pnlPath[n - 1] * POINT_VALUE,
    totalRetPct: totalRet * 100,
    sharpe,
    mdd: mdd * 100,
    mddPt,
    cagr: cagr * 100,
    calmar,
    nDays: n,
  };
}

// ---------- Buy & Hold (k units), daily mark-to-market in points ----------
function runBH(bars: Bar[], closes: { idx: number }[], units: number): number[] {
  const entry = bars[0].o;
  const pnlPath: number[] = [];
  let cp = 0;
  for (let i = 0; i < bars.length; i++) {
    if (cp < closes.length && i === closes[cp].idx) {
      pnlPath.push(units * (bars[i].c - entry) - units * COST_PT); // entry cost per unit, held to end
      cp++;
    }
  }
  return pnlPath;
}

// ---------- CORE + dip-swing strategy ----------
type SwingResult = {
  pnlPath: number[]; // combined core+swing realized+unrealized PnL (points), per session close
  corePnlPath: number[]; // core leg only (= 1-unit BH), per session close
  swingHarvest: number; // realized swing PnL net of swing cost (points), final (+ unrealized if held at end)
  swingRealizedClosed: number; // realized only from completed round trips (net of cost)
  roundTrips: number; // completed add->trim cycles
  adds: number;
  trims: number;
  swingCost: number; // total cost charged to the swing leg (points)
  closesAt2: number; // # session closes with exposure 2
  closesAt1: number; // # session closes with exposure 1
  heldAtEnd: boolean;
  maxCashStretchSessions: number; // longest run of consecutive session-closes at exposure 1 (swing in "cash")
};
function runCoreDipSwing(bars: Bar[], closes: { d: string; idx: number }[], D: number, U: number): SwingResult {
  const start = bars[0].o;
  const coreEntry = start;
  const coreCost = COST_PT;

  // swing leg state
  let swingHeld = false;
  let addPrice = 0; // price the 2nd unit was bought at
  let swingRealized = 0; // realized swing PnL (points), net of swing cost
  let swingCost = 0;
  let adds = 0,
    trims = 0,
    roundTrips = 0;

  // reference R, backward-looking. Initially the start price.
  let R = start;
  let lastTrimPrice = Infinity; // user's rule #3: after a trim, re-add level must be BELOW this.

  const pnlPath: number[] = [];
  const corePnlPath: number[] = [];
  let closesAt2 = 0,
    closesAt1 = 0;
  let cp = 0;
  // cash-stretch tracking (consecutive session closes at exposure 1)
  let curStretch = 0,
    maxStretch = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Rprev = R as of the end of the previous bar (do NOT use this bar's high yet -> no look-ahead).
    const Rprev = R;

    // ---- resolve swing fills for this bar (at most one add + one trim) ----
    // Determine candidate levels using Rprev (add) and addPrice (trim).
    const addLevel = Rprev - D;
    // rule #3: re-add only if addLevel strictly BELOW last trim price (no constraint before first trim).
    const addAllowed = !swingHeld && addLevel < lastTrimPrice;
    const addTouched = addAllowed && bar.l <= addLevel;

    if (!swingHeld) {
      if (addTouched) {
        // ADD: buy 2nd unit at addLevel
        swingHeld = true;
        addPrice = addLevel;
        swingRealized -= COST_PT;
        swingCost += COST_PT;
        adds++;
        // after adding, can we also trim in the same bar? trimLevel = addPrice + U.
        const trimLevel = addPrice + U;
        // open-relative ordering: only allow same-bar trim if the trim level is FARTHER from the
        // open than the add level was (i.e. add touched first), AND high reaches trimLevel.
        const addNearerOpen = Math.abs(addLevel - bar.o) <= Math.abs(trimLevel - bar.o);
        if (addNearerOpen && bar.h >= trimLevel) {
          // TRIM same bar
          swingRealized += trimLevel - addPrice;
          swingRealized -= COST_PT;
          swingCost += COST_PT;
          trims++;
          roundTrips++;
          swingHeld = false;
          R = trimLevel;
          lastTrimPrice = trimLevel;
        }
      }
    } else {
      // currently holding the 2nd unit -> look for a TRIM
      const trimLevel = addPrice + U;
      if (bar.h >= trimLevel) {
        swingRealized += trimLevel - addPrice;
        swingRealized -= COST_PT;
        swingCost += COST_PT;
        trims++;
        roundTrips++;
        swingHeld = false;
        R = trimLevel;
        lastTrimPrice = trimLevel;
      }
    }

    // ---- update backward-looking reference AFTER fills ----
    // While not holding the swing unit, R tracks the running swing HIGH (so a later dip is
    // measured from the most recent peak). Uses this bar's high, but only to RAISE the add
    // trigger for FUTURE bars (Rprev was used for this bar) -> no look-ahead.
    if (!swingHeld) {
      if (bar.h > R) R = bar.h;
    }
    // (when holding, R is irrelevant until next trim resets it.)

    // ---- session-close snapshot ----
    if (cp < closes.length && i === closes[cp].idx) {
      const coreMtm = bar.c - coreEntry - coreCost;
      const swingMtm = swingHeld ? bar.c - addPrice : 0;
      corePnlPath.push(coreMtm);
      pnlPath.push(coreMtm + swingRealized + swingMtm);
      if (swingHeld) {
        closesAt2++;
        curStretch = 0;
      } else {
        closesAt1++;
        curStretch++;
        if (curStretch > maxStretch) maxStretch = curStretch;
      }
      cp++;
    }
  }

  const lastBar = bars[bars.length - 1];
  const swingFinal = swingRealized + (swingHeld ? lastBar.c - addPrice : 0);
  return {
    pnlPath,
    corePnlPath,
    swingHarvest: swingFinal,
    swingRealizedClosed: swingRealized,
    roundTrips,
    adds,
    trims,
    swingCost,
    closesAt2,
    closesAt1,
    heldAtEnd: swingHeld,
    maxCashStretchSessions: maxStretch,
  };
}

// ---------- spans ----------
function buildSpans(closes: { d: string; idx: number }[]) {
  const oos = closes.findIndex((s) => s.d >= '2024-01-01');
  return {
    FULL: [0, closes.length] as [number, number],
    IS: [0, oos] as [number, number], // 2018-2023
    OOS: [oos, closes.length] as [number, number], // 2024-2026
  };
}
// slice a cumulative daily-pnl path to a span and re-base to 0 at span start.
function sliceMetrics(pnlPath: number[], span: [number, number], base: number): Metrics {
  const seg = pnlPath.slice(span[0], span[1]);
  const b = span[0] === 0 ? 0 : pnlPath[span[0] - 1];
  const rebased = seg.map((p) => p - b);
  return metricsFromDailyPnL(rebased, base);
}

function main() {
  console.log('Loading bars...');
  const bars = loadBars();
  const closes = sessionCloses(bars);
  const refPrice = bars[0].o;
  const spans = buildSpans(closes);
  console.log(`Bars: ${bars.length}  sessions: ${closes.length}  ${bars[0].d}..${bars[bars.length - 1].d}`);
  console.log(`refPrice(open)=${refPrice}  finalClose=${bars[bars.length - 1].c}  cost/fill=${COST_PT}pt\n`);

  // ----- BH benchmarks (1-unit and 2-unit), daily MTM through same engine -----
  const bh1Path = runBH(bars, closes, 1);
  const bh2Path = runBH(bars, closes, 2);
  // 1-unit base = refPrice; 2-unit base = 2*refPrice (so % is per-deployed-capital, identical to 1u).
  const bh1 = {
    FULL: sliceMetrics(bh1Path, spans.FULL, refPrice),
    IS: sliceMetrics(bh1Path, spans.IS, refPrice),
    OOS: sliceMetrics(bh1Path, spans.OOS, refPrice),
  };
  const bh2 = {
    FULL: sliceMetrics(bh2Path, spans.FULL, 2 * refPrice),
    IS: sliceMetrics(bh2Path, spans.IS, 2 * refPrice),
    OOS: sliceMetrics(bh2Path, spans.OOS, 2 * refPrice),
  };
  const fmtM = (m: Metrics) =>
    `pt=${m.totalPt.toFixed(0).padStart(7)}  ret=${m.totalRetPct.toFixed(1).padStart(7)}%  Sharpe=${m.sharpe.toFixed(2).padStart(5)}  MDD=${m.mdd.toFixed(1).padStart(6)}%  Calmar=${m.calmar.toFixed(2).padStart(5)}`;

  console.log('================ BENCHMARKS ================');
  console.log('1-unit BH:');
  console.log(`  FULL ${fmtM(bh1.FULL)}`);
  console.log(`  IS   ${fmtM(bh1.IS)}`);
  console.log(`  OOS  ${fmtM(bh1.OOS)}`);
  console.log('2-unit BH (2x notional base for %):');
  console.log(`  FULL ${fmtM(bh2.FULL)}`);
  console.log(`  IS   ${fmtM(bh2.IS)}`);
  console.log(`  OOS  ${fmtM(bh2.OOS)}`);
  const BH1_FULL_PT = bh1.FULL.totalPt;
  const BH2_FULL_PT = bh2.FULL.totalPt;
  console.log(`\n  >> 1-unit BH FULL total = ${BH1_FULL_PT.toFixed(0)} pt`);
  console.log(`  >> 2-unit BH FULL total = ${BH2_FULL_PT.toFixed(0)} pt\n`);

  // ----- param grid -----
  const Dgrid = [100, 200, 300, 500];
  const Ugrid = [100, 200, 300, 500];

  // run every cell once over FULL bar stream; collect results keyed by D,U.
  type Cell = { D: number; U: number; res: SwingResult; FULL: Metrics; IS: Metrics; OOS: Metrics };
  const cells: Cell[] = [];
  for (const D of Dgrid)
    for (const U of Ugrid) {
      const res = runCoreDipSwing(bars, closes, D, U);
      cells.push({
        D,
        U,
        res,
        FULL: sliceMetrics(res.pnlPath, spans.FULL, 2 * refPrice),
        IS: sliceMetrics(res.pnlPath, spans.IS, 2 * refPrice),
        OOS: sliceMetrics(res.pnlPath, spans.OOS, 2 * refPrice),
      });
    }
  const get = (D: number, U: number) => cells.find((c) => c.D === D && c.U === U)!;

  // ========== 1. GRID HEATMAP (FULL total PnL pt), mark beats-1u-BH / beats-2u-BH ==========
  console.log('================ 1. GRID HEATMAP — FULL total PnL (pt) ================');
  console.log('rows = D (dip-to-add), cols = U (pop-to-trim). pt = combined core+swing total.');
  console.log(`legend: "1" beats 1-unit BH (${BH1_FULL_PT.toFixed(0)}); "2" beats 2-unit BH (${BH2_FULL_PT.toFixed(0)}); "." beats neither.`);
  console.log(['  D\\U '.padEnd(8), ...Ugrid.map((u) => String(u).padStart(11))].join(''));
  for (const D of Dgrid) {
    const row: string[] = [(`D=${D}`).padEnd(8)];
    for (const U of Ugrid) {
      const c = get(D, U);
      const pt = c.FULL.totalPt;
      let mark = '.';
      if (pt > BH2_FULL_PT) mark = '2';
      else if (pt > BH1_FULL_PT) mark = '1';
      row.push((`${pt.toFixed(0)}${mark}`).padStart(11));
    }
    console.log(row.join(''));
  }

  // ========== 2. BEST CELL decomposition ==========
  // "best" by FULL total pt.
  const best = cells.reduce((a, b) => (b.FULL.totalPt > a.FULL.totalPt ? b : a));
  // also identify best risk-adjusted (Calmar) and best Sharpe for the verdict.
  const bestCalmar = cells.reduce((a, b) => (b.FULL.calmar > a.FULL.calmar ? b : a));
  const bestSharpe = cells.reduce((a, b) => (b.FULL.sharpe > a.FULL.sharpe ? b : a));

  const lastBar = bars[bars.length - 1];
  const corePtFinal = lastBar.c - refPrice - COST_PT; // 1-unit BH points
  console.log('\n================ 2. BEST CELL (by FULL total pt) DECOMPOSITION ================');
  const printDecomp = (c: Cell, label: string) => {
    const r = c.res;
    const totalPt = c.FULL.totalPt;
    const nCl = r.closesAt1 + r.closesAt2;
    console.log(`\n[${label}] D=${c.D} U=${c.U}:`);
    console.log(`  core_PnL (1u BH)      = ${corePtFinal.toFixed(0)} pt   (target ~44,620)`);
    console.log(`  swing_harvest (net)   = ${r.swingHarvest.toFixed(0)} pt   ${r.heldAtEnd ? '(incl. unrealized on 2nd unit held at end)' : '(all realized, swing flat at end)'}`);
    console.log(`    of which realized closed round-trips = ${r.swingRealizedClosed.toFixed(0)} pt`);
    console.log(`  swing total cost      = ${r.swingCost.toFixed(0)} pt  (${r.adds} adds + ${r.trims} trims = ${r.adds + r.trims} fills @ ${COST_PT})`);
    console.log(`  ---------------------------------------------`);
    console.log(`  TOTAL (core+swing)    = ${totalPt.toFixed(0)} pt = ¥${(totalPt * POINT_VALUE / 1e6).toFixed(2)}M`);
    console.log(`    check core+harvest  = ${(corePtFinal + r.swingHarvest).toFixed(0)} pt (should == total)`);
    console.log(`  round-trips           = ${r.roundTrips}`);
    console.log(`  %time at 2 units      = ${(r.closesAt2 / nCl * 100).toFixed(1)}%   %time at 1 unit = ${(r.closesAt1 / nCl * 100).toFixed(1)}%`);
    console.log(`  FULL  ${fmtM(c.FULL)}  MDDpt=${c.FULL.mddPt.toFixed(0)}`);
    console.log(`  IS    ${fmtM(c.IS)}`);
    console.log(`  OOS   ${fmtM(c.OOS)}`);
    console.log(`  vs 1u-BH: +${(totalPt - BH1_FULL_PT).toFixed(0)} pt   vs 2u-BH: ${(totalPt - BH2_FULL_PT).toFixed(0)} pt`);
    console.log(`  max swing cash-stretch = ${r.maxCashStretchSessions} consecutive session-closes at exposure 1 (out of ${nCl})`);
  };
  printDecomp(best, 'BEST by total pt');
  if (bestCalmar !== best) printDecomp(bestCalmar, 'BEST by Calmar');
  if (bestSharpe !== best && bestSharpe !== bestCalmar) printDecomp(bestSharpe, 'BEST by Sharpe');

  // ========== 3. THREE-WAY comparison for the best cell ==========
  console.log('\n================ 3. THREE-WAY COMPARISON (best-by-pt cell) ================');
  const c = best;
  const tbl = [
    ['', 'total pt', 'ret%', 'MDD%', 'MDDpt', 'Sharpe', 'Calmar'],
    ['1-unit BH', bh1.FULL.totalPt.toFixed(0), bh1.FULL.totalRetPct.toFixed(1), bh1.FULL.mdd.toFixed(1), bh1.FULL.mddPt.toFixed(0), bh1.FULL.sharpe.toFixed(2), bh1.FULL.calmar.toFixed(2)],
    ['2-unit BH', bh2.FULL.totalPt.toFixed(0), bh2.FULL.totalRetPct.toFixed(1), bh2.FULL.mdd.toFixed(1), bh2.FULL.mddPt.toFixed(0), bh2.FULL.sharpe.toFixed(2), bh2.FULL.calmar.toFixed(2)],
    [`core+swing D${c.D}/U${c.U}`, c.FULL.totalPt.toFixed(0), c.FULL.totalRetPct.toFixed(1), c.FULL.mdd.toFixed(1), c.FULL.mddPt.toFixed(0), c.FULL.sharpe.toFixed(2), c.FULL.calmar.toFixed(2)],
  ];
  for (const row of tbl) console.log(row.map((x, i) => (i === 0 ? x.padEnd(20) : x.padStart(10))).join(''));

  // ========== 4. ROBUSTNESS ==========
  console.log('\n================ 4. ROBUSTNESS ================');
  const nCells = cells.length;
  const beats1Full = cells.filter((c) => c.FULL.totalPt > BH1_FULL_PT).length;
  const beats2Full = cells.filter((c) => c.FULL.totalPt > BH2_FULL_PT).length;
  const beats1IS = cells.filter((c) => c.IS.totalPt > bh1.IS.totalPt).length;
  const beats1OOS = cells.filter((c) => c.OOS.totalPt > bh1.OOS.totalPt).length;
  console.log(`Cells beating 1-unit BH:  FULL ${beats1Full}/${nCells}   IS ${beats1IS}/${nCells}   OOS ${beats1OOS}/${nCells}`);
  console.log(`Cells beating 2-unit BH:  FULL ${beats2Full}/${nCells}`);
  // worst & best margin vs 1u BH across the grid
  const marg = cells.map((c) => c.FULL.totalPt - BH1_FULL_PT);
  console.log(`Margin vs 1u-BH across grid (pt): min ${Math.min(...marg).toFixed(0)}  max ${Math.max(...marg).toFixed(0)}  mean ${(marg.reduce((a, b) => a + b, 0) / marg.length).toFixed(0)}`);
  // cash-stretch across grid (the "gets stuck like single-unit" question)
  console.log('\nSwing cash-stretch (longest run of session-closes stuck at exposure 1) per cell:');
  console.log(['  D\\U '.padEnd(8), ...Ugrid.map((u) => String(u).padStart(10))].join(''));
  for (const D of Dgrid) {
    const row: string[] = [(`D=${D}`).padEnd(8)];
    for (const U of Ugrid) {
      const r = get(D, U).res;
      row.push((`${r.maxCashStretchSessions}`).padStart(10));
    }
    console.log(row.join(''));
  }
  const totalSessions = closes.length;
  console.log(`(total sessions = ${totalSessions}. Compare: single-unit version got stranded in cash for the rest of the run.)`);

  // per-cell beats table for IS & OOS (uniformity)
  console.log('\nPer-cell beats-1u-BH (F=FULL, I=IS, O=OOS) marks:');
  console.log(['  D\\U '.padEnd(8), ...Ugrid.map((u) => String(u).padStart(11))].join(''));
  for (const D of Dgrid) {
    const row: string[] = [(`D=${D}`).padEnd(8)];
    for (const U of Ugrid) {
      const cc = get(D, U);
      const f = cc.FULL.totalPt > BH1_FULL_PT ? 'F' : '-';
      const is = cc.IS.totalPt > bh1.IS.totalPt ? 'I' : '-';
      const o = cc.OOS.totalPt > bh1.OOS.totalPt ? 'O' : '-';
      row.push((f + is + o).padStart(11));
    }
    console.log(row.join(''));
  }

  // ========== 5. VERDICT (data only; prose in the report) ==========
  console.log('\n================ 5. VERDICT INPUTS ================');
  console.log(`(a) beats 1u-BH robustly? FULL ${beats1Full}/${nCells}, IS ${beats1IS}/${nCells}, OOS ${beats1OOS}/${nCells}`);
  console.log(`(b) best risk-adjusted (Calmar): D=${bestCalmar.D}/U=${bestCalmar.U} Calmar=${bestCalmar.FULL.calmar.toFixed(2)} (pt ${bestCalmar.FULL.totalPt.toFixed(0)}, MDD ${bestCalmar.FULL.mdd.toFixed(1)}%)`);
  console.log(`    best Sharpe: D=${bestSharpe.D}/U=${bestSharpe.U} Sharpe=${bestSharpe.FULL.sharpe.toFixed(2)}`);
  console.log(`    best total pt: D=${best.D}/U=${best.U} pt=${best.FULL.totalPt.toFixed(0)}`);
  // (c) harvest vs just holding the 2nd unit permanently:
  //   "holding 2nd unit permanently" extra pt over 1u-BH = exactly core (another 44,620) => 2u-BH.
  //   swing harvest of best cell:
  console.log(`(c) best-cell swing_harvest = ${best.res.swingHarvest.toFixed(0)} pt vs "hold 2nd unit forever" extra = ${(BH2_FULL_PT - BH1_FULL_PT).toFixed(0)} pt (=the 2nd core).`);
  console.log(`    => swing harvest is ${((best.res.swingHarvest / (BH2_FULL_PT - BH1_FULL_PT)) * 100).toFixed(1)}% of just permanently holding the 2nd unit.`);

  console.log('\n================ DONE ================');
}

main();
