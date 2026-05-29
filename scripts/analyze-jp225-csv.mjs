// 3 つの CSV を解析し、JP225USD / JP225YJPY / USDJPY の関係式を導出する。
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [time, open, high, low, close, volume] = lines[i].split(',');
    rows.push({
      time: Number(time),
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume),
    });
  }
  return rows;
}

const usdjpy = loadCsv('C:/Users/user/Downloads/OANDA_USDJPY, 1.csv');
const jp225usd = loadCsv('C:/Users/user/Downloads/OANDA_JP225USD, 1.csv');
const jp225yjpy = loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 1.csv');

// タイムスタンプで Map 化
const usdjpyByT = new Map(usdjpy.map(r => [r.time, r]));
const jp225usdByT = new Map(jp225usd.map(r => [r.time, r]));
const jp225yjpyByT = new Map(jp225yjpy.map(r => [r.time, r]));

// 共通タイムスタンプで揃える
const commonTimes = [...jp225usdByT.keys()].filter(t => jp225yjpyByT.has(t) && usdjpyByT.has(t)).sort();
console.log(`Common timestamps: ${commonTimes.length}`);

console.log('\n=== 各 OHLC の最初の数行 ===');
for (const t of commonTimes.slice(0, 5)) {
  const u = usdjpyByT.get(t);
  const usd = jp225usdByT.get(t);
  const jpy = jp225yjpyByT.get(t);
  console.log(`t=${t}: USDJPY ${u.close.toFixed(3)} | JP225USD c=${usd.close.toFixed(2)} | JP225YJPY c=${jpy.close.toFixed(2)} | USD-YJPY = ${(usd.close - jpy.close).toFixed(3)} | USD/YJPY = ${(usd.close / jpy.close).toFixed(6)}`);
}

console.log('\n=== 統計: JP225USD vs JP225YJPY の close 差 ===');
const diffs = commonTimes.map(t => jp225usdByT.get(t).close - jp225yjpyByT.get(t).close);
diffs.sort((a, b) => a - b);
const sum = diffs.reduce((a, b) => a + b, 0);
console.log(`  count=${diffs.length}, mean=${(sum/diffs.length).toFixed(3)}, min=${diffs[0].toFixed(3)}, median=${diffs[Math.floor(diffs.length/2)].toFixed(3)}, max=${diffs[diffs.length-1].toFixed(3)}`);

console.log('\n=== close-to-close 変化率の相関 ===');
const usdReturns = [];
const yjpyReturns = [];
const usdjpyReturns = [];
for (let i = 1; i < commonTimes.length; i++) {
  const t = commonTimes[i];
  const tPrev = commonTimes[i-1];
  if (t - tPrev > 120) continue; // 連続しない部分はスキップ
  const usdR = jp225usdByT.get(t).close / jp225usdByT.get(tPrev).close - 1;
  const yjpyR = jp225yjpyByT.get(t).close / jp225yjpyByT.get(tPrev).close - 1;
  const fxR = usdjpyByT.get(t).close / usdjpyByT.get(tPrev).close - 1;
  usdReturns.push(usdR);
  yjpyReturns.push(yjpyR);
  usdjpyReturns.push(fxR);
}

// 統計関数
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function variance(arr) { const m = mean(arr); return arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length; }
function cov(a, b) { const ma = mean(a), mb = mean(b); return a.reduce((s, _, i) => s + (a[i] - ma) * (b[i] - mb), 0) / a.length; }
function corr(a, b) { return cov(a, b) / Math.sqrt(variance(a) * variance(b)); }

console.log(`  USD vs YJPY return correlation: ${corr(usdReturns, yjpyReturns).toFixed(4)}`);
console.log(`  USD vs USDJPY return correlation: ${corr(usdReturns, usdjpyReturns).toFixed(4)}`);
console.log(`  YJPY vs USDJPY return correlation: ${corr(yjpyReturns, usdjpyReturns).toFixed(4)}`);

console.log(`\n  Mean returns (basis points per min):`);
console.log(`    USD = ${(mean(usdReturns) * 10000).toFixed(4)} bp`);
console.log(`    YJPY = ${(mean(yjpyReturns) * 10000).toFixed(4)} bp`);
console.log(`    USDJPY = ${(mean(usdjpyReturns) * 10000).toFixed(4)} bp`);

