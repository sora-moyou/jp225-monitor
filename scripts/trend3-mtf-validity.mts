/**
 * trend3-mtf-validity.mts — Multi-timeframe adversarial validation of computeTrend3.
 *
 * Prior result (trend3-validity.mts): the 1-min trend label is COINCIDENT-WITH-BETA,
 * not predictive — in bull years 'down' had ~0/positive forward return (it tracked regime).
 *
 * Leader's hypothesis: TREND IS MULTI-TIMEFRAME. A 1-min trend is incomplete. Test whether
 * HIGHER timeframes and/or MULTI-TF ALIGNMENT give a genuine, beta-controlled directional edge.
 *
 * Data: backtest-multiyear.db bars_1m, NIY=F, 1-min bars 2018-2026 (~2.45M). TICK=5.
 *
 * Method (point-in-time, no look-ahead):
 *  - Resample 1-min -> TF close series for TF in {5,15,60,240 min, 1Day}.
 *      intraday TF: wall-clock buckets floor(t/TFms); a TF bar's close = last 1-min close in
 *        the bucket. A TF bar is COMPLETED when a later 1-min bar's bucket index differs
 *        (i.e. we've moved past its end) OR a >5min gap occurs (the bucket is force-closed).
 *        We do NOT bridge a >5min gap inside a TF bar (the bar ends early at the last pre-gap bar).
 *      1Day TF: one bar per session_date, close = last 1-min close of that session_date.
 *  - computeTrend3 on each TF's COMPLETED close series, maBars=20, band sweep {0,10,25 yen}.
 *      slope uses the SAME maBars per the leader's spec (self-consistent per TF), NOT hardcoded 20.
 *  - Each 1-min bar t inherits the label of the most-recent COMPLETED TF bar (close-time <= t).
 *  - Forward returns measured on the 1-min series, GAP-AWARE: the forward window must not
 *      cross a >5min gap (else skip — we don't measure across a session break).
 *
 * Horizons matched to TF. Per-year (2018..2026) + full span. Beta control + bear/bull down checks.
 * Alignment test across {15,60,240}. Net bracket sweep. Random-direction baseline.
 *
 * Run:  npx tsx scripts/trend3-mtf-validity.mts
 */
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const TICK = 5;
const SYMBOL = 'NIY=F';
const MAX_GAP_MS = 5 * 60_000; // >5min gap = session break / discontinuity
const MIN = 60_000;

type Trend = 'up' | 'down' | 'neutral';
type Label = Trend;
const LABELS: Label[] = ['up', 'down', 'neutral'];

// ---- faithful computeTrend3, per leader's per-TF spec (slope uses maBars, not hardcoded 20) ----
function computeTrend3(closes: number[], maBars: number, bandYen: number): Trend | null {
  if (closes.length < maBars) return null;
  const window = closes.slice(-maBars);
  const ma = window.reduce((a, c) => a + c, 0) / window.length;
  const last = window[window.length - 1]!;
  const band = bandYen;
  const priceDir: Trend = last > ma + band ? 'up' : last < ma - band ? 'down' : 'neutral';
  // slope: need maBars+1 closes; mean(last maBars) - mean(prior maBars shifted by 1)
  if (closes.length < maBars + 1) return priceDir;
  const mean = (arr: number[]): number => arr.reduce((a, x) => a + x, 0) / arr.length;
  const slope = mean(closes.slice(-maBars)) - mean(closes.slice(-(maBars + 1), -1));
  if (priceDir === 'up' && slope > 0) return 'up';
  if (priceDir === 'down' && slope < 0) return 'down';
  return 'neutral';
}

// ---- load 1-min bars ----
const db = new DatabaseSync(DB);
type Bar = { t: number; c: number; sd: string; ses: string };
const rows = db.prepare(
  `SELECT t, c, session_date AS sd, session AS ses FROM bars_1m WHERE symbol=? ORDER BY t ASC`
).all(SYMBOL) as Bar[];
console.error(`loaded ${rows.length} 1-min bars`);

