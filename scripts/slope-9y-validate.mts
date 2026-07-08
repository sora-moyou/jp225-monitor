// 9-year point-in-time validation of monitor detectors: slope (primary), trend + dtb (secondary).
//
// CAVEAT (reconstruction fidelity): the LIVE `slope` detector (server/tickDetector.ts) fires on raw
// TICK moves of >= flashYen(=80円) over a 5s/10s window. The 9-year DB has only 1-min BARS, so a
// faithful tick replication is impossible. We reconstruct the closest bar-resolution PROXY:
//   slope = a single completed 1-min bar whose |move| >= 80円 (intrabar high-low OR close-to-close).
// This is labelled a PROXY throughout; a fidelity check vs recorded slope alerts is printed.
//
// `trend` (live: Granville reversal + raw 25MA cross with 0.08% deviation gate) and the swing
// `double`/dtb (live: detectSwingDouble over confirmed swing pivots) are reconstructed faithfully
// from bar logic. Point-in-time: every detector sees ONLY bars at index <= i.

import { DatabaseSync } from 'node:sqlite';
import { detectGranvilleReversal, detectMaCross, DEFAULT_GRANVILLE } from '../server/granville.js';
import { extractSwingPivots, type SwingBar } from '../server/swingPivots.js';
import { detectSwingDouble, DEFAULT_SWING_DOUBLE } from '../server/swingDouble.js';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const SYM = 'NIY=F';
const FLASH_YEN = 80;          // resolveFlashYen default
const L2_MIN_DEV_PCT = 0.08;   // alertEngine deviation gate for trend
const MA_MID = 25;             // resolveGranvilleMaMid default
const GAP_MS = 5 * 60_000;     // bars more than 5min apart => session break; don't measure across it
const TICK = 5;                // NIY=F tick size (円)
const COST_YEN = 10;           // round-trip cost
const SLIP_TICKS = 1;          // 1-tick slippage each side

type Bar = { t: number; o: number; h: number; l: number; c: number };
type Ev = { t: number; i: number; kind: string; dir: 'up' | 'down'; price: number };

function loadBars(): Bar[] {
  const db = new DatabaseSync(DB);
  const rows = db.prepare(
    "SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t").all(SYM) as any[];
  db.close();
  return rows.map(r => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c }));
}

// ----- detectors (point-in-time; each sees bars[0..i]) -----

// SLOPE PROXY: bar i is a slope event if its own |move| >= FLASH_YEN.
// Use max(|c-o|, h-l-direction-consistent). We take close-vs-open of the single bar as the signed
// move, plus require the bar's high-low range >= threshold so a slow drift across the minute that
// nets <80 but whipsaws isn't counted. Direction = sign(c-o).
function slopeEvent(b: Bar, i: number): Ev | null {
  const move = b.c - b.o;
  const range = b.h - b.l;
  if (Math.abs(move) >= FLASH_YEN || range >= FLASH_YEN) {
    // direction: prefer signed close-open; if flat close but big range, skip (ambiguous)
    if (Math.abs(move) < TICK) return null;
    return { t: b.t, i, kind: 'slope', dir: move >= 0 ? 'up' : 'down', price: b.c };
  }
  return null;
}

// TREND: Granville reversal OR raw 25MA cross, both gated by |deviation| >= 0.08%.
// Edge-dedup: only fire on the rising edge (note/key absent last bar), like alertEngine.
function makeTrendScanner() {
  let lastNote = '';
  let lastMaKey = '';
  return (closes: number[], i: number, t: number, price: number): Ev | null => {
    const rev = detectGranvilleReversal(closes, DEFAULT_GRANVILLE);
    let fired: Ev | null = null;
    let note = '';
    if (rev && Math.abs(rev.deviation) >= L2_MIN_DEV_PCT) {
      note = `gv-${rev.dir}`;
      if (note !== lastNote) fired = { t, i, kind: 'trend', dir: rev.dir, price };
    }
    lastNote = note;
    // raw MA cross only if granville didn't already fire same dir
    const mc = detectMaCross(closes, MA_MID);
    let maKey = '';
    if (mc && Math.abs(mc.deviation) >= L2_MIN_DEV_PCT && !(rev && rev.dir === mc.dir)) {
      maKey = `ma-${mc.dir}`;
      if (!fired && maKey !== lastMaKey) fired = { t, i, kind: 'trend', dir: mc.dir, price };
    }
    lastMaKey = maKey;
    return fired;
  };
}

