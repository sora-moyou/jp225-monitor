/**
 * swing-accum-backtest.mts
 * Tests the USER's "sell-high / re-buy-lower / repeat" volatility-harvest hypothesis
 * on NIY=F 1-min bars, 2018-2026 (~9y), vs Buy&Hold.
 *
 * MECHANISM (user, a Nikkei futures trader): ① buy → ② sell (TP) at higher price →
 * ③ RE-BUY at a price LOWER than the step-② sell price → repeat. Long-biased
 * swing-accumulation / volatility harvest; each completed round-trip (rebuy<sell)
 * banks profit on top of B&H.
 *
 * Variants:
 *   1. Single-unit patient band  : hold 1 unit; sell at entry+X; re-buy at sell-Y; if
 *      price rises instead, STAY FLAT (never buy higher than sell). Risk = miss the bull.
 *   2. Core + swing overlay      : ALWAYS hold 1 CORE unit (= B&H, never sold). 2nd
 *      OVERLAY unit does the swing (sell at +X, rebuy only at sell-Y). Overlay only
 *      closes round-trips at a profit -> structurally should beat BH by harvested swings.
 *   3. Chase / re-arm            : like (1) but if price runs +Z above the sell without
 *      coming back, re-buy HIGHER (re-arm band upward). Quantifies "buy higher" leakage.
 *   4. Grid / ladder             : fixed rungs (buy below / sell above) over the range.
 *
 * METHODOLOGY (strict, no look-ahead):
 *   - Bars processed in t order. A buy-limit fills only if bar.low <= buyLimit; a
 *     sell-limit fills only if bar.high >= sellLimit. Fill price = the limit price.
 *   - Within a bar, if multiple pending levels could fill, the one NEAREST the bar OPEN
 *     is assumed touched first (conservative open-relative path). For single-position
 *     variants only one pending order exists at a time anyway.
 *   - Cost charged on EVERY fill: 1-tick slippage (TICK pt) + commission (COMM pt),
 *     deducted from PnL in points. (Fill is AT the limit; cost is separate, adverse.)
 *   - Equity / Sharpe from the STRATEGY's own realized+unrealized PnL path, marked to
 *     market at each session close. Reported in % of an initial-price notional so it is
 *     comparable to BH's index return.
 *
 * Run: npx tsx scripts/swing-accum-backtest.mts
 */
/// <reference path="./node-sqlite-shim.d.ts" />
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const POINT_VALUE = 100; // ¥ per point per contract
const TICK = 5; // NIY tick size in points -> 1-tick slippage per fill
const COMM_PT = 0.5; // commission approx in points (~¥50/contract)
const COST_PT = TICK + COMM_PT; // adverse cost per fill, in points

// ---------- load bars ----------
type Bar = { t: number; d: string; o: number; h: number; l: number; c: number };
function loadBars(): Bar[] {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db
    .prepare(`SELECT t, session_date d, o, h, l, c FROM bars_1m WHERE symbol='NIY=F' ORDER BY t`)
    .all() as any[];
  db.close();
  return rows.map((r) => ({ t: r.t, d: r.d, o: r.o, h: r.h, l: r.l, c: r.c }));
}

// daily close index: last bar per session_date (in t order). Returns array of {d, idx}
function sessionCloses(bars: Bar[]): { d: string; idx: number; c: number }[] {
  const out: { d: string; idx: number; c: number }[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === bars.length - 1 || bars[i + 1].d !== bars[i].d) {
      out.push({ d: bars[i].d, idx: i, c: bars[i].c });
    }
  }
  return out;
}