console.log(`\n  Std dev returns (basis points per min):`);
console.log(`    USD = ${(Math.sqrt(variance(usdReturns)) * 10000).toFixed(4)} bp`);
console.log(`    YJPY = ${(Math.sqrt(variance(yjpyReturns)) * 10000).toFixed(4)} bp`);
console.log(`    USDJPY = ${(Math.sqrt(variance(usdjpyReturns)) * 10000).toFixed(4)} bp`);

console.log(`\n=== 線形回帰: USD_return = a + b*YJPY_return + c*USDJPY_return ===`);
// 単純な多変量回帰: USD_return ~ YJPY_return + USDJPY_return
// 正規方程式: β = (X'X)^-1 X'y
function regress(y, xs) {
  // xs: 列ごとに配列の配列。intercept も含めて [1, x1, x2, ...] にする。
  const n = y.length;
  const k = xs.length + 1;
  const X = []; // n × k
  for (let i = 0; i < n; i++) {
    const row = [1];
    for (const x of xs) row.push(x[i]);
    X.push(row);
  }
  // X'X (k × k)
  const XtX = Array.from({length: k}, () => Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
    let s = 0;
    for (let l = 0; l < n; l++) s += X[l][i] * X[l][j];
    XtX[i][j] = s;
  }
  // X'y (k)
  const Xty = Array(k).fill(0);
  for (let i = 0; i < k; i++) {
    let s = 0;
    for (let l = 0; l < n; l++) s += X[l][i] * y[l];
    Xty[i] = s;
  }
  // 逆行列 (k 小さいから Gauss-Jordan)
  const A = XtX.map(row => [...row]);
  const I = Array.from({length: k}, (_, i) => Array.from({length: k}, (_, j) => i === j ? 1 : 0));
  for (let i = 0; i < k; i++) {
    let pivot = A[i][i];
    for (let j = 0; j < k; j++) { A[i][j] /= pivot; I[i][j] /= pivot; }
    for (let r = 0; r < k; r++) if (r !== i) {
      const f = A[r][i];
      for (let j = 0; j < k; j++) { A[r][j] -= f * A[i][j]; I[r][j] -= f * I[i][j]; }
    }
  }
  // β = (X'X)^-1 X'y
  const beta = Array(k).fill(0);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) beta[i] += I[i][j] * Xty[j];
  return beta;
}

const beta = regress(usdReturns, [yjpyReturns, usdjpyReturns]);
console.log(`  USD_ret = ${beta[0].toExponential(3)} + ${beta[1].toFixed(4)} * YJPY_ret + ${beta[2].toFixed(4)} * USDJPY_ret`);

// 残差で R^2 を計算
const meanY = mean(usdReturns);
let ssTot = 0, ssRes = 0;
for (let i = 0; i < usdReturns.length; i++) {
  const pred = beta[0] + beta[1] * yjpyReturns[i] + beta[2] * usdjpyReturns[i];
  ssTot += (usdReturns[i] - meanY) ** 2;
  ssRes += (usdReturns[i] - pred) ** 2;
}
console.log(`  R^2 = ${(1 - ssRes / ssTot).toFixed(6)}`);

console.log('\n=== 価格レベルの関係: JP225USD = f(JP225YJPY, USDJPY) ===');
// 仮説 A: JP225USD = JP225YJPY (まったく同じ)
// 仮説 B: JP225USD = JP225YJPY * USDJPY (× レート)
// 仮説 C: JP225USD = JP225YJPY / USDJPY (÷ レート)
// 仮説 D: JP225USD = JP225YJPY * 何らかの定数

const ratios_AB = [];
const ratios_AC = [];
for (const t of commonTimes.slice(0, 100)) {
  const usd = jp225usdByT.get(t).close;
  const yjpy = jp225yjpyByT.get(t).close;
  const fx = usdjpyByT.get(t).close;
  ratios_AB.push((usd / yjpy) / fx);  // 仮説 B が正しいなら 1 になるはず
  ratios_AC.push((usd / yjpy) * fx);  // 仮説 C が正しいなら 1 になるはず
}
console.log(`  仮説 B (USD = YJPY × USDJPY): (USD/YJPY)/USDJPY 平均=${mean(ratios_AB).toFixed(8)} (期待値 1)`);
console.log(`  仮説 C (USD = YJPY ÷ USDJPY): (USD/YJPY)*USDJPY 平均=${mean(ratios_AC).toFixed(4)} (期待値 1)`);
console.log(`  仮説 A (USD = YJPY): USD/YJPY 平均=${mean(commonTimes.slice(0, 100).map(t => jp225usdByT.get(t).close / jp225yjpyByT.get(t).close)).toFixed(8)} (期待値 1)`);
