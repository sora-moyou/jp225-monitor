// Yahoo Chart API を直接呼び出して NK=F / ^N225 / JPY=X の日足を取得 → OANDA と比較
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  return lines.slice(1).map(l => {
    const [time, open, high, low, close] = l.split(',');
    return { time: +time, open: +open, high: +high, low: +low, close: +close };
  });
}

function rollupToDaily(rows) {
  const byDate = new Map();
  for (const r of rows) {
    const date = new Date(r.time * 1000).toISOString().slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(r);
  }
  const result = [];
  for (const [date, arr] of byDate) {
    arr.sort((a, b) => a.time - b.time);
    result.push({
      date,
      open: arr[0].open,
      high: Math.max(...arr.map(r => r.high)),
      low: Math.min(...arr.map(r => r.low)),
      close: arr[arr.length - 1].close,
    });
  }
  return result;
}

async function fetchYahoo(sym, period1, period2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) return [];
  const times = result.timestamp ?? [];
  const ohlc = result.indicators?.quote?.[0] ?? {};
  return times.map((t, i) => ({
    date: new Date(t * 1000).toISOString().slice(0, 10),
    open: ohlc.open?.[i],
    high: ohlc.high?.[i],
    low: ohlc.low?.[i],
    close: ohlc.close?.[i],
  })).filter(r => r.close != null);
}

