// gem-jp225-reproduce.mts
// Faithful TS port of Pine v6 `GEM_JP225_Strategy_B3_api_Day` to reproduce the
// TradingView backtest CSV (33 trades, 2025-06-13 -> 2026-06-13, +~280%).
//
// Run on 30-min OSE NK225-mini bars. Config: A3 ON; B2,B3,B5,B6 ON.
// A1,A2,A4 OFF; B1,B4 OFF; System C OFF. use_auto_select=false.
// Night short OFF. Day long+short ON, Night long ON.
//
// Data: backtest-multiyear.db bars_1m (symbol NIY=F = OSE NK225 mini 1-min).
//
// NOTE (no look-ahead): all HTF/security values (daily pivots, 60/15/480m pivots,
// 5m bundle) are computed from CLOSED higher-TF bars only. We reproduce Pine's
// `lookahead_on + [1]` non-repaint idiom by feeding each 30m bar's logic the
// value of the higher-TF series as of the LAST FULLY-CLOSED HTF bar strictly
// before the current 30m bar's open time. See htfValueAt().
//
// tsc-clean. NOT committed.

import XLSX from 'xlsx';
import { rowToBar } from '../server/basedataDate.js';
import { classifySession } from '../collector/session.js';

// ============================================================================
// DATA SOURCE = NATIVE pre-aggregated bars from the data book xlsx (the FIX).
// Previously this script self-aggregated 5m/15m/30m/60m from DB 1-min bars; the
// resulting indicators differed slightly from TradingView's at gate thresholds
// and cascaded through the carry-and-reverse model. TradingView's request.security()
// actually fetches the broker's native HTF bars, which are exactly the sheets in
// the data book (1min,3min,5min,10min,15min,20min,30min,60min + daily variants).
// So we now load those sheets DIRECTLY and feed them to the (unchanged) engine.
//
//  30min sheet -> chart/decision bars (entries decided at 30m close)
//  5min  sheet -> all 5m indicator series (RSI/ADX/MACD/MA20/EMA200/patterns/impulse)
//  60min sheet -> 60m pivots (3,3)
//  15min sheet -> 15m pivots (5,5) feeding GEM key zones
//  daily sheet -> daily pivot (prior-day H/L/C). DAILY_SHEET selects which native
//                 daily aggregate TradingView "D" matches (取引日日足 vs 終日日足).
//  1min  sheet -> bar-magnifier intrabar fills (attached as .mins to each 30m bar)
//
// 480min (8h) has NO native sheet -> still built from native 1m (documented).
// ============================================================================

const WIN_START = '2025-06-13';
const WIN_END   = '2026-06-13';

// Calibration window needs the 2025 + 2026 books. Each carries native sheets at
// every timeframe; we dedupe overlapping bars across files by timestamp.
const XLSX_FILES = [
  'C:/Users/user/Downloads/N225minif_2025/N225minif_2025.xlsx',
  'C:/Users/user/Downloads/N225minif_2026/N225minif_2026.xlsx',
];
// which native daily aggregate maps to TradingView "D" on this OSE futures chart.
// Tested both; see honest report. '取引日日足' (trading-day) first, then '終日日足'.
const DAILY_SHEET: '取引日日足' | '終日日足' = (process.env.DAILY_SHEET as any) || '取引日日足';

// ----- config (matches task) -----
const use_a_1 = false, use_a_2 = false, use_a_3 = true, use_a_4 = false;
const use_b_1 = false, use_b_2 = true, use_b_3 = true, use_b_4 = false, use_b_5 = true, use_b_6 = true;
const day_ab_long = true, day_ab_short = true, night_ab_long = true, night_ab_short = false;
const use_c = false;

// numerics
const GJ_LOOKBACK = 30;
const prox_ticks = 50;
const adx_min_buy = 18, adx_min_sell = 22, rev_adx_max = 35;
const rsi_ob_gj = 60, rsi_os_gj = 40;
const fixed_sl_yen = 55, tp_offset = 25;
const MINTICK = 5;
const gj_prox = prox_ticks * MINTICK; // 250

interface Bar1m { t: number; o: number; h: number; l: number; c: number; session: string; sdate: string; }
interface Bar { t: number; o: number; h: number; l: number; c: number; session: string; sdate: string; mins: Bar1m[]; }

function jstParts(t: number) {
  const d = new Date(t + 9 * 3600000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, day: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), sec: d.getUTCSeconds() };
}
function ymd(t: number) { const p = jstParts(t); return `${p.y}-${String(p.mo).padStart(2,'0')}-${String(p.day).padStart(2,'0')}`; }
function hm(t: number) { const p = jstParts(t); return `${String(p.h).padStart(2,'0')}:${String(p.mi).padStart(2,'0')}`; }
function dtstr(t: number) { return `${ymd(t)} ${hm(t)}`; }