// ---------- equity metrics from a daily mark-to-market PnL series (in points) ----------
// pnlPath[k] = cumulative realized+unrealized strategy PnL (points) at session-close k.
// We convert to a return path relative to refPrice (initial index level) so % is
// comparable to BH index return: equityFrac = 1 + pnlPoints/refPrice.
type Metrics = {
  totalRetPct: number;
  yenPnL: number;
  sharpe: number;
  mdd: number;
  cagr: number;
  calmar: number;
  nDays: number;
};
function metricsFromDailyPnL(pnlPath: number[], refPrice: number): Metrics {
  const n = pnlPath.length;
  // daily fractional returns of equity (equity = refPrice + pnl)
  const eq = pnlPath.map((p) => refPrice + p);
  const rets: number[] = [];
  for (let i = 1; i < n; i++) rets.push(eq[i] / eq[i - 1] - 1);
  let peak = eq[0],
    mdd = 0;
  for (const e of eq) {
    if (e > peak) peak = e;
    const dd = e / peak - 1;
    if (dd < mdd) mdd = dd;
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
    totalRetPct: totalRet * 100,
    yenPnL: pnlPath[n - 1] * POINT_VALUE, // final realized+unrealized points * ¥/pt (1 contract)
    sharpe,
    mdd: mdd * 100,
    cagr: cagr * 100,
    calmar,
    nDays: n,
  };
}

// ============================================================================
// Simulation harness. A strategy is driven bar-by-bar. It maintains:
//   - position size (contracts, can be 0,1,2 for core+overlay)
//   - a set of pending limit orders, each {side:'buy'|'sell', price, qty}
// On each bar we resolve fills (open-relative ordering), updating position and
// realizedPnL. At each session close we snapshot realized+unrealized PnL.
// ============================================================================

type Order = { side: 'buy' | 'sell'; price: number; qty: number; tag: string };

// Each variant is an explicit state machine inside its own runner (more auditable than a
// generic interface). Shared helper below resolves which pending orders fill on a bar.

// Shared fill resolver for a bar given a list of pending orders.
// Returns the orders that fill THIS bar, in open-relative touch order.
function fillsThisBar(bar: Bar, orders: Order[]): Order[] {
  const hit = orders.filter((o) =>
    o.side === 'buy' ? bar.l <= o.price : bar.h >= o.price,
  );
  // order by distance from open (nearest first = touched first intrabar)
  hit.sort((a, b) => Math.abs(a.price - bar.o) - Math.abs(b.price - bar.o));
  return hit;
}

// ---------------------------------------------------------------------------
// VARIANT 1: single-unit patient band
//   State: either LONG 1 (entry e) with a sell order at e+X, or FLAT with a buy
//   order at lastSell - Y. Never buys above lastSell while flat.
// Xpt, Ypt are absolute point thresholds (we sweep both pt and %).
// ---------------------------------------------------------------------------
function runVariant1(
  bars: Bar[],
  closes: { idx: number }[],
  Xpt: number,
  Ypt: number,
): { pnlPath: number[]; roundTrips: number; nFills: number; flatBars: number; missedFlat: number; lastSellDate: string; lastSellPx: number } {
  let pos = 0; // 0 or 1
  let entry = 0;
  let realized = 0;
  let lastSellDate = '';
  let lastSellPx = 0;
  const orders: Order[] = [];
  // start: market-buy at first bar open
  const first = bars[0];
  pos = 1;
  entry = first.o;
  realized -= COST_PT; // entry cost
  orders.push({ side: 'sell', price: entry + Xpt, qty: 1, tag: 'tp' });

  let roundTrips = 0,
    nFills = 1,
    flatBars = 0,
    missedFlat = 0;
  let closePtr = 0;
  const pnlPath: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // resolve fills (at most one pending order at a time here, but use resolver for safety)
    let guard = 0;
    while (true) {
      const hits = fillsThisBar(bar, orders);
      if (hits.length === 0) break;
      const o = hits[0];
      // execute o
      const oi = orders.indexOf(o);
      orders.splice(oi, 1);
      realized -= COST_PT;
      nFills++;
      if (o.side === 'sell') {
        // close the long at o.price
        realized += o.price - entry;
        pos = 0;
        roundTrips++;
        lastSellDate = bar.d;
        lastSellPx = o.price;
        // arm re-buy at sell - Y (patient: never above this)
        orders.length = 0;
        orders.push({ side: 'buy', price: o.price - Ypt, qty: 1, tag: 'rebuy' });
      } else {
        // buy fill -> go long
        pos = 1;
        entry = o.price;
        orders.length = 0;
        orders.push({ side: 'sell', price: entry + Xpt, qty: 1, tag: 'tp' });
      }
      if (++guard > 8) break;
    }
    if (pos === 0) flatBars++;

    // snapshot at session close
    if (closePtr < closes.length && i === closes[closePtr].idx) {
      const mtm = pos === 1 ? bar.c - entry : 0;
      pnlPath.push(realized + mtm);
      closePtr++;
    }
  }
  // missedFlat: count round-trips where after selling, price never returned to rebuy (still flat at end)
  if (pos === 0) missedFlat = 1;
  return { pnlPath, roundTrips, nFills, flatBars, missedFlat, lastSellDate, lastSellPx };
}

