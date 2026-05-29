// Yahoo NK=F の日足 OHLC を取得し、JPY スポット (^N225) と USDJPY (JPY=X) と比較
// → NK=F が JPY 建てか USD 建てかを判定する。

import yahooFinance from 'yahoo-finance2';

const yf = new yahooFinance();

const symbols = ['NK=F', '^N225', 'JPY=X'];
const today = new Date();
const past = new Date(today.getTime() - 60 * 24 * 60 * 60 * 1000);  // 60 日前

console.log(`Fetching daily OHLC from ${past.toISOString().slice(0, 10)} to ${today.toISOString().slice(0, 10)}\n`);

const results = {};
for (const sym of symbols) {
  try {
    const data = await yf.historical(sym, { period1: past, period2: today, interval: '1d' });
    results[sym] = data;
    console.log(`${sym}: ${data.length} rows, ${data[0]?.date.toISOString().slice(0,10)} → ${data[data.length-1]?.date.toISOString().slice(0,10)}`);
  } catch (err) {
    console.error(`Failed to fetch ${sym}:`, err.message);
  }
}

// 共通日付で揃える
function byDate(arr) {
  const m = new Map();
  for (const row of arr) m.set(row.date.toISOString().slice(0, 10), row);
  return m;
}

const nkfByDate = byDate(results['NK=F'] ?? []);
const nspotByDate = byDate(results['^N225'] ?? []);
const fxByDate = byDate(results['JPY=X'] ?? []);

const commonDates = [...nkfByDate.keys()].filter(d => nspotByDate.has(d) && fxByDate.has(d)).sort();
console.log(`\nCommon dates: ${commonDates.length}`);

console.log(`\n=== 各日の close 値の比較 ===`);
console.log(`date         NK=F close    ^N225 close   JPY=X close   NK=F/N225    NK=F×JPY=X    NK=F÷JPY=X`);
for (const d of commonDates.slice(-15)) {
  const nkf = nkfByDate.get(d).close;
  const nspot = nspotByDate.get(d).close;
  const fx = fxByDate.get(d).close;
  const ratio = nkf / nspot;
  const prod = nkf * fx;
  const div = nkf / fx;
  console.log(`${d}  ${nkf.toFixed(2).padStart(10)}  ${nspot.toFixed(2).padStart(10)}  ${fx.toFixed(3).padStart(9)}  ${ratio.toFixed(4).padStart(8)}  ${prod.toFixed(1).padStart(11)}  ${div.toFixed(2).padStart(9)}`);
}

// 仮説検証
console.log(`\n=== 仮説検証 ===`);
const sample = commonDates.map(d => ({
  nkf: nkfByDate.get(d).close,
  nspot: nspotByDate.get(d).close,
  fx: fxByDate.get(d).close,
}));

function mean(a) { return a.reduce((s,x) => s+x, 0) / a.length; }
function stddev(a) { const m = mean(a); return Math.sqrt(a.reduce((s,x) => s+(x-m)**2, 0) / a.length); }

const ratios = sample.map(r => r.nkf / r.nspot);
const products = sample.map(r => (r.nkf * r.fx) / r.nspot);
const divisions = sample.map(r => (r.nkf / r.fx) / r.nspot);

console.log(`  NK=F / ^N225        平均=${mean(ratios).toFixed(4)} 標準偏差=${stddev(ratios).toFixed(4)} (1.0 なら NK=F は JPY 建て = N225 と同じ)`);
console.log(`  (NK=F × JPY=X) / ^N225  平均=${mean(products).toFixed(2)} (USDJPY ≈ ${mean(sample.map(r=>r.fx)).toFixed(2)} ならNK=F は USD 建て)`);
console.log(`  (NK=F / JPY=X) / ^N225  平均=${mean(divisions).toFixed(4)} (1/USDJPY ≈ ${(1/mean(sample.map(r=>r.fx))).toFixed(4)} ならNK=F は JPY 建て、× USDJPY が必要)`);

// 日々の変化率
console.log(`\n=== 日次リターン比較 (close-to-close) ===`);
const nkfReturns = [];
const nspotReturns = [];
const fxReturns = [];
for (let i = 1; i < commonDates.length; i++) {
  const cur = commonDates[i], prev = commonDates[i-1];
  nkfReturns.push(nkfByDate.get(cur).close / nkfByDate.get(prev).close - 1);
  nspotReturns.push(nspotByDate.get(cur).close / nspotByDate.get(prev).close - 1);
  fxReturns.push(fxByDate.get(cur).close / fxByDate.get(prev).close - 1);
}

function cov(a, b) { const ma = mean(a), mb = mean(b); return a.reduce((s,_,i) => s+(a[i]-ma)*(b[i]-mb), 0) / a.length; }
function variance(a) { const m = mean(a); return a.reduce((s,x) => s+(x-m)**2, 0) / a.length; }
function corr(a, b) { return cov(a,b) / Math.sqrt(variance(a) * variance(b)); }

console.log(`  NK=F vs ^N225 daily return correlation: ${corr(nkfReturns, nspotReturns).toFixed(4)}`);
console.log(`  NK=F vs JPY=X daily return correlation: ${corr(nkfReturns, fxReturns).toFixed(4)}`);
console.log(`  ^N225 vs JPY=X daily return correlation: ${corr(nspotReturns, fxReturns).toFixed(4)}`);

// 多変量回帰: NK=F_ret = a + b*N225_ret + c*USDJPY_ret
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

const b = regress(nkfReturns, [nspotReturns, fxReturns]);
console.log(`\n  NK=F_ret = ${b[0].toExponential(2)} + ${b[1].toFixed(4)} * N225_ret + ${b[2].toFixed(4)} * USDJPY_ret`);
console.log(`  予測:`);
console.log(`    NK=F が JPY 建て (= N225 と同じ): b1 ≈ 1.00, b2 ≈ 0`);
console.log(`    NK=F が USD 建て (= N225 / USDJPY): b1 ≈ 1.00, b2 ≈ -1.00`);

let ssTot = 0, ssRes = 0;
const meanY = mean(nkfReturns);
for (let i = 0; i < nkfReturns.length; i++) {
  const pred = b[0] + b[1]*nspotReturns[i] + b[2]*fxReturns[i];
  ssTot += (nkfReturns[i] - meanY)**2;
  ssRes += (nkfReturns[i] - pred)**2;
}
console.log(`  R^2 = ${(1 - ssRes/ssTot).toFixed(4)}`);