// ============ load NATIVE bars from xlsx sheets ============
// Intraday sheets: 日付(excel serial) 時間(fraction) 始値 高値 安値 終値 出来高 (header row 0).
// rowToBar() maps (serial, frac) -> real epoch (same canonical mapping as the 1min import).
// classifySession() tags session/sessionDate identically to the DB import path.
// Bars outside any session (weekend/holiday/off-session) are skipped (importBars convention).
function loadIntraday(sheet: string): Bar[] {
  const out: Bar[] = [];
  const seen = new Set<number>();           // dedupe overlapping bars across the 2 books
  for (const f of XLSX_FILES) {
    const wb = XLSX.readFile(f, { cellDates: false });
    const ws = wb.Sheets[sheet];
    if (!ws) { console.error(`sheet "${sheet}" not found in ${f}`); process.exit(1); }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as any[][];
    for (let i = 1; i < rows.length; i++) {
      const [d, tm, o, h, l, c] = rows[i];
      if (typeof d !== 'number' || typeof tm !== 'number' || typeof o !== 'number') continue;
      const bb = rowToBar(d, tm, o, h, l, c, null);
      if (seen.has(bb.t)) continue; seen.add(bb.t);
      const s = classifySession(bb.t);
      if (!s) continue;                       // off-session / weekend / holiday
      out.push({ t: bb.t, o: bb.o, h: bb.h, l: bb.l, c: bb.c, session: s.session, sdate: s.sessionDate, mins: [] });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

// Native daily sheet: 日付(serial) 始値 高値 安値 終値 出来高 — serial IS the real calendar
// date (these aggregates are not session-offset; verified vs the chart). No time column.
function loadDaily(sheet: string): Bar[] {
  const out: Bar[] = [];
  const seen = new Set<string>();
  for (const f of XLSX_FILES) {
    const wb = XLSX.readFile(f, { cellDates: false });
    const ws = wb.Sheets[sheet];
    if (!ws) { console.error(`daily sheet "${sheet}" not found in ${f}`); process.exit(1); }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false }) as any[][];
    for (let i = 1; i < rows.length; i++) {
      const [d, o, h, l, c] = rows[i];
      if (typeof d !== 'number' || typeof o !== 'number') continue;
      // serial -> real date string + bar open time = JST 00:00 of that date (epoch)
      const dayMs = (d - 25569) * 86400_000;          // EXCEL_1970
      const t = dayMs - 9 * 3600_000;                 // JST midnight
      const dt = new Date(dayMs);
      const sd = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
      if (seen.has(sd)) continue; seen.add(sd);
      out.push({ t, o, h, l, c, session: 'D', sdate: sd, mins: [] });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

const bars30 = loadIntraday('30min');
const bars5  = loadIntraday('5min');
const bars15 = loadIntraday('15min');
const bars60 = loadIntraday('60min');
const barsD  = loadDaily(DAILY_SHEET);
// native 1m for (a) intrabar fills attached to each 30m bar and (b) the 480m series.
const m1 = loadIntraday('1min');

// attach native 1m sub-bars to each native 30m bar (bar-magnifier intrabar fills).
// bucket each 1m into its 30m slot key (sdate|session|slot-of-day); match the 30m bar
// occupying the same slot. (30m native bars open exactly on the JST 30-min grid.)
{
  const slotKey = (b: Bar) => {
    const p = jstParts(b.t); const mod = p.h * 60 + p.mi; const slot = Math.floor(mod / 30) * 30;
    return `${b.sdate}|${b.session}|${slot}`;
  };
  const by30 = new Map<string, Bar>();
  for (const b of bars30) by30.set(slotKey(b), b);
  for (const mb of m1) {
    const k = slotKey(mb);
    const host = by30.get(k);
    if (host) host.mins.push({ t: mb.t, o: mb.o, h: mb.h, l: mb.l, c: mb.c, session: mb.session, sdate: mb.sdate });
  }
  for (const b of bars30) b.mins.sort((a, c) => a.t - c.t);
}

// 480m (8h) — NO native sheet exists. Build from native 1m on the JST 8h grid.
// (documented simplification: only feeds gj_h8_9 highest/lowest-9, a coarse key-zone input.)
function build480(src: Bar1m[]): Bar[] {
  const map = new Map<string, Bar>(); const order: string[] = [];
  for (const b of src) {
    const p = jstParts(b.t); const mod = p.h * 60 + p.mi; const slot = Math.floor(mod / 480) * 480;
    const key = `${b.sdate}|${b.session}|${slot}`;
    let bar = map.get(key);
    if (!bar) {
      const slotH = Math.floor(slot / 60), slotMi = slot % 60;
      const dd = new Date(b.t + 9 * 3600000); dd.setUTCHours(slotH, slotMi, 0, 0);
      const slotT = dd.getTime() - 9 * 3600000;
      bar = { t: slotT, o: b.o, h: b.h, l: b.l, c: b.c, session: b.session, sdate: b.sdate, mins: [] };
      map.set(key, bar); order.push(key);
    } else { bar.h = Math.max(bar.h, b.h); bar.l = Math.min(bar.l, b.l); bar.c = b.c; }
  }
  return order.map(k => map.get(k)!).sort((a, b) => a.t - b.t);
}
const bars480 = build480(m1);

const m1InWin = m1.filter(b => ymd(b.t) >= WIN_START);
console.error(`native bars  30m:${bars30.length} 5m:${bars5.length} 15m:${bars15.length} 60m:${bars60.length} D:${barsD.length}(${DAILY_SHEET}) 480:${bars480.length} 1m:${m1.length}`);
const orphan30 = bars30.filter(b => b.mins.length === 0 && ymd(b.t) >= WIN_START).length;
console.error(`window: 1m=${m1InWin.length}, 30m bars with 0 intrabar fills (in-window): ${orphan30}`);

// ============ indicator helpers (computed per HTF series in time order) ============
function sma(arr: number[], i: number, len: number): number {
  if (i < len - 1) return NaN; let s = 0; for (let k = i - len + 1; k <= i; k++) s += arr[k]; return s / len;
}
function rma(prev: number, val: number, len: number): number { return (prev * (len - 1) + val) / len; }

// RSI(14), DMI/ADX(14,14), MACD(12,26,9), EMA(200), percentile_linear_interpolation(R,200,50)
// computed bar-by-bar over a series of OHLC.
interface Series5 { c:number[]; o:number[]; h:number[]; l:number[]; ma20:number[]; rsi:number[]; adx:number[]; macdL:number[]; macdS:number[]; ema200:number[]; baseR:number[]; t:number[]; }
function ema(prev: number, val: number, len: number) { const k = 2/(len+1); return val*k + prev*(1-k); }

function percentileLinInterp(window: number[], pct: number): number {
  // Pine ta.percentile_linear_interpolation(src, length, percentage)
  const arr = window.slice().sort((a,b)=>a-b);
  const n = arr.length;
  if (n === 0) return NaN;
  const rank = (pct/100) * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return arr[lo];
  return arr[lo] + (arr[hi]-arr[lo])*(rank-lo);
}

function computeSeries(bars: Bar[]): Series5 {
  const c = bars.map(b=>b.c), o = bars.map(b=>b.o), h = bars.map(b=>b.h), l = bars.map(b=>b.l), t = bars.map(b=>b.t);
  const n = bars.length;
  const ma20 = new Array(n).fill(NaN), rsi = new Array(n).fill(NaN), adx = new Array(n).fill(NaN);
  const macdL = new Array(n).fill(NaN), macdS = new Array(n).fill(NaN), ema200 = new Array(n).fill(NaN), baseR = new Array(n).fill(NaN);
  // MA20
  for (let i=0;i<n;i++) ma20[i]=sma(c,i,20);
  // RSI 14 (Wilder RMA)
  let avgGain=NaN, avgLoss=NaN;
  for (let i=1;i<n;i++){
    const ch=c[i]-c[i-1]; const g=Math.max(ch,0), ls=Math.max(-ch,0);
    if (i<=14){ if(i===1){avgGain=g;avgLoss=ls;} else {avgGain+=g;avgLoss+=ls;} if(i===14){avgGain/=14;avgLoss/=14; rsi[i]=avgLoss===0?100:100-100/(1+avgGain/avgLoss);} }
    else { avgGain=rma(avgGain,g,14); avgLoss=rma(avgLoss,ls,14); rsi[i]=avgLoss===0?100:100-100/(1+avgGain/avgLoss); }
  }
  // DMI/ADX (14,14) Wilder
  let smTR=NaN, smPDM=NaN, smMDM=NaN, adxPrev=NaN; const dxArr:number[]=[];
  for (let i=1;i<n;i++){
    const up=h[i]-h[i-1], dn=l[i-1]-l[i];
    const pDM=(up>dn&&up>0)?up:0, mDM=(dn>up&&dn>0)?dn:0;
    const tr=Math.max(h[i]-l[i], Math.abs(h[i]-c[i-1]), Math.abs(l[i]-c[i-1]));
    if (i<=14){ if(i===1){smTR=tr;smPDM=pDM;smMDM=mDM;} else {smTR+=tr;smPDM+=pDM;smMDM+=mDM;} }
    else { smTR=smTR-smTR/14+tr; smPDM=smPDM-smPDM/14+pDM; smMDM=smMDM-smMDM/14+mDM; }
    if (i>=14){
      const pDI=100*smPDM/smTR, mDI=100*smMDM/smTR;
      const dx=(pDI+mDI===0)?0:100*Math.abs(pDI-mDI)/(pDI+mDI);
      dxArr.push(dx);
      if (dxArr.length<14){ /* warming adx */ }
      else if (dxArr.length===14){ adxPrev=dxArr.reduce((a,b)=>a+b,0)/14; adx[i]=adxPrev; }
      else { adxPrev=(adxPrev*13+dx)/14; adx[i]=adxPrev; }
    }
  }
  // MACD 12/26/9
  let e12=NaN,e26=NaN,sig=NaN; const macdLine:number[]=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){ e12=isNaN(e12)?c[i]:ema(e12,c[i],12); e26=isNaN(e26)?c[i]:ema(e26,c[i],26); if(i>=25){ macdLine[i]=e12-e26; } }
  // signal ema9 of macdLine (start when macdLine valid)
  for(let i=0;i<n;i++){ if(!isNaN(macdLine[i])){ sig=isNaN(sig)?macdLine[i]:ema(sig,macdLine[i],9); macdL[i]=macdLine[i]; macdS[i]=sig; } }
  // EMA200
  let e200=NaN; for(let i=0;i<n;i++){ e200=isNaN(e200)?c[i]:ema(e200,c[i],200); if(i>=199) ema200[i]=e200; }
  // baseR = percentile_linear_interpolation(h-l, 200, 50) -> rolling median of range
  for(let i=0;i<n;i++){ if(i>=199){ const w:number[]=[]; for(let k=i-199;k<=i;k++) w.push(h[k]-l[k]); baseR[i]=percentileLinInterp(w,50); } }
  return { c,o,h,l,ma20,rsi,adx,macdL,macdS,ema200,baseR,t };
}

const s5 = computeSeries(bars5);

// ---- 30m CHART MA20 + crossunder/crossover (the FIX, root-cause of the divergence) ----
// In Pine, ta.crossunder(close, ma20)/ta.crossover are evaluated in the STRATEGY BODY on the
// CHART timeframe (here 30m), NOT via request.security("5",...). Only RSI/ADX/EMA200/MACD/patterns
// /impulse come from the 5m bundle. The prior port computed the MA20-cross on the 5m series sampled
// at the 30m close, which aliases out the actual cross event (it usually happens mid-30m-window) —
// that is exactly why the 2025-07-16 B_6 short never fired. We now compute it on bars30.
const c30arr = bars30.map(b=>b.c);
const ma20_30 = new Array(bars30.length).fill(NaN);
for (let i = 0; i < bars30.length; i++) ma20_30[i] = sma(c30arr, i, 20);
function crossUnder30(i: number): boolean { if (i < 20) return false; return bars30[i-1].c >= ma20_30[i-1] && bars30[i].c < ma20_30[i]; }
function crossOver30(i: number): boolean { if (i < 20) return false; return bars30[i-1].c <= ma20_30[i-1] && bars30[i].c > ma20_30[i]; }

// ---- pivots for 60m/15m ----
// ta.pivothigh(high,L,R): bar at i-R is pivot high if h[i-R] > all h in [i-2R..i] except itself.
function pivots(bars: Bar[], L: number, R: number): { tHigh:number[]; vHigh:number[]; tLow:number[]; vLow:number[]; t:number[] } {
  const h=bars.map(b=>b.h), l=bars.map(b=>b.l), t=bars.map(b=>b.t); const n=bars.length;
  // for each bar index produce the "confirmed pivot value at that bar" (pivot confirmed at bar i for candidate i-R)
  const vHigh=new Array(n).fill(NaN), vLow=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){
    const ci=i-R; if(ci-L<0||i>=n) continue;
    let isH=true, isL=true; const ph=h[ci], pl=l[ci];
    for(let k=ci-L;k<=ci+R;k++){ if(k===ci) continue; if(h[k]>=ph) isH=false; if(l[k]<=pl) isL=false; }
    if(isH) vHigh[i]=ph; if(isL) vLow[i]=pl;
  }
  return { tHigh:t, vHigh, tLow:t, vLow, t };
}
const piv60 = pivots(bars60, 3, 3);
const piv15 = pivots(bars15, 5, 5);

// ---- highest/lowest 9 on 480m (with [1]) ----
function hl9(bars: Bar[]) {
  const h=bars.map(b=>b.h), l=bars.map(b=>b.l), t=bars.map(b=>b.t); const n=bars.length;
  const hi=new Array(n).fill(NaN), lo=new Array(n).fill(NaN);
  for(let i=0;i<n;i++){ if(i-1>=8){ let mh=-Infinity,ml=Infinity; for(let k=i-9;k<=i-1;k++){ mh=Math.max(mh,h[k]); ml=Math.min(ml,l[k]); } hi[i]=mh; lo[i]=ml; } }
  return { t, hi, lo };
}
const h480 = hl9(bars480);

// ---- daily pivots (security "D" with [1]) ----
const dH = barsD.map(b=>b.h), dL = barsD.map(b=>b.l), dC = barsD.map(b=>b.c), dT = barsD.map(b=>b.t), dSD = barsD.map(b=>b.sdate);

// ============ HTF value lookup: last CLOSED bar strictly before time tt ============
// fixnan-style for pivots (carry forward last non-na confirmed value)
function lastClosedIndex(times: number[], tt: number): number {
  // largest i with times[i] < tt  (HTF bar closes at its open+period; we conservatively
  // require the HTF bar to have OPENED strictly before tt AND be a fully prior bar).
  // For lookahead_on+[1] non-repaint: value as of the previous completed HTF bar.
  let lo=0, hi=times.length-1, res=-1;
  while(lo<=hi){ const mid=(lo+hi)>>1; if(times[mid] < tt){ res=mid; lo=mid+1; } else hi=mid-1; }
  return res;
}
function carryForward(vals:number[], idx:number): number {
  for(let i=idx;i>=0;i--){ if(!isNaN(vals[i])) return vals[i]; } return NaN;
}
// For series whose value is the indicator AT that closed bar (no fixnan): take value at lastClosed index, but step back to a bar whose indicator is defined.
function valueAtClosed(times:number[], vals:number[], tt:number): number {
  const idx = lastClosedIndex(times, tt); if(idx<0) return NaN;
  for(let i=idx;i>=0;i--){ if(!isNaN(vals[i])) return vals[i]; } return NaN;
}

// ============ GEM helper functions (port) ============
function findBestCluster(keyZones:number[], histVals:number[], minP:number, maxP:number): number {
  let best=NaN, maxScore=-1;
  for(const p of keyZones){ if(isNaN(p)||p<minP||p>maxP) continue; let score=0;
    for(const ck of keyZones){ if(!isNaN(ck)&&Math.abs(ck-p)<=20) score++; }
    for(const ch of histVals){ if(!isNaN(ch)&&Math.abs(ch-p)<=20) score++; }
    if(score>maxScore){ maxScore=score; best=p; } }
  for(const p of histVals){ if(isNaN(p)||p<minP||p>maxP) continue; let score=0;
    for(const ck of keyZones){ if(!isNaN(ck)&&Math.abs(ck-p)<=20) score++; }
    for(const ch of histVals){ if(!isNaN(ch)&&Math.abs(ch-p)<=20) score++; }
    if(score>maxScore){ maxScore=score; best=p; } }
  return best;
}
function findResSup(ref:number, kz:number[], sessH:number, sessL:number, histH:number[], histL:number[]) {
  const GAP_MIN=100; let res1=NaN,res2=NaN,res3=NaN,sup1=NaN,sup2=NaN,sup3=NaN;
  const naF=(x:number)=>isNaN(x);
  // resistance
  const s_l_abv = (!naF(sessL)&&sessL>ref)?sessL:NaN;
  const s_h_abv = (!naF(sessH)&&sessH>ref)?sessH:NaN;
  let c1=NaN,c2=NaN;
  if(!naF(s_l_abv)&&!naF(s_h_abv)){ c1=s_l_abv<s_h_abv?s_l_abv:s_h_abv; c2=s_l_abv<s_h_abv?s_h_abv:s_l_abv; }
  else if(!naF(s_l_abv)) c1=s_l_abv; else if(!naF(s_h_abv)) c1=s_h_abv;
  if(!naF(c1)){ const d=c1-ref; if(d<400) res1=c1; else if(d<800) res2=c1; else res3=c1; }
  if(!naF(c2)){ const d=c2-ref; if(d<400){ if(naF(res1)) res1=c2; else res2=c2; } else if(d<800){ if(naF(res2)) res2=c2; else res3=c2; } else res3=c2; }
  if(naF(res1)){ let max_r1=ref+400; if(!naF(res2)) max_r1=Math.min(max_r1,res2-150); if(max_r1>ref+GAP_MIN) res1=findBestCluster(kz,histH,ref+GAP_MIN,max_r1);
    if(naF(res1)){ res1=Math.ceil((ref+100)/100)*100; if(!naF(res2)&&res1>res2-150) res1=res2-150; } }
  if(naF(res3)){ let min_r3=ref+800; if(!naF(res2)) min_r3=Math.max(min_r3,res2+150); else if(!naF(res1)) min_r3=Math.max(min_r3,res1+300); res3=findBestCluster(kz,histH,min_r3,ref+1500);
    if(naF(res3)){ const tt=ref+1000; res3=Math.floor(tt/100)*100; if(res3<min_r3) res3=min_r3; } }
  if(naF(res2)){ const min_r2=(naF(res1)?ref:res1)+150; const max_r2=(naF(res3)?ref+1000:res3)-150; if(max_r2>min_r2) res2=findBestCluster(kz,histH,min_r2,max_r2);
    if(naF(res2)){ const b1=naF(res1)?ref:res1; const b3=naF(res3)?ref+1000:res3; res2=Math.round((b1+b3)/2/50)*50; res2=Math.max(res2,min_r2); res2=Math.min(res2,max_r2); } }
  // support
  const s_h_bel=(!naF(sessH)&&sessH<ref)?sessH:NaN;
  const s_l_bel=(!naF(sessL)&&sessL<ref)?sessL:NaN;
  let k1=NaN,k2=NaN;
  if(!naF(s_h_bel)&&!naF(s_l_bel)){ k1=s_h_bel>s_l_bel?s_h_bel:s_l_bel; k2=s_h_bel>s_l_bel?s_l_bel:s_h_bel; }
  else if(!naF(s_h_bel)) k1=s_h_bel; else if(!naF(s_l_bel)) k1=s_l_bel;
  if(!naF(k1)){ const d=ref-k1; if(d<400) sup1=k1; else if(d<800) sup2=k1; else sup3=k1; }
  if(!naF(k2)){ const d=ref-k2; if(d<400){ if(naF(sup1)) sup1=k2; else sup2=k2; } else if(d<800){ if(naF(sup2)) sup2=k2; else sup3=k2; } else sup3=k2; }
  if(naF(sup1)){ let min_s1=ref-400; if(!naF(sup2)) min_s1=Math.max(min_s1,sup2+150); if(min_s1<ref-GAP_MIN) sup1=findBestCluster(kz,histL,min_s1,ref-GAP_MIN);
    if(naF(sup1)){ sup1=Math.floor((ref-100)/100)*100; if(!naF(sup2)&&sup1<sup2+150) sup1=sup2+150; } }
  if(naF(sup3)){ let max_s3=ref-800; if(!naF(sup2)) max_s3=Math.min(max_s3,sup2-150); else if(!naF(sup1)) max_s3=Math.min(max_s3,sup1-300); sup3=findBestCluster(kz,histL,ref-1500,max_s3);
    if(naF(sup3)){ const tt=ref-1000; sup3=Math.ceil(tt/100)*100; if(sup3>max_s3) sup3=max_s3; } }
  if(naF(sup2)){ const max_s2=(naF(sup1)?ref:sup1)-150; const min_s2=(naF(sup3)?ref-1000:sup3)+150; if(max_s2>min_s2) sup2=findBestCluster(kz,histL,min_s2,max_s2);
    if(naF(sup2)){ const b1=naF(sup1)?ref:sup1; const b3=naF(sup3)?ref-1000:sup3; sup2=Math.round((b1+b3)/2/50)*50; sup2=Math.min(sup2,max_s2); sup2=Math.max(sup2,min_s2); } }
  return { res1,res2,res3,sup1,sup2,sup3 };
}
function getMid(v1:number, v2:number, kz:number[]): number {
  if(isNaN(v1)||isNaN(v2)||Math.abs(v1-v2)<500) return NaN;
  const minV=Math.min(v1,v2), maxV=Math.max(v1,v2), mid=(v1+v2)/2;
  let best=NaN, minDst=1e9;
  for(const v of kz){ if(!isNaN(v)&&v>minV&&v<maxV){ const d=Math.abs(v-mid); if(d<minDst){ minDst=d; best=v; } } }
  return !isNaN(best)?best:mid;
}

// ============ Strategy engine ============
interface OpenTrade { id:string; dir:1|-1; qty:number; entry:number; t:number; }
interface ClosedTrade { entryId:string; exitSig:string; dir:1|-1; qty:number; entry:number; exit:number; tEntry:number; tExit:number; pnl:number; }
const openTrades: OpenTrade[] = [];
const closed: ClosedTrade[] = [];
let posSize = 0; // signed sum of qty
const PYRAMIDING = 2;

function netPos(){ return openTrades.reduce((s,o)=>s+o.dir*o.qty,0); }
function sameDirCount(dir:number){ return openTrades.filter(o=>o.dir===dir).length; }

// reservation orders (A stop/limit + B3 limit). Market entries (B5/B6/B2) fill at bar close.
interface ResOrder { id:string; dir:1|-1; kind:'stop'|'limit'|'market'; price:number; oca:string; }
let pendingA: ResOrder | null = null; // Group_A (only one A used = A3); oca cancel
let pendingB: ResOrder | null = null; // Group_B reservation (B3 limit); market handled inline

// Close all opposite-direction open trades at price p (reversal). Returns pnl.
function closeOpposite(newDir:number, price:number, sig:string, tt:number){
  for(let i=openTrades.length-1;i>=0;i--){ const o=openTrades[i];
    if(o.dir!==newDir){ const pnl=(price-o.entry)*o.dir*o.qty*100; // ¥100/pt
      closed.push({ entryId:o.id, exitSig:sig, dir:o.dir, qty:o.qty, entry:o.entry, exit:price, tEntry:o.t, tExit:tt, pnl });
      openTrades.splice(i,1);
    } }
}
function addEntry(id:string, dir:1|-1, price:number, tt:number){
  // close_entries_rule=ANY + OCA: opposite signal closes existing opposite pos first.
  if(posSize!==0 && Math.sign(posSize)!==dir){ closeOpposite(dir, price, id, tt); }
  // pyramiding limit
  if(sameDirCount(dir) >= PYRAMIDING) return;
  openTrades.push({ id, dir, qty:1, entry:price, t:tt });
  posSize = netPos();
}

// ============ main loop over 30m bars ============
// GEM session state
let gj_in_sess=false, gj_sess_type=''; let gj_s_high=NaN, gj_s_low=NaN;
const gj_hist_h:number[]=[], gj_hist_l:number[]=[], gj_hist_r1:number[]=[], gj_hist_s1:number[]=[];
const gj_hist_r2:number[]=[], gj_hist_r3:number[]=[], gj_hist_s2:number[]=[], gj_hist_s3:number[]=[];
let gj_r1=NaN,gj_r2=NaN,gj_r3=NaN,gj_s1=NaN,gj_s2=NaN,gj_s3=NaN,gj_r05=NaN,gj_s05=NaN,gj_ref=NaN;
// A/B levels
let a_3_lower=NaN,a_3_upper=NaN,a_3_entry=NaN,a_3_tp=NaN,a_3_sl=NaN;
let b_2_entry=NaN,b_2_tp=NaN,b_2_sl=NaN, b_3_entry=NaN,b_3_tp=NaN,b_3_sl=NaN;
let b_5_entry=NaN,b_5_tp=NaN,b_5_sl=NaN, b_6_entry=NaN,b_6_tp=NaN,b_6_sl=NaN;

// per-session ordered flags (reset at is_session_start_time). On 30m, 17:00 hits grid;
// 08:45 does NOT — but we still reset at the first bar of each session (the partial 08:45 slot
// produces a bar whose first 1m is 08:45). We faithfully gate reset by the Pine rule below.
let is_a3_ordered=false, is_b2_ordered=false, is_b3_ordered=false, is_b5_ordered=false, is_b6_ordered=false;

// For 5m-derived booleans we need previous-bar values: track prev close_5m/open_5m for engulfing & crossovers
function pushHist(){
  gj_hist_h.unshift(gj_s_high); gj_hist_l.unshift(gj_s_low);
  gj_hist_r1.unshift(gj_r1); gj_hist_r2.unshift(gj_r2); gj_hist_r3.unshift(gj_r3);
  gj_hist_s1.unshift(gj_s1); gj_hist_s2.unshift(gj_s2); gj_hist_s3.unshift(gj_s3);
  if(gj_hist_h.length>GJ_LOOKBACK){ [gj_hist_h,gj_hist_l,gj_hist_r1,gj_hist_r2,gj_hist_r3,gj_hist_s1,gj_hist_s2,gj_hist_s3].forEach(a=>a.pop()); }
}

// 5m value lookup helpers keyed by 30m bar time. We need the 5m bundle value as of the
// last CLOSED 5m bar before the 30m bar close. But conditions use close_5m etc evaluated
// at "current" — Pine security with lookahead_on returns current HTF bar's value (repainting
// avoided only by [1] idiom). The script uses lookahead_on WITHOUT [1] for f_5m_bundle,
// meaning on the realtime/confirmed bar it returns the 5m value aligned to that bar. For a
// 30m bar closing at time T, the contained 5m bars close at T (last one). We use the 5m bar
// that closes AT the 30m close (i.e. last 5m sub-bar) => value "as of 30m close".
function fiveMAtClose(tt30close:number){
  // last 5m bar with t < tt30close ... but the 5m bar that ENDS at tt30close has t = tt30close-5min.
  // We want the 5m bar whose close == 30m close => its open t = tt30close - 5min.
  const idx = lastClosedIndex(s5.t, tt30close); // last 5m bar opened before 30m close
  return idx;
}

// engulfing/cross need 5m index and its predecessor
function evalCond(i5:number){
  const c=s5.c[i5], o=s5.o[i5], h=s5.h[i5], l=s5.l[i5];
  const cp=s5.c[i5-1], op=s5.o[i5-1];
  const ma20=s5.ma20[i5], ma20p=s5.ma20[i5-1];
  const rsi=s5.rsi[i5], adx=s5.adx[i5], adxp=s5.adx[i5-1];
  const macdL=s5.macdL[i5], macdS=s5.macdS[i5], ema200=s5.ema200[i5];
  const is_bull=c>o, is_bear=c<o, is_bull_p=cp>op, is_bear_p=cp<op;
  const body=Math.abs(c-o), lower_wick=Math.min(c,o)-l, upper_wick=h-Math.max(c,o);
  const eng_bear=is_bear&&is_bull_p&&o>cp&&c<op;
  const eng_bull=is_bull&&is_bear_p&&o<cp&&c>op;
  const cross_under=(cp>=ma20p)&&(c<ma20); // crossunder close vs ma20
  const cross_over=(cp<=ma20p)&&(c>ma20);
  const adx_rising=adx>adxp;
  const macd_bull=macdL>macdS, macd_bear=macdL<macdS;
  const uptrend=c>ema200, dntrend=c<ema200;
  // impulse 5m
  const R5=h-l, body5=Math.abs(c-o), baseR=s5.baseR[i5];
  const imp_cmn=!isNaN(baseR)&&R5>=3.2*baseR&&body5>=0.6*R5;
  const impUp=imp_cmn&&c>o&&(c-l)>=0.8*R5;
  const impDn=imp_cmn&&c<o&&(h-c)>=0.8*R5;
  return { c,o,h,l,ma20,rsi,adx,ema200,adx_rising,macd_bull,macd_bear,uptrend,dntrend,
    eng_bear,eng_bull,body,lower_wick,upper_wick,cross_under,cross_over,impUp,impDn };
}

const trace:string[]=[];
let inWindow=false;

for(let bi=0; bi<bars30.length; bi++){
  const bar=bars30[bi];
  const closeT = bar.t + 30*60000; // bar close time (next 30m boundary)
  const p=jstParts(bar.t);
  const isDay = bar.session==='Day';
  const isNight = bar.session==='Night';

  // ---- GEM session detection ----
  let gj_sess_start=false;
  if(isDay){
    if(!gj_in_sess){ gj_sess_start=true; gj_sess_type='DAY'; gj_in_sess=true; gj_s_high=bar.h; gj_s_low=bar.l; }
    else if(gj_sess_type==='NIGHT'){ pushHist(); gj_sess_start=true; gj_sess_type='DAY'; gj_s_high=bar.h; gj_s_low=bar.l; }
    else { gj_s_high=Math.max(gj_s_high,bar.h); gj_s_low=Math.min(gj_s_low,bar.l); }
  } else if(isNight){
    if(!gj_in_sess){ gj_sess_start=true; gj_sess_type='NIGHT'; gj_in_sess=true; gj_s_high=bar.h; gj_s_low=bar.l; }
    else if(gj_sess_type==='DAY'){ pushHist(); gj_sess_start=true; gj_sess_type='NIGHT'; gj_s_high=bar.h; gj_s_low=bar.l; }
    else { gj_s_high=Math.max(gj_s_high,bar.h); gj_s_low=Math.min(gj_s_low,bar.l); }
  }

  // ---- key zones (HTF security, non-repaint) evaluated at bar close ----
  // daily pivots use [high[1],low[1],close[1]] with lookahead_on => previous completed daily bar.
  const dIdx = lastClosedIndex(dT, bar.t); // last daily bar opened before current 30m bar
  // [1] => use the daily bar BEFORE dIdx (previous day's HLC). lookahead_on+[1] non-repaint.
  const useDIdx = dIdx-1>=0 ? dIdx-1 : -1;
  let gj_d_p=NaN,gj_d_r1=NaN,gj_d_s1=NaN,gj_d_r2=NaN,gj_d_s2=NaN;
  if(useDIdx>=0){ const H=dH[useDIdx],L=dL[useDIdx],C=dC[useDIdx]; gj_d_p=(H+L+C)/3; gj_d_r1=2*gj_d_p-L; gj_d_s1=2*gj_d_p-H; gj_d_r2=gj_d_p+H-L; gj_d_s2=gj_d_p-(H-L); }
  const gj_lpivh60=carryForward(piv60.vHigh, lastClosedIndex(piv60.t, bar.t));
  const gj_lpivl60=carryForward(piv60.vLow,  lastClosedIndex(piv60.t, bar.t));
  const gj_lpivh15=carryForward(piv15.vHigh, lastClosedIndex(piv15.t, bar.t));
  const gj_lpivl15=carryForward(piv15.vLow,  lastClosedIndex(piv15.t, bar.t));
  const i480=lastClosedIndex(h480.t, bar.t);
  const gj_h8_9 = i480>=0?h480.hi[i480]:NaN, gj_l8_9 = i480>=0?h480.lo[i480]:NaN;
  const gj_kz:number[]=[];
  gj_kz.push(gj_d_p,gj_d_r1,gj_d_s1,gj_d_r2,gj_d_s2);
  if(!isNaN(gj_lpivh60)) gj_kz.push(gj_lpivh60);
  if(!isNaN(gj_lpivl60)) gj_kz.push(gj_lpivl60);
  if(!isNaN(gj_lpivh15)) gj_kz.push(gj_lpivh15);
  if(!isNaN(gj_lpivl15)) gj_kz.push(gj_lpivl15);
  gj_kz.push(gj_h8_9,gj_l8_9);

  // ---- 5m bundle as of bar close ----
  const i5 = fiveMAtClose(closeT);
  const F = (i5>=1)?evalCond(i5):null;
  // NOTE: MA20-cross source is ambiguous in the Pine (5m bundle vs 30m chart). Toggle via env.
  // CROSS30=1 uses the 30m CHART crossunder/crossover (crossUnder30/Over30); default = 5m sample.
  // Empirically NEITHER reproduces the CSV cleanly (5m under-fires the 07-16 event; 30m over-fires
  // in chop). See honest report. Kept as a switch for the leader to probe.
  if(F && process.env.CROSS30){ F.cross_under = crossUnder30(bi); F.cross_over = crossOver30(bi); }

  // ---- session start: compute GEM levels + A/B levels ----
  if(gj_sess_start){
    gj_ref = bar.o;
    const prev_h = gj_hist_h.length>0?gj_hist_h[0]:NaN;
    const prev_l = gj_hist_l.length>0?gj_hist_l[0]:NaN;
    const rs = findResSup(gj_ref, gj_kz, prev_h, prev_l, gj_hist_h, gj_hist_l);
    gj_r1=rs.res1; gj_r2=rs.res2; gj_r3=rs.res3; gj_s1=rs.sup1; gj_s2=rs.sup2; gj_s3=rs.sup3;
    gj_r05=getMid(gj_ref,gj_r1,gj_kz); gj_r05=gj_r05; // r15 unused for active set
    gj_s05=getMid(gj_ref,gj_s1,gj_kz);
    // A3
    a_3_lower=gj_s1-gj_prox*3; a_3_upper=gj_s1+gj_prox*2; a_3_entry=gj_s1;
    a_3_tp = !isNaN(gj_r1)?gj_r1-tp_offset:gj_ref-tp_offset; a_3_sl=gj_s1-fixed_sl_yen;
    // B2
    b_2_entry=gj_s1; b_2_tp=!isNaN(gj_s2)?gj_s2+tp_offset:gj_s1-400; b_2_sl=gj_s1+fixed_sl_yen;
    // B3
    b_3_entry=gj_s1; b_3_tp=!isNaN(gj_r05)?gj_r05-tp_offset:gj_ref-tp_offset; b_3_sl=gj_s1-fixed_sl_yen;
    // B5
    b_5_entry = !isNaN(gj_s05)?gj_s05:((!isNaN(gj_ref)&&!isNaN(gj_s1))?(gj_ref+gj_s1)/2:NaN);
    b_5_tp = !isNaN(gj_r1)?gj_r1-tp_offset:gj_ref+400; b_5_sl=!isNaN(b_5_entry)?b_5_entry-fixed_sl_yen:NaN;
    // B6
    b_6_entry = !isNaN(gj_r05)?gj_r05:((!isNaN(gj_ref)&&!isNaN(gj_r1))?(gj_ref+gj_r1)/2:NaN);
    b_6_tp = !isNaN(gj_s1)?gj_s1+tp_offset:gj_ref-400; b_6_sl=!isNaN(b_6_entry)?b_6_entry+fixed_sl_yen:NaN;
  }

  // ---- is_session_start_time reset (Pine): (8:45 or 17:00) & sec<15 ----
  // first 1m of session has the :45/:00 minute. On the 30m bar, check if it contains it.
  const firstMin = bar.mins[0];
  const fp = jstParts(firstMin.t);
  const is_session_start_time = ((fp.h===8&&fp.mi===45)||(fp.h===17&&fp.mi===0));
  // Pine resets is_*_ordered at session start but does NOT cancel reservation orders here
  // (cancel_all only at is_cancel_time=15:38/05:53, which never occurs on 30m bars).
  // So pending A/B reservation orders PERSIST across the session boundary and can fill on
  // the session-start bar. Do NOT clear pendingA/pendingB here.
  if(is_session_start_time){ is_a3_ordered=false; is_b2_ordered=false; is_b3_ordered=false; is_b5_ordered=false; is_b6_ordered=false; }

  // window gating for reporting (process logic across whole loaded range to warm history,
  // but only count trades whose entry is within window). Pine runs from chart start; the CSV
  // window is set by the strategy's backtest range. We emulate by only RECORDING trades in window.
  if(ymd(bar.t) >= WIN_START) inWindow=true;

  // ---- effective switches ----
  const inMaster = isDay || isNight; // A/B run whenever in a GEM session master (day/night)
  const ab_can_long = isDay?day_ab_long:night_ab_long;
  const ab_can_short = isDay?day_ab_short:night_ab_short;
  const eff_a3 = use_a_3 && ab_can_long;
  const eff_b2 = use_b_2 && ab_can_short;
  const eff_b3 = use_b_3 && ab_can_long;
  const eff_b5 = use_b_5 && ab_can_long;
  const eff_b6 = use_b_6 && ab_can_short;

  // ---- FIRST: process reservation orders against THIS bar's 1m sub-bars (intrabar fills) ----
  // Pine process_orders_on_close=true + bar magnifier: reservation orders placed on prior bars
  // get checked intrabar on the current bar. We fill at the reservation price when touched.
  function tryFillRes(res:ResOrder|null): ResOrder|null {
    if(!res) return res;
    for(const mb of bar.mins){
      let fill=false, fp2=res.price;
      if(res.kind==='stop'){ if(res.dir===1 && mb.h>=res.price) {fill=true;} else if(res.dir===-1 && mb.l<=res.price){fill=true;} }
      else if(res.kind==='limit'){ if(res.dir===1 && mb.l<=res.price){fill=true;} else if(res.dir===-1 && mb.h>=res.price){fill=true;} }
      // TradingView timestamps the fill at the 30m BAR open (bar.t), not the 1m sub-bar.
      if(fill){ addEntry(res.id, res.dir, fp2, bar.t); return null; }
    }
    return res;
  }
  pendingA = tryFillRes(pendingA);
  pendingB = tryFillRes(pendingB);

  // ---- gj_sess_start bar clears all cond (no entries on session-start bar) ----
  if(!gj_sess_start && F && inMaster){
    const cc5 = F.c;     // close_5m (used inside cond_*/exit_cond_* per Pine)
    const cc30 = bar.c;  // 30m chart close (used in the unqualified `close` entry filters)
    // exit conds (Pine uses close_5m)
    const exit_cond_b2 = !isNaN(gj_s1) && cc5>gj_s1;
    const exit_cond_b3 = !isNaN(gj_s1) && cc5<gj_s1-fixed_sl_yen;
    const exit_cond_b5 = F.cross_under || (!isNaN(gj_s1)&&cc5<gj_s1);
    const exit_cond_b6 = F.cross_over || (!isNaN(gj_r1)&&cc5>gj_r1);

    // --- A3 (S1 stop-buy) reservation. cond uses close_5m; entry filter `close < a_3_entry` uses 30m close ---
    const cond_a3 = !isNaN(gj_s1)&&!isNaN(a_3_lower) && a_3_lower<=cc5 && cc5<a_3_upper
      && (F.rsi<rsi_os_gj || F.eng_bull) && F.adx>adx_min_buy;
    if(eff_a3 && cond_a3 && cc30<a_3_entry && !is_a3_ordered){
      pendingA = { id:'A_Bull', dir:1, kind:'stop', price:a_3_entry, oca:'A' };
      is_a3_ordered=true;
    }

    // --- DIAG: trace cond_b6 sub-conditions on flagged days ---
    if(process.env.TRACE_B6 && ymd(bar.t)===process.env.TRACE_B6){
      const cb6 = cond_b6(F,gj_r1,gj_ref);
      console.error(`[B6 ${dtstr(bar.t)} ${bar.session}] cc30=${cc30} r1=${gj_r1} ref=${gj_ref} b6entry=${b_6_entry} b6tp=${b_6_tp} | `+
        `5m c=${F.c} rsi=${F.rsi?.toFixed(1)} adx=${F.adx?.toFixed(1)} ema200=${F.ema200?.toFixed?.(0)??'?'} dn=${F.dntrend} xUnder=${F.cross_under} | `+
        `cond=${cb6} subs[c<r1=${F.c<gj_r1} c<ref=${F.c<gj_ref} xUnder=${F.cross_under} dn=${F.dntrend} rsi35-60=${F.rsi<60&&F.rsi>35}] `+
        `filt[cc30<b6entry=${cc30<b_6_entry} cc30>b6tp+50=${cc30>b_6_tp+50} !exitB6=${!exit_cond_b6}] b6ord=${is_b6_ordered}`);
    }
    // --- B reservations / market (mutually exclusive else-if chain in Pine). Filters use 30m close. ---
    if(eff_b2 && !is_b2_ordered && cc30>b_2_tp+50 && cc30<b_2_entry && !exit_cond_b2
        && cond_b2(F,gj_s1)){
      addEntry('B_2', -1, cc30, bar.t); is_b2_ordered=true; // market fills at 30m close
    }
    else if(eff_b3 && !is_b3_ordered && cc30<b_3_tp-50 && cc30>b_3_entry && !exit_cond_b3
        && cond_b3(F,gj_s1)){
      pendingB = { id:'B_3', dir:1, kind:'limit', price:b_3_entry, oca:'B' }; is_b3_ordered=true;
    }
    else if(eff_b5 && !is_b5_ordered && cc30<b_5_tp-50 && cc30>b_5_entry && !exit_cond_b5
        && cond_b5(F,gj_s1,gj_ref)){
      addEntry('B_5_Mkt', 1, cc30, bar.t); is_b5_ordered=true;
    }
    else if(eff_b6 && !is_b6_ordered && cc30<b_6_entry && cc30>b_6_tp+50 && !exit_cond_b6
        && cond_b6(F,gj_r1,gj_ref)){
      addEntry('B_6_Mkt', -1, cc30, bar.t); is_b6_ordered=true;
    }
  }
}

function cond_b2(F:any, s1:number){ return !isNaN(s1)&&F.c<s1&&F.impDn&&F.dntrend&&F.adx>adx_min_sell&&F.adx_rising&&F.rsi<50&&F.macd_bear; }
function cond_b3(F:any, s1:number){ return !isNaN(s1)&&F.c>=s1-gj_prox&&F.c<=s1+gj_prox&&F.rsi<rsi_os_gj&&(F.eng_bull||F.lower_wick>F.body*2.0)&&F.adx<rev_adx_max; }
function cond_b5(F:any, s1:number, ref:number){ return !isNaN(ref)&&!isNaN(s1)&&F.c>s1&&F.c>ref&&F.cross_over&&F.uptrend&&F.rsi>40&&F.rsi<65; }
function cond_b6(F:any, r1:number, ref:number){ return !isNaN(ref)&&!isNaN(r1)&&F.c<r1&&F.c<ref&&F.cross_under&&F.dntrend&&F.rsi<60&&F.rsi>35; }

// ============ report ============
const inWin = closed.filter(c=> ymd(c.tEntry) >= WIN_START && ymd(c.tEntry) <= WIN_END);
let cum=0;
console.log('\n=== PORT trades (entry within window) ===');
console.log('# | entry dt | dir | sig | entryPx -> exit dt | exitSig | exitPx | pnl | cum');
for(let i=0;i<closed.length;i++){ const c=closed[i]; if(ymd(c.tEntry)<WIN_START) continue; cum+=c.pnl;
  console.log(`${i+1} | ${dtstr(c.tEntry)} | ${c.dir>0?'L':'S'} | ${c.entryId} | ${c.entry} -> ${dtstr(c.tExit)} | ${c.exitSig} | ${c.exit} | ${c.pnl} | ${cum}`);
}
// open positions at end
console.log('\n=== still-open at end ===');
for(const o of openTrades){ console.log(`${o.id} ${o.dir>0?'L':'S'} @${o.entry} ${dtstr(o.t)}`); }
const lastPx = bars30[bars30.length-1].c;
let openPnl=0; for(const o of openTrades){ openPnl+=(lastPx-o.entry)*o.dir*o.qty*100; }
console.log(`\nclosed trades in window: ${inWin.length}, realized cum: ¥${cum}, open MTM @${lastPx}: ¥${openPnl}`);
console.log(`total (realized+open): ¥${cum+openPnl} on ¥2,000,000 = ${((cum+openPnl)/2000000*100).toFixed(1)}%`);

// ============ CSV reference (from reference CSV, 33 trades) ============
// entryDate, dir, entrySig, entryPx, exitDate, exitSig, exitPx, pnl
const CSV: [string,string,string,number,string,string,number,number][] = [
 ['2025-06-13','L','A_Bull',37955,'2025-07-07','B_6_Mkt',39685,172600],
 ['2025-06-17','L','B_5_Mkt',38475,'2025-07-07','B_6_Mkt',39685,120600],
 ['2025-07-07','S','B_6_Mkt',39685,'2025-07-07','A_Bull',39615,6600],
 ['2025-07-07','L','A_Bull',39615,'2025-07-16','B_6_Mkt',39730,11100],
 ['2025-07-09','L','A_Bull',39810,'2025-07-16','B_6_Mkt',39730,-8400],
 ['2025-07-16','S','B_6_Mkt',39730,'2025-07-18','B_3',39800,-7400],
 ['2025-07-18','L','B_3',39800,'2025-07-25','B_6_Mkt',41700,189600],
 ['2025-07-25','S','B_6_Mkt',41700,'2025-07-25','B_5_Mkt',41630,6600],
 ['2025-07-25','L','B_5_Mkt',41630,'2025-09-26','B_6_Mkt',45375,374100],
 ['2025-07-31','L','A_Bull',41250,'2025-09-26','B_6_Mkt',45375,412100],
 ['2025-09-26','S','B_6_Mkt',45375,'2025-09-30','B_3',44925,44600],
 ['2025-09-30','L','B_3',44925,'2025-09-30','B_2',44965,3600],
 ['2025-09-30','L','A_Bull',45045,'2025-09-30','B_2',44965,-16800],
 ['2025-09-30','S','B_2',44965,'2025-10-02','A_Bull',44870,9100],
 ['2025-10-01','S','B_6_Mkt',44725,'2025-10-02','A_Bull',44870,-14900],
 ['2025-10-02','L','A_Bull',44870,'2025-10-30','B_6_Mkt',51155,628100],
 ['2025-10-08','L','B_5_Mkt',48130,'2025-10-30','B_6_Mkt',51155,302100],
 ['2025-10-30','S','B_6_Mkt',51155,'2025-11-05','A_Bull',50385,76600],
 ['2025-11-05','L','A_Bull',50385,'2025-12-11','B_2',50615,22600],
 ['2025-11-06','L','A_Bull',51025,'2025-12-11','B_2',50615,-41400],
 ['2025-12-11','S','B_2',50615,'2025-12-17','A_Bull',49460,115100],
 ['2025-12-17','L','A_Bull',49460,'2026-01-15','B_6_Mkt',53795,433100],
 ['2026-01-13','L','A_Bull',53775,'2026-01-15','B_6_Mkt',53795,1600],
 ['2026-01-15','S','B_6_Mkt',53795,'2026-01-16','A_Bull',53965,-17400],
 ['2026-01-16','L','A_Bull',53965,'2026-03-03','B_6_Mkt',57450,348100],
 ['2026-01-19','L','A_Bull',53305,'2026-03-03','B_6_Mkt',57450,414100],
 ['2026-03-03','S','B_6_Mkt',57450,'2026-03-03','A_Bull',57370,7600],
 ['2026-03-03','L','A_Bull',57370,'2026-04-28','B_6_Mkt',60390,301600],
 ['2026-03-09','L','A_Bull',52105,'2026-04-28','B_6_Mkt',60390,828100],
 ['2026-04-28','S','B_6_Mkt',60390,'2026-05-01','B_3',59415,97100],
 ['2026-04-29','S','B_6_Mkt',59285,'2026-05-01','B_3',59415,-13400],
 ['2026-05-01','L','B_3',59415,'2026-06-13','未決済',67435,801600],
 ['2026-05-12','L','A_Bull',62750,'2026-06-13','未決済',67435,468100],
];
const csvCum = CSV.reduce((s,t)=>s+t[7],0);
console.log(`\n=== CSV reference: ${CSV.length} trades, cum PnL ¥${csvCum} = ${(csvCum/2000000*100).toFixed(1)}% ===`);

// build PORT legs as ordered list (closed in-window + still-open marked unrealized)
interface Leg { entryDate:string; dir:string; sig:string; entryPx:number; exitDate:string; exitSig:string; exitPx:number; pnl:number; }
const portLegs: Leg[] = [];
for(const c of closed){ if(ymd(c.tEntry)<WIN_START) continue;
  portLegs.push({ entryDate:ymd(c.tEntry), dir:c.dir>0?'L':'S', sig:c.entryId, entryPx:c.entry, exitDate:ymd(c.tExit), exitSig:c.exitSig, exitPx:c.exit, pnl:c.pnl }); }
for(const o of openTrades){ portLegs.push({ entryDate:ymd(o.t), dir:o.dir>0?'L':'S', sig:o.id, entryPx:o.entry, exitDate:'OPEN', exitSig:'未決済', exitPx:lastPx, pnl:(lastPx-o.entry)*o.dir*o.qty*100 }); }
portLegs.sort((a,b)=> a.entryDate<b.entryDate?-1:a.entryDate>b.entryDate?1:0);

console.log('\n=== SIDE-BY-SIDE (CSV vs PORT) by sequence ===');
console.log('idx | CSV: entry dir sig px -> exit sig px pnl | PORT: entry dir sig px -> exit sig px pnl | match?');
const N=Math.max(CSV.length, portLegs.length);
let matched=0;
for(let i=0;i<N;i++){
  const cv=CSV[i], pl=portLegs[i];
  const cstr = cv? `${cv[0]} ${cv[1]} ${cv[2]} ${cv[3]} -> ${cv[4]} ${cv[5]} ${cv[6]} ${cv[7]}` : '—';
  const pstr = pl? `${pl.entryDate} ${pl.dir} ${pl.sig} ${pl.entryPx} -> ${pl.exitDate} ${pl.exitSig} ${pl.exitPx} ${Math.round(pl.pnl)}` : '—';
  // match heuristic: same direction & same entry signal & entry date within 7 days
  let ok=false;
  if(cv&&pl&&cv[1]===pl.dir&&cv[2]===pl.sig){
    const d1=new Date(cv[0]).getTime(), d2=new Date(pl.entryDate).getTime();
    if(Math.abs(d1-d2)<=7*86400000) ok=true;
  }
  if(ok) matched++;
  console.log(`${String(i+1).padStart(2)} | ${cstr.padEnd(54)} | ${pstr.padEnd(58)} | ${ok?'Y':' '}`);
}
console.log(`\nSequence matches (dir+sig+<=7d): ${matched}/${CSV.length}`);
console.log(`PORT total ${((cum+openPnl)/2000000*100).toFixed(1)}% vs CSV ${(csvCum/2000000*100).toFixed(1)}%  (ratio ${((cum+openPnl)/csvCum*100).toFixed(0)}%)`);
