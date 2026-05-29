// OANDA 10秒データから、現アラート窓 (30s slope / 5m magnitude) と
// 閾値 (0.10% / 0.30%) の妥当性を定量評価する。
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  return lines.slice(1).map(l => {
    const [time, open, high, low, close] = l.split(',');
    return { time: +time, open: +open, high: +high, low: +low, close: +close };
  });
}

const rows = loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 10S.csv').sort((a, b) => a.time - b.time);
console.log(`データ期間: ${new Date(rows[0].time * 1000).toISOString()} → ${new Date(rows[rows.length-1].time * 1000).toISOString()}`);
console.log(`bar 数: ${rows.length} (= ${(rows.length * 10 / 60).toFixed(1)} 分)`);

// 連続性チェック (10s 間隔か?)
let gaps = 0;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].time - rows[i-1].time !== 10) gaps++;
}
console.log(`非連続な間隔: ${gaps} 箇所 (= 取引時間外/空白)`);

// 各バー時点で「過去 N 秒間の最大変動率」を計算
function rollingMaxChange(rows, secondsBack) {
  const ticks = Math.floor(secondsBack / 10);
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < ticks) { result.push(null); continue; }
    // 過去 ticks バーの最古値と現在 close を比較
    const baseI = i - ticks;
    // 時刻差が正しく secondsBack 秒か念のため確認
    if (rows[i].time - rows[baseI].time !== secondsBack) {
      result.push(null);
      continue;
    }
    const change = (rows[i].close / rows[baseI].close - 1) * 100;  // %
    result.push(change);
  }
  return result;
}

// 過去 N 秒間の最大値・最小値からの変動 (h/l 使用)
function rollingHighLowChange(rows, secondsBack) {
  const ticks = Math.floor(secondsBack / 10);
  const result = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < ticks) { result.push(null); continue; }
    const baseI = i - ticks + 1;
    if (rows[i].time - rows[baseI].time !== secondsBack - 10) {
      result.push(null);
      continue;
    }
    let hi = -Infinity, lo = Infinity;
    for (let k = baseI; k <= i; k++) { if (rows[k].high > hi) hi = rows[k].high; if (rows[k].low < lo) lo = rows[k].low; }
    result.push(((hi - lo) / lo) * 100);
  }
  return result;
}

const slope_close_30s = rollingMaxChange(rows, 30);
const slope_hl_30s = rollingHighLowChange(rows, 30);
const slope_close_60s = rollingMaxChange(rows, 60);
const mag_close_5m = rollingMaxChange(rows, 300);
const mag_hl_5m = rollingHighLowChange(rows, 300);

function valid(arr) { return arr.filter(x => x !== null); }
function abs(arr) { return arr.map(Math.abs); }
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)];
}

console.log('\n=== 30 秒窓 (close-to-close 変動率 %) ===');
const s30 = valid(slope_close_30s);
const s30a = abs(s30);
console.log(`  サンプル数: ${s30.length}`);
console.log(`  abs %: min=${Math.min(...s30a).toFixed(4)}, p50=${percentile(s30a, 0.50).toFixed(4)}, p90=${percentile(s30a, 0.90).toFixed(4)}, p95=${percentile(s30a, 0.95).toFixed(4)}, p99=${percentile(s30a, 0.99).toFixed(4)}, max=${Math.max(...s30a).toFixed(4)}`);

for (const th of [0.05, 0.07, 0.10, 0.15, 0.20]) {
  const hits = s30a.filter(x => x >= th).length;
  console.log(`  閾値 ${th.toFixed(2)}% を超えた tick: ${hits} 件 (${(hits/s30.length*100).toFixed(1)}%) → 平均 ${hits > 0 ? (rows.length * 10 / 60 / hits).toFixed(1) : 'inf'} 分に 1 回`);
}