// OANDA 1分データ
const oandaJpy = rollupToDaily(loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 1.csv'))[0];
const oandaUsd = rollupToDaily(loadCsv('C:/Users/user/Downloads/OANDA_JP225USD, 1.csv'))[0];
const oandaFx = rollupToDaily(loadCsv('C:/Users/user/Downloads/OANDA_USDJPY, 1.csv'))[0];

console.log('=== OANDA 2026-05-29 (1分データから日足計算) ===');
console.log(`JP225YJPY  O ${oandaJpy.open.toFixed(2)}  H ${oandaJpy.high.toFixed(2)}  L ${oandaJpy.low.toFixed(2)}  C ${oandaJpy.close.toFixed(2)}`);
console.log(`JP225USD   O ${oandaUsd.open.toFixed(2)}  H ${oandaUsd.high.toFixed(2)}  L ${oandaUsd.low.toFixed(2)}  C ${oandaUsd.close.toFixed(2)}`);
console.log(`USDJPY     O ${oandaFx.open.toFixed(3)}  H ${oandaFx.high.toFixed(3)}  L ${oandaFx.low.toFixed(3)}  C ${oandaFx.close.toFixed(3)}`);

console.log('\n=== Yahoo Chart API 取得 (60 日分) ===');
const now = Math.floor(Date.now() / 1000);
const past = now - 60 * 24 * 60 * 60;
const nkf = await fetchYahoo('NIY=F', past, now);
const n225 = await fetchYahoo('^N225', past, now);
const fx = await fetchYahoo('JPY=X', past, now);
console.log(`  NK=F: ${nkf.length} 日`);
console.log(`  ^N225: ${n225.length} 日`);
console.log(`  JPY=X: ${fx.length} 日`);

if (nkf.length === 0) { console.error('Yahoo データ取得失敗'); process.exit(1); }

console.log('\n=== Yahoo 直近 10 日の日足 close ===');
console.log(`date         NK=F        ^N225       JPY=X     NK=F/^N225   NK=F-^N225`);
const nkByDate = new Map(nkf.map(r => [r.date, r]));
const nsByDate = new Map(n225.map(r => [r.date, r]));
const fxByDate = new Map(fx.map(r => [r.date, r]));
const dates = nkf.map(r => r.date).filter(d => nsByDate.has(d) && fxByDate.has(d)).slice(-15);
for (const d of dates) {
  const k = nkByDate.get(d), s = nsByDate.get(d), f = fxByDate.get(d);
  console.log(
    `${d}  ${k.close.toFixed(2).padStart(9)}  ${s.close.toFixed(2).padStart(9)}  ${f.close.toFixed(3).padStart(7)}  ${(k.close/s.close).toFixed(4).padStart(8)}  ${(k.close-s.close).toFixed(2).padStart(9)}`
  );
}

console.log('\n=== Yahoo NK=F vs OANDA JP225YJPY 2026-05-29 比較 ===');
const yahooMay29 = nkByDate.get('2026-05-29');
const yahooMay28 = nkByDate.get('2026-05-28');
if (yahooMay29) {
  console.log(`Yahoo NK=F 2026-05-29   O ${yahooMay29.open?.toFixed(2)}  H ${yahooMay29.high?.toFixed(2)}  L ${yahooMay29.low?.toFixed(2)}  C ${yahooMay29.close.toFixed(2)}`);
  console.log(`OANDA JP225YJPY (5h窓) O ${oandaJpy.open.toFixed(2)}  H ${oandaJpy.high.toFixed(2)}  L ${oandaJpy.low.toFixed(2)}  C ${oandaJpy.close.toFixed(2)}`);
  console.log(`OANDA JP225USD  (5h窓) O ${oandaUsd.open.toFixed(2)}  H ${oandaUsd.high.toFixed(2)}  L ${oandaUsd.low.toFixed(2)}  C ${oandaUsd.close.toFixed(2)}`);
  console.log(`Yahoo close - OANDA YJPY close = ${(yahooMay29.close - oandaJpy.close).toFixed(2)} (${((yahooMay29.close-oandaJpy.close)/oandaJpy.close*100).toFixed(3)}%)`);
  console.log(`Yahoo close - OANDA USD  close = ${(yahooMay29.close - oandaUsd.close).toFixed(2)} (${((yahooMay29.close-oandaUsd.close)/oandaUsd.close*100).toFixed(3)}%)`);
} else {
  console.log(`Yahoo NK=F 2026-05-29: 取得なし (今日が最終営業日かまだ未確定)`);
  if (yahooMay28) console.log(`Yahoo NK=F 2026-05-28 close: ${yahooMay28.close.toFixed(2)}`);
}

console.log('\n=== 日次リターン回帰: NK=F_ret = a + b*^N225_ret + c*USDJPY_ret ===');
const sortedDates = nkf.map(r => r.date).sort();
const nkRets = [], nsRets = [], fxRets = [];
for (let i = 1; i < sortedDates.length; i++) {
  const c = sortedDates[i], p = sortedDates[i-1];
  const kCur = nkByDate.get(c), kPrev = nkByDate.get(p);
  const sCur = nsByDate.get(c), sPrev = nsByDate.get(p);
  const fCur = fxByDate.get(c), fPrev = fxByDate.get(p);
  if (kCur && kPrev && sCur && sPrev && fCur && fPrev) {
    nkRets.push(kCur.close / kPrev.close - 1);
    nsRets.push(sCur.close / sPrev.close - 1);
    fxRets.push(fCur.close / fPrev.close - 1);
  }
}
console.log(`  サンプル数: ${nkRets.length}`);

function mean(a) { return a.reduce((s,x) => s+x, 0) / a.length; }
function variance(a) { const m = mean(a); return a.reduce((s,x) => s+(x-m)**2, 0) / a.length; }
function cov(a, b) { const ma = mean(a), mb = mean(b); return a.reduce((s,_,i) => s+(a[i]-ma)*(b[i]-mb), 0) / a.length; }
function corr(a, b) { return cov(a,b) / Math.sqrt(variance(a) * variance(b)); }

console.log(`\n  相関係数:`);
console.log(`    NK=F vs ^N225  : ${corr(nkRets, nsRets).toFixed(4)}`);
console.log(`    NK=F vs JPY=X  : ${corr(nkRets, fxRets).toFixed(4)}`);
console.log(`    ^N225 vs JPY=X : ${corr(nsRets, fxRets).toFixed(4)}`);

function regress(y, xs) {
  const n = y.length, k = xs.length + 1;
  const X = []; for (let i = 0; i < n; i++) { const row = [1]; for (const x of xs) row.push(x[i]); X.push(row); }
  const XtX = Array.from({length: k}, () => Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    let s = 0; for (let l = 0; l < n; l++) s += X[l][i] * X[l][j];
    XtX[i][j] = s;
  }
  const Xty = Array(k).fill(0);
  for (let i = 0; i < k; i++) { let s = 0; for (let l = 0; l < n; l++) s += X[l][i] * y[l]; Xty[i] = s; }
  const A = XtX.map(r => [...r]);
  const I = Array.from({length: k}, (_, i) => Array.from({length: k}, (_, j) => i === j ? 1 : 0));
  for (let i = 0; i < k; i++) {
    const piv = A[i][i];
    for (let j = 0; j < k; j++) { A[i][j] /= piv; I[i][j] /= piv; }
    for (let r = 0; r < k; r++) if (r !== i) {
      const f = A[r][i];
      for (let j = 0; j < k; j++) { A[r][j] -= f * A[i][j]; I[r][j] -= f * I[i][j]; }
    }
  }
  const beta = Array(k).fill(0);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) beta[i] += I[i][j] * Xty[j];
  return beta;
}

const b = regress(nkRets, [nsRets, fxRets]);
console.log(`\n  NK=F_ret = ${b[0].toExponential(2)} + ${b[1].toFixed(4)} × ^N225_ret + ${b[2].toFixed(4)} × USDJPY_ret`);
console.log(`\n  期待値による判定:`);
console.log(`    b1 ≈ 1.00, b2 ≈  0.00 → NK=F = JPY 建て (= ^N225 と同銘柄)`);
console.log(`    b1 ≈ 1.00, b2 ≈ -1.00 → NK=F = USD per point (= ^N225 / USDJPY)`);
console.log(`    実測 b2 = ${b[2].toFixed(4)} → ${Math.abs(b[2]) < 0.3 ? '→ JPY 建て寄り' : Math.abs(b[2] + 1) < 0.3 ? '→ USD 建て寄り' : '→ 中間的'}`);

let ssTot = 0, ssRes = 0;
const meanY = mean(nkRets);
for (let i = 0; i < nkRets.length; i++) {
  const pred = b[0] + b[1]*nsRets[i] + b[2]*fxRets[i];
  ssTot += (nkRets[i] - meanY)**2;
  ssRes += (nkRets[i] - pred)**2;
}
console.log(`  R^2 = ${(1 - ssRes/ssTot).toFixed(4)}`);
