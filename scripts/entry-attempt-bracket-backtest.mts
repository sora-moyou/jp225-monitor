// 仮説検証(ブラケット損益版): 「1回目の試行はだまし、反転後の“2回目の同価格試行”の方が良い」を、
//   エントリー種別を横断して(① ブレイク=順張り / ② バウンス=逆張り)実損益で比較する。
//   ポイント・イン・タイム。NIY=F の 1分足(基礎データ=約6ヶ月)。レベル=スイング高安(前後K本・確定はK本後=先読みなし)。
//
// ブラケット: エントリ価格 p0、ストップ= 確定レベル L の少し外(buf tick)、利確 = R × ストップ幅。
//   費用 = 片道マージン5円 ×2 + スリッページ(slipTick×TICK)を1トレードから控除。
//   同一足で SL/TP 両ヒットは SL 優先(保守)。maxHold 分で時間切れ→終端決済。
//
// 試行の分類(レベル L・方向 dir ごとに状態機械):
//   ブレイク族: 1stトリガ= close が L を抜ける / 失敗= close が L 内側へ戻る(だまし) / 2ndトリガ= 再び抜ける。
//   バウンス族: 1stトリガ= L に到達し弾かれて close が手前へ / 失敗= close が L を貫通(抜けた) / 2ndトリガ= 戻って再び弾かれる。
//
// 使い方: npx tsx scripts/entry-attempt-bracket-backtest.mts [K=10] [bufTick=2] [R=2] [maxHoldMin=60]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const K = Number(process.argv[2] ?? 10);
const BUF = Number(process.argv[3] ?? 2);          // ストップをレベルから何 tick 外に置くか
const R = Number(process.argv[4] ?? 2);            // 利確 = R × ストップ幅
const MAXHOLD = Number(process.argv[5] ?? 60);     // 時間切れ(分)
const TICK = 5;
const MARGIN = 5;                                  // 片道マージン(円)
const SLIP_TICK = 1;                               // スリッページ(tick)
const COST = MARGIN * 2 + SLIP_TICK * TICK;        // 1トレード往復費用 = 10 + 5 = 15
const SYMBOL = 'NIY=F';
const MS = 60_000;

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;
const span = `${new Date(bars[0]!.t + 9 * 3.6e6).toISOString().slice(0, 10)} .. ${new Date(bars.at(-1)!.t + 9 * 3.6e6).toISOString().slice(0, 10)}`;
console.log(`bars: ${N} (${span})  K=${K} buf=${BUF}tick R=${R} maxHold=${MAXHOLD}min cost=${COST}/trade\n`);

interface Trade { pnl: number; win: boolean; }
// ブラケット決済シミュレーション。dir=エントリ方向, slPrice=ストップ価格。
function bracket(i0: number, dir: 'up' | 'down', slPrice: number): Trade | null {
  const p0 = bars[i0]!.c;
  const stopDist = dir === 'up' ? p0 - slPrice : slPrice - p0;
  if (stopDist < TICK) return null;                          // レベルに近すぎ/不正はスキップ
  const tp = dir === 'up' ? p0 + R * stopDist : p0 - R * stopDist;
  const endT = bars[i0]!.t + MAXHOLD * MS;
  for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') {
      if (b.l <= slPrice) return { pnl: -stopDist - COST, win: false };   // 同一足両ヒットは SL 優先
      if (b.h >= tp) return { pnl: R * stopDist - COST, win: true };
    } else {
      if (b.h >= slPrice) return { pnl: -stopDist - COST, win: false };
      if (b.l <= tp) return { pnl: R * stopDist - COST, win: true };
    }
  }
  // 時間切れ: 終端 close で決済
  let last = p0; for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  const raw = dir === 'up' ? last - p0 : p0 - last;
  return { pnl: raw - COST, win: raw > 0 };
}

// レベル(スイング高安)を列挙。resistance=高値ピボット(上抜け/上から叩く), support=安値ピボット。
function pivots(kind: 'res' | 'sup'): { idx: number; L: number }[] {
  const out: { idx: number; L: number }[] = [];
  for (let j = K; j < N - K; j++) {
    const b = bars[j]!; let ok = true;
    for (let d = 1; d <= K; d++) {
      if (kind === 'res' ? (bars[j - d]!.h >= b.h || bars[j + d]!.h > b.h) : (bars[j - d]!.l <= b.l || bars[j + d]!.l < b.l)) { ok = false; break; }
    }
    if (ok) out.push({ idx: j, L: kind === 'res' ? b.h : b.l });
  }
  return out;
}

interface Entry { i0: number; dir: 'up' | 'down'; sl: number; }
const G = {
  break1: [] as Entry[], break2: [] as Entry[],     // ブレイク順張り 1st/2nd
  bounce1: [] as Entry[], bounce2: [] as Entry[],   // バウンス逆張り 1st/2nd
};
const TTL = 240; // レベル確定後の監視窓(分)

