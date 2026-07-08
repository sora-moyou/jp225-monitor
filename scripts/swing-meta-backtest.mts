/**
 * swing-meta-backtest.mts
 * Blank-slate SWING (daily) backtest for NIY=F, 2018-2026 (~9y).
 *
 * Goal: build a daily-position system that BEATS Buy&Hold, where the system
 * AUTONOMOUSLY SWITCHES its sub-strategy over time (regime / performance meta-layer).
 *
 * Methodology guards (strict, no look-ahead):
 *  - Daily series: group bars_1m by session_date (futures session = Night+Day).
 *    close = last bar by t; high = max(h); low = min(l).
 *  - Every position for day t is decided using ONLY data through close[t-1].
 *  - Execution model: a strategy outputs a target position pos[t] in {-1,0,+1,frac}.
 *    The position pos[t] is HELD over the return r[t] = (close[t]/close[t-1]-1).
 *    Since pos[t] is decided from data <= t-1, this is point-in-time (no look-ahead).
 *  - Cost: charged whenever net exposure changes, proportional to |pos[t]-pos[t-1]|,
 *    cost rate = 1 tick slip + small commission, expressed as fraction of notional.
 *  - Sharpe = mean(dailyStratRet)/std(dailyStratRet) * sqrt(252), from the
 *    STRATEGY's own net daily equity returns.
 *
 * Run: npx tsx scripts/swing-meta-backtest.mts
 */
/// <reference path="./node-sqlite-shim.d.ts" />
// @types/node 20.x predates node:sqlite typings; the shim above declares the slice we use.
// (runtime is Node 24 via tsx, which has the real implementation.)
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const POINT_VALUE = 100; // ¥ per point
const NOTIONAL = 1_000_000; // ¥1M notional reference

// ---------- load daily series ----------
type Day = { d: string; c: number; h: number; l: number };
function loadDaily(): Day[] {
  const db = new DatabaseSync(DB);
  // last close per session_date: pick c at max(t)
  const rows = db
    .prepare(
      `SELECT b.session_date d, b.c c, mm.hi h, mm.lo l
       FROM bars_1m b
       JOIN (SELECT session_date, max(t) tmax, max(h) hi, min(l) lo
             FROM bars_1m GROUP BY session_date) mm
       ON b.session_date=mm.session_date AND b.t=mm.tmax
       ORDER BY b.session_date`,
    )
    .all() as any[];
  db.close();
  // dedupe (if two bars share max t)
  const seen = new Set<string>();
  const out: Day[] = [];
  for (const r of rows) {
    if (seen.has(r.d)) continue;
    seen.add(r.d);
    out.push({ d: r.d, c: r.c, h: r.h, l: r.l });
  }
  return out;
}

// ---------- indicators (all causal: value at i uses data <= i) ----------
function sma(c: number[], n: number): number[] {
  const out = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < c.length; i++) {
    s += c[i];
    if (i >= n) s -= c[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}
function rsi2(c: number[], n: number): number[] {
  // Wilder-ish simple RSI over n periods
  const out = new Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) {
    let g = 0,
      l = 0;
    for (let k = i - n + 1; k <= i; k++) {
      const ch = c[k] - c[k - 1];
      if (ch >= 0) g += ch;
      else l -= ch;
    }
    const rs = l === 0 ? 100 : g / l;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}
function dailyRet(c: number[]): number[] {
  const r = new Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) r[i] = c[i] / c[i - 1] - 1;
  return r;
}
function realizedVol(ret: number[], n: number): number[] {
  // annualized rolling std of daily returns, value at i uses ret[i-n+1..i]
  const out = new Array(ret.length).fill(NaN);
  for (let i = n; i < ret.length; i++) {
    let m = 0;
    for (let k = i - n + 1; k <= i; k++) m += ret[k];
    m /= n;
    let v = 0;
    for (let k = i - n + 1; k <= i; k++) v += (ret[k] - m) ** 2;
    out[i] = Math.sqrt(v / (n - 1)) * Math.sqrt(252);
  }
  return out;
}
function lowerBoll(c: number[], n: number, k: number): number[] {
  const m = sma(c, n);
  const out = new Array(c.length).fill(NaN);
  for (let i = n - 1; i < c.length; i++) {
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (c[j] - m[i]) ** 2;
    out[i] = m[i] - k * Math.sqrt(v / n);
  }
  return out;
}