// ---------------------------------------------------------------------------
// VARIANT 2: core + swing overlay
//   CORE: 1 contract bought at start, NEVER sold (pure BH leg).
//   OVERLAY: 1 contract. State machine identical to variant1 but independent.
//   Total pos = 1 (core) + overlay(0/1).
// ---------------------------------------------------------------------------
function runVariant2(
  bars: Bar[],
  closes: { idx: number }[],
  Xpt: number,
  Ypt: number,
): {
  pnlPath: number[];
  corePnlPath: number[];
  overlayHarvest: number; // realized overlay PnL net of overlay cost (points)
  roundTrips: number;
  overlayCost: number;
  flatFrac: number; // fraction of session-closes overlay was flat (in cash)
} {
  const first = bars[0];
  const coreEntry = first.o;
  let coreCost = COST_PT;

  // overlay
  let oPos = 1;
  let oEntry = first.o;
  let overlayRealized = -COST_PT; // overlay entry cost
  let overlayCost = COST_PT;
  const orders: Order[] = [{ side: 'sell', price: oEntry + Xpt, qty: 1, tag: 'tp' }];

  let roundTrips = 0;
  let closePtr = 0;
  const pnlPath: number[] = [];
  const corePnlPath: number[] = [];
  let flatCloses = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    let guard = 0;
    while (true) {
      const hits = fillsThisBar(bar, orders);
      if (hits.length === 0) break;
      const o = hits[0];
      orders.splice(orders.indexOf(o), 1);
      overlayRealized -= COST_PT;
      overlayCost += COST_PT;
      if (o.side === 'sell') {
        overlayRealized += o.price - oEntry;
        oPos = 0;
        roundTrips++;
        orders.length = 0;
        orders.push({ side: 'buy', price: o.price - Ypt, qty: 1, tag: 'rebuy' });
      } else {
        oPos = 1;
        oEntry = o.price;
        orders.length = 0;
        orders.push({ side: 'sell', price: oEntry + Xpt, qty: 1, tag: 'tp' });
      }
      if (++guard > 8) break;
    }
    if (closePtr < closes.length && i === closes[closePtr].idx) {
      const coreMtm = bar.c - coreEntry - coreCost;
      const overlayMtm = oPos === 1 ? bar.c - oEntry : 0;
      corePnlPath.push(coreMtm);
      pnlPath.push(coreMtm + overlayRealized + overlayMtm);
      if (oPos === 0) flatCloses++;
      closePtr++;
    }
  }
  // overlayHarvest = realized overlay PnL (net of overlay cost). Add final unrealized if still open.
  const lastBar = bars[bars.length - 1];
  const overlayFinal = overlayRealized + (oPos === 1 ? lastBar.c - oEntry : 0);
  return {
    pnlPath,
    corePnlPath,
    overlayHarvest: overlayFinal,
    roundTrips,
    overlayCost,
    flatFrac: flatCloses / corePnlPath.length,
  };
}

