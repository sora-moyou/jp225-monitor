// 10 秒足での再解析。1 分足より粒度が細かいため、USDJPY 影響がより鮮明に出るはず。
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  return lines.slice(1).map(l => {
    const [time, open, high, low, close] = l.split(',');
    return { time: +time, open: +open, high: +high, low: +low, close: +close };
  });
}

const fx = new Map(loadCsv('C:/Users/user/Downloads/OANDA_USDJPY, 10S.csv').map(r => [r.time, r]));
const usd = new Map(loadCsv('C:/Users/user/Downloads/OANDA_JP225USD, 10S.csv').map(r => [r.time, r]));
const yjpy = new Map(loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 10S.csv').map(r => [r.time, r]));

const common = [...usd.keys()].filter(t => yjpy.has(t) && fx.has(t)).sort();
console.log(`Common timestamps (10S): ${common.length}`);

// 候補方向の食い違いカウント
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
let agree = 0, disagree = 0, doji = 0;
const disagreements = [];
for (const t of common) {
  const u = usd.get(t), j = yjpy.get(t), f = fx.get(t);
  const uDir = sign(u.close - u.open), jDir = sign(j.close - j.open);
  if (uDir === 0 || jDir === 0) { doji++; continue; }
  if (uDir === jDir) agree++;
  else {
    disagree++;
    disagreements.push({
      t, fxO: f.open, fxC: f.close, fxBp: (f.close/f.open-1)*10000,
      jO: j.open, jC: j.close, jBp: (j.close/j.open-1)*10000, jDir,
      uO: u.open, uC: u.close, uBp: (u.close/u.open-1)*10000, uDir,
      diff_OC: (u.close - j.close),
    });
  }
}
console.log(`\n=== 10秒足 候補方向の食い違い ===`);
console.log(`  一致:      ${agree}`);
console.log(`  食い違い:   ${disagree}  (${(disagree/common.length*100).toFixed(1)}%)`);
console.log(`  doji:      ${doji}`);

console.log(`\n=== 食い違い 15 件の代表 ===`);
console.log(`時刻         USDJPY Δbp  YJPY (Δbp 方向)     USD (Δbp 方向)      USD-YJPY(close)`);
for (const d of disagreements.slice(0, 15)) {
  console.log(
    `${d.t}  ${d.fxBp.toFixed(2).padStart(7)}  ` +
    `${d.jO.toFixed(2)}→${d.jC.toFixed(2)} (${d.jBp.toFixed(2).padStart(6)} ${d.jDir>0?'陽':'陰'})  ` +
    `${d.uO.toFixed(2)}→${d.uC.toFixed(2)} (${d.uBp.toFixed(2).padStart(6)} ${d.uDir>0?'陽':'陰'})  ` +
    `${d.diff_OC.toFixed(2).padStart(7)}`
  );
}

// 各 close-to-close リターン
const usdReturns = [], yjpyReturns = [], fxReturns = [];
for (let i = 1; i < common.length; i++) {
  const t = common[i], tp = common[i-1];
  if (t - tp > 30) continue;  // 連続しない部分はスキップ
  usdReturns.push(usd.get(t).close / usd.get(tp).close - 1);
  yjpyReturns.push(yjpy.get(t).close / yjpy.get(tp).close - 1);
  fxReturns.push(fx.get(t).close / fx.get(tp).close - 1);
}

const mean = a => a.reduce((s,x)=>s+x,0) / a.length;
const variance = a => { const m = mean(a); return a.reduce((s,x)=>s+(x-m)**2,0)/a.length; };
const cov = (a,b) => { const ma = mean(a), mb = mean(b); return a.reduce((s,_,i)=>s+(a[i]-ma)*(b[i]-mb),0)/a.length; };
const corr = (a,b) => cov(a,b) / Math.sqrt(variance(a)*variance(b));

console.log(`\n=== 10秒足 リターン相関 (${usdReturns.length} sample) ===`);
console.log(`  USD vs YJPY  : ${corr(usdReturns, yjpyReturns).toFixed(4)}`);
console.log(`  USD vs USDJPY: ${corr(usdReturns, fxReturns).toFixed(4)}`);
console.log(`  YJPY vs USDJPY: ${corr(yjpyReturns, fxReturns).toFixed(4)}`);

console.log(`\n=== 10秒足 リターン標準偏差 (bp) ===`);
console.log(`  USD = ${(Math.sqrt(variance(usdReturns))*10000).toFixed(2)} bp`);
console.log(`  YJPY = ${(Math.sqrt(variance(yjpyReturns))*10000).toFixed(2)} bp`);
console.log(`  USDJPY = ${(Math.sqrt(variance(fxReturns))*10000).toFixed(2)} bp`);

// 多変量回帰 USD_ret = a + b*YJPY_ret + c*USDJPY_ret
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

const b = regress(usdReturns, [yjpyReturns, fxReturns]);
console.log(`\n=== 10秒足 USD_ret = a + b*YJPY + c*USDJPY ===`);
console.log(`  USD_ret = ${b[0].toExponential(2)} + ${b[1].toFixed(4)} * YJPY_ret + ${b[2].toFixed(4)} * USDJPY_ret`);
let ssTot = 0, ssRes = 0; const meanY = mean(usdReturns);
for (let i = 0; i < usdReturns.length; i++) {
  const pred = b[0] + b[1]*yjpyReturns[i] + b[2]*fxReturns[i];
  ssTot += (usdReturns[i] - meanY)**2;
  ssRes += (usdReturns[i] - pred)**2;
}
console.log(`  R^2 = ${(1 - ssRes/ssTot).toFixed(6)}`);

// 純粋 USD per point 仮説検証
console.log(`\n=== 純粋 USD per point 仮説 (USD = YJPY / USDJPY × 定数) ===`);
const productSamples = common.slice(0, 100).map(t => {
  const u = usd.get(t), j = yjpy.get(t), f = fx.get(t);
  return (u.close * f.close) / j.close;
});
const meanProd = mean(productSamples);
console.log(`  (USD × USDJPY) / YJPY 平均: ${meanProd.toFixed(4)}, 標準偏差: ${Math.sqrt(variance(productSamples)).toFixed(4)}`);
console.log(`  → USD = YJPY × (${meanProd.toFixed(4)} / USDJPY) なら 100% 当たる`);
console.log(`     ≈ 1 なら純粋に YJPY と同じ; ≈ USDJPY 平均値なら純粋 USD per point`);

const meanFx = mean(common.slice(0, 100).map(t => fx.get(t).close));
console.log(`  USDJPY 平均: ${meanFx.toFixed(3)}`);
console.log(`  比較: (USD×USDJPY)/YJPY=${meanProd.toFixed(4)} vs USDJPY平均=${meanFx.toFixed(3)}`);
console.log(`  → 結論: ${meanProd > 100 ? '純粋 USD per point 寄り (= YJPY÷USDJPY)' : '実質 YJPY 同一'}`);

// 仮説: USD は YJPY と同じだが、micro-noise (5 ポイントタイカ単位) がある
console.log(`\n=== USD - YJPY 差 (close) の統計 ===`);
const closeDiffs = common.map(t => usd.get(t).close - yjpy.get(t).close);
const sorted = [...closeDiffs].sort((a,b) => a - b);
const ad = closeDiffs.map(Math.abs);
console.log(`  平均: ${mean(closeDiffs).toFixed(3)} ポイント`);
console.log(`  中央: ${sorted[Math.floor(sorted.length/2)].toFixed(3)}`);
console.log(`  min/max: ${sorted[0].toFixed(2)} / ${sorted[sorted.length-1].toFixed(2)}`);
console.log(`  abs 平均: ${mean(ad).toFixed(3)}`);
console.log(`  YJPY 平均値の何 %: ${(mean(ad) / mean(common.map(t => yjpy.get(t).close)) * 100).toFixed(4)} %`);