// ---------- sub-strategies: produce target position array, decided from data <= t-1 ----------
// Convention: posWanted[i] is the position to HOLD over return r[i] (close[i-1]->close[i]).
// It must be computed from indicators at index i-1 (strictly before bar i).
type Strat = { name: string; pos: number[] };

function buildStrats(c: number[]): Strat[] {
  const n = c.length;
  const ret = dailyRet(c);
  const s200 = sma(c, 200);
  const s50 = sma(c, 50);
  const s20 = sma(c, 20);
  const r2 = rsi2(c, 2);
  const lb = lowerBoll(c, 20, 2);
  const rv20 = realizedVol(ret, 20);

  const mk = (fn: (i: number) => number): number[] => {
    const p = new Array(n).fill(0);
    for (let i = 1; i < n; i++) p[i] = fn(i - 1); // decide from i-1
    return p;
  };

  // TREND: long if close>SMA200 else flat
  const TREND = mk((j) => (isFinite(s200[j]) && c[j] > s200[j] ? 1 : 0));
  // MOM: long if trailing-252d return>0 else flat
  const MOM = mk((j) => (j >= 252 && c[j] / c[j - 252] - 1 > 0 ? 1 : 0));
  // DUAL: long if SMA50>SMA200 else flat
  const DUAL = mk((j) => (isFinite(s50[j]) && isFinite(s200[j]) && s50[j] > s200[j] ? 1 : 0));
  // MR: long if RSI2<10 (or close<lowerBoll) else flat
  const MR = mk((j) =>
    (isFinite(r2[j]) && r2[j] < 10) || (isFinite(lb[j]) && c[j] < lb[j]) ? 1 : 0,
  );
  // TREND_LS: long if close>SMA200 else SHORT
  const TREND_LS = mk((j) => (isFinite(s200[j]) ? (c[j] > s200[j] ? 1 : -1) : 0));
  // VOLTGT: BH scaled by targetVol/realizedVol, cap 1.5
  const targetVol = 0.15;
  const VOLTGT = mk((j) => {
    if (!isFinite(rv20[j]) || rv20[j] <= 0) return 1;
    return Math.min(1.5, targetVol / rv20[j]);
  });
  // CASH: flat always
  const CASH = new Array(n).fill(0);

  // expose s20/s200 for regime classifier reuse via closures is messy; rebuild there.
  return [
    { name: 'TREND', pos: TREND },
    { name: 'MOM', pos: MOM },
    { name: 'DUAL', pos: DUAL },
    { name: 'MR', pos: MR },
    { name: 'TREND_LS', pos: TREND_LS },
    { name: 'VOLTGT', pos: VOLTGT },
    { name: 'CASH', pos: CASH },
  ];
}

// ---------- equity / metrics ----------
const COST = 0.0002; // per unit exposure change. 1 tick (~5pt on ~30000 ~=0.00017) + small commission ~ 0.0002 (2bps)
type Metrics = {
  name: string;
  totalRetPct: number;
  totalRetPt: number; // points captured per 1 unit (¥ via *POINT_VALUE)
  yenPnL: number;
  cagr: number;
  sharpe: number;
  mdd: number;
  calmar: number;
  pctLong: number;
  pctFlat: number;
  pctShort: number;
  switches: number;
  costDrag: number; // total fraction lost to cost
  n: number;
};

// Given a position array (held over r[i]) and returns, compute net daily strat returns + metrics.
function evalStrat(name: string, pos: number[], ret: number[], slice?: [number, number]): Metrics {
  const a = slice ? slice[0] : 0;
  const b = slice ? slice[1] : ret.length; // [a,b)
  const stratRet: number[] = [];
  let switches = 0;
  let costDragSum = 0;
  let nLong = 0,
    nFlat = 0,
    nShort = 0,
    cnt = 0;
  for (let i = a; i < b; i++) {
    const prev = i === a ? (slice ? pos[a - 1] ?? 0 : 0) : pos[i - 1];
    const dExp = Math.abs(pos[i] - prev);
    const cost = dExp * COST;
    if (dExp > 1e-9) switches++;
    costDragSum += cost;
    const sr = pos[i] * ret[i] - cost;
    stratRet.push(sr);
    cnt++;
    if (pos[i] > 1e-9) nLong++;
    else if (pos[i] < -1e-9) nShort++;
    else nFlat++;
  }
  // equity
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (const sr of stratRet) {
    eq *= 1 + sr;
    if (eq > peak) peak = eq;
    const dd = eq / peak - 1;
    if (dd < mdd) mdd = dd;
  }
  const totalRet = eq - 1;
  const years = cnt / 252;
  const cagr = years > 0 ? Math.pow(eq, 1 / years) - 1 : 0;
  const mean = stratRet.reduce((s, x) => s + x, 0) / stratRet.length;
  const variance =
    stratRet.reduce((s, x) => s + (x - mean) ** 2, 0) / (stratRet.length - 1);
  const sd = Math.sqrt(variance);
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : 0;
  // points captured: sum of pos*priceChange would be path-dependent; approximate via
  // compounding on notional then convert. For BH(pos=1) totalRet matches index change.
  const yenPnL = totalRet * NOTIONAL;
  const totalRetPt = (yenPnL / POINT_VALUE);
  return {
    name,
    totalRetPct: totalRet * 100,
    totalRetPt,
    yenPnL,
    cagr: cagr * 100,
    sharpe,
    mdd: mdd * 100,
    calmar,
    pctLong: (nLong / cnt) * 100,
    pctFlat: (nFlat / cnt) * 100,
    pctShort: (nShort / cnt) * 100,
    switches,
    costDrag: costDragSum * 100,
    n: cnt,
  };
}