// ----- main scan -----
function scan(bars: Bar[]): Ev[] {
  const evs: Ev[] = [];
  const closes: number[] = [];
  const trendScan = makeTrendScanner();

  // swing-double recompute every 60 bars (live: every 60s, ~1 bar). We run it every bar but with
  // per-neck cooldown handled via stage/neck dedup to mimic emission frequency loosely. For the
  // edge measurement we want DISTINCT setups, so dedup identical (kind,neck,stage) until it changes.
  let lastDoubleKey = '';
  const SWING_LOOKBACK_BARS = 4 * 24 * 60; // 4 days of minute bars (lookback for pivots)
  const RECLAIM_PCT = 0.008;

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    closes.push(b.c);

    // gap guard for detectors that span history: if previous bar gap > GAP_MS we keep history but
    // detectors using a window naturally tolerate it. (forward measurement handles gaps separately.)

    // SLOPE proxy
    const sp = slopeEvent(b, i);
    if (sp) evs.push(sp);

    // TREND (needs warmup: maPeriod + 2*slopeBack + 1 = 25+30+1=56)
    if (closes.length >= 56) {
      const te = trendScan(closes, i, b.t, b.c);
      if (te) evs.push(te);
    }

    // DTB / swing double — only recompute occasionally to limit cost (every 5 bars) using last
    // SWING_LOOKBACK_BARS bars for pivots.
    if (i % 5 === 0 && i >= 200) {
      const lo = Math.max(0, i - SWING_LOOKBACK_BARS);
      const sb: SwingBar[] = [];
      for (let j = lo; j <= i; j++) sb.push({ t: bars[j]!.t, h: bars[j]!.h, l: bars[j]!.l });
      const reclaimYen = b.c * RECLAIM_PCT;
      const piv = extractSwingPivots(sb, reclaimYen);
      const sd = detectSwingDouble(piv, b.c, DEFAULT_SWING_DOUBLE);
      if (sd) {
        const dir: 'up' | 'down' = sd.kind === 'bottom' ? 'up' : 'down';
        const key = `${sd.kind}-${Math.round(sd.neck / 5) * 5}-${sd.stage}`;
        if (key !== lastDoubleKey) {
          evs.push({ t: b.t, i, kind: 'dtb', dir, price: b.c });
          lastDoubleKey = key;
        }
      } else {
        lastDoubleKey = '';
      }
    }
  }
  return evs;
}

// ----- forward / bracket measurement (gap-aware, point-in-time) -----
type Fwd = { r5: number; r15: number; r30: number; r60: number; mfe: number; mae: number; valid: boolean };

function forwardReturn(bars: Bar[], i: number, dir: 'up' | 'down'): Fwd {
  const sign = dir === 'up' ? 1 : -1;
  const ent = bars[i]!.c;
  const at = (h: number): number => {
    const j = i + h;
    if (j >= bars.length) return NaN;
    // gap guard: ensure contiguous (no session break) between i and j
    for (let k = i + 1; k <= j; k++) if (bars[k]!.t - bars[k - 1]!.t > GAP_MS) return NaN;
    return sign * (bars[j]!.c - ent);
  };
  // MFE/MAE over 60-bar horizon (contiguous)
  let mfe = 0, mae = 0;
  for (let k = i + 1; k <= i + 60 && k < bars.length; k++) {
    if (bars[k]!.t - bars[k - 1]!.t > GAP_MS) break;
    const fav = sign * (bars[k]!.h - ent), adv = sign * (bars[k]!.l - ent);
    if (dir === 'down') { // for short, favorable = price down: low gives MFE, high gives MAE
      const f2 = sign * (bars[k]!.l - ent), a2 = sign * (bars[k]!.h - ent);
      mfe = Math.max(mfe, f2); mae = Math.min(mae, a2); continue;
    }
    mfe = Math.max(mfe, fav); mae = Math.min(mae, adv);
  }
  return { r5: at(5), r15: at(15), r30: at(30), r60: at(60), mfe, mae, valid: true };
}