// ブレイク族(順張り): res→up, sup→down。
for (const kind of ['res', 'sup'] as const) {
  const dir = kind === 'res' ? 'up' : 'down';
  for (const { idx, L } of pivots(kind)) {
    const start = idx + K, deadline = bars[idx]!.t + TTL * MS;
    let st = 0;
    for (let i = start; i < N && bars[i]!.t <= deadline; i++) {
      const c = bars[i]!.c; const broke = dir === 'up' ? c > L : c < L; const back = dir === 'up' ? c < L : c > L;
      const sl = dir === 'up' ? L - BUF * TICK : L + BUF * TICK;   // 抜けた後はレベルが保持線
      if (st === 0 && broke) { G.break1.push({ i0: i, dir, sl }); st = 1; }
      else if (st === 1 && back) st = 2;
      else if (st === 2 && broke) { G.break2.push({ i0: i, dir, sl }); break; }
    }
  }
}
// バウンス族(逆張り): res を上から叩いて反落(short=down) / sup を下から支えられ反発(long=up)。
for (const kind of ['res', 'sup'] as const) {
  const dir = kind === 'res' ? 'down' : 'up';   // 逆張り方向
  for (const { idx, L } of pivots(kind)) {
    const start = idx + K, deadline = bars[idx]!.t + TTL * MS;
    const sl = kind === 'res' ? L + BUF * TICK : L - BUF * TICK;   // レベルの外側
    let st = 0;
    for (let i = start; i < N && bars[i]!.t <= deadline; i++) {
      const b = bars[i]!;
      // タッチ&拒否: res は high>=L かつ close<L / sup は low<=L かつ close>L
      const reject = kind === 'res' ? (b.h >= L && b.c < L) : (b.l <= L && b.c > L);
      const pierce = kind === 'res' ? b.c > L : b.c < L;   // 失敗=貫通
      if (st === 0 && reject) { G.bounce1.push({ i0: i, dir, sl }); st = 1; }
      else if (st === 1 && pierce) st = 2;
      else if (st === 2 && reject) { G.bounce2.push({ i0: i, dir, sl }); break; }
    }
  }
}

// ランダムベースライン(同数・両方向・ストップは固定 stopDist=中央値相当の代用として buf でなく直近レンジ)。
let seed = 2024; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function baseline(n: number): Entry[] {
  const out: Entry[] = [];
  for (let k = 0; k < n; k++) {
    const i0 = K + Math.floor(rnd() * (N - 2 * K));
    const dir = rnd() < 0.5 ? 'up' : 'down';
    // ストップ幅をブレイク群と揃えるため直近20本のレンジ平均の半分を採用
    let hi = -1e9, lo = 1e9; for (let i = Math.max(0, i0 - 20); i <= i0; i++) { hi = Math.max(hi, bars[i]!.h); lo = Math.min(lo, bars[i]!.l); }
    const half = Math.max((hi - lo) / 2, TICK * (BUF + 1));
    const sl = dir === 'up' ? bars[i0]!.c - half : bars[i0]!.c + half;
    out.push({ i0, dir, sl });
  }
  return out;
}

function report(label: string, es: Entry[]) {
  const ts = es.map(e => bracket(e.i0, e.dir, e.sl)).filter((t): t is Trade => t !== null);
  if (!ts.length) { console.log(`${label.padEnd(26)} n=0`); return; }
  const n = ts.length, wins = ts.filter(t => t.win).length;
  const tot = ts.reduce((a, t) => a + t.pnl, 0);
  const gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const gl = -ts.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const pf = gl > 0 ? gp / gl : Infinity;
  const avg = tot / n;
  console.log(`${label.padEnd(26)} n=${String(n).padStart(4)}  勝率=${(wins / n * 100).toFixed(1)}%  平均=${avg >= 0 ? '+' : ''}${avg.toFixed(1)}  合計=${tot >= 0 ? '+' : ''}${Math.round(tot)}  PF=${pf.toFixed(2)}`);
}

console.log('=== ① ブレイク族(順張り) ===');
report('1回目ブレイク', G.break1);
report('2回目(だまし後)ブレイク', G.break2);
console.log('\n=== ② バウンス族(逆張り) ===');
report('1回目バウンス', G.bounce1);
report('2回目(失敗後)バウンス', G.bounce2);
console.log('\n=== ベースライン ===');
report('ランダム入場', baseline(4000));
console.log(`\n単位=円(NIY指数pt)。費用 ${COST}/trade 控除済。ストップ=レベル±${BUF}tick、利確=${R}R、時間切れ${MAXHOLD}分。`);