// ---------- META layers ----------
// All meta decisions for day i use sub-strategy realized returns through i-1 only.
// We rebalance every K trading days; between rebalances we HOLD the chosen sub(s).

// Per-sub daily net return series (with their own cost), aligned to ret index.
function subDailyRets(strats: Strat[], ret: number[]): number[][] {
  return strats.map((s) => {
    const out = new Array(ret.length).fill(0);
    for (let i = 0; i < ret.length; i++) {
      const prev = i === 0 ? 0 : s.pos[i - 1];
      out[i] = s.pos[i] * ret[i] - Math.abs(s.pos[i] - prev) * COST;
    }
    return out;
  });
}

function trailingSharpe(r: number[], end: number, look: number): number {
  // sharpe of r[end-look+1 .. end], causal (end inclusive). Returns -Inf if not enough data.
  const a = end - look + 1;
  if (a < 0) return -Infinity;
  let m = 0;
  for (let i = a; i <= end; i++) m += r[i];
  m /= look;
  let v = 0;
  for (let i = a; i <= end; i++) v += (r[i] - m) ** 2;
  const sd = Math.sqrt(v / (look - 1));
  if (sd <= 0) return m > 0 ? 5 : m < 0 ? -5 : 0;
  return (m / sd) * Math.sqrt(252);
}

// A: Performance-switch. Every K days choose sub with best trailing-L-month Sharpe; hold it.
// Returns the META position array (so cost is naturally re-charged when the chosen sub changes net exposure).
function metaPerfSwitch(
  strats: Strat[],
  subRets: number[][],
  Lmonths: number,
  K: number,
): { pos: number[]; choice: string[] } {
  const n = strats[0].pos.length;
  const look = Math.round(Lmonths * 21); // ~21 td/month
  const pos = new Array(n).fill(0);
  const choice = new Array(n).fill('');
  let chosen = strats.length - 1; // start CASH-ish (last is CASH)
  for (let i = 1; i < n; i++) {
    // decide chosen using data <= i-1 (subRets index i-1)
    if ((i - 1) % K === 0 && i - 1 >= look) {
      let best = -Infinity,
        bi = chosen;
      for (let s = 0; s < strats.length; s++) {
        const sh = trailingSharpe(subRets[s], i - 1, look);
        if (sh > best) {
          best = sh;
          bi = s;
        }
      }
      chosen = bi;
    }
    pos[i] = strats[chosen].pos[i];
    choice[i] = strats[chosen].name;
  }
  return { pos, choice };
}

// B: Top-k equal weight by trailing Sharpe, rebalanced every K days.
function metaTopK(
  strats: Strat[],
  subRets: number[][],
  k: number,
  Lmonths: number,
  K: number,
): { pos: number[] } {
  const n = strats[0].pos.length;
  const look = Math.round(Lmonths * 21);
  const pos = new Array(n).fill(0);
  let chosenSet: number[] = [strats.length - 1];
  for (let i = 1; i < n; i++) {
    if ((i - 1) % K === 0 && i - 1 >= look) {
      const sh = strats.map((_, s) => ({ s, v: trailingSharpe(subRets[s], i - 1, look) }));
      sh.sort((x, y) => y.v - x.v);
      chosenSet = sh.slice(0, k).map((x) => x.s);
    }
    let p = 0;
    for (const s of chosenSet) p += strats[s].pos[i];
    pos[i] = p / chosenSet.length;
  }
  return { pos };
}