const N = rows.length;
const T = new Float64Array(N);
const C = new Float64Array(N);
const YR = new Int16Array(N);
// gapNext[i] = true if gap from i to i+1 exceeds MAX_GAP_MS (forward window must not cross it)
const gapNext = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  T[i] = rows[i]!.t; C[i] = rows[i]!.c; YR[i] = Number(rows[i]!.sd.slice(0, 4));
}
for (let i = 0; i < N - 1; i++) gapNext[i] = (T[i + 1]! - T[i]! > MAX_GAP_MS || T[i + 1]! - T[i]! <= 0) ? 1 : 0;
gapNext[N - 1] = 1;

// ---- forward-return helper ----
// Two regimes:
//  (a) intraday horizons (< INTRADAY_MAX): the forward window must NOT cross a >5min gap. A gap aborts
//      (we don't measure across a session break for a short horizon). returns -1 if aborted.
//  (b) long horizons (>= INTRADAY_MAX, i.e. ~>=6h / 1-3 days): a strictly gap-confined window is
//      IMPOSSIBLE (every ~24h window crosses a session break), so we measure CALENDAR-forward:
//      take the first bar whose time >= target (binary search), allowing gaps. This is the only
//      defensible way to score daily/multi-day horizons (close-to-close across the calendar).
//      We cap how far past target we accept (must land within MAX_FWD_SLACK of target, else -1) so a
//      long holiday gap doesn't map a 1-day horizon onto a bar 4 days later.
const INTRADAY_MAX = 360;            // minutes; horizons >= this use calendar-forward
const MAX_FWD_SLACK = 24 * 60 * MIN; // accept a calendar-fwd landing within +24h of target

function fwdIdxIntraday(i: number, hMin: number): number {
  const target = T[i]! + hMin * MIN;
  let j = i;
  while (j < N - 1) {
    if (gapNext[j]) return -1;            // gap before reaching target -> abort
    j++;
    if (T[j]! >= target) return j;
  }
  return -1;
}
function fwdIdxCalendar(i: number, hMin: number): number {
  const target = T[i]! + hMin * MIN;
  // binary search for first index with T[j] >= target
  let lo = i + 1, hi = N - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (T[mid]! >= target) { ans = mid; hi = mid - 1; } else lo = mid + 1;
  }
  if (ans < 0) return -1;
  if (T[ans]! - target > MAX_FWD_SLACK) return -1; // landed too far past target (long holiday) -> skip
  return ans;
}
function fwdIdx(i: number, hMin: number): number {
  return hMin >= INTRADAY_MAX ? fwdIdxCalendar(i, hMin) : fwdIdxIntraday(i, hMin);
}

// ================== TF RESAMPLING ==================
// A completed TF bar: { closeTimeMs (end-of-bucket wall time when completed), close, yr }
// closeTimeMs is the timestamp of the LAST 1-min bar in the bucket (the moment its close is known).
// A 1-min bar at time t may use a TF bar only if that TF bar's closeTimeMs <= t (strict point-in-time;
// the bar that completes AT t is itself only usable from the NEXT 1-min bar — see assignment below).
type TFBar = { tEnd: number; close: number; yr: number };

function resampleIntraday(tfMin: number): TFBar[] {
  const tfMs = tfMin * MIN;
  const out: TFBar[] = [];
  let bucketIdx: number | null = null;
  let lastClose = 0, lastT = 0, lastYr = 0;
  const flush = () => { if (bucketIdx !== null) out.push({ tEnd: lastT, close: lastClose, yr: lastYr }); };
  for (let i = 0; i < N; i++) {
    const bi = Math.floor(T[i]! / tfMs);
    if (bucketIdx === null) { bucketIdx = bi; }
    else if (bi !== bucketIdx) { flush(); bucketIdx = bi; }
    // gap inside a bucket: force-close the bucket at the pre-gap bar, start fresh next
    lastClose = C[i]!; lastT = T[i]!; lastYr = YR[i]!;
    if (gapNext[i]) { flush(); bucketIdx = null; }
  }
  flush();
  return out;
}