console.log('\n=== 30 秒窓 (high-low ボラ %) — どれだけブレたか ===');
const s30hl = valid(slope_hl_30s);
console.log(`  abs %: p50=${percentile(s30hl, 0.50).toFixed(4)}, p90=${percentile(s30hl, 0.90).toFixed(4)}, p99=${percentile(s30hl, 0.99).toFixed(4)}, max=${Math.max(...s30hl).toFixed(4)}`);

console.log('\n=== 60 秒窓 (close-to-close 変動率 %) ===');
const s60 = valid(slope_close_60s);
const s60a = abs(s60);
console.log(`  abs %: p50=${percentile(s60a, 0.50).toFixed(4)}, p90=${percentile(s60a, 0.90).toFixed(4)}, p95=${percentile(s60a, 0.95).toFixed(4)}, p99=${percentile(s60a, 0.99).toFixed(4)}`);
for (const th of [0.10, 0.15, 0.20]) {
  const hits = s60a.filter(x => x >= th).length;
  console.log(`  閾値 ${th.toFixed(2)}% を超えた tick: ${hits} 件 (${(hits/s60.length*100).toFixed(1)}%) → 平均 ${hits > 0 ? (rows.length * 10 / 60 / hits).toFixed(1) : 'inf'} 分に 1 回`);
}

console.log('\n=== 5 分窓 (close-to-close 変動率 %) ===');
const m5 = valid(mag_close_5m);
const m5a = abs(m5);
console.log(`  サンプル数: ${m5.length}`);
console.log(`  abs %: min=${Math.min(...m5a).toFixed(4)}, p50=${percentile(m5a, 0.50).toFixed(4)}, p90=${percentile(m5a, 0.90).toFixed(4)}, p95=${percentile(m5a, 0.95).toFixed(4)}, p99=${percentile(m5a, 0.99).toFixed(4)}, max=${Math.max(...m5a).toFixed(4)}`);

for (const th of [0.15, 0.20, 0.30, 0.40, 0.50]) {
  const hits = m5a.filter(x => x >= th).length;
  console.log(`  閾値 ${th.toFixed(2)}% を超えた tick: ${hits} 件 (${(hits/m5.length*100).toFixed(1)}%) → 平均 ${hits > 0 ? (rows.length * 10 / 60 / hits).toFixed(1) : 'inf'} 分に 1 回`);
}

console.log('\n=== 5 分窓 (high-low ボラ %) ===');
const m5hl = valid(mag_hl_5m);
console.log(`  p50=${percentile(m5hl, 0.50).toFixed(4)}, p90=${percentile(m5hl, 0.90).toFixed(4)}, p99=${percentile(m5hl, 0.99).toFixed(4)}, max=${Math.max(...m5hl).toFixed(4)}`);

console.log('\n=== 結論 ===');
console.log(`現設定 (30s slope 0.10% / 5m magnitude 0.30%) の発火頻度:`);
const slopeHits = s30a.filter(x => x >= 0.10).length;
const magHits = m5a.filter(x => x >= 0.30).length;
console.log(`  slope: ${slopeHits} 件 / ${(rows.length*10/60).toFixed(0)} 分 = 平均 ${slopeHits > 0 ? (rows.length*10/60/slopeHits).toFixed(1) : 'inf'} 分に 1 回`);
console.log(`  magnitude: ${magHits} 件 / ${(rows.length*10/60).toFixed(0)} 分 = 平均 ${magHits > 0 ? (rows.length*10/60/magHits).toFixed(1) : 'inf'} 分に 1 回`);
console.log(`データの平均 30s 変動: ${(s30a.reduce((a,b)=>a+b,0)/s30a.length).toFixed(4)}%`);
console.log(`データの平均 5m 変動: ${(m5a.reduce((a,b)=>a+b,0)/m5a.length).toFixed(4)}%`);
console.log(`データの 30s p99 変動: ${percentile(s30a, 0.99).toFixed(4)}% (上位 1% に入る大きな動き)`);
console.log(`データの 5m p99 変動: ${percentile(m5a, 0.99).toFixed(4)}%`);