// C: Regime-map. Classify from price/vol (causal, from i-1) and map to a sub.
// trend(up) -> TREND ; range -> MR ; crash/high-vol-down -> CASH.
function metaRegime(c: number[], strats: Strat[]): { pos: number[]; choice: string[] } {
  const n = c.length;
  const ret = dailyRet(c);
  const s200 = sma(c, 200);
  const s50 = sma(c, 50);
  const rv20 = realizedVol(ret, 20);
  const byName: Record<string, number[]> = {};
  for (const s of strats) byName[s.name] = s.pos;
  const pos = new Array(n).fill(0);
  const choice = new Array(n).fill('');
  // rolling drawdown over 20d for crash detection
  for (let i = 1; i < n; i++) {
    const j = i - 1;
    let reg = 'range';
    const volHigh = isFinite(rv20[j]) && rv20[j] > 0.25; // >25% annualized
    // recent 10d drawdown from 10d-back peak
    let dd = 0;
    if (j >= 10) {
      let pk = c[j];
      for (let k = j - 10; k <= j; k++) pk = Math.max(pk, c[k]);
      dd = c[j] / pk - 1;
    }
    const crash = volHigh && dd < -0.05;
    const upTrend = isFinite(s200[j]) && c[j] > s200[j] && isFinite(s50[j]) && s50[j] > s200[j];
    if (crash) reg = 'crash';
    else if (upTrend && !volHigh) reg = 'trend';
    else reg = 'range';
    let src: string;
    if (reg === 'trend') src = 'TREND';
    else if (reg === 'crash') src = 'CASH';
    else src = 'MR';
    pos[i] = byName[src][i];
    choice[i] = reg;
  }
  return { pos, choice };
}

// D: Static equal-weight ensemble (non-adaptive control): average all sub positions each day.
function metaStaticEW(strats: Strat[]): { pos: number[] } {
  const n = strats[0].pos.length;
  const pos = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let p = 0;
    for (const s of strats) p += s.pos[i];
    pos[i] = p / strats.length;
  }
  return { pos };
}

// ---------- main ----------
function fmt(m: Metrics): string {
  const pad = (s: string | number, w: number) => String(s).padStart(w);
  return [
    m.name.padEnd(16),
    pad(m.totalRetPct.toFixed(1) + '%', 9),
    pad('¥' + (m.yenPnL / 1e6).toFixed(2) + 'M', 9),
    pad(m.cagr.toFixed(1) + '%', 7),
    pad(m.sharpe.toFixed(2), 6),
    pad(m.mdd.toFixed(1) + '%', 8),
    pad(m.calmar.toFixed(2), 6),
    pad(m.pctLong.toFixed(0), 4),
    pad(m.pctFlat.toFixed(0), 4),
    pad(m.pctShort.toFixed(0), 4),
    pad(m.switches, 7),
    pad(m.costDrag.toFixed(1) + '%', 7),
  ].join(' ');
}
const HEADER =
  'name             totalRet     yenPnL    CAGR  Sharpe     MDD Calmar  %L  %F  %S #switch  cost';