function resampleDaily(): TFBar[] {
  const out: TFBar[] = [];
  let curSd: string | null = null;
  let lastClose = 0, lastT = 0, lastYr = 0;
  for (let i = 0; i < N; i++) {
    const sd = rows[i]!.sd;
    if (curSd === null) curSd = sd;
    else if (sd !== curSd) { out.push({ tEnd: lastT, close: lastClose, yr: lastYr }); curSd = sd; }
    lastClose = C[i]!; lastT = T[i]!; lastYr = YR[i]!;
  }
  if (curSd !== null) out.push({ tEnd: lastT, close: lastClose, yr: lastYr });
  return out;
}

// Build a per-1-min-bar label array for a given TF + config.
// labelAt[i] = label of the most-recent COMPLETED TF bar with tEnd < T[i] (strictly before -> no look-ahead).
function buildLabels(tfBars: TFBar[], maBars: number, bandYen: number): (Label | null)[] {
  // compute label for each TF bar from closes up to & including that bar (point-in-time for that TF series)
  const tfLabel: (Label | null)[] = new Array(tfBars.length).fill(null);
  const closes: number[] = [];
  // NOTE: we keep a single rolling close series across the WHOLE TF series. Higher-TF bars already
  // span session gaps; resetting per-gap on a daily series would wipe history. For intraday TFs a gap
  // force-closed a bar but the TF series is still a legitimate sequence of completed bars. We compute
  // the MA/slope over the contiguous TF-bar sequence (this is how a live MA on a TF chart behaves).
  for (let k = 0; k < tfBars.length; k++) {
    closes.push(tfBars[k]!.close);
    if (closes.length > maBars * 3) closes.shift();
    tfLabel[k] = computeTrend3(closes, maBars, bandYen);
  }
  // assign to 1-min bars: for bar i, find latest TF bar with tEnd < T[i]
  const out: (Label | null)[] = new Array(N).fill(null);
  let k = 0;
  for (let i = 0; i < N; i++) {
    while (k < tfBars.length && tfBars[k]!.tEnd < T[i]!) k++;
    // k is first TF bar with tEnd >= T[i]; the usable one is k-1
    out[i] = k > 0 ? tfLabel[k - 1]! : null;
  }
  return out;
}

// ================== ACCUMULATORS ==================
interface Acc { n: number; sum: number; pos: number; }
const mk = (): Acc => ({ n: 0, sum: 0, pos: 0 });
const add = (a: Acc, fwd: number) => { a.n++; a.sum += fwd; if (fwd > 0) a.pos++; };
const mean = (a: Acc) => a.n ? a.sum / a.n : NaN;
const hit = (a: Acc) => a.n ? a.pos / a.n : NaN;

const fmt = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'NaN';
const pct = (x: number) => Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : 'NaN';

const BEAR_YEARS = new Set([2018, 2020, 2022]);
const BULL_YEARS = new Set([2023, 2025]);

// ================== TF CONFIG ==================
type TFDef = { name: string; min: number | 'D'; horizons: number[]; bracket: { SL: number; TP: number; hold: number } };
const TFS: TFDef[] = [
  { name: '5min',   min: 5,    horizons: [15, 30],       bracket: { SL: 40 * TICK, TP: 60 * TICK, hold: 60 } },
  { name: '15min',  min: 15,   horizons: [30, 60],       bracket: { SL: 40 * TICK, TP: 60 * TICK, hold: 120 } },
  { name: '60min',  min: 60,   horizons: [120, 240],     bracket: { SL: 100 * TICK, TP: 200 * TICK, hold: 240 } },
  { name: '240min', min: 240,  horizons: [480, 1440],    bracket: { SL: 100 * TICK, TP: 200 * TICK, hold: 480 } },
  { name: '1Day',   min: 'D',  horizons: [1440, 2880, 4320], bracket: { SL: 200 * TICK, TP: 400 * TICK, hold: 1440 } },
];
const BANDS = [0, 10, 25]; // yen (0, 2 ticks, 5 ticks)

