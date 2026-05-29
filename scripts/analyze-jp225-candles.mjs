// 候補が陽線/陰線で食い違うケースを特定し、USDJPY との関係を調査
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const [time, open, high, low, close] = lines[i].split(',');
    rows.push({ time: Number(time), open: +open, high: +high, low: +low, close: +close });
  }
  return rows;
}

const usdjpy = new Map(loadCsv('C:/Users/user/Downloads/OANDA_USDJPY, 1.csv').map(r => [r.time, r]));
const jp225usd = new Map(loadCsv('C:/Users/user/Downloads/OANDA_JP225USD, 1.csv').map(r => [r.time, r]));
const jp225yjpy = new Map(loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 1.csv').map(r => [r.time, r]));

const common = [...jp225usd.keys()].filter(t => jp225yjpy.has(t) && usdjpy.has(t)).sort();

const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;

let agree = 0, disagree = 0, both_doji = 0;
const disagreements = [];

for (const t of common) {
  const u = jp225usd.get(t);
  const j = jp225yjpy.get(t);
  const f = usdjpy.get(t);
  const uDir = sign(u.close - u.open);
  const jDir = sign(j.close - j.open);
  const fDir = sign(f.close - f.open);
  const fxChg = (f.close / f.open - 1) * 10000;  // bp
  const uChg = (u.close / u.open - 1) * 10000;
  const jChg = (j.close / j.open - 1) * 10000;

  if (uDir === 0 || jDir === 0) { both_doji++; continue; }
  if (uDir === jDir) {
    agree++;
  } else {
    disagree++;
    disagreements.push({
      t, fxOpen: f.open, fxClose: f.close, fxChg,
      yjpyOpen: j.open, yjpyClose: j.close, yjpyChg: jChg, yjpyDir: jDir,
      usdOpen: u.open, usdClose: u.close, usdChg: uChg, usdDir: uDir,
    });
  }
}

console.log(`\n=== 陽線/陰線の食い違いカウント ===`);
console.log(`  一致:       ${agree}`);
console.log(`  食い違い:    ${disagree}`);
console.log(`  どちらか同値: ${both_doji}`);

console.log(`\n=== 食い違いケースの詳細 (代表 10 件) ===`);
console.log(`時刻        | USDJPY(O→C, Δbp) | YJPY(O→C, Δbp, dir) | USD(O→C, Δbp, dir)`);
for (const d of disagreements.slice(0, 10)) {
  console.log(
    `t=${d.t} | ${d.fxOpen.toFixed(3)}→${d.fxClose.toFixed(3)} (${d.fxChg.toFixed(2)}bp) | ` +
    `${d.yjpyOpen.toFixed(2)}→${d.yjpyClose.toFixed(2)} (${d.yjpyChg.toFixed(2)}bp, ${d.yjpyDir>0?'陽':'陰'}) | ` +
    `${d.usdOpen.toFixed(2)}→${d.usdClose.toFixed(2)} (${d.usdChg.toFixed(2)}bp, ${d.usdDir>0?'陽':'陰'})`
  );
}

// 食い違い時の USDJPY 動き方
console.log(`\n=== 食い違い時の USDJPY 動向 ===`);
const yPosUNeg = disagreements.filter(d => d.yjpyDir > 0 && d.usdDir < 0);   // 円建陽 / 米建陰
const yNegUPos = disagreements.filter(d => d.yjpyDir < 0 && d.usdDir > 0);   // 円建陰 / 米建陽
console.log(`  ケース 1: 円陽線 / ドル陰線 (USDJPY が下がる = 円高 → USD で見ると下がる、と整合) → ${yPosUNeg.length} 件`);
console.log(`    平均 USDJPY Δ: ${(yPosUNeg.reduce((s, d) => s + d.fxChg, 0) / Math.max(yPosUNeg.length, 1)).toFixed(2)} bp`);
console.log(`  ケース 2: 円陰線 / ドル陽線 (USDJPY が上がる = 円安 → USD で見ると上がる、と整合) → ${yNegUPos.length} 件`);
console.log(`    平均 USDJPY Δ: ${(yNegUPos.reduce((s, d) => s + d.fxChg, 0) / Math.max(yNegUPos.length, 1)).toFixed(2)} bp`);

// 完全な USD per point 換算と比較
console.log(`\n=== 仮説検証: USD = YJPY / USDJPY (純粋な USD per point 換算) ===`);
// もし JP225USD が純粋に YJPY を USDJPY で割っているなら、USD * USDJPY ≈ YJPY × 適当な定数
const samples = common.slice(0, 50);
const productSamples = samples.map(t => {
  const u = jp225usd.get(t);
  const j = jp225yjpy.get(t);
  const f = usdjpy.get(t);
  return { ratio: (u.close * f.close) / j.close };
});
const meanRatio = productSamples.reduce((s, x) => s + x.ratio, 0) / productSamples.length;
console.log(`  (USD × USDJPY) / YJPY 平均: ${meanRatio.toFixed(4)} (期待 1 なら純粋 USD per point)`);

console.log(`\n=== 真の関係式の推定 ===`);
// USD_OHLC を USDJPY_OHLC で割ると、YJPY と一致するか?
// USD_close / USDJPY_close × 平均_USDJPY ≈ YJPY_close ?
const refFx = usdjpy.get(common[0]).close;  // 参照 USDJPY
const yjpyPredicted_pureFX = common.map(t => {
  const u = jp225usd.get(t);
  const f = usdjpy.get(t);
  return { t, predicted: u.close * (refFx / f.close) };
});
const yjpyActual = common.map(t => jp225yjpy.get(t).close);
const errors_pureFX = yjpyPredicted_pureFX.map((x, i) => x.predicted - yjpyActual[i]);
const mse_pureFX = errors_pureFX.reduce((s, e) => s + e * e, 0) / errors_pureFX.length;
console.log(`  仮説 1 (USD は YJPY / USDJPY スケーリング): RMSE = ${Math.sqrt(mse_pureFX).toFixed(2)} ポイント`);

const errors_identity = common.map(t => jp225usd.get(t).close - jp225yjpy.get(t).close);
const mse_identity = errors_identity.reduce((s, e) => s + e * e, 0) / errors_identity.length;
console.log(`  仮説 2 (USD = YJPY、同一): RMSE = ${Math.sqrt(mse_identity).toFixed(2)} ポイント`);

// 多変量回帰: YJPY_close = a * USD_close + b * USDJPY_close + c
function regress2(y, x1, x2) {
  const n = y.length;
  const sumX1 = x1.reduce((s, v) => s + v, 0);
  const sumX2 = x2.reduce((s, v) => s + v, 0);
  const sumY = y.reduce((s, v) => s + v, 0);
  const sumX1X1 = x1.reduce((s, v) => s + v * v, 0);
  const sumX2X2 = x2.reduce((s, v) => s + v * v, 0);
  const sumX1X2 = x1.reduce((s, v, i) => s + v * x2[i], 0);
  const sumX1Y = x1.reduce((s, v, i) => s + v * y[i], 0);
  const sumX2Y = x2.reduce((s, v, i) => s + v * y[i], 0);
  // 正規方程式 (X'X) β = X'y, X = [1, x1, x2]
  const A = [
    [n, sumX1, sumX2],
    [sumX1, sumX1X1, sumX1X2],
    [sumX2, sumX1X2, sumX2X2],
  ];
  const b = [sumY, sumX1Y, sumX2Y];
  // 3x3 逆行列
  const det = A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1]) - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0]) + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0]);
  const inv = [
    [(A[1][1]*A[2][2]-A[1][2]*A[2][1])/det, (A[0][2]*A[2][1]-A[0][1]*A[2][2])/det, (A[0][1]*A[1][2]-A[0][2]*A[1][1])/det],
    [(A[1][2]*A[2][0]-A[1][0]*A[2][2])/det, (A[0][0]*A[2][2]-A[0][2]*A[2][0])/det, (A[0][2]*A[1][0]-A[0][0]*A[1][2])/det],
    [(A[1][0]*A[2][1]-A[1][1]*A[2][0])/det, (A[0][1]*A[2][0]-A[0][0]*A[2][1])/det, (A[0][0]*A[1][1]-A[0][1]*A[1][0])/det],
  ];
  return [inv[0][0]*b[0]+inv[0][1]*b[1]+inv[0][2]*b[2], inv[1][0]*b[0]+inv[1][1]*b[1]+inv[1][2]*b[2], inv[2][0]*b[0]+inv[2][1]*b[1]+inv[2][2]*b[2]];
}