function main() {
  const daily = loadDaily();
  const c = daily.map((x) => x.c);
  const dates = daily.map((x) => x.d);
  const ret = dailyRet(c);
  const n = c.length;

  // slices: full [1,n) ; IS 2018..2023 ; OOS 2024..2026
  const idxOf = (yr: string) => dates.findIndex((d) => d >= yr);
  const isStart = 1;
  const oosStart = idxOf('2024-01-01');
  const full: [number, number] = [1, n];
  const IS: [number, number] = [isStart, oosStart];
  const OOS: [number, number] = [oosStart, n];

  console.log(`\n=== DATA === ${n} daily bars  ${dates[0]} -> ${dates[n - 1]}`);
  console.log(`IS  = ${dates[IS[0]]} .. ${dates[IS[1] - 1]}  (${IS[1] - IS[0]} d)`);
  console.log(`OOS = ${dates[OOS[0]]} .. ${dates[OOS[1] - 1]}  (${OOS[1] - OOS[0]} d)`);
  console.log(`Cost per unit-exposure change = ${(COST * 10000).toFixed(1)} bps`);

  const strats = buildStrats(c);
  const subRets = subDailyRets(strats, ret);

  // BH
  const bhPos = new Array(n).fill(1);

  const evalAll = (name: string, pos: number[]) => ({
    full: evalStrat(name, pos, ret, full),
    is: evalStrat(name, pos, ret, IS),
    oos: evalStrat(name, pos, ret, OOS),
  });

  const rows: { name: string; full: Metrics; is: Metrics; oos: Metrics }[] = [];
  rows.push({ name: 'BH', ...evalAll('BH', bhPos) });
  for (const s of strats) rows.push({ name: s.name, ...evalAll(s.name, s.pos) });

  // metas
  const metaRows: { name: string; full: Metrics; is: Metrics; oos: Metrics }[] = [];
  // A sweep L
  for (const L of [3, 6, 12]) {
    const { pos } = metaPerfSwitch(strats, subRets, L, 21);
    metaRows.push({ name: `A-PerfSw L${L}`, ...evalAll(`A-PerfSw L${L}`, pos) });
  }
  // B top-2 (L6)
  {
    const { pos } = metaTopK(strats, subRets, 2, 6, 21);
    metaRows.push({ name: 'B-Top2 L6', ...evalAll('B-Top2 L6', pos) });
  }
  // C regime
  {
    const { pos } = metaRegime(c, strats);
    metaRows.push({ name: 'C-Regime', ...evalAll('C-Regime', pos) });
  }
  // D static EW
  {
    const { pos } = metaStaticEW(strats);
    metaRows.push({ name: 'D-StaticEW', ...evalAll('D-StaticEW', pos) });
  }

  for (const span of ['full', 'is', 'oos'] as const) {
    const lab = span === 'full' ? 'FULL 9y' : span === 'is' ? 'IS 2018-2023' : 'OOS 2024-2026';
    console.log(`\n================ ${lab} ================`);
    console.log(HEADER);
    console.log('-- sub-strategies --');
    for (const r of rows) console.log(fmt(r[span]));
    console.log('-- meta variants --');
    for (const r of metaRows) console.log(fmt(r[span]));
  }

  // robustness summary: does best meta beat BH in BOTH IS and OOS on totalRet & Sharpe?
  console.log('\n================ ROBUSTNESS / ADAPTATION VALUE ================');
  const bh = rows.find((r) => r.name === 'BH')!;
  const staticEW = metaRows.find((r) => r.name === 'D-StaticEW')!;
  const bestSingleFull = rows
    .filter((r) => r.name !== 'BH')
    .reduce((a, b) => (b.full.totalRetPct > a.full.totalRetPct ? b : a));
  console.log(
    `BH full: ret=${bh.full.totalRetPct.toFixed(0)}% Sharpe=${bh.full.sharpe.toFixed(2)} MDD=${bh.full.mdd.toFixed(0)}% Calmar=${bh.full.calmar.toFixed(2)}`,
  );
  console.log(
    `Best single by full ret = ${bestSingleFull.name}: ret=${bestSingleFull.full.totalRetPct.toFixed(0)}% Sharpe=${bestSingleFull.full.sharpe.toFixed(2)} MDD=${bestSingleFull.full.mdd.toFixed(0)}%`,
  );
  console.log(
    `Static EW (D): full ret=${staticEW.full.totalRetPct.toFixed(0)}% Sharpe=${staticEW.full.sharpe.toFixed(2)} MDD=${staticEW.full.mdd.toFixed(0)}% | IS ret=${staticEW.is.totalRetPct.toFixed(0)}% Sh=${staticEW.is.sharpe.toFixed(2)} | OOS ret=${staticEW.oos.totalRetPct.toFixed(0)}% Sh=${staticEW.oos.sharpe.toFixed(2)}`,
  );
  console.log('\nMeta beats BH? (totalRet / Sharpe in each span)');
  for (const r of metaRows) {
    const f = r.full.totalRetPct > bh.full.totalRetPct,
      fs = r.full.sharpe > bh.full.sharpe;
    const i = r.is.totalRetPct > bh.is.totalRetPct,
      is = r.is.sharpe > bh.is.sharpe;
    const o = r.oos.totalRetPct > bh.oos.totalRetPct,
      os = r.oos.sharpe > bh.oos.sharpe;
    const Y = (b: boolean) => (b ? 'Y' : '.');
    console.log(
      `${r.name.padEnd(14)} FULL ret${Y(f)} Sh${Y(fs)} | IS ret${Y(i)} Sh${Y(is)} | OOS ret${Y(o)} Sh${Y(os)}  ` +
        `[full Sharpe ${r.full.sharpe.toFixed(2)} vs BH ${bh.full.sharpe.toFixed(2)}; MDD ${r.full.mdd.toFixed(0)}% vs ${bh.full.mdd.toFixed(0)}%]`,
    );
  }
}

main();