// ================== UNCONDITIONAL BASELINE (drift), per horizon, per year ==================
// computed once over the union of horizons used.
const ALL_H = [...new Set(TFS.flatMap(t => t.horizons))].sort((a, b) => a - b);
const baseFull = new Map<number, Acc>();      // h -> acc
const baseYear = new Map<number, Map<number, Acc>>(); // yr -> h -> acc
for (const h of ALL_H) { baseFull.set(h, mk()); }
for (let i = 0; i < N; i++) {
  const yr = YR[i]!;
  for (const h of ALL_H) {
    const j = fwdIdx(i, h);
    if (j < 0) continue;
    const fwd = C[j]! - C[i]!;
    add(baseFull.get(h)!, fwd);
    let ym = baseYear.get(yr); if (!ym) { ym = new Map<number, Acc>(); baseYear.set(yr, ym); }
    let a = ym.get(h); if (!a) { a = mk(); ym.set(h, a); }
    add(a, fwd);
  }
}
console.error('baseline computed');

// store label arrays for alignment + bracket re-use (band=10 canonical)
const labelStore = new Map<string, (Label | null)[]>(); // key=`${tf}` at band=10

// ================== PER-TF VALIDATION ==================
function reportTF(tf: TFDef) {
  const tfBars = tf.min === 'D' ? resampleDaily() : resampleIntraday(tf.min as number);
  console.log('\n' + '#'.repeat(110));
  console.log(`#### TIMEFRAME ${tf.name}   (TF bars=${tfBars.length}, horizons=${tf.horizons.join('/')}min)`);
  console.log('#'.repeat(110));

  for (const band of BANDS) {
    const labels = buildLabels(tfBars, 20, band);
    if (band === 10) labelStore.set(tf.name, labels);

    // full + per-year label-conditional, per horizon
    const full: Record<Label, Map<number, Acc>> = { up: new Map(), down: new Map(), neutral: new Map() };
    const yrAcc = new Map<number, Record<Label, Map<number, Acc>>>();
    for (const L of LABELS) for (const h of tf.horizons) full[L].set(h, mk());

    for (let i = 0; i < N; i++) {
      const lab = labels[i]; if (!lab) continue;
      const yr = YR[i]!;
      for (const h of tf.horizons) {
        const j = fwdIdx(i, h); if (j < 0) continue;
        const fwd = C[j]! - C[i]!;
        add(full[lab].get(h)!, fwd);
        let ya = yrAcc.get(yr); if (!ya) { ya = { up: new Map<number, Acc>(), down: new Map<number, Acc>(), neutral: new Map<number, Acc>() }; yrAcc.set(yr, ya); }
        let a = ya[lab].get(h); if (!a) { a = mk(); ya[lab].set(h, a); }
        add(a, fwd);
      }
    }

    const h0 = tf.horizons[0]!; // primary horizon for compact per-year table
    console.log(`\n--- ${tf.name}  band=${band}yen (${band / TICK}t)  [primary horizon ${h0}min] ---`);
    // full-span table
    console.log(`  FULL-SPAN  baseline(${h0}m) mean=${fmt(mean(baseFull.get(h0)!), 1)} hit=${pct(hit(baseFull.get(h0)!))} n=${baseFull.get(h0)!.n}`);
    console.log('  label   |     n    | ' + tf.horizons.map(h => `mean${h} hit${h}`).join(' | '));
    for (const L of LABELS) {
      const cells = tf.horizons.map(h => { const a = full[L].get(h)!; return `${fmt(mean(a), 1).padStart(7)} ${pct(hit(a)).padStart(6)}`; });
      console.log(`  ${L.padEnd(7)} | ${String(full[L].get(h0)!.n).padStart(8)} | ${cells.join(' | ')}`);
    }
    // beta-control full
    for (const h of tf.horizons) {
      const u = mean(full.up.get(h)!), d = mean(full.down.get(h)!), b = mean(baseFull.get(h)!);
      console.log(`    [${h}m] up-base=${fmt(u - b, 1)}  down-base=${fmt(d - b, 1)}  down<0? ${d < 0 ? 'YES' : 'NO'} (down=${fmt(d, 1)})  monotone? ${u > mean(full.neutral.get(h)!) && mean(full.neutral.get(h)!) > d ? 'YES' : 'NO'}`);
    }
    // per-year (primary horizon) — the decisive beta test
    console.log(`  PER-YEAR @${h0}m:  yr | base | up:n mean hit | down:n mean hit | regime-check`);
    const years = [...yrAcc.keys()].sort((a, b) => a - b);
    let bearDownOk = 0, bearDownTot = 0, bullDownNonPos = 0, bullDownTot = 0;
    for (const yr of years) {
      const ya = yrAcc.get(yr)!;
      const u = ya.up.get(h0) ?? mk(), d = ya.down.get(h0) ?? mk();
      const b = baseYear.get(yr)?.get(h0) ?? mk();
      const um = mean(u), dm = mean(d);
      let tag = '';
      if (BEAR_YEARS.has(yr)) { bearDownTot++; if (dm < 0) bearDownOk++; tag = dm < 0 ? 'BEAR ok(down<0)' : 'BEAR FAIL(down>=0)'; }
      else if (BULL_YEARS.has(yr)) { bullDownTot++; if (dm <= 0) bullDownNonPos++; tag = dm <= 0 ? 'BULL ok(down<=0)' : 'BULL FAIL(down>0=beta)'; }
      else tag = dm < 0 ? 'down<0' : 'down>=0';
      console.log(`    ${yr} | ${fmt(mean(b), 0).padStart(6)} | ${String(u.n).padStart(7)} ${fmt(um, 1).padStart(7)} ${pct(hit(u)).padStart(6)} | ${String(d.n).padStart(7)} ${fmt(dm, 1).padStart(7)} ${pct(hit(d)).padStart(6)} | ${tag}`);
    }
    console.log(`    >>> VERDICT band=${band}: bear-years down<0 ${bearDownOk}/${bearDownTot}; bull-years down<=0 ${bullDownNonPos}/${bullDownTot}  => ${(bearDownOk === bearDownTot && bullDownNonPos === bullDownTot && bearDownTot > 0) ? 'PASSES cross-regime short test' : 'FAILS (beta-tracking)'}`);
  }
}

