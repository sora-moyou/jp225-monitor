/**
 * GEM_Smart_Strategy_02_sbi — TypeScript port for multi-regime validation.
 *
 * Source Pine v6: C:\Users\user\Downloads\GEM_Smart_Strategy_02_sbi.txt (2313 lines)
 * Reference CSV : GEM_JP225_Strategy_B3_api_Day_OSE_NK225M1!_2026-06-15_823a3.csv
 * Data          : C:\Users\user\Desktop\backtest-multiyear.db  bars_1m  symbol='NIY=F'
 *                 (LABEL only — actually OSE NK225 mini 1-min bars; same instrument as CSV)
 *
 * Instrument: OSE NK225 mini.  mintick = 5 (index points).  ¥100 per index point. qty=1.
 *
 * ------------------------------------------------------------------------------------------
 * NO-LOOK-AHEAD GUARANTEE (see report):
 *  - Chart TF = 30min (the TF the user ran). 30m bars are aggregated from 1m, aligned to the
 *    JST sessions stored in the DB (Day 0845-1545, Night 1700-0600).
 *  - The 30m entry DECISION at bar i is made using only bars whose close <= bar i's close.
 *    Specifically: the rolling-3 5-min window ENDING at the 30m bar close (= last 15 min of
 *    that 30m bar), plus indicators (ADX/HTF/RSI) computed on series up to that close.
 *  - HTF (60m SMA25, daily pivots, etc.) replicate Pine's `[1]` + lookahead_on idiom = the
 *    PREVIOUS COMPLETED HTF bar's value, which is non-repainting. We always use the last
 *    *fully closed* HTF bar strictly before the current 30m bar's close window.
 *  - Exits/trailing then evaluated bar-by-bar on subsequent 1-min bars (bar magnifier), never
 *    using future data within a bar (high/low of the bar are touch-tested, fills at the level).
 * ------------------------------------------------------------------------------------------
 */

import { DatabaseSync } from "node:sqlite";

const DB_PATH = "C:/Users/user/Desktop/backtest-multiyear.db";
const SYMBOL = "NIY=F";
const MINTICK = 5; // index points per tick (NK225 mini)
const YEN_PER_POINT = 100; // 1 mini contract
const LOOKBACK_SESSIONS = 50;
const GAP_FILL_MIN = 100;
const GAP_FILL_MAX = 250;

// ======================= PARAMS (Pine input() DEFAULTS = the user's optimized values) =======================
const P = {
  sl_tp_mode: "Auto (Risk Based)",
  fc_type: "15:30/05:45",
  use_be: true,
  be_trigger: 50, // ticks
  be_offset: 0,
  session_loss_limit: 25000, // JPY
  ts_mode: "Auto",
  auto_opt_days: 4,
  bound_break_force: 5, // ticks
  entry_prox_ticks: 2,
  max_bound_gap_ticks: 0,
  use_rolling_15m: true,
  rolling_bar_count: 3,
  // Long
  auto_sl_l: 1.0,
  auto_tp_ratio_l: 3.0,
  sl_ticks_l: 200,
  tp_ticks_l: 0,
  ts_trig_l: 100,
  ts_dist_l: 50,
  // Short
  auto_sl_s: 1.0,
  auto_tp_ratio_s: 3.5,
  sl_ticks_s: 200,
  tp_ticks_s: 0,
  ts_trig_s: 100,
  ts_dist_s: 50,
  // Breakout
  use_breakout_logic: true,
  use_level_cross: true,
  use_center_cross: true,
  adx_thresh_buy: 17,
  adx_thresh_sell: 23,
  use_adx_slope: true,
  use_adx_filter: true,
  use_htf_filter: true,
  htf_period: "60",
  htf_ma_len: 25,
  use_brk_struct_sl: true,
  brk_struct_offset: 20, // ticks
  // Reversal
  use_reversal_logic: true,
  rev_exit_target: "Opposite Bound",
  rev_target_offset: 5,
  rev_tp_ticks: 100,
  use_rev_sl_bound: true,
  rev_sl_offset: 0,
  rev_sl_ticks: 50,
  rev_ts_trigger: 50,
  rev_ts_dist: 30,
  rev_match_breakout_mode: "Promote to Breakout",
  use_rev_adx_filter: true,
  rev_adx_max: 40,
  use_rev_rsi_filter: true,
  rsi_len: 14,
  rsi_ob: 65,
  rsi_os: 35,
  use_rev_htf_filter: true,
  use_1h_pinbar: false,
  pin_bar_ratio: 3.0,
  pin_bar_min_ticks: 25,
  // Manual fibs (used inside key zones)
  u_fib_h: 56505,
  u_fib_l: 52965,
};

// ======================= TYPES =======================
type Bar = { t: number; o: number; h: number; l: number; c: number; v: number; session: string; sdate: string };

// ======================= DB LOAD =======================
function loadBars(fromMs: number | null, toMs: number | null): Bar[] {
  const db = new DatabaseSync(DB_PATH);
  let q = `SELECT t,o,h,l,c,volume,session,session_date FROM bars_1m WHERE symbol=?`;
  const args: any[] = [SYMBOL];
  if (fromMs != null) { q += ` AND t>=?`; args.push(fromMs); }
  if (toMs != null) { q += ` AND t<?`; args.push(toMs); }
  q += ` ORDER BY t`;
  const rows = db.prepare(q).all(...args) as any[];
  db.close();
  return rows.map((r) => ({
    t: Number(r.t), o: r.o, h: r.h, l: r.l, c: r.c, v: r.volume,
    session: r.session, sdate: r.session_date,
  }));
}