// ---------------------------------------------------------------------------
// VARIANT 3: chase / re-arm. Like variant1 but while FLAT, in addition to the
//   patient re-buy at sell-Y, we also place a CHASE buy at sell+Z: if price runs
//   up Z above the sell without first dipping to sell-Y, we re-buy HIGHER.
//   This quantifies the cost of "buying higher" to avoid being stranded flat.
// ---------------------------------------------------------------------------
function runVariant3(
  bars: Bar[],
  closes: { idx: number }[],
  Xpt: number,
  Ypt: number,
  Zpt: number,
): { pnlPath: number[]; roundTrips: number; chaseBuys: number; patientBuys: number; nFills: number; longCloses: number } {
  let pos = 1;
  let entry = bars[0].o;
  let realized = -COST_PT;
  const orders: Order[] = [{ side: 'sell', price: entry + Xpt, qty: 1, tag: 'tp' }];
  let roundTrips = 0,
    chaseBuys = 0,
    patientBuys = 0,
    nFills = 1,
    longCloses = 0;
  let closePtr = 0;
  const pnlPath: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    let guard = 0;
    while (true) {
      const hits = fillsThisBar(bar, orders);
      if (hits.length === 0) break;
      const o = hits[0];
      orders.splice(orders.indexOf(o), 1);
      realized -= COST_PT;
      nFills++;
      if (o.side === 'sell') {
        realized += o.price - entry;
        pos = 0;
        roundTrips++;
        orders.length = 0;
        // patient rebuy (lower) AND chase rebuy (higher)
        orders.push({ side: 'buy', price: o.price - Ypt, qty: 1, tag: 'rebuy' });
        orders.push({ side: 'buy', price: o.price + Zpt, qty: 1, tag: 'chase' });
      } else {
        pos = 1;
        entry = o.price;
        if (o.tag === 'chase') chaseBuys++;
        else patientBuys++;
        orders.length = 0;
        orders.push({ side: 'sell', price: entry + Xpt, qty: 1, tag: 'tp' });
      }
      if (++guard > 8) break;
    }
    if (closePtr < closes.length && i === closes[closePtr].idx) {
      const mtm = pos === 1 ? bar.c - entry : 0;
      pnlPath.push(realized + mtm);
      if (pos === 1) longCloses++;
      closePtr++;
    }
  }
  return { pnlPath, roundTrips, chaseBuys, patientBuys, nFills, longCloses };
}

// ---------------------------------------------------------------------------
// VARIANT 4: static grid/ladder. Rungs spaced G points apart across a band of
//   R rungs below and R rungs above a center. Buy when a lower rung is touched,
//   sell 1 unit when an upper rung is touched (only if holding inventory bought
//   cheaper). Classic long-only grid: each unit bought at rung k is sold at rung
//   k+1 (one grid step up = G points profit). Max inventory = R units.
//   Grid recenters by absolute price levels (fixed ladder), not look-ahead.
// ---------------------------------------------------------------------------
function runVariant4(
  bars: Bar[],
  closes: { idx: number }[],
  Gpt: number,
  R: number,
): { pnlPath: number[]; buys: number; sells: number; maxInv: number; avgInv: number } {
  // ladder anchored at first bar open; levels at open + k*Gpt for integer k.
  const anchor = bars[0].o;
  const level = (k: number) => anchor + k * Gpt;
  // inventory: stack of lots each tagged with the rung k at which bought (sell target = k+1)
  const inv: { k: number; entry: number }[] = [];
  let realized = 0;
  let buys = 0,
    sells = 0,
    maxInv = 0,
    invSumAtCloses = 0;
  // seed: start with R/2 ... keep it simple: start flat, let grid fill.
  let closePtr = 0;
  const pnlPath: number[] = [];

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    // Determine the band of rung levels potentially crossed this bar: [floor(low),ceil(high)]
    const kLow = Math.ceil((bar.l - anchor) / Gpt);
    const kHigh = Math.floor((bar.h - anchor) / Gpt);
    // We simulate crossing in open-relative order is complex for many rungs; use a
    // simple, conservative rule consistent with no-look-ahead:
    // Process rungs the bar spans in open-relative order (nearest first).
    const touched: number[] = [];
    for (let k = kLow; k <= kHigh; k++) touched.push(k);
    touched.sort((a, b) => Math.abs(level(a) - bar.o) - Math.abs(level(b) - bar.o));
    for (const k of touched) {
      const p = level(k);
      if (p <= bar.o) {
        // a level at/below open touched on the way down -> BUY if inventory < R and no lot already at this k
        if (inv.length < R && !inv.some((x) => x.k === k)) {
          inv.push({ k, entry: p });
          realized -= COST_PT;
          buys++;
        }
      } else {
        // level above open -> SELL one lot whose buy-rung is below k (profit = (k - lot.k)*G)
        // sell the lot with the HIGHEST buy-rung that is still < k (closest, FIFO-ish nearest)
        let best = -1;
        for (let j = 0; j < inv.length; j++) {
          if (inv[j].k < k && (best < 0 || inv[j].k > inv[best].k)) best = j;
        }
        if (best >= 0) {
          realized += p - inv[best].entry;
          realized -= COST_PT;
          inv.splice(best, 1);
          sells++;
        }
      }
    }
    if (inv.length > maxInv) maxInv = inv.length;
    if (closePtr < closes.length && i === closes[closePtr].idx) {
      // mark unrealized inventory at close
      let mtm = 0;
      for (const lot of inv) mtm += bar.c - lot.entry;
      pnlPath.push(realized + mtm);
      invSumAtCloses += inv.length;
      closePtr++;
    }
  }
  return { pnlPath, buys, sells, maxInv, avgInv: invSumAtCloses / pnlPath.length };
}

