// 仮説検証: 「初回ブレイクは見送り、だまし(失敗)→反転後の“同価格の2回目ブレイク”の方が良い」。
// ポイント・イン・タイムで NIY=F の 1分足(基礎データ=約6ヶ月)からブレイクを再構成し、
//   ① 初回ブレイク群  ② だまし後の再ブレイク群  をランダム入場ベースラインと比較する。
// 使い方: npx tsx scripts/break-rebreak-backtest.mts [pivotK=10] [horizonMin=30] [levelTTLmin=240]
//
// レベル定義: スイング高値/安値(前後 K 本の極値=確定は K 本後＝先読みなし)。
// up(上抜け)の手順:  レベル L(スイング高値) に対し
//   1回目ブレイク = 確定後はじめて close>L になった足。
//   だまし        = その後 close<L に戻った(=失敗)。
//   2回目ブレイク = だましの後に再び close>L になった足。
// 各エントリの前進リターン= H 分後の方向終端リターン(円)+ MFE/MAE。down は対称。
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const K = Number(process.argv[2] ?? 10);          // スイング強度(前後K本)
const H = Number(process.argv[3] ?? 30);          // 前進ホライズン(分)
const TTL = Number(process.argv[4] ?? 240);       // レベル有効期間(分・確定後これを超えたら無効)
const SYMBOL = 'NIY=F';
const MS = 60_000;

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;
const span = `${new Date(bars[0]!.t + 9 * 3.6e6).toISOString().slice(0, 10)} .. ${new Date(bars.at(-1)!.t + 9 * 3.6e6).toISOString().slice(0, 10)}`;
console.log(`bars: ${N} (${span})  K=${K} H=${H}min TTL=${TTL}min\n`);

// 連続バー前提だがセッション境界でギャップがある。前進は「時刻 t+H*60s までの実バー」で測る。
function idxAtOrAfter(t: number): number { let lo = 0, hi = N; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m]!.t < t) lo = m + 1; else hi = m; } return lo; }

// エントリ(方向 dir, 入場 index i0)の前進結果。
function fwd(i0: number, dir: 'up' | 'down') {
  const p0 = bars[i0]!.c;
  const endT = bars[i0]!.t + H * MS;
  let mfe = 0, mae = 0, last = p0;
  for (let i = i0; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    const fav = dir === 'up' ? b.h - p0 : p0 - b.l;
    const adv = dir === 'up' ? p0 - b.l : b.h - p0;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    last = b.c;
  }
  return { ret: dir === 'up' ? last - p0 : p0 - last, mfe, mae };
}

interface Entry { i0: number; dir: 'up' | 'down'; }
const first: Entry[] = [];   // 初回ブレイク
const re: Entry[] = [];      // だまし後の再ブレイク

// スイング高値(resistance)/安値(support)を確定(先読みなし: index j のピボットは j+K で確定)。
// 各レベルについて確定後 TTL 内で break/fakeout/rebreak を1サイクル追う。
function scan(dir: 'up' | 'down') {
  for (let j = K; j < N - K; j++) {
    const b = bars[j]!;
    // ピボット判定(前後K本の極値)
    let isPivot = true;
    for (let d = 1; d <= K; d++) {
      if (dir === 'up' ? (bars[j - d]!.h >= b.h || bars[j + d]!.h > b.h) : (bars[j - d]!.l <= b.l || bars[j + d]!.l < b.l)) { isPivot = false; break; }
    }
    if (!isPivot) continue;
    const L = dir === 'up' ? b.h : b.l;
    const startIdx = j + K;                 // 確定時点(ここから監視開始=先読みなし)
    const deadline = bars[j]!.t + TTL * MS;
    // 状態機械: waitBreak1 -> waitFake -> waitBreak2
    let state = 0;
    for (let i = startIdx; i < N && bars[i]!.t <= deadline; i++) {
      const c = bars[i]!.c;
      const broken = dir === 'up' ? c > L : c < L;
      const back = dir === 'up' ? c < L : c > L;
      if (state === 0 && broken) { first.push({ i0: i, dir }); state = 1; }       // 1回目ブレイク
      else if (state === 1 && back) { state = 2; }                                  // だまし(失敗)
      else if (state === 2 && broken) { re.push({ i0: i, dir }); break; }           // 2回目ブレイク(だまし後)
    }
  }
}
scan('up'); scan('down');

// ランダム入場ベースライン(同数・同方向分布・同じ前進測定)。決定的乱数(線形合同)で再現可能。
let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function baseline(n: number, dir: 'up' | 'down') { const out: Entry[] = []; for (let k = 0; k < n; k++) out.push({ i0: K + Math.floor(rnd() * (N - 2 * K)), dir }); return out; }

function stats(label: string, es: Entry[]) {
  if (!es.length) { console.log(`${label.padEnd(22)} n=0`); return; }
  const rs = es.map(e => fwd(e.i0, e.dir));
  const n = rs.length;
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const ret = rs.map(r => r.ret);
  const hit = rs.filter(r => r.ret > 0).length / n;
  const avg = mean(ret);
  const mfe = mean(rs.map(r => r.mfe)), mae = mean(rs.map(r => r.mae));
  const sorted = [...ret].sort((a, b) => a - b); const med = sorted[Math.floor(n / 2)]!;
  console.log(`${label.padEnd(22)} n=${String(n).padStart(4)}  hit=${(hit * 100).toFixed(1)}%  avgRet=${avg >= 0 ? '+' : ''}${avg.toFixed(1)}  med=${med >= 0 ? '+' : ''}${med}  MFE=${mfe.toFixed(1)}  MAE=${mae.toFixed(1)}  期待値(MFE-MAE)=${(mfe - mae).toFixed(1)}`);
}

const firstUp = first.filter(e => e.dir === 'up'), firstDn = first.filter(e => e.dir === 'down');
const reUp = re.filter(e => e.dir === 'up'), reDn = re.filter(e => e.dir === 'down');
console.log('=== 全体(up+down) ===');
stats('① 初回ブレイク', first);
stats('② だまし後 再ブレイク', re);
stats('   ベースライン(random)', [...baseline(Math.round(first.length / 2), 'up'), ...baseline(Math.round(first.length / 2), 'down')]);
console.log('\n=== up(上抜け) ===');
stats('① 初回', firstUp); stats('② 再ブレイク', reUp);
console.log('\n=== down(下抜け) ===');
stats('① 初回', firstDn); stats('② 再ブレイク', reDn);
console.log(`\n注: ret/MFE/MAE は円(NIY=指数pt)。「② が ① を上回る」かが仮説の核。MFE-MAE は素のブラケット期待値の近似。`);