for (const tf of TFS) reportTF(tf);

// ================== MULTI-TF ALIGNMENT ==================
// Use band=10 labels stored for 15/60/240. Aligned = all three same non-neutral. Horizon: match the
// SLOWEST aligned TF -> use 240min's primary horizon (480m ~ 1 day) and also 240m (~half day).
console.log('\n' + '='.repeat(110));
console.log('==== MULTI-TF ALIGNMENT (15min & 60min & 240min, band=10yen) ====');
console.log('='.repeat(110));
const l15 = labelStore.get('15min')!, l60 = labelStore.get('60min')!, l240 = labelStore.get('240min')!;
const ALIGN_H = [240, 480]; // ~half day / ~1 day forward

type AlignCat = 'all-up' | 'all-down' | 'mixed';
function alignCat(i: number): AlignCat | null {
  const a = l15[i], b = l60[i], c = l240[i];
  if (!a || !b || !c) return null;
  if (a === 'up' && b === 'up' && c === 'up') return 'all-up';
  if (a === 'down' && b === 'down' && c === 'down') return 'all-down';
  return 'mixed';
}
const CATS: AlignCat[] = ['all-up', 'all-down', 'mixed'];

const alFull: Record<AlignCat, Map<number, Acc>> = { 'all-up': new Map(), 'all-down': new Map(), 'mixed': new Map() };
const alYear = new Map<number, Record<AlignCat, Map<number, Acc>>>();
for (const c of CATS) for (const h of ALIGN_H) alFull[c].set(h, mk());
for (let i = 0; i < N; i++) {
  const cat = alignCat(i); if (!cat) continue;
  const yr = YR[i]!;
  for (const h of ALIGN_H) {
    const j = fwdIdx(i, h); if (j < 0) continue;
    const fwd = C[j]! - C[i]!;
    add(alFull[cat].get(h)!, fwd);
    let ya = alYear.get(yr); if (!ya) { ya = { 'all-up': new Map<number, Acc>(), 'all-down': new Map<number, Acc>(), 'mixed': new Map<number, Acc>() }; alYear.set(yr, ya); }
    let a = ya[cat].get(h); if (!a) { a = mk(); ya[cat].set(h, a); }
    add(a, fwd);
  }
}
console.log('\n[FULL-SPAN ALIGNMENT]  cat | n | ' + ALIGN_H.map(h => `mean${h} hit${h}`).join(' | '));
for (const c of CATS) {
  const cells = ALIGN_H.map(h => { const a = alFull[c].get(h)!; return `${fmt(mean(a), 1).padStart(7)} ${pct(hit(a)).padStart(6)}`; });
  console.log(`  ${c.padEnd(8)} | ${String(alFull[c].get(ALIGN_H[0]!)!.n).padStart(8)} | ${cells.join(' | ')}`);
}
for (const h of ALIGN_H) {
  const b = mean(baseFull.get(h) ?? mk());
  console.log(`    [${h}m] baseline=${fmt(b, 1)}  all-up-base=${fmt(mean(alFull['all-up'].get(h)!) - b, 1)}  all-down-base=${fmt(mean(alFull['all-down'].get(h)!) - b, 1)}  all-down<0? ${mean(alFull['all-down'].get(h)!) < 0 ? 'YES' : 'NO'}`);
}
console.log('\n[PER-YEAR ALIGNMENT @240m]  yr | base | all-up:n mean hit | all-down:n mean hit | mixed:mean | regime-check');
const ah = 240;
let bdOk = 0, bdTot = 0, budNonPos = 0, budTot = 0;
for (const yr of [...alYear.keys()].sort((a, b) => a - b)) {
  const ya = alYear.get(yr)!;
  const u = ya['all-up'].get(ah) ?? mk(), d = ya['all-down'].get(ah) ?? mk(), m = ya['mixed'].get(ah) ?? mk();
  const b = baseYear.get(yr)?.get(ah) ?? mk();
  const dm = mean(d);
  let tag = '';
  if (BEAR_YEARS.has(yr)) { bdTot++; if (dm < 0) bdOk++; tag = dm < 0 ? 'BEAR ok' : 'BEAR FAIL'; }
  else if (BULL_YEARS.has(yr)) { budTot++; if (dm <= 0) budNonPos++; tag = dm <= 0 ? 'BULL ok(down<=0)' : 'BULL FAIL(down>0=beta)'; }
  else tag = dm < 0 ? 'down<0' : 'down>=0';
  console.log(`    ${yr} | ${fmt(mean(b), 0).padStart(6)} | ${String(u.n).padStart(7)} ${fmt(mean(u), 1).padStart(7)} ${pct(hit(u)).padStart(6)} | ${String(d.n).padStart(7)} ${fmt(dm, 1).padStart(7)} ${pct(hit(d)).padStart(6)} | ${fmt(mean(m), 1).padStart(7)} | ${tag}`);
}
console.log(`    >>> ALIGNMENT VERDICT @${ah}m: bear all-down<0 ${bdOk}/${bdTot}; bull all-down<=0 ${budNonPos}/${budTot} => ${(bdOk === bdTot && budNonPos === budTot && bdTot > 0) ? 'PASSES cross-regime short test' : 'FAILS (beta-tracking)'}`);