// ---------------------------------------------------------------------------
// Buy & Hold reference: 1 contract bought at first bar open, marked at each close.
// ---------------------------------------------------------------------------
function runBH(bars: Bar[], closes: { idx: number }[]): number[] {
  const entry = bars[0].o;
  const pnlPath: number[] = [];
  let closePtr = 0;
  for (let i = 0; i < bars.length; i++) {
    if (closePtr < closes.length && i === closes[closePtr].idx) {
      pnlPath.push(bars[i].c - entry - COST_PT);
      closePtr++;
    }
  }
  return pnlPath;
}

// ---------- main ----------
function main() {
  console.log('Loading bars...');
  const bars = loadBars();
  const closes = sessionCloses(bars);
  const refPrice = bars[0].o;
  console.log(`Bars: ${bars.length}  sessions: ${closes.length}  ${bars[0].d}..${bars[bars.length - 1].d}`);
  console.log(`refPrice(open)=${refPrice}  cost/fill=${COST_PT}pt (tick ${TICK} + comm ${COMM_PT})\n`);

  // span boundaries by session index
  const oosCloseIdx = closes.findIndex((s) => (s as any).d >= '2024-01-01');
  const spans: Record<string, [number, number]> = {
    FULL: [0, closes.length],
    IS: [0, oosCloseIdx],
    OOS: [oosCloseIdx, closes.length],
  };
  // We also need a bar-index split so each variant runs IS / OOS independently for honesty.
  // Simpler & faithful: run each variant once over the FULL bar stream, then slice the
  // daily pnlPath for IS/OOS metrics. Slicing the cumulative pnl path and re-basing to its
  // segment start gives the segment's own return path. (Position carries across the split,
  // which is realistic.)
  function sliceMetrics(pnlPath: number[], span: [number, number]): Metrics {
    const seg = pnlPath.slice(span[0], span[1]);
    // re-base so segment starts at 0 cumulative -> use refPrice as equity base
    const base = span[0] === 0 ? 0 : pnlPath[span[0] - 1];
    const rebased = seg.map((p) => p - base);
    return metricsFromDailyPnL(rebased, refPrice);
  }

  // BH
  const bhPnl = runBH(bars, closes);
  const bh = {
    FULL: sliceMetrics(bhPnl, spans.FULL),
    IS: sliceMetrics(bhPnl, spans.IS),
    OOS: sliceMetrics(bhPnl, spans.OOS),
  };

  const fmtM = (m: Metrics) =>
    `ret=${m.totalRetPct.toFixed(1).padStart(7)}%  Sharpe=${m.sharpe.toFixed(2).padStart(5)}  MDD=${m.mdd.toFixed(1).padStart(6)}%  CAGR=${m.cagr.toFixed(1).padStart(5)}%  ¥${(m.yenPnL / 1e6).toFixed(2)}M`;

  console.log('================ BUY & HOLD (benchmark) ================');
  console.log(`FULL  ${fmtM(bh.FULL)}`);
  console.log(`IS    ${fmtM(bh.IS)}`);
  console.log(`OOS   ${fmtM(bh.OOS)}`);

  // ---- grids ----
  // % of refPrice -> points
  const pctGrid = [0.5, 1, 2, 3];
  const ptOfPct = (pct: number) => Math.round((pct / 100) * refPrice / TICK) * TICK; // snap to tick
  // pt-based grid (absolute)
  const ptGrid = [100, 200, 400, 600];

  const beats = (m: Metrics, span: keyof typeof bh) => (m.totalRetPct > bh[span].totalRetPct ? '*' : ' ');

  // ============ VARIANT 1: single-unit patient band ============
  console.log('\n================ VARIANT 1: single-unit patient band ================');
  console.log('grid = (X=sell trigger above entry, Y=rebuy below sell). %-grid then pt-grid.');
  console.log('cells show FULL totalRet% (and IS/OOS). "*" = beats BH that span. BH FULL=' + bh.FULL.totalRetPct.toFixed(0) + '%');
  const v1run = (Xpt: number, Ypt: number) => {
    const r = runVariant1(bars, closes, Xpt, Ypt);
    return {
      r,
      FULL: sliceMetrics(r.pnlPath, spans.FULL),
      IS: sliceMetrics(r.pnlPath, spans.IS),
      OOS: sliceMetrics(r.pnlPath, spans.OOS),
    };
  };
  function v1Heatmap(label: string, grid: number[], asPct: boolean) {
    console.log(`\n-- V1 ${label} --`);
    const head = ['X\\Y'.padEnd(8), ...grid.map((g) => (asPct ? g + '%' : g + 'pt').padStart(10))].join('');
    console.log(head);
    let bestFull = -Infinity;
    let bestCell = '';
    for (const X of grid) {
      const Xpt = asPct ? ptOfPct(X) : X;
      const cells: string[] = [(asPct ? X + '%' : X + 'pt').padEnd(8)];
      for (const Y of grid) {
        const Ypt = asPct ? ptOfPct(Y) : Y;
        const o = v1run(Xpt, Ypt);
        if (o.FULL.totalRetPct > bestFull) {
          bestFull = o.FULL.totalRetPct;
          bestCell = `X=${asPct ? X + '%' : X + 'pt'} Y=${asPct ? Y + '%' : Y + 'pt'}`;
        }
        cells.push((o.FULL.totalRetPct.toFixed(0) + beats(o.FULL, 'FULL')).padStart(10));
      }
      console.log(cells.join(''));
    }
    console.log(`best FULL cell: ${bestCell} -> ${bestFull.toFixed(1)}% (BH ${bh.FULL.totalRetPct.toFixed(0)}%)`);
    return { bestCell, bestFull };
  }
  const v1pct = v1Heatmap('% grid', pctGrid, true);
  v1Heatmap('pt grid', ptGrid, false);
  // detail on best % cell incl IS/OOS + failure mode
  {
    // re-derive best cell params
    let best: { X: number; Y: number; o: ReturnType<typeof v1run> } | null = null;
    for (const X of pctGrid)
      for (const Y of pctGrid) {
        const o = v1run(ptOfPct(X), ptOfPct(Y));
        if (!best || o.FULL.totalRetPct > best.o.FULL.totalRetPct) best = { X, Y, o };
      }
    const b = best!;
    console.log(`\nV1 best %-cell detail X=${b.X}% Y=${b.Y}%:`);
    console.log(`  FULL ${fmtM(b.o.FULL)}  rt=${b.o.r.roundTrips} fills=${b.o.r.nFills}`);
    console.log(`  IS   ${fmtM(b.o.IS)}`);
    console.log(`  OOS  ${fmtM(b.o.OOS)}`);
    console.log(`  flatBars=${b.o.r.flatBars}/${bars.length} (${((b.o.r.flatBars / bars.length) * 100).toFixed(1)}% of bars in cash)`);
    console.log(`  endedFlat=${b.o.r.missedFlat === 1 ? 'YES (sitting in cash at end - stranded by a rally)' : 'no (long at end)'}`);
    console.log(`  lastSell=${b.o.r.lastSellDate} @${b.o.r.lastSellPx} -> then price never came back ${b.Y}% so it sat in cash from there to ${bars[bars.length - 1].d} (final ${bars[bars.length - 1].c}). THIS is the missed-bull cost.`);
  }

  // ============ VARIANT 2: core + overlay (the structural-edge claim) ============
  console.log('\n================ VARIANT 2: core + swing overlay ================');
  console.log('CORE always long (=BH). OVERLAY swings (sell +X, rebuy sell-Y). Decomp: BH_core + overlay_harvest - cost = total.');
  console.log('cells = FULL totalRet% of the COMBINED 2-unit book (vs its own 2x notional). "*" beats BH%.');
  const v2run = (Xpt: number, Ypt: number) => {
    const r = runVariant2(bars, closes, Xpt, Ypt);
    return {
      r,
      FULL: sliceMetrics(r.pnlPath, spans.FULL),
      IS: sliceMetrics(r.pnlPath, spans.IS),
      OOS: sliceMetrics(r.pnlPath, spans.OOS),
    };
  };
  // NOTE: variant2 holds up to 2 units; its pnlPath is in points of a 2-unit book. To compare
  // total RETURN fairly against BH (1 unit), we normalize equity base to 2*refPrice for V2.
  function v2Metrics(pnlPath: number[], span: [number, number]): Metrics {
    const seg = pnlPath.slice(span[0], span[1]);
    const base = span[0] === 0 ? 0 : pnlPath[span[0] - 1];
    const rebased = seg.map((p) => p - base);
    return metricsFromDailyPnL(rebased, 2 * refPrice); // 2-unit notional base
  }
  // BH 2-unit equivalent for fair % compare: just BH return (same % since linear); but the
  // honest comparison is "does the overlay add return ON TOP of holding 1 core unit?". So we
  // compare V2's per-unit-of-deployed-capital return vs BH. We report both the combined book
  // and the pure overlay harvest decomposition.
  console.log(`(BH FULL ${bh.FULL.totalRetPct.toFixed(0)}% is 1-unit. V2 combined book uses 2-unit base.)`);
  function v2Heatmap(label: string, grid: number[], asPct: boolean) {
    console.log(`\n-- V2 ${label} --  (cell = combined-book FULL ret%, *beats BH)`);
    console.log(['X\\Y'.padEnd(8), ...grid.map((g) => (asPct ? g + '%' : g + 'pt').padStart(10))].join(''));
    for (const X of grid) {
      const Xpt = asPct ? ptOfPct(X) : X;
      const cells: string[] = [(asPct ? X + '%' : X + 'pt').padEnd(8)];
      for (const Y of grid) {
        const Ypt = asPct ? ptOfPct(Y) : Y;
        const r = runVariant2(bars, closes, Xpt, Ypt);
        const m = v2Metrics(r.pnlPath, spans.FULL);
        cells.push((m.totalRetPct.toFixed(0) + (m.totalRetPct > bh.FULL.totalRetPct ? '*' : ' ')).padStart(10));
      }
      console.log(cells.join(''));
    }
  }
  v2Heatmap('% grid', pctGrid, true);
  // decomposition at a representative + best harvest cell
  {
    console.log('\nV2 DECOMPOSITION (points & ¥, 1 core + 1 overlay), FULL 9y:');
    console.log('  X%   Y%   overlay_rt  overlay_harvest(pt)  overlayCost(pt)  flatFrac   core_BH(pt)   total(pt)   total¥M');
    const lastBar = bars[bars.length - 1];
    const coreBHpt = lastBar.c - refPrice - COST_PT;
    for (const X of pctGrid)
      for (const Y of pctGrid) {
        const Xpt = ptOfPct(X), Ypt = ptOfPct(Y);
        const r = runVariant2(bars, closes, Xpt, Ypt);
        const totalPt = r.pnlPath[r.pnlPath.length - 1];
        console.log(
          `  ${(X + '%').padEnd(4)} ${(Y + '%').padEnd(4)} ${String(r.roundTrips).padStart(9)}  ${r.overlayHarvest.toFixed(0).padStart(18)}  ${r.overlayCost.toFixed(0).padStart(14)}  ${(r.flatFrac * 100).toFixed(0).padStart(7)}%  ${coreBHpt.toFixed(0).padStart(11)}  ${totalPt.toFixed(0).padStart(10)}  ${((totalPt * POINT_VALUE) / 1e6).toFixed(2).padStart(7)}`,
        );
      }
    console.log(`  (check: total = core_BH + overlay_harvest, where overlay_harvest already nets overlay cost)`);
  }

  // ============ VARIANT 3: chase / re-arm leakage ============
  console.log('\n================ VARIANT 3: chase / re-arm (buy-higher leakage) ================');
  console.log('Like V1 but adds a CHASE buy at sell+Z (re-buy higher if price runs away up).');
  console.log('Compare vs V1 patient (same X,Y) to quantify the "buy higher" cost. FULL ret%.');
  {
    const X = 2, Y = 2; // representative mid cell
    const Xpt = ptOfPct(X), Ypt = ptOfPct(Y);
    const v1 = v1run(Xpt, Ypt);
    console.log(`\nAt X=${X}% Y=${Y}%  (V1 patient FULL=${v1.FULL.totalRetPct.toFixed(1)}%, rt=${v1.r.roundTrips}):`);
    console.log('  Z%    FULL ret%   IS ret%   OOS ret%   chaseBuys  patientBuys  rt   %timeLong  Sharpe');
    for (const Z of [0.5, 1, 2, 3]) {
      const Zpt = ptOfPct(Z);
      const r = runVariant3(bars, closes, Xpt, Ypt, Zpt);
      const F = sliceMetrics(r.pnlPath, spans.FULL);
      const I = sliceMetrics(r.pnlPath, spans.IS);
      const O = sliceMetrics(r.pnlPath, spans.OOS);
      const timeLong = (r.longCloses / r.pnlPath.length) * 100;
      console.log(
        `  ${(Z + '%').padEnd(5)} ${F.totalRetPct.toFixed(1).padStart(9)} ${I.totalRetPct.toFixed(1).padStart(9)} ${O.totalRetPct.toFixed(1).padStart(9)}   ${String(r.chaseBuys).padStart(8)} ${String(r.patientBuys).padStart(11)} ${String(r.roundTrips).padStart(4)}   ${timeLong.toFixed(1).padStart(7)}%  ${F.sharpe.toFixed(2)}`,
      );
    }
    console.log(`  (BH FULL=${bh.FULL.totalRetPct.toFixed(0)}% Sharpe=${bh.FULL.sharpe.toFixed(2)}; %timeLong->100 means V3 is just re-creating BH beta by buying back higher.)`);
  }

  // ============ VARIANT 4: grid / ladder ============
  console.log('\n================ VARIANT 4: grid / ladder ================');
  console.log('Fixed ladder, step=G pt, max inventory=R units. Each unit sold one step (G) higher.');
  console.log('V4 holds avgInv units of long inventory => it is essentially LEVERAGED LONG BETA.');
  console.log('FULL¥M = raw realized+unrealized yen. retPerUnit% = ret on capital actually deployed');
  console.log('(avgInv*refPrice base) => the only beta-fair vs-BH(1-unit, FULL ' + bh.FULL.totalRetPct.toFixed(0) + '%) number.');
  console.log('  G(pt)  R   FULL¥M   avgInv   maxInv   buys   sells   retPerUnit%   *beatsBH/unit');
  for (const G of [100, 200, 400]) {
    for (const R of [3, 5, 10]) {
      const r = runVariant4(bars, closes, G, R);
      const fullPt = r.pnlPath[r.pnlPath.length - 1];
      const fullYenM = (fullPt * POINT_VALUE) / 1e6;
      // beta-fair: ret per unit of avg deployed capital
      const perUnit = r.avgInv > 0 ? metricsFromDailyPnL(r.pnlPath, r.avgInv * refPrice) : null;
      const ru = perUnit ? perUnit.totalRetPct : 0;
      console.log(
        `  ${String(G).padStart(5)} ${String(R).padStart(2)} ${fullYenM.toFixed(2).padStart(7)} ${r.avgInv.toFixed(2).padStart(8)} ${String(r.maxInv).padStart(7)} ${String(r.buys).padStart(6)} ${String(r.sells).padStart(6)} ${ru.toFixed(1).padStart(11)}%    ${ru > bh.FULL.totalRetPct ? '*' : ' '}`,
      );
    }
  }

  console.log('\n================ DONE ================');
}

main();