// bracket: enter at close[i] in `dir`, SL/TP in yen, max-hold bars, 1-tick slippage + cost.
function bracket(bars: Bar[], i: number, dir: 'up' | 'down', sl: number, tp: number, maxHold: number): number | null {
  const sign = dir === 'up' ? 1 : -1;
  const ent = bars[i]!.c + sign * SLIP_TICKS * TICK; // adverse slippage on entry
  for (let k = i + 1; k <= i + maxHold && k < bars.length; k++) {
    if (bars[k]!.t - bars[k - 1]!.t > GAP_MS) {
      // close at last contiguous bar's close
      const exit = bars[k - 1]!.c;
      return sign * (exit - ent) - COST_YEN;
    }
    const fav = sign * (bars[k]!.h - ent), adv = sign * (bars[k]!.l - ent);
    // pessimistic: if both SL and TP hit in same bar, assume SL first
    const hiFav = dir === 'up' ? sign * (bars[k]!.h - ent) : sign * (bars[k]!.l - ent);
    const loAdv = dir === 'up' ? sign * (bars[k]!.l - ent) : sign * (bars[k]!.h - ent);
    if (loAdv <= -sl) return -sl - SLIP_TICKS * TICK - COST_YEN;
    if (hiFav >= tp) return tp - SLIP_TICKS * TICK - COST_YEN;
  }
  // time exit at close
  const j = Math.min(i + maxHold, bars.length - 1);
  let jj = j;
  for (let k = i + 1; k <= j; k++) if (bars[k]!.t - bars[k - 1]!.t > GAP_MS) { jj = k - 1; break; }
  return sign * (bars[jj]!.c - ent) - COST_YEN;
}

// ----- stats helpers -----
function stats(xs: number[]) {
  const v = xs.filter(x => Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: 0, med: 0, hit: 0 };
  const s = [...v].sort((a, b) => a - b);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const med = s[Math.floor(s.length / 2)]!;
  const hit = v.filter(x => x > 0).length / v.length;
  return { n: v.length, mean, med, hit };
}
function pf(pnls: number[]) {
  let gp = 0, gl = 0, tot = 0, wins = 0, peak = 0, dd = 0, cum = 0;
  for (const p of pnls) { if (p > 0) { gp += p; wins++; } else gl -= p; tot += p; cum += p; peak = Math.max(peak, cum); dd = Math.min(dd, cum - peak); }
  return { n: pnls.length, pf: gl > 0 ? gp / gl : Infinity, tot, win: pnls.length ? wins / pnls.length : 0, dd };
}

function yearOf(t: number): number { return new Date(t).getUTCFullYear(); }

// ----- run -----
const bars = loadBars();
console.error(`loaded ${bars.length} bars ${new Date(bars[0]!.t).toISOString().slice(0,10)}..${new Date(bars[bars.length-1]!.t).toISOString().slice(0,10)}`);
const evs = scan(bars);
console.error(`events: ${evs.length}`);