const yclose = common.map(t => jp225yjpy.get(t).close);
const uclose = common.map(t => jp225usd.get(t).close);
const fclose = common.map(t => usdjpy.get(t).close);
const beta = regress2(yclose, uclose, fclose);
console.log(`\n  YJPY_close = ${beta[0].toFixed(3)} + ${beta[1].toFixed(6)} × USD_close + ${beta[2].toFixed(4)} × USDJPY`);

// 予測値の精度
const yjpy_pred = common.map((t, i) => beta[0] + beta[1] * uclose[i] + beta[2] * fclose[i]);
const errors_reg = yjpy_pred.map((p, i) => p - yclose[i]);
const mse_reg = errors_reg.reduce((s, e) => s + e * e, 0) / errors_reg.length;
console.log(`  RMSE = ${Math.sqrt(mse_reg).toFixed(2)} ポイント (仮説 2 同一 RMSE ${Math.sqrt(mse_identity).toFixed(2)} に対して)`);

// 仮説: USD と YJPY は同じだが、各バーの OHLC スナップショットのタイミングで小さなズレ
// もしそうなら、bar 内で USDJPY が動いた量が直接候補方向に影響する
console.log(`\n=== 食い違い時の USDJPY Δbp の絶対値 vs YJPY Δbp の絶対値 ===`);
const yPosUNeg_stats = yPosUNeg;
const yNegUPos_stats = yNegUPos;
if (yPosUNeg_stats.length > 0) {
  console.log(`  円陽/米陰 ${yPosUNeg_stats.length} 件: YJPY Δ 平均 +${(yPosUNeg_stats.reduce((s, d) => s + Math.abs(d.yjpyChg), 0) / yPosUNeg_stats.length).toFixed(2)} bp, USDJPY Δ 平均 ${(yPosUNeg_stats.reduce((s, d) => s + d.fxChg, 0) / yPosUNeg_stats.length).toFixed(2)} bp`);
}
if (yNegUPos_stats.length > 0) {
  console.log(`  円陰/米陽 ${yNegUPos_stats.length} 件: YJPY Δ 平均 -${(yNegUPos_stats.reduce((s, d) => s + Math.abs(d.yjpyChg), 0) / yNegUPos_stats.length).toFixed(2)} bp, USDJPY Δ 平均 ${(yNegUPos_stats.reduce((s, d) => s + d.fxChg, 0) / yNegUPos_stats.length).toFixed(2)} bp`);
}
