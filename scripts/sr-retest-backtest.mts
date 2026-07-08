// 決定版検証: S/Rレベル限定 ＋ リテスト入場 で「1回目ブレイク vs だまし後の2回目ブレイク」を実損益比較。
//   レベル = monitor が高weightで使う点(=ポイント・イン・タイムに安く再現できる) に限定:
//     ・直近 LOOKBACK セッションの 高値/安値(sessHL)   ・250円グリッド(節目, 現値近傍)
//   入場 = ブレイク後の「リテスト」: 抜けたレベルへ価格が戻り、保持して再進行した所で順張り。
//     ストップ = レベルの反対側すぐ外(buf tick) → 浅い。利確 = R × ストップ幅。費用=5円×2+1tick。
//   分類: レベルごとに 1stブレイク→(だまし=内側へ戻る)→2ndブレイク。各々のリテスト入場を別集計。
// 使い方: npx tsx scripts/sr-retest-backtest.mts [LOOKBACK=10] [buf=2] [R=2] [maxHoldMin=60] [tol=20]
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { classifySession } from '../collector/session.js';

const LOOKBACK = Number(process.argv[2] ?? 10);   // 直近何セッションの H/L をレベルにするか
const BUF = Number(process.argv[3] ?? 2);
const R = Number(process.argv[4] ?? 2);
const MAXHOLD = Number(process.argv[5] ?? 60);
const TOL = Number(process.argv[6] ?? 20);        // リテスト到達/レベル束ね 許容(円)
const TICK = 5, COST = 5 * 2 + 1 * TICK;          // 15円/トレード
const GRID = 250, GRID_NEAR = 1500;               // 現値±この範囲のグリッドのみ
const RETEST_WIN = 60;                            // ブレイク後この分内にリテストが来なければ破棄
const SYMBOL = 'NIY=F', MS = 60_000;

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare('SELECT t,o,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t').all(SYMBOL) as Array<{ t: number; o: number; h: number; l: number; c: number }>;
const N = bars.length;

// セッション分割(先読みなし: 各バーを session に割当て、完了セッションの H/L を後続で使う)。
interface Sess { key: string; date: string; sess: 'Day' | 'Night'; hi: number; lo: number; startIdx: number; endIdx: number; }
const sessions: Sess[] = [];
let cur: Sess | null = null;
for (let i = 0; i < N; i++) {
  const si = classifySession(bars[i]!.t);
  if (!si) { continue; }
  const key = `${si.sessionDate}|${si.session}`;
  if (!cur || cur.key !== key) {
    if (cur) sessions.push(cur);
    cur = { key, date: si.sessionDate, sess: si.session, hi: bars[i]!.h, lo: bars[i]!.l, startIdx: i, endIdx: i };
  } else {
    cur.hi = Math.max(cur.hi, bars[i]!.h); cur.lo = Math.min(cur.lo, bars[i]!.l); cur.endIdx = i;
  }
}
if (cur) sessions.push(cur);
const span = `${sessions[0]?.date} .. ${sessions.at(-1)?.date}`;
console.log(`bars ${N}, sessions ${sessions.length} (${span})  LOOKBACK=${LOOKBACK} buf=${BUF}t R=${R} hold=${MAXHOLD}m tol=${TOL} cost=${COST}\n`);

// ブラケット決済(リテスト入場 index i0、方向 dir、ストップ slPrice)。
interface Trade { pnl: number; win: boolean; }
function bracket(i0: number, dir: 'up' | 'down', slPrice: number): Trade | null {
  const p0 = bars[i0]!.c;
  const stopDist = dir === 'up' ? p0 - slPrice : slPrice - p0;
  if (stopDist < TICK) return null;
  const tp = dir === 'up' ? p0 + R * stopDist : p0 - R * stopDist;
  const endT = bars[i0]!.t + MAXHOLD * MS;
  for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) {
    const b = bars[i]!;
    if (dir === 'up') { if (b.l <= slPrice) return { pnl: -stopDist - COST, win: false }; if (b.h >= tp) return { pnl: R * stopDist - COST, win: true }; }
    else { if (b.h >= slPrice) return { pnl: -stopDist - COST, win: false }; if (b.l <= tp) return { pnl: R * stopDist - COST, win: true }; }
  }
  let last = p0; for (let i = i0 + 1; i < N && bars[i]!.t <= endT; i++) last = bars[i]!.c;
  const raw = dir === 'up' ? last - p0 : p0 - last;
  return { pnl: raw - COST, win: raw > 0 };
}

interface Entry { i0: number; dir: 'up' | 'down'; sl: number; }
const first: Entry[] = [], second: Entry[] = [];