// ===== Instruction 1 fidelity: compare reconstructed slope vs recorded slope alerts (06-02..06-10) =====
{
  const recDb = new DatabaseSync(`${process.env.APPDATA}/jp225-monitor/jp225.db`);
  const wStart = Date.parse('2026-06-02T00:00:00Z'), wEnd = Date.parse('2026-06-11T00:00:00Z');
  for (const kind of ['slope', 'trend', 'dtb']) {
    const rec = recDb.prepare("SELECT triggered_at, direction FROM alerts WHERE symbol='NIY=F' AND detection_kind=? AND triggered_at>=? AND triggered_at<? ORDER BY triggered_at").all(kind, wStart, wEnd) as any[];
    const mine = evs.filter(e => e.kind === kind && e.t >= wStart && e.t < wEnd);
    const recUp = rec.filter(r => r.direction === 'up').length;
    const myUp = mine.filter(e => e.dir === 'up').length;
    // timing overlap: my event within +/-3min of a recorded one, same dir
    const recTs = rec.map(r => ({ t: r.triggered_at, d: r.direction }));
    let matched = 0;
    for (const e of mine) {
      if (recTs.some(r => r.d === e.dir && Math.abs(r.t - e.t) <= 180_000)) matched++;
    }
    console.log(`[FIDELITY ${kind}] recorded n=${rec.length}(up=${recUp}) reconstructed n=${mine.length}(up=${myUp}) my-events-within-3min-of-a-recorded=${matched} (${mine.length?(100*matched/mine.length).toFixed(0):0}%)`);
  }
  recDb.close();
}

// ===== Instruction 2: per-kind, per-year forward edge + bracket + baseline =====
const HZ: (keyof Fwd)[] = ['r5', 'r15', 'r30', 'r60'];

function report(kind: string, fade = false) {
  const tag = fade ? `${kind} [FADE]` : kind;
  const evK = evs.filter(e => e.kind === kind).map(e => {
    const dir: 'up' | 'down' = fade ? (e.dir === 'up' ? 'down' : 'up') : e.dir;
    return { ...e, mdir: dir };
  });
  console.log(`\n========== ${tag} (n=${evK.length}) ==========`);

  // overall + per-year forward table
  const years = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
  console.log('year   n   |  r15 mean  med   hit  | r60 mean  hit |  long_n short_n  | r60_long r60_short');
  for (const yr of ['ALL', ...years]) {
    const sub = evK.filter(e => yr === 'ALL' || yearOf(e.t) === yr);
    if (sub.length === 0) { continue; }
    const f = sub.map(e => forwardReturn(bars, e.i, e.mdir));
    const r15 = stats(f.map(x => x.r15)), r60 = stats(f.map(x => x.r60));
    const longs = sub.filter(e => e.mdir === 'up'), shorts = sub.filter(e => e.mdir === 'down');
    const r60L = stats(longs.map(e => forwardReturn(bars, e.i, 'up').r60));
    const r60S = stats(shorts.map(e => forwardReturn(bars, e.i, 'down').r60));
    console.log(
      `${String(yr).padEnd(5)} ${String(sub.length).padStart(4)} | ${r15.mean.toFixed(1).padStart(8)} ${r15.med.toFixed(0).padStart(5)} ${(r15.hit*100).toFixed(0).padStart(4)}% | ${r60.mean.toFixed(1).padStart(7)} ${(r60.hit*100).toFixed(0).padStart(3)}% | ${String(longs.length).padStart(6)} ${String(shorts.length).padStart(6)} | ${r60L.mean.toFixed(1).padStart(7)} ${r60S.mean.toFixed(1).padStart(8)}`);
  }

  // bracket P&L (two configs) overall + long/short split
  for (const [sl, tp] of [[40, 60], [60, 120]] as [number, number][]) {
    const all = evK.map(e => bracket(bars, e.i, e.mdir, sl, tp, 120)).filter((x): x is number => x !== null);
    const L = evK.filter(e => e.mdir === 'up').map(e => bracket(bars, e.i, 'up', sl, tp, 120)).filter((x): x is number => x !== null);
    const S = evK.filter(e => e.mdir === 'down').map(e => bracket(bars, e.i, 'down', sl, tp, 120)).filter((x): x is number => x !== null);
    const a = pf(all), l = pf(L), s = pf(S);
    console.log(`  BRACKET SL${sl}/TP${tp}: ALL pf=${a.pf.toFixed(2)} tot=${a.tot.toFixed(0)} win=${(a.win*100).toFixed(0)}% dd=${a.dd.toFixed(0)} | LONG pf=${l.pf.toFixed(2)} tot=${l.tot.toFixed(0)} n=${l.n} | SHORT pf=${s.pf.toFixed(2)} tot=${s.tot.toFixed(0)} n=${s.n}`);
  }

  // BASELINE: random entries, same count, same up/down ratio
  const upRatio = evK.filter(e => e.mdir === 'up').length / Math.max(1, evK.length);
  const N = evK.length;
  let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const baseEv: { i: number; mdir: 'up' | 'down' }[] = [];
  for (let k = 0; k < N; k++) {
    const i = 100 + Math.floor(rnd() * (bars.length - 200));
    baseEv.push({ i, mdir: rnd() < upRatio ? 'up' : 'down' });
  }
  const bf = baseEv.map(e => forwardReturn(bars, e.i, e.mdir));
  const br15 = stats(bf.map(x => x.r15)), br60 = stats(bf.map(x => x.r60));
  const bb = pf(baseEv.map(e => bracket(bars, e.i, e.mdir, 40, 60, 120)).filter((x): x is number => x !== null));
  console.log(`  BASELINE(random,same-ratio): r15 mean=${br15.mean.toFixed(1)} hit=${(br15.hit*100).toFixed(0)}% | r60 mean=${br60.mean.toFixed(1)} hit=${(br60.hit*100).toFixed(0)}% | bracket SL40/TP60 pf=${bb.pf.toFixed(2)} tot=${bb.tot.toFixed(0)} win=${(bb.win*100).toFixed(0)}%`);
}

