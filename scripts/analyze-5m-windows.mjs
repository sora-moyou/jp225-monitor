// OANDA 1 分データ (5 時間ぶん) から 5 分窓の変動を分析
import { readFileSync } from 'node:fs';

function loadCsv(path) {
  const lines = readFileSync(path, 'utf-8').trim().split(/\r?\n/);
  return lines.slice(1).map(l => {
    const [time, open, high, low, close] = l.split(',');
    return { time: +time, open: +open, high: +high, low: +low, close: +close };
  });
}

const rows = loadCsv('C:/Users/user/Downloads/OANDA_JP225YJPY, 1.csv').sort((a, b) => a.time - b.time);
console.log(`データ: ${new Date(rows[0].time*1000).toISOString()} → ${new Date(rows[rows.length-1].time*1000).toISOString()}`);
console.log(`1 分 bar 数: ${rows.length} (${(rows.length/60).toFixed(1)} 時間)`);

// 5 分ロールアップ
function rollup(rows, periodSec) {
  const buckets = new Map();
  for (const r of rows) {
    const bucketStart = Math.floor(r.time / periodSec) * periodSec;
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, []);
    buckets.get(bucketStart).push(r);
  }
  const result = [];
  for (const [bs, arr] of [...buckets.entries()].sort((a,b)=>a[0]-b[0])) {
    arr.sort((a, b) => a.time - b.time);
    result.push({
      time: bs,
      open: arr[0].open,
      high: Math.max(...arr.map(r => r.high)),
      low: Math.min(...arr.map(r => r.low)),
      close: arr[arr.length-1].close,
    });
  }
  return result;
}

const m5 = rollup(rows, 300);
console.log(`\n5 分 bar 数: ${m5.length}`);
console.log(`先頭 10 本:`);
for (const r of m5.slice(0, 10)) {
  console.log(`  ${new Date(r.time*1000).toISOString()}  O=${r.open.toFixed(2)} H=${r.high.toFixed(2)} L=${r.low.toFixed(2)} C=${r.close.toFixed(2)}`);
}

// ============ 5 分窓 close-to-close 変動 (1 分粒度で計算、より精密) ============
// 各 1 分 bar 時点で「5 分前と比較した変動率」を見る
console.log('\n=== 1 分粒度で「現在 close ÷ 5 分前 close」の変動率分布 ===');
const changes5m = [];
for (let i = 5; i < rows.length; i++) {
  if (rows[i].time - rows[i-5].time !== 300) continue;
  changes5m.push((rows[i].close / rows[i-5].close - 1) * 100);
}
const abs5m = changes5m.map(Math.abs);
const sorted5m = [...abs5m].sort((a,b)=>a-b);
function pct(p) { return sorted5m[Math.floor(sorted5m.length * p)]; }

console.log(`  サンプル: ${changes5m.length}`);
console.log(`  abs %: min=${Math.min(...abs5m).toFixed(4)}, p50=${pct(0.50).toFixed(4)}, p75=${pct(0.75).toFixed(4)}, p90=${pct(0.90).toFixed(4)}, p95=${pct(0.95).toFixed(4)}, p99=${pct(0.99).toFixed(4)}, max=${Math.max(...abs5m).toFixed(4)}`);

console.log(`\n=== 5 分窓 閾値ごとのヒット頻度 (5 時間サンプル) ===`);
const totalMin = rows.length;
for (const th of [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50]) {
  const hits = abs5m.filter(x => x >= th).length;
  const cooldownAware = hits > 0 ? Math.max(hits, 1) : 0;
  console.log(`  ≥ ${th.toFixed(2)}% : ${hits} tick (${(hits/changes5m.length*100).toFixed(1)}%) → ${cooldownAware > 0 ? `平均 ${(totalMin / cooldownAware).toFixed(1)} 分に 1 件` : '発火なし'}`);
}

// ============ 30 秒スロープを 1 分粒度で代用 (1 分窓 close-to-close) ============
console.log('\n=== 1 分窓 close-to-close 変動率 (slope の代理) ===');
const changes1m = [];
for (let i = 1; i < rows.length; i++) {
  if (rows[i].time - rows[i-1].time !== 60) continue;
  changes1m.push((rows[i].close / rows[i-1].close - 1) * 100);
}
const abs1m = changes1m.map(Math.abs);
const sorted1m = [...abs1m].sort((a,b)=>a-b);
function pct1(p) { return sorted1m[Math.floor(sorted1m.length * p)]; }
console.log(`  サンプル: ${changes1m.length}`);
console.log(`  abs %: min=${Math.min(...abs1m).toFixed(4)}, p50=${pct1(0.50).toFixed(4)}, p90=${pct1(0.90).toFixed(4)}, p95=${pct1(0.95).toFixed(4)}, p99=${pct1(0.99).toFixed(4)}, max=${Math.max(...abs1m).toFixed(4)}`);

console.log(`\n=== 1 分窓 閾値ヒット (slope 0.10% は 30s 窓基準なので参考) ===`);
for (const th of [0.05, 0.07, 0.10, 0.15]) {
  const hits = abs1m.filter(x => x >= th).length;
  console.log(`  ≥ ${th.toFixed(2)}% : ${hits} tick → ${hits > 0 ? `${(totalMin/hits).toFixed(1)} 分に 1 件` : '0 件'}`);
}

// ============ 上位 10 件の最大変動を時刻と共に表示 (異常時を特定) ============
console.log('\n=== 5 分窓で最大変動 上位 10 ===');
const indexed = [];
for (let i = 5; i < rows.length; i++) {
  if (rows[i].time - rows[i-5].time !== 300) continue;
  indexed.push({ time: rows[i].time, chg: (rows[i].close / rows[i-5].close - 1) * 100, from: rows[i-5].close, to: rows[i].close });
}
indexed.sort((a, b) => Math.abs(b.chg) - Math.abs(a.chg));
for (const x of indexed.slice(0, 10)) {
  console.log(`  ${new Date(x.time*1000).toISOString()}  ${x.from.toFixed(2)} → ${x.to.toFixed(2)} (${x.chg.toFixed(3)}%)`);
}

// 期間全体での価格レンジ
console.log('\n=== 期間全体のレンジ ===');
const allHigh = Math.max(...rows.map(r => r.high));
const allLow = Math.min(...rows.map(r => r.low));
console.log(`  期間最高: ${allHigh}`);
console.log(`  期間最安: ${allLow}`);
console.log(`  期間レンジ: ${((allHigh - allLow) / allLow * 100).toFixed(3)}%`);