// 各セッションを処理。そのセッション開始時点で確定している「直近LOOKBACKセッションのH/L」+「節目グリッド」をレベルとする。
for (let s = LOOKBACK; s < sessions.length; s++) {
  const S = sessions[s]!;
  const ref = bars[S.startIdx]!.c;
  // レベル候補(上方=resistance, 下方=support)。
  const resraw: number[] = [], supraw: number[] = [];
  for (let k = s - LOOKBACK; k < s; k++) { resraw.push(sessions[k]!.hi); supraw.push(sessions[k]!.lo); }
  for (let g = Math.ceil((ref - GRID_NEAR) / GRID) * GRID; g <= ref + GRID_NEAR; g += GRID) { (g >= ref ? resraw : supraw).push(g); }
  // 束ね(TOL内)して、現値から GRID_NEAR 内のみ採用。
  const bundle = (arr: number[]) => { const a = [...new Set(arr)].sort((x, y) => x - y); const out: number[] = []; for (const v of a) { if (!out.length || v - out.at(-1)! > TOL) out.push(v); } return out.filter(v => Math.abs(v - ref) <= GRID_NEAR); };
  const resLevels = bundle(resraw), supLevels = bundle(supraw);

  // セッション内バー範囲(リテスト/決済は後続セッションへまたいでOK=実時間で測る)。
  const lo = S.startIdx, hi = S.endIdx;
  // 各レベルに状態機械。up=resistance上抜け / down=support下抜け。
  const run = (levels: number[], dir: 'up' | 'down') => {
    for (const L of levels) {
      const slBreak = dir === 'up' ? L - BUF * TICK : L + BUF * TICK;
      let st = 0;            // 0=未, 1=1stブレイク済(リテスト待ち), 2=だまし, 3=2ndブレイク済(リテスト待ち)
      let brokeAtT = 0;
      for (let i = lo; i <= hi; i++) {
        const b = bars[i]!; const c = b.c;
        const broke = dir === 'up' ? c > L : c < L;
        const back = dir === 'up' ? c < L : c > L;
        // リテスト到達&保持: レベルへ戻って(影が触れ)終値は進行側を維持。
        const touched = dir === 'up' ? (b.l <= L + TOL && c > L) : (b.h >= L - TOL && c < L);
        if (st === 0 && broke) { st = 1; brokeAtT = b.t; }
        else if (st === 1) {
          if (back) { st = 2; }
          else if (touched && b.t - brokeAtT <= RETEST_WIN * MS) { first.push({ i0: i, dir, sl: slBreak }); st = 9; }   // 1st リテスト入場→このレベル終了
        }
        else if (st === 2 && broke) { st = 3; brokeAtT = b.t; }
        else if (st === 3) {
          if (touched && b.t - brokeAtT <= RETEST_WIN * MS) { second.push({ i0: i, dir, sl: slBreak }); break; }
          if (back) { /* 2ndも失敗。打ち切り */ break; }
        }
      }
    }
  };
  run(resLevels, 'up'); run(supLevels, 'down');
}

function report(label: string, es: Entry[]) {
  const ts = es.map(e => bracket(e.i0, e.dir, e.sl)).filter((t): t is Trade => t !== null);
  if (!ts.length) { console.log(`${label.padEnd(24)} n=0`); return; }
  const n = ts.length, wins = ts.filter(t => t.win).length;
  const tot = ts.reduce((a, t) => a + t.pnl, 0);
  const gp = ts.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), gl = -ts.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  console.log(`${label.padEnd(24)} n=${String(n).padStart(4)}  勝率=${(wins / n * 100).toFixed(1)}%  平均=${(tot / n) >= 0 ? '+' : ''}${(tot / n).toFixed(1)}  合計=${tot >= 0 ? '+' : ''}${Math.round(tot)}  PF=${(gl > 0 ? gp / gl : Infinity).toFixed(2)}`);
}

console.log('=== S/Rレベル限定 + リテスト入場 ===');
report('① 1回目ブレイク', first);
report('② 2回目(だまし後)ブレイク', second);
report('  └ up(上抜け)①', first.filter(e => e.dir === 'up'));
report('  └ up(上抜け)②', second.filter(e => e.dir === 'up'));
report('  └ down(下抜け)①', first.filter(e => e.dir === 'down'));
report('  └ down(下抜け)②', second.filter(e => e.dir === 'down'));
console.log(`\n単位=円。費用 ${COST}/trade 控除済。レベル=直近${LOOKBACK}セッションH/L + 250節目。リテスト=ブレイク後${RETEST_WIN}分内にレベル復帰&保持。`);