// ======================= TIME HELPERS (JST) =======================
function jstParts(tMs: number) {
  const d = new Date(tMs + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}

// ======================= LEVEL CLUSTERING (faithful port) =======================
function f_find_best_cluster(key_zones: number[], hist_vals: number[], min_p: number, max_p: number): number {
  let best_level = NaN;
  let max_score = -1;
  const kz_size = key_zones.length;
  if (kz_size > 0) {
    for (let i = 0; i < kz_size; i++) {
      const p = key_zones[i];
      if (!isNaN(p) && p >= min_p && p <= max_p) {
        let current_score = 0;
        for (let k = 0; k < kz_size; k++) {
          const check = key_zones[k];
          if (!isNaN(check) && Math.abs(check - p) <= 20) current_score++;
        }
        const h_size = hist_vals.length;
        if (h_size > 0) {
          for (let h = 0; h < h_size; h++) {
            const check_h = hist_vals[h];
            if (!isNaN(check_h) && Math.abs(check_h - p) <= 20) current_score++;
          }
        }
        if (current_score > max_score) { max_score = current_score; best_level = p; }
      }
    }
  }
  const h_size = hist_vals.length;
  if (h_size > 0) {
    for (let i = 0; i < h_size; i++) {
      const p = hist_vals[i];
      if (!isNaN(p) && p >= min_p && p <= max_p) {
        let current_score = 0;
        if (kz_size > 0) {
          for (let k = 0; k < kz_size; k++) {
            const check = key_zones[k];
            if (!isNaN(check) && Math.abs(check - p) <= 20) current_score++;
          }
        }
        for (let h = 0; h < h_size; h++) {
          const check_h = hist_vals[h];
          if (!isNaN(check_h) && Math.abs(check_h - p) <= 20) current_score++;
        }
        if (current_score > max_score) { max_score = current_score; best_level = p; }
      }
    }
  }
  return best_level;
}

function f_find_res_sup(
  ref_price: number, key_zones: number[], sess_h: number, sess_l: number,
  hist_highs: number[], hist_lows: number[]
): [number, number, number, number, number, number] {
  let res1 = NaN, res2 = NaN, res3 = NaN, sup1 = NaN, sup2 = NaN, sup3 = NaN;

  const s_l_abv = !isNaN(sess_l) && sess_l > ref_price ? sess_l : NaN;
  const s_h_abv = !isNaN(sess_h) && sess_h > ref_price ? sess_h : NaN;
  let c1 = NaN, c2 = NaN;
  if (!isNaN(s_l_abv) && !isNaN(s_h_abv)) {
    if (s_l_abv < s_h_abv) { c1 = s_l_abv; c2 = s_h_abv; } else { c1 = s_h_abv; c2 = s_l_abv; }
  } else if (!isNaN(s_l_abv)) c1 = s_l_abv;
  else if (!isNaN(s_h_abv)) c1 = s_h_abv;

  if (!isNaN(c1)) {
    const d = c1 - ref_price;
    if (d < 400) res1 = c1; else if (d < 800) res2 = c1; else res3 = c1;
  }
  if (!isNaN(c2)) {
    const d = c2 - ref_price;
    if (d < 400) { if (isNaN(res1)) res1 = c2; else res2 = c2; }
    else if (d < 800) { if (isNaN(res2)) res2 = c2; else res3 = c2; }
    else res3 = c2;
  }

  if (isNaN(res1)) {
    let max_r1 = ref_price + 400;
    if (!isNaN(res2)) max_r1 = Math.min(max_r1, res2 - 150);
    if (max_r1 > ref_price + GAP_FILL_MIN) res1 = f_find_best_cluster(key_zones, hist_highs, ref_price + GAP_FILL_MIN, max_r1);
    if (isNaN(res1)) {
      res1 = Math.ceil((ref_price + 100) / 100) * 100;
      if (!isNaN(res2) && res1 > res2 - 150) res1 = res2 - 150;
    }
  }
  if (isNaN(res3)) {
    let min_r3 = ref_price + 800;
    if (!isNaN(res2)) min_r3 = Math.max(min_r3, res2 + 150);
    else if (!isNaN(res1)) min_r3 = Math.max(min_r3, res1 + 300);
    const target_r3 = ref_price + 1000;
    res3 = f_find_best_cluster(key_zones, hist_highs, min_r3, ref_price + 1500);
    if (isNaN(res3)) { res3 = Math.floor(target_r3 / 100) * 100; if (res3 < min_r3) res3 = min_r3; }
  }
  if (isNaN(res2)) {
    const min_r2 = (isNaN(res1) ? ref_price : res1) + 150;
    const max_r2 = (isNaN(res3) ? ref_price + 1000 : res3) - 150;
    if (max_r2 > min_r2) res2 = f_find_best_cluster(key_zones, hist_highs, min_r2, max_r2);
    if (isNaN(res2)) {
      const base1 = isNaN(res1) ? ref_price : res1;
      const base3 = isNaN(res3) ? ref_price + 1000 : res3;
      res2 = Math.round((base1 + base3) / 2 / 50) * 50;
      if (res2 < min_r2) res2 = min_r2;
      if (res2 > max_r2) res2 = max_r2;
    }
  }

  const s_h_bel = !isNaN(sess_h) && sess_h < ref_price ? sess_h : NaN;
  const s_l_bel = !isNaN(sess_l) && sess_l < ref_price ? sess_l : NaN;
  let k1 = NaN, k2 = NaN;
  if (!isNaN(s_h_bel) && !isNaN(s_l_bel)) {
    if (s_h_bel > s_l_bel) { k1 = s_h_bel; k2 = s_l_bel; } else { k1 = s_l_bel; k2 = s_h_bel; }
  } else if (!isNaN(s_h_bel)) k1 = s_h_bel;
  else if (!isNaN(s_l_bel)) k1 = s_l_bel;

  if (!isNaN(k1)) {
    const d = ref_price - k1;
    if (d < 400) sup1 = k1; else if (d < 800) sup2 = k1; else sup3 = k1;
  }
  if (!isNaN(k2)) {
    const d = ref_price - k2;
    if (d < 400) { if (isNaN(sup1)) sup1 = k2; else sup2 = k2; }
    else if (d < 800) { if (isNaN(sup2)) sup2 = k2; else sup3 = k2; }
    else sup3 = k2;
  }
  if (isNaN(sup1)) {
    let min_s1 = ref_price - 400;
    if (!isNaN(sup2)) min_s1 = Math.max(min_s1, sup2 + 150);
    if (min_s1 < ref_price - GAP_FILL_MIN) sup1 = f_find_best_cluster(key_zones, hist_lows, min_s1, ref_price - GAP_FILL_MIN);
    if (isNaN(sup1)) {
      sup1 = Math.floor((ref_price - 100) / 100) * 100;
      if (!isNaN(sup2) && sup1 < sup2 + 150) sup1 = sup2 + 150;
    }
  }
  if (isNaN(sup3)) {
    let max_s3 = ref_price - 800;
    if (!isNaN(sup2)) max_s3 = Math.min(max_s3, sup2 - 150);
    else if (!isNaN(sup1)) max_s3 = Math.min(max_s3, sup1 - 300);
    const target_s3 = ref_price - 1000;
    sup3 = f_find_best_cluster(key_zones, hist_lows, ref_price - 1500, max_s3);
    if (isNaN(sup3)) { sup3 = Math.ceil(target_s3 / 100) * 100; if (sup3 > max_s3) sup3 = max_s3; }
  }
  if (isNaN(sup2)) {
    const max_s2 = (isNaN(sup1) ? ref_price : sup1) - 150;
    const min_s2 = (isNaN(sup3) ? ref_price - 1000 : sup3) + 150;
    if (max_s2 > min_s2) sup2 = f_find_best_cluster(key_zones, hist_lows, min_s2, max_s2);
    if (isNaN(sup2)) {
      const base1 = isNaN(sup1) ? ref_price : sup1;
      const base3 = isNaN(sup3) ? ref_price - 1000 : sup3;
      sup2 = Math.round((base1 + base3) / 2 / 50) * 50;
      if (sup2 > max_s2) sup2 = max_s2;
      if (sup2 < min_s2) sup2 = min_s2;
    }
  }
  return [res1, res2, res3, sup1, sup2, sup3];
}

function f_get_intermediate_level(
  val1: number, val2: number, kz: number[],
  hist_r1: number[], hist_r2: number[], hist_r3: number[], hist_s1: number[], hist_s2: number[], hist_s3: number[]
): number {
  let res = NaN;
  if (!isNaN(val1) && !isNaN(val2) && Math.abs(val1 - val2) >= 500) {
    const mid = (val1 + val2) / 2;
    let best_cand = NaN;
    let min_dist = 1000000.0;
    const min_v = Math.min(val1, val2);
    const max_v = Math.max(val1, val2);
    for (let i = 0; i < kz.length; i++) {
      const v = kz[i];
      if (!isNaN(v) && v > min_v && v < max_v) {
        const d = Math.abs(v - mid);
        if (d < min_dist) { min_dist = d; best_cand = v; }
      }
    }
    const h_size = hist_r1.length;
    const checks = Math.min(h_size, 2);
    for (let i = 0; i < checks; i++) {
      const cl = [hist_r1[i], hist_r2[i], hist_r3[i], hist_s1[i], hist_s2[i], hist_s3[i]];
      for (let j = 0; j < 6; j++) {
        const v = cl[j];
        if (!isNaN(v) && v > min_v && v < max_v) {
          const d = Math.abs(v - mid);
          if (d < min_dist) { min_dist = d; best_cand = v; }
        }
      }
    }
    const start_250 = Math.ceil(min_v / 250) * 250;
    if (start_250 < max_v) {
      let curr = start_250;
      while (curr < max_v) {
        const d = Math.abs(curr - mid);
        if (d < min_dist) { min_dist = d; best_cand = curr; }
        curr += 250;
      }
    }
    res = best_cand;
  }
  return res;
}

// Block info from sorted levels. Returns [b_type, b_lower, b_upper, block_idx]
function f_get_block_info_from_sorted(p: number, levels: number[]): [number, number, number, number] {
  let b_type = 0, b_lower = NaN, b_upper = NaN;
  let on_bound = false;
  const sz = levels.length;
  for (let i = 0; i < sz; i++) { if (p === levels[i]) { on_bound = true; break; } }
  if (on_bound) {
    b_type = -1;
  } else if (sz > 0) {
    if (p < levels[0]) { b_upper = levels[0]; b_type = 0; }
    else if (p > levels[sz - 1]) { b_lower = levels[sz - 1]; b_type = 1; }
    else {
      for (let i = 0; i < sz - 1; i++) {
        const l_v = levels[i], u_v = levels[i + 1];
        if (p > l_v && p < u_v) {
          b_lower = l_v; b_upper = u_v;
          const center = (l_v + u_v) / 2;
          b_type = p >= center ? 1 : 0;
          break;
        }
      }
    }
  } else b_type = 0;

  let block_idx = -1;
  if (sz > 0) {
    if (p < levels[0]) block_idx = -1;
    else if (p > levels[sz - 1]) block_idx = sz;
    else {
      for (let i = 0; i < sz - 1; i++) {
        if (p > levels[i] && p < levels[i + 1]) { block_idx = i; break; }
      }
    }
  }
  if (on_bound) block_idx = -999;
  return [b_type, b_lower, b_upper, block_idx];
}

function f_fill_boundary_gaps(levelsIn: number[], gap_ticks: number): number[] {
  const levels = levelsIn.slice();
  const sz = levels.length;
  let res_levels = levels.slice();
  if (gap_ticks > 0 && sz > 1) {
    const gap_p = gap_ticks * MINTICK;
    const new_filled: number[] = [];
    levels.sort((a, b) => a - b);
    new_filled.push(levels[0]);
    for (let i = 0; i < sz - 1; i++) {
      const p_curr = levels[i], p_next = levels[i + 1];
      const diff = p_next - p_curr;
      if (diff > gap_p) {
        const steps = Math.ceil(diff / gap_p);
        if (steps > 1) {
          const step_size = diff / steps;
          for (let k = 1; k < steps; k++) new_filled.push(p_curr + step_size * k);
        }
      }
      new_filled.push(p_next);
    }
    res_levels = new_filled;
  }
  return res_levels;
}

// ======================= ROLLING INDICATORS on a generic series =======================
// Wilder ADX/DMI(14,14)
class DMI {
  len: number; lenAdx: number;
  prevClose = NaN; prevHigh = NaN; prevLow = NaN;
  smTR = NaN; smPlus = NaN; smMinus = NaN; adx = NaN;
  count = 0;
  constructor(len = 14, lenAdx = 14) { this.len = len; this.lenAdx = lenAdx; }
  update(h: number, l: number, c: number): number {
    if (isNaN(this.prevClose)) { this.prevClose = c; this.prevHigh = h; this.prevLow = l; return NaN; }
    const up = h - this.prevHigh;
    const down = this.prevLow - l;
    const plusDM = up > down && up > 0 ? up : 0;
    const minusDM = down > up && down > 0 ? down : 0;
    const tr = Math.max(h - l, Math.abs(h - this.prevClose), Math.abs(l - this.prevClose));
    this.prevClose = c; this.prevHigh = h; this.prevLow = l;
    this.count++;
    if (isNaN(this.smTR)) { this.smTR = tr; this.smPlus = plusDM; this.smMinus = minusDM; }
    else {
      this.smTR = this.smTR - this.smTR / this.len + tr;
      this.smPlus = this.smPlus - this.smPlus / this.len + plusDM;
      this.smMinus = this.smMinus - this.smMinus / this.len + minusDM;
    }
    const diPlus = this.smTR === 0 ? 0 : 100 * this.smPlus / this.smTR;
    const diMinus = this.smTR === 0 ? 0 : 100 * this.smMinus / this.smTR;
    const sum = diPlus + diMinus;
    const dx = sum === 0 ? 0 : 100 * Math.abs(diPlus - diMinus) / sum;
    if (isNaN(this.adx)) {
      // seed adx as simple average of dx once we have lenAdx samples; approximate w/ Wilder smoothing start
      this.adx = dx;
    } else {
      this.adx = (this.adx * (this.lenAdx - 1) + dx) / this.lenAdx;
    }
    return this.adx;
  }
}

// Wilder RSI
class RSI {
  len: number; prev = NaN; avgGain = NaN; avgLoss = NaN; count = 0;
  constructor(len = 14) { this.len = len; }
  update(c: number): number {
    if (isNaN(this.prev)) { this.prev = c; return NaN; }
    const ch = c - this.prev; this.prev = c;
    const gain = ch > 0 ? ch : 0, loss = ch < 0 ? -ch : 0;
    this.count++;
    if (isNaN(this.avgGain)) { this.avgGain = gain; this.avgLoss = loss; }
    else {
      this.avgGain = (this.avgGain * (this.len - 1) + gain) / this.len;
      this.avgLoss = (this.avgLoss * (this.len - 1) + loss) / this.len;
    }
    if (this.avgLoss === 0) return 100;
    const rs = this.avgGain / this.avgLoss;
    return 100 - 100 / (1 + rs);
  }
}

// SMA
class SMA {
  len: number; buf: number[] = []; sum = 0;
  constructor(len: number) { this.len = len; }
  update(v: number): number {
    this.buf.push(v); this.sum += v;
    if (this.buf.length > this.len) this.sum -= this.buf.shift()!;
    return this.buf.length >= this.len ? this.sum / this.len : NaN;
  }
}

// ======================= AGGREGATION =======================
// Aggregate 1m bars into TF-min bars, keyed by session boundaries.
// We align bars to wall-clock JST minute grid within each (sdate, session) group so that
// 5m/15m/30m boundaries line up with TradingView's exchange-session grid.
type AggBar = { t: number; tClose: number; o: number; h: number; l: number; c: number; v: number; session: string; sdate: string; subs: Bar[] };

function aggregate(bars: Bar[], tfMin: number): AggBar[] {
  const out: AggBar[] = [];
  const tfMs = tfMin * 60 * 1000;
  let cur: AggBar | null = null;
  let curKey = "";
  for (const b of bars) {
    // bucket start = floor to tf grid in JST wall clock
    const jstMs = b.t + 9 * 3600 * 1000;
    const bucketStartJst = Math.floor(jstMs / tfMs) * tfMs;
    const bucketStart = bucketStartJst - 9 * 3600 * 1000;
    const key = `${b.sdate}|${b.session}|${bucketStart}`;
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { t: bucketStart, tClose: bucketStart + tfMs, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, session: b.session, sdate: b.sdate, subs: [b] };
      curKey = key;
    } else {
      cur!.h = Math.max(cur!.h, b.h);
      cur!.l = Math.min(cur!.l, b.l);
      cur!.c = b.c;
      cur!.v += b.v;
      cur!.subs.push(b);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ======================= HTF SERIES with non-repaint [1] semantics =======================
// Build closed HTF bars; provide a function to fetch the value of the LAST CLOSED HTF bar
// strictly before a given timestamp (replicates lookahead_on + [1] idiom = prior completed bar).
class HtfSeries {
  bars: AggBar[];
  constructor(bars1m: Bar[], tfMin: number) { this.bars = aggregate(bars1m, tfMin); }
}

// ======================= ENGINE: compute 30m trigger state =======================
// Mirrors f_strategy_engine_5m running on the rolling-3 5m window ending at the 30m bar close.
// Inputs: the constituent 5m sub-bars of the 30m bar (chronological), the session levels, prox/gap.
function computeTriggerState(
  fiveMinSubs: AggBar[], // the 5m bars composing this 30m bar (up to 6)
  L: SessionLevels,
  prox_ticks: number, max_gap: number, roll_cnt: number,
  session_high: number, session_low: number
): number {
  // Need at least roll_cnt 5m bars
  if (fiveMinSubs.length < roll_cnt) return 0;
  const n = fiveMinSubs.length;
  const win = fiveMinSubs.slice(n - roll_cnt); // last roll_cnt 5m bars
  const bound_chk = win[win.length - 1].c; // close of pseudo-15m = close of last 5m
  const o_chk = win[0].o; // open[roll_cnt-1]
  let h_15 = -Infinity, l_15 = Infinity;
  for (const b of win) { h_15 = Math.max(h_15, b.h); l_15 = Math.min(l_15, b.l); }

  // Build levels array (matches f_strategy_engine_5m ordering then sort)
  const t_levels: number[] = [];
  const push = (v: number) => { if (!isNaN(v)) t_levels.push(v); };
  push(L.s3); push(L.s25); push(L.s2); push(L.s15); push(L.s1); push(L.s05);
  push(L.s_open); push(L.r05); push(L.r1); push(L.r15); push(L.r2); push(L.r25); push(L.r3);
  t_levels.sort((a, b) => a - b);
  const filled = f_fill_boundary_gaps(t_levels, max_gap);

  const [b_type, bl, bu, b_idx] = f_get_block_info_from_sorted(bound_chk, filled);
  const [b_type_o, blo, buo, b_idx_o] = f_get_block_info_from_sorted(o_chk, filled);
  const [, , , b_idx_open] = f_get_block_info_from_sorted(L.s_open, filled);

  const is_block_type_change = b_type !== b_type_o;
  const is_block_idx_change = b_idx !== b_idx_o;
  const is_bound_reach = b_type === -1;
  const is_15_bull = bound_chk > o_chk;
  const is_15_bear = bound_chk < o_chk;
  const is_15_doji = bound_chk === o_chk;

  let is_breakout_candidate = false;
  let is_force_entry = false;

  if (P.use_breakout_logic) {
    const is_level_cross = is_block_idx_change || is_bound_reach;
    const is_center_cross = !is_level_cross && is_block_type_change;
    const center_o = (blo + buo) / 2;
    if (is_15_bull && !isNaN(center_o) && !isNaN(buo)) {
      if (o_chk < center_o && bound_chk > buo) is_force_entry = true;
    }
    if (is_15_bear && !isNaN(center_o) && !isNaN(blo)) {
      if (o_chk > center_o && bound_chk < blo) is_force_entry = true;
    }
    if (P.use_level_cross && is_level_cross) is_breakout_candidate = true;
    if (P.use_center_cross && is_center_cross) is_breakout_candidate = true;

    if (!is_force_entry && prox_ticks > 0) {
      const p_val = prox_ticks * MINTICK;
      if (is_breakout_candidate && is_15_bull && !isNaN(bu)) {
        if (bound_chk < bu && bound_chk >= bu - p_val) is_breakout_candidate = false;
      }
      if (is_breakout_candidate && is_15_bear && !isNaN(bl)) {
        if (bound_chk > bl && bound_chk <= bl + p_val) is_breakout_candidate = false;
      }
    }
  }

  // Reversal
  let is_reversal_buy = false, is_reversal_sell = false;
  if (P.use_reversal_logic) {
    if (is_15_bull) {
      const pv = prox_ticks * MINTICK;
      const dist_low_b = Math.abs(l_15 - bl);
      const dist_s1 = Math.abs(l_15 - L.s1), dist_s2 = Math.abs(l_15 - L.s2), dist_s3 = Math.abs(l_15 - L.s3);
      const dist_s05 = Math.abs(l_15 - L.s05), dist_s15 = Math.abs(l_15 - L.s15), dist_s25 = Math.abs(l_15 - L.s25);
      const min_dist_s = Math.min(dist_low_b, dist_s1, dist_s2, dist_s3, dist_s05, dist_s15, dist_s25);
      const is_pierce_s = l_15 <= bl + pv || l_15 <= L.s1 + pv || l_15 <= L.s2 + pv;
      if (is_pierce_s || min_dist_s <= pv) is_reversal_buy = true;
    }
    if (is_15_bear) {
      const pv = prox_ticks * MINTICK;
      const dist_up_b = Math.abs(h_15 - bu);
      const dist_r1 = Math.abs(h_15 - L.r1), dist_r2 = Math.abs(h_15 - L.r2), dist_r3 = Math.abs(h_15 - L.r3);
      const dist_r05 = Math.abs(h_15 - L.r05), dist_r15 = Math.abs(h_15 - L.r15), dist_r25 = Math.abs(h_15 - L.r25);
      const min_dist_r = Math.min(dist_up_b, dist_r1, dist_r2, dist_r3, dist_r05, dist_r15, dist_r25);
      const is_pierce_r = h_15 >= bu - pv || h_15 >= L.r1 - pv || h_15 >= L.r2 - pv;
      if (is_pierce_r || min_dist_r <= pv) is_reversal_sell = true;
    }
  }

  let trig_st = 0;
  if (is_breakout_candidate) {
    if (is_15_bull) trig_st = 2; else if (is_15_bear) trig_st = -2;
    // Session high/low straddle ban
    const block_center = (bl + bu) * 0.5;
    const idx_delta = Math.abs(b_idx - b_idx_o);
    const is_multi_cross = idx_delta >= 2;
    if (trig_st === 2) {
      if (bu >= session_high && block_center < bound_chk) {
        const is_exc_open_adj = b_idx === b_idx_open + 1;
        if (!is_exc_open_adj && !is_multi_cross) trig_st = 0;
      }
    }
    if (trig_st === -2) {
      if (bl <= session_low && block_center > bound_chk) {
        const is_exc_open_adj = b_idx === b_idx_open - 1;
        if (!is_exc_open_adj && !is_multi_cross) trig_st = 0;
      }
    }
  }
  if (is_reversal_buy) trig_st = 1; else if (is_reversal_sell) trig_st = -1;
  if (is_15_doji && is_bound_reach && o_chk === bound_chk) trig_st = 2;
  return trig_st;
}

type SessionLevels = {
  r1: number; r2: number; r3: number; r05: number; r15: number; r25: number;
  s1: number; s2: number; s3: number; s05: number; s15: number; s25: number;
  s_open: number;
};

// ======================= HTF helper: last completed bar value lookup =======================
// Builds 60m bars and an SMA25 over their closes. Lookup returns:
//   { close: last-completed-60m close as of tMs, ma: SMA25 evaluated at the previous-completed
//     60m bar (Pine's sma(close,25)[1]) }
// Non-repainting: only bars whose CLOSE time <= tMs are considered.
class Htf60 {
  bars: AggBar[];
  closes: number[] = [];
  sma25: number[] = []; // sma25[i] = SMA of closes[0..i]
  constructor(bars1m: Bar[]) {
    this.bars = aggregate(bars1m, 60);
    const sma = new SMA(25);
    for (const b of this.bars) {
      this.closes.push(b.c);
      this.sma25.push(sma.update(b.c));
    }
  }
  // returns index of last bar with tClose <= tMs
  private lastClosedIdx(tMs: number): number {
    // binary search
    let lo = 0, hi = this.bars.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid].tClose <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  lookup(tMs: number): { close: number; ma: number } {
    const i = this.lastClosedIdx(tMs);
    if (i < 0) return { close: NaN, ma: NaN };
    const close = this.closes[i];
    const maIdx = i - 1; // sma(close,25)[1] = previous completed bar's SMA
    const ma = maIdx >= 0 ? this.sma25[maIdx] : NaN;
    return { close, ma };
  }
}

// ======================= 5m ADX / RSI series with last-completed lookup =======================
class FiveMinIndicators {
  bars: AggBar[];
  adx: number[] = [];     // adx[i] computed on 5m bar i (Wilder)
  adxPrev: number[] = []; // adx of bar i-1
  rsi: number[] = [];     // rsi(close,rsi_len) at 5m bar i
  constructor(fiveMin: AggBar[]) {
    this.bars = fiveMin;
    const dmi = new DMI(14, 14);
    const rsi = new RSI(P.rsi_len);
    let prevAdx = NaN;
    for (const b of fiveMin) {
      const a = dmi.update(b.h, b.l, b.c);
      this.adx.push(a);
      this.adxPrev.push(prevAdx);
      prevAdx = a;
      this.rsi.push(rsi.update(b.c));
    }
  }
  private lastClosedIdx(tMs: number): number {
    let lo = 0, hi = this.bars.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.bars[mid].tClose <= tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }
  lookup(tMs: number): { adx: number; adxPrev: number; rsi: number } {
    const i = this.lastClosedIdx(tMs);
    if (i < 0) return { adx: NaN, adxPrev: NaN, rsi: NaN };
    return { adx: this.adx[i], adxPrev: this.adxPrev[i], rsi: this.rsi[i] };
  }
}

// ======================= DAILY pivots & key-zone builders =======================
// Build daily bars (session-day aggregation is non-trivial; TradingView "D" uses exchange day).
// We approximate the daily pivot using prior calendar-day OHLC (high[1],low[1],close[1] non-repaint).
class DailyPivots {
  days: { dateKey: string; h: number; l: number; c: number; tClose: number }[] = [];
  constructor(bars1m: Bar[]) {
    // group by JST calendar date
    const map = new Map<string, { h: number; l: number; c: number; tMax: number }>();
    const order: string[] = [];
    for (const b of bars1m) {
      const p = jstParts(b.t);
      const key = `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
      let e = map.get(key);
      if (!e) { e = { h: b.h, l: b.l, c: b.c, tMax: b.t }; map.set(key, e); order.push(key); }
      else { e.h = Math.max(e.h, b.h); e.l = Math.min(e.l, b.l); if (b.t >= e.tMax) { e.tMax = b.t; e.c = b.c; } }
    }
    for (const k of order) {
      const e = map.get(k)!;
      // tClose ~ end of that JST day (approx 24:00 JST)
      this.days.push({ dateKey: k, h: e.h, l: e.l, c: e.c, tClose: e.tMax });
    }
  }
  // prior completed day's pivot levels as of tMs
  lookup(tMs: number): { p: number; r1: number; s1: number; r2: number; s2: number } {
    // find last day whose tClose < tMs (strictly prior, non-repaint via [1])
    let lo = 0, hi = this.days.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.days[mid].tClose < tMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (ans < 0) return { p: NaN, r1: NaN, s1: NaN, r2: NaN, s2: NaN };
    const d = this.days[ans];
    const pp = (d.h + d.l + d.c) / 3;
    return { p: pp, r1: 2 * pp - d.l, s1: 2 * pp - d.h, r2: pp + d.h - d.l, s2: pp - (d.h - d.l) };
  }
}

// ======================= MAIN BACKTEST =======================
type ClosedTrade = {
  num: number; dir: 1 | -1; entryT: number; exitT: number;
  entryPrice: number; exitPrice: number; profitPts: number; profitYen: number;
  entrySig: string; exitReason: string; cumYen: number;
};

type OptState = {
  // virtual self-optimizer state (per side), simplified — see report
  active_x_l: number; active_y_l: number;
  active_x_s: number; active_y_s: number;
};

function runBacktest(bars1m: Bar[], opts: { startMs: number; endMs: number; tag: string }) {
  // Pre-aggregate series
  const fiveMin = aggregate(bars1m, 5);
  const thirtyMin = aggregate(bars1m, 30);
  const htf60 = new Htf60(bars1m);
  const ind5 = new FiveMinIndicators(fiveMin);
  const daily = new DailyPivots(bars1m);

  // Map 30m bars -> their constituent 5m subs (by sdate|session and time window)
  const fiveByKey = new Map<string, AggBar[]>();
  for (const fb of fiveMin) {
    const k = `${fb.sdate}|${fb.session}`;
    let a = fiveByKey.get(k); if (!a) { a = []; fiveByKey.set(k, a); } a.push(fb);
  }

  // Session-history state (replicates the unshift/pop arrays, newest at index 0)
  const hist_highs: number[] = [], hist_lows: number[] = [];
  const hist_r1: number[] = [], hist_r2: number[] = [], hist_r3: number[] = [];
  const hist_s1: number[] = [], hist_s2: number[] = [], hist_s3: number[] = [];

  let curSessKey = ""; // sdate|session
  let curLevels: SessionLevels | null = null;
  let curGLevels: number[] = []; // sorted filled levels for exit trailing
  let cur_sh = NaN, cur_sl = NaN; // session high/low accumulators (for prev-session push)

  // Trading state
  let posDir: 0 | 1 | -1 = 0;
  let entryPrice = NaN, entryT = 0, entrySig = "";
  let trail_sl = NaN;              // trailing SL (risk/TS/BE unified)
  let brk_entry_level = NaN;       // structural SL anchor
  let trail_bound = NaN;           // boundary-trail level
  let isRev = false;               // reversal trade flag
  let promoted = false;            // reversal promoted to breakout
  let active_x = 100, active_y = 50; // TS params in effect for the open trade

  // Self-optimizer simplification: we keep the DEFAULT seed params (x=100,y=50) which is what
  // the Pine starts with and (per report) the 8x8 virtual optimizer only adjusts Y modestly.
  // Sensitivity is examined separately. active_x_l/y_l etc default 100/50.
  let opt_active_x_l = 100, opt_active_y_l = 50, opt_active_x_s = 100, opt_active_y_s = 50;

  let session_profit = 0;       // realized profit this session
  let sessionStartT = 0;

  const closed: ClosedTrade[] = [];
  let cumYen = 0;
  let tradeNum = 0;
  let equityPeak = 0, maxDD = 0; // on realized yen
  let wins = 0;

  // helper: push prior session into hist arrays (newest first)
  function pushHist(sh: number, sl: number, L: SessionLevels | null) {
    hist_highs.unshift(sh); hist_lows.unshift(sl);
    hist_r1.unshift(L ? L.r1 : NaN); hist_r2.unshift(L ? L.r2 : NaN); hist_r3.unshift(L ? L.r3 : NaN);
    hist_s1.unshift(L ? L.s1 : NaN); hist_s2.unshift(L ? L.s2 : NaN); hist_s3.unshift(L ? L.s3 : NaN);
    if (hist_highs.length > LOOKBACK_SESSIONS) {
      hist_highs.pop(); hist_lows.pop();
      hist_r1.pop(); hist_r2.pop(); hist_r3.pop(); hist_s1.pop(); hist_s2.pop(); hist_s3.pop();
    }
  }

  // Build session levels at session open
  function buildLevels(refOpen: number, tOpen: number): SessionLevels {
    const prev_h = hist_highs.length > 0 ? hist_highs[0] : NaN;
    const prev_l = hist_lows.length > 0 ? hist_lows[0] : NaN;
    // Key zones (deterministic subset — see report for omissions: VWAP, vol-nodes)
    const kz: number[] = [];
    const dp = daily.lookup(tOpen);
    for (const v of [dp.p, dp.r1, dp.s1, dp.r2, dp.s2]) if (!isNaN(v)) kz.push(v);
    // Manual fibs
    const man382 = P.u_fib_l + (P.u_fib_h - P.u_fib_l) * 0.382;
    const man500 = P.u_fib_l + (P.u_fib_h - P.u_fib_l) * 0.500;
    const man618 = P.u_fib_l + (P.u_fib_h - P.u_fib_l) * 0.618;
    kz.push(man382, man500, man618);
    const [r1, r2, r3, s1, s2, s3] = f_find_res_sup(refOpen, kz, prev_h, prev_l, hist_highs, hist_lows);
    const r05 = f_get_intermediate_level(refOpen, r1, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    const r15 = f_get_intermediate_level(r1, r2, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    const r25 = f_get_intermediate_level(r2, r3, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    const s05 = f_get_intermediate_level(refOpen, s1, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    const s15 = f_get_intermediate_level(s1, s2, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    const s25 = f_get_intermediate_level(s2, s3, kz, hist_r1, hist_r2, hist_r3, hist_s1, hist_s2, hist_s3);
    return { r1, r2, r3, r05, r15, r25, s1, s2, s3, s05, s15, s25, s_open: refOpen };
  }

  function gLevelsFrom(L: SessionLevels): number[] {
    const arr: number[] = [];
    for (const v of [L.s3, L.s25, L.s2, L.s15, L.s1, L.s05, L.s_open, L.r05, L.r1, L.r15, L.r2, L.r25, L.r3]) if (!isNaN(v)) arr.push(v);
    arr.sort((a, b) => a - b);
    return f_fill_boundary_gaps(arr, P.max_bound_gap_ticks);
  }

  // close the position, record trade
  function closePosition(exitPrice: number, exitT: number, reason: string) {
    if (posDir === 0) return;
    const pts = posDir === 1 ? exitPrice - entryPrice : entryPrice - exitPrice;
    const yen = pts * YEN_PER_POINT;
    tradeNum++;
    cumYen += yen;
    session_profit += yen;
    if (yen > 0) wins++;
    if (cumYen > equityPeak) equityPeak = cumYen;
    const dd = equityPeak - cumYen;
    if (dd > maxDD) maxDD = dd;
    closed.push({
      num: tradeNum, dir: posDir, entryT, exitT, entryPrice, exitPrice,
      profitPts: pts, profitYen: yen, entrySig, exitReason: reason, cumYen,
    });
    posDir = 0; entryPrice = NaN; trail_sl = NaN; brk_entry_level = NaN; trail_bound = NaN;
    isRev = false; promoted = false;
  }

  // ---- iterate session-grouped 30m bars in time order ----
  // We process bar-by-bar at the 30m cadence; within each bar we replay its 1m subs for exits,
  // then (at bar close) decide entries to fill at NEXT bar's open.
  // To fill at next-bar open we defer: keep a pending signal.
  let pendingEntry: { dir: 1 | -1; sig: string; isRev: boolean } | null = null;

  // running session high/low (live, updated each 1m) for engine straddle ban & loss-limit
  let liveSessHigh = NaN, liveSessLow = NaN;

  for (let bi = 0; bi < thirtyMin.length; bi++) {
    const bar = thirtyMin[bi];
    const sessKey = `${bar.sdate}|${bar.session}`;
    const isNewSession = sessKey !== curSessKey;

    if (isNewSession) {
      // push prior session's accumulated H/L + its levels
      if (curSessKey !== "") pushHist(cur_sh, cur_sl, curLevels);
      curSessKey = sessKey;
      // session ref price = open of first bar of session
      cur_sh = bar.h; cur_sl = bar.l;
      curLevels = buildLevels(bar.o, bar.t);
      curGLevels = gLevelsFrom(curLevels);
      sessionStartT = bar.t;
      session_profit = 0; // session profit resets at session start
      liveSessHigh = bar.h; liveSessLow = bar.l;
    } else {
      cur_sh = Math.max(cur_sh, bar.h); cur_sl = Math.min(cur_sl, bar.l);
    }
    const L = curLevels!;

    // ---- pending entry fills at the OPEN of this 30m bar (its first 1m sub) ----
    if (pendingEntry && posDir === 0 && bar.subs.length > 0) {
      const fillP = bar.subs[0].o;
      posDir = pendingEntry.dir;
      entryPrice = fillP; entryT = bar.subs[0].t; entrySig = pendingEntry.sig; isRev = pendingEntry.isRev;
      promoted = false;
      active_x = posDir === 1 ? opt_active_x_l : opt_active_x_s;
      active_y = posDir === 1 ? opt_active_y_l : opt_active_y_s;
      let entry_sl_ticks: number;
      if (isRev) entry_sl_ticks = P.rev_sl_ticks;
      else if (P.sl_tp_mode === "Auto (Risk Based)") entry_sl_ticks = Math.round(active_y * (posDir === 1 ? P.auto_sl_l : P.auto_sl_s));
      else entry_sl_ticks = posDir === 1 ? P.sl_ticks_l : P.sl_ticks_s;
      trail_sl = posDir === 1 ? entryPrice - entry_sl_ticks * MINTICK : entryPrice + entry_sl_ticks * MINTICK;
      const [, c_low_b0, c_up_b0] = f_get_block_info_from_sorted(fillP, curGLevels);
      if (posDir === 1) { brk_entry_level = c_low_b0; trail_bound = isNaN(c_low_b0) ? NaN : c_low_b0; }
      else { brk_entry_level = c_up_b0; trail_bound = isNaN(c_up_b0) ? NaN : c_up_b0; }
      pendingEntry = null;
    }

    // update running session high/low from this 30m bar
    liveSessHigh = isNaN(liveSessHigh) ? bar.h : Math.max(liveSessHigh, bar.h);
    liveSessLow = isNaN(liveSessLow) ? bar.l : Math.min(liveSessLow, bar.l);

    // ===================== EXIT LOGIC (30m cadence, bar-magnifier 1m fills) =====================
    // Pine on a 30m chart evaluates these once per 30m bar. The strategy.exit stop/limit orders
    // are filled intrabar by the bar magnifier (we replay 1m subs to find the touch).
    // Boundary-trail exit + loss-limit are decided at the 30m close.
    // Force-close minute windows ([20,29]/[35,44]) NEVER contain a bar on a 30m chart -> disabled.
    if (posDir !== 0) {
      // --- compute TS params (reversal override) for THIS 30m bar ---
      let tr_trig: number, tr_dist: number, eff_sl_ticks: number, eff_tp_ticks: number;
      if (posDir === 1) {
        tr_trig = active_x * MINTICK; tr_dist = active_y * MINTICK;
        eff_sl_ticks = P.sl_ticks_l; eff_tp_ticks = P.tp_ticks_l;
        if (P.sl_tp_mode === "Auto (Risk Based)") {
          eff_sl_ticks = Math.round(active_y * P.auto_sl_l);
          eff_tp_ticks = P.auto_tp_ratio_l > 0 ? Math.round(eff_sl_ticks * P.auto_tp_ratio_l) : 0;
        }
      } else {
        tr_trig = active_x * MINTICK; tr_dist = active_y * MINTICK;
        eff_sl_ticks = P.sl_ticks_s; eff_tp_ticks = P.tp_ticks_s;
        if (P.sl_tp_mode === "Auto (Risk Based)") {
          eff_sl_ticks = Math.round(active_y * P.auto_sl_s);
          eff_tp_ticks = P.auto_tp_ratio_s > 0 ? Math.round(eff_sl_ticks * P.auto_tp_ratio_s) : 0;
        }
      }
      if (isRev && !promoted) {
        tr_trig = P.rev_ts_trigger * MINTICK; tr_dist = P.rev_ts_dist * MINTICK;
        eff_sl_ticks = P.rev_sl_ticks;
        eff_tp_ticks = P.rev_tp_ticks > 0 ? P.rev_tp_ticks : 0;
      }

      // block info at the 30m close (for reversal target & SL boundary)
      const [, c_low_b, c_up_b] = f_get_block_info_from_sorted(bar.c, curGLevels);
      const block_center = (!isNaN(c_low_b) && !isNaN(c_up_b)) ? (c_low_b + c_up_b) / 2 : NaN;

      // --- update TS/BE using this 30m bar's high/low (Pine uses bar high/low) ---
      if (posDir === 1) {
        if (bar.h >= entryPrice + tr_trig) { const new_sl = bar.h - tr_dist; if (new_sl > trail_sl) trail_sl = new_sl; }
        if (P.use_be) {
          const be_trig_val = P.be_trigger * MINTICK, be_off_val = P.be_offset * MINTICK;
          if (bar.h >= entryPrice + be_trig_val) { const be_level = entryPrice + be_off_val; if (trail_sl < be_level) trail_sl = be_level; }
        }
      } else {
        if (bar.l <= entryPrice - tr_trig) { const new_sl = bar.l + tr_dist; if (new_sl < trail_sl) trail_sl = new_sl; }
        if (P.use_be) {
          const be_trig_val = P.be_trigger * MINTICK, be_off_val = P.be_offset * MINTICK;
          if (bar.l <= entryPrice - be_trig_val) { const be_level = entryPrice - be_off_val; if (trail_sl > be_level) trail_sl = be_level; }
        }
      }

      // --- assemble stop/limit levels for strategy.exit (filled intrabar) ---
      let stopLevel: number, limitLevel: number;
      if (posDir === 1) {
        let brk_stop = trail_sl;
        if (P.use_brk_struct_sl && !isNaN(brk_entry_level)) { const ss = brk_entry_level - P.brk_struct_offset * MINTICK; brk_stop = Math.max(brk_stop, ss); }
        const brk_limit = eff_tp_ticks > 0 ? entryPrice + eff_tp_ticks * MINTICK : NaN;
        if (isRev && !promoted) {
          let rev_limit = NaN;
          if (P.rev_exit_target === "Opposite Bound" && !isNaN(c_up_b) && c_up_b > entryPrice) rev_limit = c_up_b - P.rev_target_offset * MINTICK;
          else if (P.rev_exit_target === "Block Center" && !isNaN(block_center) && block_center > entryPrice) rev_limit = block_center;
          if (P.rev_tp_ticks > 0) { const f_tp = entryPrice + P.rev_tp_ticks * MINTICK; rev_limit = isNaN(rev_limit) ? f_tp : Math.min(rev_limit, f_tp); }
          let final_sl = brk_stop;
          if (P.use_rev_sl_bound && !isNaN(c_low_b)) { const b_sl = c_low_b - P.rev_sl_offset * MINTICK; final_sl = Math.max(final_sl, b_sl); }
          stopLevel = final_sl; limitLevel = rev_limit;
        } else { stopLevel = brk_stop; limitLevel = brk_limit; }
      } else {
        let brk_stop = trail_sl;
        if (P.use_brk_struct_sl && !isNaN(brk_entry_level)) { const ss = brk_entry_level + P.brk_struct_offset * MINTICK; brk_stop = Math.min(brk_stop, ss); }
        const brk_limit = eff_tp_ticks > 0 ? entryPrice - eff_tp_ticks * MINTICK : NaN;
        if (isRev && !promoted) {
          let rev_limit = NaN;
          if (P.rev_exit_target === "Opposite Bound" && !isNaN(c_low_b) && c_low_b < entryPrice) rev_limit = c_low_b + P.rev_target_offset * MINTICK;
          else if (P.rev_exit_target === "Block Center" && !isNaN(block_center) && block_center < entryPrice) rev_limit = block_center;
          if (P.rev_tp_ticks > 0) { const f_tp = entryPrice - P.rev_tp_ticks * MINTICK; rev_limit = isNaN(rev_limit) ? f_tp : Math.max(rev_limit, f_tp); }
          let final_sl = brk_stop;
          if (P.use_rev_sl_bound && !isNaN(c_up_b)) { const b_sl = c_up_b + P.rev_sl_offset * MINTICK; final_sl = Math.min(final_sl, b_sl); }
          stopLevel = final_sl; limitLevel = rev_limit;
        } else { stopLevel = brk_stop; limitLevel = brk_limit; }
      }

      // --- replay 1m subs of THIS bar to fill stop/limit intrabar (bar magnifier) ---
      let exited = false;
      for (const m1 of bar.subs) {
        if (posDir === 1) {
          if (m1.l <= stopLevel) { closePosition(Math.min(stopLevel, m1.o), m1.t, "Stop"); exited = true; break; }
          if (!isNaN(limitLevel) && m1.h >= limitLevel) { closePosition(Math.max(limitLevel, m1.o), m1.t, "TP"); exited = true; break; }
        } else {
          if (m1.h >= stopLevel) { closePosition(Math.max(stopLevel, m1.o), m1.t, "Stop"); exited = true; break; }
          if (!isNaN(limitLevel) && m1.l <= limitLevel) { closePosition(Math.min(limitLevel, m1.o), m1.t, "TP"); exited = true; break; }
        }
      }

      // --- boundary-trail update & exit at the 30m CLOSE (only if not already exited) ---
      if (!exited) {
        const allLevels = [L.r3, L.r25, L.r2, L.r15, L.r1, L.r05, L.s_open, L.s05, L.s1, L.s15, L.s2, L.s25, L.s3];
        if (posDir === 1) {
          for (const lvl of allLevels) if (!isNaN(lvl) && bar.c > lvl) { if (isNaN(trail_bound) || lvl > trail_bound) trail_bound = lvl; }
        } else {
          for (const lvl of allLevels) if (!isNaN(lvl) && bar.c < lvl) { if (isNaN(trail_bound) || lvl < trail_bound) trail_bound = lvl; }
        }
        // strong-trend check via 5m RSI at bar close (Pine uses chart-RSI; approximated by 5m RSI)
        const rsiNow = ind5.lookup(bar.tClose).rsi;
        if (posDir === 1 && !isNaN(trail_bound) && bar.c < trail_bound) {
          closePosition(bar.c, bar.tClose - 60000, "BoundExit"); exited = true;
        } else if (posDir === -1 && !isNaN(trail_bound) && bar.c > trail_bound) {
          closePosition(bar.c, bar.tClose - 60000, "BoundExit"); exited = true;
        }
        void rsiNow;
      }

      // --- session loss-limit (decided at 30m close on realized+open profit) ---
      if (!exited && P.session_loss_limit > 0) {
        const openP = (posDir === 1 ? bar.c - entryPrice : entryPrice - bar.c) * YEN_PER_POINT;
        if (session_profit + openP <= -P.session_loss_limit) { closePosition(bar.c, bar.tClose - 60000, "LossLimit"); exited = true; }
      }
    }

    // ---- ENTRY DECISION at 30m bar CLOSE (fills next bar open) ----
    // Restrictions (computed at the decision bar's close time)
    const jpc = jstParts(bar.tClose - 60000); // last minute of bar
    const t_h = jpc.h, t_m = jpc.mi;
    const ban_1530 = (t_h === 15 && t_m >= 30) || (t_h === 5 && t_m >= 45) || t_h === 16 || (t_h === 6 || t_h === 7);
    const is_ban_active = P.fc_type === "15:30/05:45" ? ban_1530 : false;
    const is_base_restricted = t_h === 2 || t_h === 3 || t_h === 4 || (t_h === 5 && t_m <= 30);
    const is_loss_limit_hit = P.session_loss_limit > 0 && session_profit <= -P.session_loss_limit;
    const is_restricted = is_base_restricted || is_ban_active || is_loss_limit_hit;

    if (posDir === 0 && pendingEntry === null && !is_restricted) {
      // 30m bar is a 15m boundary -> always evaluate
      const subs5 = (fiveByKey.get(sessKey) || []).filter((fb) => fb.tClose <= bar.tClose && fb.t >= bar.t);
      const trig = computeTriggerState(subs5, L, P.entry_prox_ticks, P.max_bound_gap_ticks, P.rolling_bar_count, liveSessHigh, liveSessLow);

      // 1H pin bar disabled (use_1h_pinbar=false) — skip
      // o_type from open_15 block (rolling: open[rolling_bar_count-1] on 5m series = first 5m of this bar)
      const open15 = subs5.length >= P.rolling_bar_count ? subs5[subs5.length - P.rolling_bar_count].o : (subs5.length ? subs5[0].o : bar.o);
      const [o_type] = f_get_block_info_from_sorted(open15, curGLevels);

      // Filters
      const ind = ind5.lookup(bar.tClose);
      const adx = ind.adx, adxPrev = ind.adxPrev;
      const is_adx_slope_ok = P.use_adx_slope ? adx >= adxPrev : true;
      const is_adx_buy_ok = P.use_adx_filter ? (adx >= P.adx_thresh_buy && is_adx_slope_ok) : true;
      const is_adx_sell_ok = P.use_adx_filter ? (adx >= P.adx_thresh_sell && is_adx_slope_ok) : true;
      const htf = htf60.lookup(bar.tClose);
      const is_htf_buy_ok = P.use_htf_filter ? htf.close > htf.ma : true;
      const is_htf_sell_ok = P.use_htf_filter ? htf.close < htf.ma : true;

      let longSig = false, shortSig = false, sig = "";
      if (o_type === 0) {
        if (trig === 2 && is_adx_buy_ok && is_htf_buy_ok) { longSig = true; sig = "Brk"; }
        else if (trig === 1) { longSig = true; sig = "Rev"; }
      }
      if (o_type === 1) {
        if (trig === -2 && is_adx_sell_ok && is_htf_sell_ok) { shortSig = true; sig = "Brk"; }
        else if (trig === -1) { shortSig = true; sig = "Rev"; }
      }

      // Reversal extra filters (ADX max / RSI / HTF)
      let rev_ok = true;
      if (trig === 1 || trig === -1) {
        const adx5 = ind.adx, rsi5 = ind.rsi;
        if (P.use_rev_adx_filter && adx5 > P.rev_adx_max) rev_ok = false;
        if (P.use_rev_rsi_filter) {
          if (trig === 1 && rsi5 > P.rsi_os) rev_ok = false;
          if (trig === -1 && rsi5 < P.rsi_ob) rev_ok = false;
        }
        if (P.use_rev_htf_filter) {
          // uses close vs htf_ma_val; approximate close with bar close, htf_ma with htf.ma
          if (trig === 1 && bar.c < htf.ma) rev_ok = false;
          if (trig === -1 && bar.c > htf.ma) rev_ok = false;
        }
      }

      if (longSig && (sig !== "Rev" || rev_ok)) pendingEntry = { dir: 1, sig, isRev: sig === "Rev" };
      else if (shortSig && (sig !== "Rev" || rev_ok)) pendingEntry = { dir: -1, sig, isRev: sig === "Rev" };

      if (DEBUG_AT && bar.tClose - 60000 >= DEBUG_AT.from && bar.tClose - 60000 <= DEBUG_AT.to) {
        console.log(
          `[dbg] close=${ymd(bar.tClose - 60000)} barClose=${bar.c} trig=${trig} o_type=${o_type} ` +
          `adx=${isNaN(adx) ? "na" : adx.toFixed(1)} adxPrev=${isNaN(adxPrev) ? "na" : adxPrev.toFixed(1)} ` +
          `htfClose=${isNaN(htf.close) ? "na" : htf.close} htfMA=${isNaN(htf.ma) ? "na" : htf.ma.toFixed(0)} ` +
          `htfBuyOk=${is_htf_buy_ok} adxBuyOk=${is_adx_buy_ok} long=${longSig} short=${shortSig} sig=${sig} | ` +
          `R1=${fmtL(L.r1)} R2=${fmtL(L.r2)} R3=${fmtL(L.r3)} S1=${fmtL(L.s1)} S2=${fmtL(L.s2)} S3=${fmtL(L.s3)} open=${fmtL(L.s_open)}`
        );
      }
    }
  } // end 30m bars

  // Close any open position at end of data (mark-to-market at last close) — matches CSV "未決済"
  let openMtm = 0;
  if (posDir !== 0) {
    const last = bars1m[bars1m.length - 1];
    const pts = posDir === 1 ? last.c - entryPrice : entryPrice - last.c;
    openMtm = pts * YEN_PER_POINT;
    // record as open trade for reporting
    closePosition(last.c, last.t, "OpenMTM");
  }

  // Metrics
  const totalYen = cumYen;
  const nTrades = closed.length;
  const winRate = nTrades > 0 ? (wins / nTrades) * 100 : 0;
  return { closed, totalYen, nTrades, winRate, maxDD, openMtm, tag: opts.tag };
}

// ======================= BUY & HOLD =======================
function buyHold(bars1m: Bar[]): number {
  if (bars1m.length === 0) return 0;
  return (bars1m[bars1m.length - 1].c - bars1m[0].o);
}

// ======================= RUN =======================
let DEBUG_AT: { from: number; to: number } | null = null;
function fmtL(n: number): string { return isNaN(n) ? "na" : String(Math.round(n)); }
function fmt(n: number): string { return n.toLocaleString("en-US", { maximumFractionDigits: 0 }); }

function ymd(t: number): string {
  const p = jstParts(t);
  return `${p.y}-${String(p.mo).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`;
}

function main() {
  const mode = process.argv[2] || "phase1";
  const CAPITAL = 2_000_000;

  if (mode === "debug") {
    // npx tsx gem-port-backtest.mts debug 2025-10-01 2025-10-03
    const from = new Date((process.argv[3] || "2025-10-01") + "T00:00:00+09:00").getTime();
    const to = new Date((process.argv[4] || "2025-10-03") + "T23:59:00+09:00").getTime();
    DEBUG_AT = { from, to };
    const warmMs = from - 90 * 24 * 3600 * 1000;
    const bars = loadBars(warmMs, to + 5 * 24 * 3600 * 1000);
    runBacktest(bars, { startMs: from, endMs: to, tag: "debug" });
    return;
  }

  if (mode === "phase1") {
    const startMs = new Date("2025-06-13T00:00:00+09:00").getTime();
    const endMs = new Date("2026-06-13T23:59:00+09:00").getTime();
    // warmup: load ~60 sessions before start for hist arrays + indicators
    const warmMs = new Date("2025-03-01T00:00:00+09:00").getTime();
    const bars = loadBars(warmMs, endMs);
    const r = runBacktest(bars, { startMs, endMs, tag: "calib" });
    // filter trades to those entered >= startMs for reporting
    const tr = r.closed.filter((c) => c.entryT >= startMs);
    console.log("=== PHASE 1 CALIBRATION (2025-06-13 -> 2026-06-13) ===");
    console.log(`Trades (entered in window): ${tr.length}  | all closed in run: ${r.closed.length}`);
    let cum = 0, wins = 0;
    console.log("idx dir  entry(JST)         entryPx  exit(JST)          exitPx   sig   pnlYen     cumYen");
    for (const c of tr) {
      cum += c.profitYen; if (c.profitYen > 0) wins++;
      console.log(
        `${String(c.num).padStart(3)} ${c.dir === 1 ? "L" : "S"}   ${ymd(c.entryT).padEnd(17)} ${String(c.entryPrice).padStart(7)}  ${ymd(c.exitT).padEnd(17)} ${String(Math.round(c.exitPrice)).padStart(7)}  ${c.entrySig.padEnd(4)} ${String(Math.round(c.profitYen)).padStart(9)} ${String(Math.round(cum)).padStart(10)}`
      );
    }
    const pct = (cum / CAPITAL) * 100;
    console.log(`\nPort total (window trades): ¥${fmt(cum)}  = ${pct.toFixed(1)}% on ¥2M  | win% ${((wins / tr.length) * 100).toFixed(0)}`);
    console.log(`CSV reference: 33 trades, +¥5,607,900 = +280.4% on ¥2M`);
  } else if (mode === "phase2") {
    const windows: { tag: string; from: string; to: string }[] = [
      { tag: "2018", from: "2018-01-01", to: "2019-01-01" },
      { tag: "2018H2", from: "2018-07-01", to: "2019-01-01" },
      { tag: "2019", from: "2019-01-01", to: "2020-01-01" },
      { tag: "2020", from: "2020-01-01", to: "2021-01-01" },
      { tag: "2020crash", from: "2020-02-01", to: "2020-05-01" },
      { tag: "2021", from: "2021-01-01", to: "2022-01-01" },
      { tag: "2022", from: "2022-01-01", to: "2023-01-01" },
      { tag: "2023", from: "2023-01-01", to: "2024-01-01" },
      { tag: "2024", from: "2024-01-01", to: "2025-01-01" },
      { tag: "2025H1", from: "2025-01-01", to: "2025-07-01" },
      { tag: "calib25-26", from: "2025-06-13", to: "2026-06-13" },
      { tag: "FULL18-26", from: "2018-01-01", to: "2026-06-13" },
    ];
    console.log("=== PHASE 2 MULTI-REGIME OOS ===");
    console.log("window      strat¥        strat%   stratPts  #tr  win%  MDD¥        BH(1u)pts  BH¥        verdict");
    for (const w of windows) {
      const startMs = new Date(w.from + "T00:00:00+09:00").getTime();
      const endMs = new Date(w.to + "T23:59:00+09:00").getTime();
      const warmMs = startMs - 90 * 24 * 3600 * 1000; // 90d warmup
      const bars = loadBars(warmMs, endMs);
      const r = runBacktest(bars, { startMs, endMs, tag: w.tag });
      const tr = r.closed.filter((c) => c.entryT >= startMs);
      let cum = 0, wins = 0, peak = 0, mdd = 0;
      for (const c of tr) { cum += c.profitYen; if (c.profitYen > 0) wins++; if (cum > peak) peak = cum; if (peak - cum > mdd) mdd = peak - cum; }
      // BH for window (bars within window only)
      const winBars = bars.filter((b) => b.t >= startMs && b.t < endMs);
      const bhPts = buyHold(winBars);
      const bhYen = bhPts * YEN_PER_POINT;
      const pct = (cum / CAPITAL) * 100;
      const strPts = cum / YEN_PER_POINT;
      const beat = cum > bhYen ? "BEAT" : "lose";
      const pos = cum > 0 ? "+" : "";
      console.log(
        `${w.tag.padEnd(11)} ${(pos + fmt(cum)).padStart(12)} ${pct.toFixed(1).padStart(7)} ${fmt(strPts).padStart(9)} ${String(tr.length).padStart(4)} ${(tr.length ? (wins / tr.length * 100) : 0).toFixed(0).padStart(4)} ${fmt(mdd).padStart(11)} ${fmt(bhPts).padStart(10)} ${fmt(bhYen).padStart(11)}  ${pos && cum > 0 ? beat : "NEG"}`
      );
    }
    console.log("\nFull-span BH reference: 1-unit +44,620pt (¥4,462,000) ; 2-unit +89,240pt (¥8,924,000)");
  }
}

main();