// ================== NET BRACKET (trade-relevant) ==================
// Long when signal=up/all-up, short when down/all-down, skip otherwise. SL/TP per TF. 1-tick slip+10yen.
// Entry at the NEXT 1-min bar close after signal; exit on first 1-min close to breach SL/TP (close-path),
// or after `hold` minutes (mark-to-market), or at a >5min gap (force flat at last pre-gap close).
// Random-direction baseline uses identical entry cadence, random dir. Deterministic PRNG.
const COST = 1 * TICK + 10;
function bracket(sigArr: (i: number) => 1 | -1 | 0, SL: number, TP: number, hold: number, randomize: boolean) {
  let seed = 987654321;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const yr_tt = new Map<number, { tt: number; w: number; gp: number; gl: number; net: number }>();
  let tt = 0, w = 0, gp = 0, gl = 0, eq = 0, peak = 0, mdd = 0;
  let i = 0;
  while (i < N - 1) {
    if (gapNext[i]) { i++; continue; }
    let sig = sigArr(i);
    if (sig === 0) { i++; continue; }
    if (randomize) sig = rnd() < 0.5 ? 1 : -1;
    const entryIdx = i + 1;
    const entry = C[entryIdx]!;
    const dir = sig;
    const tEntry = T[entryIdx]!;
    let pnl = 0, exitIdx = entryIdx;
    let j = entryIdx;
    while (j < N - 1) {
      if (gapNext[j]) { exitIdx = j; pnl = (C[j]! - entry) * dir; break; } // force flat at gap
      j++;
      const move = (C[j]! - entry) * dir;
      if (move <= -SL) { exitIdx = j; pnl = -SL; break; }
      if (move >= TP) { exitIdx = j; pnl = TP; break; }
      if (T[j]! - tEntry >= hold * MIN) { exitIdx = j; pnl = (C[j]! - entry) * dir; break; }
      if (j === N - 1) { exitIdx = j; pnl = (C[j]! - entry) * dir; break; }
    }
    pnl -= COST;
    tt++; if (pnl > 0) { w++; gp += pnl; } else gl += -pnl;
    eq += pnl; if (eq > peak) peak = eq; if (peak - eq > mdd) mdd = peak - eq;
    const yr = YR[entryIdx]!;
    let y = yr_tt.get(yr); if (!y) { y = { tt: 0, w: 0, gp: 0, gl: 0, net: 0 }; yr_tt.set(yr, y); }
    y.tt++; if (pnl > 0) { y.w++; y.gp += pnl; } else y.gl += -pnl; y.net += pnl;
    i = exitIdx; // resume after exit
  }
  const pf = gl > 0 ? gp / gl : Infinity;
  return { tt, w, gp, gl, net: eq, mdd, pf, yr_tt };
}