// buy&hold benchmark per year (60-bar fwd from random longs = ~beta drift)
console.log('\n===== BUY&HOLD per year (NIY=F close YoY, 円) =====');
for (const yr of [2018,2019,2020,2021,2022,2023,2024,2025,2026]) {
  const yb = bars.filter(b => yearOf(b.t) === yr);
  if (yb.length < 2) continue;
  console.log(`  ${yr}: ${yb[0]!.c} -> ${yb[yb.length-1]!.c}  (${(yb[yb.length-1]!.c - yb[0]!.c >=0?'+':'')}${(yb[yb.length-1]!.c - yb[0]!.c).toFixed(0)}円)`);
}

report('slope');
report('trend');
report('trend', true);
report('dtb');
report('dtb', true);

// ===== extra: recorded-side fidelity (what fraction of RECORDED alerts have a nearby reconstructed event) =====
{
  const recDb = new DatabaseSync(`${process.env.APPDATA}/jp225-monitor/jp225.db`);
  const wStart = Date.parse('2026-06-02T00:00:00Z'), wEnd = Date.parse('2026-06-11T00:00:00Z');
  for (const kind of ['slope', 'trend', 'dtb']) {
    const rec = recDb.prepare("SELECT triggered_at, direction, window_seconds FROM alerts WHERE symbol='NIY=F' AND detection_kind=? AND triggered_at>=? AND triggered_at<? ORDER BY triggered_at").all(kind, wStart, wEnd) as any[];
    const mine = evs.filter(e => e.kind === kind && e.t >= wStart && e.t < wEnd);
    let cov = 0;
    for (const r of rec) if (mine.some(e => e.dir === r.direction && Math.abs(e.t - r.t) <= 180_000)) cov++;
    console.log(`[RECALL ${kind}] of ${rec.length} recorded, ${cov} (${rec.length?(100*cov/rec.length).toFixed(0):0}%) have a reconstructed same-dir event within 3min`);
    if (kind === 'slope') {
      // split recall by recorded window_seconds (5/10s tick vs 60s)
      for (const w of [5,10,60]) {
        const rw = rec.filter(r=>r.window_seconds===w);
        let c=0; for (const r of rw) if (mine.some(e=>e.dir===r.direction && Math.abs(e.t-r.t)<=180_000)) c++;
        console.log(`   slope win=${w}s: ${c}/${rw.length} recalled`);
      }
    }
  }
  recDb.close();
}