console.log('\n' + '='.repeat(110));
console.log('==== NET BRACKET (with-trend vs random-dir, 1-tick slip +10yen/trade) ====');
console.log('='.repeat(110));

function reportBracket(name: string, sig: (i: number) => 1 | -1 | 0, SL: number, TP: number, hold: number) {
  const wt = bracket(sig, SL, TP, hold, false);
  const rd = bracket(sig, SL, TP, hold, true);
  console.log(`\n[${name}]  SL=${SL / TICK}t TP=${TP / TICK}t hold=${hold}m`);
  console.log(`  WITH-TREND: trades=${wt.tt} win%=${pct(wt.tt ? wt.w / wt.tt : NaN)} PF=${fmt(wt.pf, 2)} net=${fmt(wt.net, 0)} maxDD=${fmt(wt.mdd, 0)}`);
  console.log(`  RANDOM-DIR: trades=${rd.tt} win%=${pct(rd.tt ? rd.w / rd.tt : NaN)} PF=${fmt(rd.pf, 2)} net=${fmt(rd.net, 0)} maxDD=${fmt(rd.mdd, 0)}`);
  console.log('  per-year WITH-TREND (yr: trades win% PF net) | RANDOM (PF net):');
  for (const yr of [...wt.yr_tt.keys()].sort((a, b) => a - b)) {
    const y = wt.yr_tt.get(yr)!; const r = rd.yr_tt.get(yr);
    const pf = y.gl > 0 ? y.gp / y.gl : Infinity;
    const rpf = r && r.gl > 0 ? r.gp / r.gl : (r ? Infinity : NaN);
    console.log(`    ${yr}: ${String(y.tt).padStart(5)} ${pct(y.tt ? y.w / y.tt : NaN).padStart(6)} ${fmt(pf, 2).padStart(5)} ${fmt(y.net, 0).padStart(9)} | ${fmt(rpf, 2).padStart(5)} ${r ? fmt(r.net, 0).padStart(9) : '   -'}`);
  }
}

// per-TF brackets
for (const tf of TFS) {
  const labels = labelStore.get(tf.name)!;
  const sig = (i: number): 1 | -1 | 0 => { const l = labels[i]; return l === 'up' ? 1 : l === 'down' ? -1 : 0; };
  reportBracket(`TF ${tf.name} with-trend`, sig, tf.bracket.SL, tf.bracket.TP, tf.bracket.hold);
}
// alignment bracket (wide SL/TP, ~1 day hold)
const sigAlign = (i: number): 1 | -1 | 0 => { const c = alignCat(i); return c === 'all-up' ? 1 : c === 'all-down' ? -1 : 0; };
reportBracket('ALIGNMENT all-up/all-down (15&60&240)', sigAlign, 100 * TICK, 200 * TICK, 480);
reportBracket('ALIGNMENT all-up/all-down WIDE', sigAlign, 200 * TICK, 400 * TICK, 1440);

console.error('done');
