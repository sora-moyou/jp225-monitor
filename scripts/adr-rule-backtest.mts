/**
 * ADR バンドルール検証(9年・NIY=F・bar駆動・アラート非依存)
 * ルール:
 *  ① 買いはADR上限で強制決済、売りはADR下限で強制決済(=テイクプロフィット)
 *  ② 強制決済ラインまで最低利幅が取れないならエントリーしない
 *  ③ 逆張りはADR上限/下限の近く(15%以内)のみ。中間帯は順張りのみ。
 *
 * ADR=「現状通り」: 同一セッション種別(Day/Night別)・直近20回・始値基準 median(high-open)/median(open-low)。
 * A=動的: 上限=当日セッション実現安値+R / 下限=実現高値-R(R=adrUp+adrDown)。毎バー再計算。
 * 既定(ルール外の実装値・要調整可): MA60+傾きでトレンド, stop=建値∓0.5R, 往復コスト10pt, 1ポジ, 足終値で成行。
 * ルックアヘッド無し: ADRは厳密に過去の完了同種セッションのみ。
 */
import { DatabaseSync } from 'node:sqlite';

const DB = 'C:/Users/user/Desktop/backtest-multiyear.db';
const ADR_N = 20;
const EDGE = 0.15;          // 端=Rの15%以内
let MIN_PROFIT_FRAC = 0.25; // ②最低利幅=0.25R(スイープで可変)
const MA_N = 60;            // トレンド用MA(本)
const SLOPE_LAG = 20;       // 傾き=MA[now]-MA[lag前]
let STOP_FRAC = 0.5;        // stop=建値∓0.5R(スイープで可変)
let COST_RT = Number(process.argv.find(a => a.startsWith('--cost='))?.split('=')[1] ?? 10);  // 往復コスト(pt)
const TICK = 5;

interface Bar { sd: string; ses: 'Day' | 'Night'; t: number; o: number; h: number; l: number; c: number; }
interface Sess { key: string; sd: string; ses: 'Day' | 'Night'; bars: Bar[]; open: number; high: number; low: number; close: number; openT: number; complete: boolean; }

const DAY_OPEN_MIN = 8 * 60 + 45, NIGHT_OPEN_MIN = 17 * 60, COMPLETE_TOL_MS = 12 * 60_000;
function sessionOpenEpoch(sd: string, ses: 'Day' | 'Night'): number {
  const [y, m, d] = sd.split('-').map(Number);
  const min = ses === 'Day' ? DAY_OPEN_MIN : NIGHT_OPEN_MIN;
  return Date.UTC(y!, m! - 1, d!, Math.floor(min / 60), min % 60) - 9 * 3600_000;
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y); const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

// ---- load + group into sessions ----
const db = new DatabaseSync(DB);
const rows = db.prepare("select session_date sd, session ses, t, o, h, l, c from bars_1m where symbol='NIY=F' order by t").all() as any[];
const sessMap = new Map<string, Sess>();
for (const r of rows) {
  const key = r.sd + '|' + r.ses;
  let s = sessMap.get(key);
  if (!s) { s = { key, sd: r.sd, ses: r.ses, bars: [], open: r.o, high: r.h, low: r.l, close: r.c, openT: r.t, complete: false }; sessMap.set(key, s); }
  s.bars.push({ sd: r.sd, ses: r.ses, t: r.t, o: r.o, h: r.h, l: r.l, c: r.c });
  if (r.h > s.high) s.high = r.h; if (r.l < s.low) s.low = r.l; s.close = r.c;
}
const sessions = [...sessMap.values()].sort((a, b) => a.openT - b.openT);
for (const s of sessions) s.complete = s.openT <= sessionOpenEpoch(s.sd, s.ses) + COMPLETE_TOL_MS;

// trailing ADR per session type (strictly prior complete same-type sessions)
function adrFor(idx: number, ses: 'Day' | 'Night'): { up: number; down: number; n: number } {
  const up: number[] = [], down: number[] = [];
  for (let i = idx - 1; i >= 0 && up.length < ADR_N; i--) {
    const s = sessions[i]!;
    if (s.ses !== ses || !s.complete) continue;
    up.push(s.high - s.open); down.push(s.open - s.low);
  }
  return { up: median(up), down: median(down), n: up.length };
}

const yr = (t: number) => new Date(t).getUTCFullYear();

// --- US DST 判定(2nd Sun Mar 〜 1st Sun Nov, 07:00 UTC=2am ET 切替近似) ---
function nthSundayUTC(y: number, monthIdx: number, n: number): number {
  let d = Date.UTC(y, monthIdx, 1), cnt = 0;
  while (true) { if (new Date(d).getUTCDay() === 0) { cnt++; if (cnt === n) break; } d += 86400_000; }
  return d + 7 * 3600_000;  // 07:00 UTC
}
function isUSDST(t: number): boolean {
  const y = new Date(t).getUTCFullYear();
  return t >= nthSundayUTC(y, 2, 2) && t < nthSundayUTC(y, 10, 1);
}
// 5サブバケット: entryT(UTC ms)から。NY=前半(9:30-12:45ET)/後半(12:45-16:00ET〜)
function subBucket(t: number, ses: 'Day' | 'Night'): string {
  if (ses === 'Day') {
    const jstHour = new Date(t + 9 * 3600_000).getUTCHours();
    return jstHour < 12 ? 'Day-AM(前場)' : 'Day-PM(後場)';
  }
  const etOff = (isUSDST(t) ? -4 : -5) * 3600_000;
  const etMin = Math.floor(((t + etOff) % 86400_000 + 86400_000) % 86400_000 / 60000);
  if (etMin < 570) return 'Night-NY前';     // <9:30 ET(夕方)
  if (etMin < 765) return 'NY前半';          // 9:30-12:45 ET
  return 'NY後半';                            // 12:45 ET〜(引け16:00含む)
}

interface Trade { side: 1 | -1; entry: number; exit: number; pnl: number; reason: string; t: number; entryT: number; zone: string; mode: string; durMs: number; ses: 'Day' | 'Night'; }

// rolling MA over continuous stream for trend
function runStrategy(decide: (ctx: DecideCtx) => 0 | 1 | -1, opts: { oncePerSession?: boolean; gate?: (t: number, ses: 'Day' | 'Night') => boolean } = {}): Trade[] {
  const trades: Trade[] = [];
  const closes: number[] = [];
  const maHist: number[] = [];
  for (let si = 0; si < sessions.length; si++) {
    const S = sessions[si]!;
    if (!S.complete) { for (const b of S.bars) { closes.push(b.c); pushMA(closes, maHist); } continue; }
    const adr = adrFor(si, S.ses);
    if (adr.n < 10 || adr.up <= 0 || adr.down <= 0) { for (const b of S.bars) { closes.push(b.c); pushMA(closes, maHist); } continue; }
    const R = adr.up + adr.down;
    let lo = S.bars[0]!.l, hi = S.bars[0]!.h;
    let entriesThisSession = 0;
    let pos: { side: 1 | -1; entry: number; stop: number; entryT: number } | null = null;
    for (let bi = 0; bi < S.bars.length; bi++) {
      const b = S.bars[bi]!;
      lo = Math.min(lo, b.l); hi = Math.max(hi, b.h);
      closes.push(b.c); pushMA(closes, maHist);
      const upper = lo + R, lower = hi - R;        // 動的バンド
      // --- manage open position (intrabar: stop優先=保守的) ---
      if (pos) {
        if (pos.side === 1) {
          if (b.l <= pos.stop) { close(pos, pos.stop, 'stop', b.t); pos = null; }
          else if (b.h >= upper) { close(pos, upper, 'adr-tp', b.t); pos = null; }
        } else {
          if (b.h >= pos.stop) { close(pos, pos.stop, 'stop', b.t); pos = null; }
          else if (b.l <= lower) { close(pos, lower, 'adr-tp', b.t); pos = null; }
        }
      }
      // --- entry when flat ---
      if (!pos && bi < S.bars.length - 1 && !(opts.oncePerSession && entriesThisSession >= 1) && (!opts.gate || opts.gate(b.t, S.ses))) {     // 最終バーは新規しない(引け決済のみ)
        const ma = maHist[maHist.length - 1];
        const maPast = maHist[maHist.length - 1 - SLOPE_LAG];
        if (ma != null && maPast != null) {
          const price = b.c;
          const slope = ma - maPast;
          const trend: 0 | 1 | -1 = (price > ma && slope > 0) ? 1 : (price < ma && slope < 0) ? -1 : 0;
          const nearUpper = price >= upper - EDGE * R;
          const nearLower = price <= lower + EDGE * R;
          const zone = nearUpper ? 'upper' : nearLower ? 'lower' : 'mid';
          const side = decide({ price, upper, lower, R, trend, zone });
          if (side !== 0) {
            // ② 最低利幅チェック
            const room = side === 1 ? upper - price : price - lower;
            if (room >= MIN_PROFIT_FRAC * R) {
              const stop = side === 1 ? price - STOP_FRAC * R : price + STOP_FRAC * R;
              pos = { side, entry: price, stop, entryT: b.t };
              entriesThisSession++;
              (pos as any)._zone = zone; (pos as any)._mode = (zone === 'mid' ? 'trend' : 'fade');
            }
          }
        }
      }
    }
    // session end: close
    if (pos) close(pos, S.bars[S.bars.length - 1]!.c, 'session-end', S.bars[S.bars.length - 1]!.t);

    function close(p: { side: 1 | -1; entry: number; entryT: number }, px: number, reason: string, t: number) {
      const gross = (px - p.entry) * p.side;
      trades.push({ side: p.side, entry: p.entry, exit: px, pnl: gross - COST_RT, reason, t, entryT: p.entryT, zone: (p as any)._zone ?? '?', mode: (p as any)._mode ?? '?', durMs: t - p.entryT, ses: S.ses });
    }
  }
  return trades;
}
function pushMA(closes: number[], maHist: number[]) {
  const n = closes.length;
  if (n >= MA_N) { let s = 0; for (let i = n - MA_N; i < n; i++) s += closes[i]!; maHist.push(s / MA_N); }
  else maHist.push(null as any);
}
interface DecideCtx { price: number; upper: number; lower: number; R: number; trend: 0 | 1 | -1; zone: string; }

// ---- the RULE decision ----
function ruleDecide(c: DecideCtx): 0 | 1 | -1 {
  if (c.zone === 'upper') return -1;   // ③ 端=逆張り(上限近く→売り)
  if (c.zone === 'lower') return 1;    // 端=逆張り(下限近く→買い)
  return c.trend;                       // 中間=順張りのみ
}
// 順張りのみ(③の逆張りを捨て、端でもトレンド側だけ。中間=順張り)
function trendOnlyDecide(c: DecideCtx): 0 | 1 | -1 { return c.trend; }
// 逆張りのみ(端のみ・中間は何もしない)= ③の逆張り脚を単独評価
function fadeOnlyDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'upper' ? -1 : c.zone === 'lower' ? 1 : 0; }
// 「2+1」: 中間帯で順張りのみ新規(端では新規しない=①利確専用)
function trendMidOnlyDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'mid' ? c.trend : 0; }
// 買いの逆張りのみ(下限のみ・単独評価)
function buyFadeOnlyDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'lower' ? 1 : 0; }
function sellFadeOnlyDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'upper' ? -1 : 0; }
// MIX: 中間=順張り + 下限=買い逆張り(上限ショートは無し)
function mixDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'lower' ? 1 : c.zone === 'mid' ? c.trend : 0; }
// MIX(ロングバイアス): 中間=順張りロングのみ + 下限=買い逆張り(売り一切なし)
function mixLongDecide(c: DecideCtx): 0 | 1 | -1 { return c.zone === 'lower' ? 1 : (c.zone === 'mid' && c.trend === 1) ? 1 : 0; }
// ---- random baseline: same opportunities, random side ----
function randDecide(seed: { v: number }) {
  return (c: DecideCtx): 0 | 1 | -1 => {
    // 同じ「エントリー機会(zone/trendが何であれ常に試行)」で side をランダム化
    seed.v = (seed.v * 1103515245 + 12345) & 0x7fffffff;
    if (c.zone === 'mid' && c.trend === 0) return 0; // mid neutral は rule同様スキップ(機会母集団を揃える)
    return (seed.v & 1) ? 1 : -1;
  };
}

function report(name: string, trades: Trade[]) {
  const n = trades.length, pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const w = trades.filter(t => t.pnl > 0), l = trades.filter(t => t.pnl <= 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = l.reduce((a, t) => a + t.pnl, 0);
  const pf = gl !== 0 ? gw / -gl : Infinity;
  // max drawdown on cumulative
  let cum = 0, peak = 0, dd = 0;
  for (const t of trades) { cum += t.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  console.log(`${name.padEnd(22)} n=${String(n).padStart(5)} pnl=${pnl.toFixed(0).padStart(7)} win%=${(100 * w.length / n).toFixed(0).padStart(3)} PF=${pf.toFixed(2).padStart(5)} avg=${(pnl / n).toFixed(1).padStart(6)} maxDD=${dd.toFixed(0)}`);
  return { n, pnl, pf };
}

console.log(`=== ADR rule backtest: NIY=F 2018-2026, ADR_N=${ADR_N}(median,per-session) EDGE=${EDGE} minProfit=${MIN_PROFIT_FRAC}R stop=${STOP_FRAC}R cost=${COST_RT}pt ===\n`);
const ruleTrades = runStrategy(ruleDecide);
report('RULE (all)', ruleTrades);

// by mode/zone
for (const m of ['trend', 'fade']) report('  ' + m, ruleTrades.filter(t => t.mode === m));
for (const z of ['upper', 'lower', 'mid']) report('  zone=' + z, ruleTrades.filter(t => t.zone === z));
for (const s of [[1, 'long'], [-1, 'short']] as const) report('  ' + s[1], ruleTrades.filter(t => t.side === s[0]));
console.log('  -- exit reasons --');
for (const r of ['adr-tp', 'stop', 'session-end']) report('  exit=' + r, ruleTrades.filter(t => t.reason === r));

console.log('\n-- by year --');
for (let y = 2018; y <= 2026; y++) { const ty = ruleTrades.filter(t => yr(t.t) === y); if (ty.length) report('  ' + y, ty); }

console.log('\n-- random baseline (5 seeds, same opportunity set) --');
let rsum = 0, rn = 0;
for (let k = 0; k < 5; k++) { const seed = { v: 1000 + k * 777 }; const rt = runStrategy(randDecide(seed)); const r = report('  rand seed' + k, rt); rsum += r.pnl; rn += r.n; }
console.log(`  rand AVG pnl=${(rsum / 5).toFixed(0)} (avg n=${(rn / 5).toFixed(0)})`);

console.log('\n-- variants (net @cost) --');
report('TREND-only', runStrategy(trendOnlyDecide));
report('FADE-only', runStrategy(fadeOnlyDecide));

console.log('\n=== 「2+1」: 中間順張りのみ + 端は①利確専用 + 1セッション1エントリー ===');
const v21 = runStrategy(trendMidOnlyDecide, { oncePerSession: true });
report('2+1 (cost=10)', v21);
console.log('  -- exit reasons --');
for (const r of ['adr-tp', 'stop', 'session-end']) report('  exit=' + r, v21.filter(t => t.reason === r));
for (const s of [[1, 'long'], [-1, 'short']] as const) report('  ' + s[1], v21.filter(t => t.side === s[0]));
console.log('  -- by year --');
for (let y = 2018; y <= 2026; y++) { const ty = v21.filter(t => yr(t.t) === y); if (ty.length) report('  ' + y, ty); }
COST_RT = 5; report('2+1 (cost=5)', runStrategy(trendMidOnlyDecide, { oncePerSession: true }));
COST_RT = 0; report('2+1 (gross,cost=0)', runStrategy(trendMidOnlyDecide, { oncePerSession: true }));
{ const seed = { v: 909 }; report('2+1 rand side gross', runStrategy(c => { seed.v = (seed.v * 1103515245 + 12345) & 0x7fffffff; return c.zone === 'mid' ? (seed.v & 1 ? 1 : -1) : 0; }, { oncePerSession: true })); }
COST_RT = 10;

console.log('\n=== MIX: 中間順張り + 下限「買い逆張り」のみ(上限ショート無し)・1セッション1エントリー ===');
console.log('-- 逆張り脚の単独グロス比較(cost=0) --');
COST_RT = 0;
report('buy-fade(下限)のみ gross', runStrategy(buyFadeOnlyDecide, { oncePerSession: true }));
report('sell-fade(上限)のみ gross', runStrategy(sellFadeOnlyDecide, { oncePerSession: true }));
COST_RT = 10;
const mix = runStrategy(mixDecide, { oncePerSession: true });
report('MIX (cost=10)', mix);
for (const s of [[1, 'long'], [-1, 'short']] as const) report('  ' + s[1], mix.filter(t => t.side === s[0]));
for (const z of ['lower', 'mid'] as const) report('  zone=' + z, mix.filter(t => t.zone === z));
console.log('  -- by year --');
for (let y = 2018; y <= 2026; y++) { const ty = mix.filter(t => yr(t.t) === y); if (ty.length) report('  ' + y, ty); }
COST_RT = 5; report('MIX (cost=5)', runStrategy(mixDecide, { oncePerSession: true }));
COST_RT = 0; report('MIX (gross)', runStrategy(mixDecide, { oncePerSession: true }));
COST_RT = 10;
console.log('-- MIX ロングバイアス版(売り一切なし) --');
const mixL = runStrategy(mixLongDecide, { oncePerSession: true });
report('MIX-long (cost=10)', mixL);
COST_RT = 5; report('MIX-long (cost=5)', runStrategy(mixLongDecide, { oncePerSession: true }));
COST_RT = 0; report('MIX-long (gross)', runStrategy(mixLongDecide, { oncePerSession: true }));
console.log('  -- by year (MIX-long, cost=10) --');
COST_RT = 10; const mixL2 = runStrategy(mixLongDecide, { oncePerSession: true });
for (let y = 2018; y <= 2026; y++) { const ty = mixL2.filter(t => yr(t.t) === y); if (ty.length) report('  ' + y, ty); }

console.log('\n-- GROSS (cost=0) --');
COST_RT = 0;
report('RULE gross', runStrategy(ruleDecide));
report('  trend gross', runStrategy(ruleDecide).filter(t => t.mode === 'trend'));
report('  fade gross', runStrategy(ruleDecide).filter(t => t.mode === 'fade'));
report('TREND-only gross', runStrategy(trendOnlyDecide));
{ const seed = { v: 4242 }; report('rand gross', runStrategy(randDecide(seed))); }

// ===== BETA CONTROL: MIX-long vs ランダムロング(同条件・エントリー時刻のみ乱択) =====
console.log('\n=== ベータ統制: MIX-long vs ランダムロング(1セッション1回・ロング限定・同じ出口) ===');
function expoStats(name: string, trades: Trade[]) {
  const gross = trades.reduce((a, t) => a + t.pnl, 0);
  const hrs = trades.reduce((a, t) => a + t.durMs, 0) / 3600_000;
  console.log(`${name.padEnd(26)} n=${String(trades.length).padStart(5)} gross=${gross.toFixed(0).padStart(7)} 保有h=${hrs.toFixed(0).padStart(6)} pt/保有h=${(gross / hrs).toFixed(2).padStart(6)}`);
  return { gross, hrs, perHr: gross / hrs };
}
COST_RT = 0;  // ベータ比較はグロスで(コストは同程度かかるので相殺)
const mlong = runStrategy(mixLongDecide, { oncePerSession: true });
const ml = expoStats('MIX-long (trend timing)', mlong);
// ランダムロング: 各バーで確率pでロング(時刻のみ乱択)、room/oncePerSession/出口は同一
let rlGross = 0, rlHrs = 0, rlPerHr = 0;
for (let k = 0; k < 5; k++) {
  const seed = { v: 5000 + k * 331 };
  const rl = runStrategy((c) => { seed.v = (seed.v * 1103515245 + 12345) & 0x7fffffff; return (seed.v % 100) < 3 ? 1 : 0; }, { oncePerSession: true });
  const s = expoStats('  randLong seed' + k, rl); rlGross += s.gross; rlHrs += s.hrs; rlPerHr += s.perHr;
}
console.log(`  randLong AVG gross=${(rlGross / 5).toFixed(0)} pt/保有h=${(rlPerHr / 5).toFixed(2)}`);
console.log(`\n  → MIX-long pt/保有h = ${ml.perHr.toFixed(2)}  vs  randLong pt/保有h = ${(rlPerHr / 5).toFixed(2)}`);
console.log(`     差(アルファの指標) = ${(ml.perHr - rlPerHr / 5).toFixed(2)} pt/保有h  ${ml.perHr > rlPerHr / 5 * 1.15 ? '→ タイミングに優位あり' : '→ ほぼ差なし=純ベータ'}`);
COST_RT = 10;

// buy&hold over period + 市場露出
const first = sessions.find(s => s.bars.length)!, last = [...sessions].reverse().find(s => s.bars.length)!;
const totMktHrs = sessions.reduce((a, s) => a + (s.bars.length ? (s.bars[s.bars.length - 1]!.t - s.bars[0]!.t) : 0), 0) / 3600_000;
const bh = last.close - first.open;
console.log(`\nbuy&hold ${first.sd}->${last.sd}: ${bh.toFixed(0)} pt / 市場露出 ${totMktHrs.toFixed(0)}h = ${(bh / totMktHrs).toFixed(2)} pt/h (参考: フル保有=ギャップ込み)`);

// ================= Day / Night 分離まとめ =================
console.log('\n\n################## Day / Night 分離まとめ ##################');
function dn(name: string, trades: Trade[]) {
  for (const [lab, set] of [['ALL', trades], ['  Day', trades.filter(t => t.ses === 'Day')], ['  Night', trades.filter(t => t.ses === 'Night')]] as const) {
    report((name + ' ' + lab).slice(0, 28), set as Trade[]);
  }
}
// gross runs
COST_RT = 0;
console.log('\n--- 順張り(中間)gross ---'); dn('trend-mid', runStrategy(trendMidOnlyDecide, { oncePerSession: true }));
console.log('--- 逆張り買い(下限)gross ---'); dn('buy-fade', runStrategy(buyFadeOnlyDecide, { oncePerSession: true }));
console.log('--- 逆張り売り(上限)gross ---'); dn('sell-fade', runStrategy(sellFadeOnlyDecide, { oncePerSession: true }));
console.log('--- MIX-long gross ---'); dn('MIX-long', runStrategy(mixLongDecide, { oncePerSession: true }));
// net runs
COST_RT = 10; console.log('\n--- MIX-long net@cost10 ---'); dn('MIX-long', runStrategy(mixLongDecide, { oncePerSession: true }));
COST_RT = 5; console.log('--- MIX-long net@cost5 ---'); dn('MIX-long', runStrategy(mixLongDecide, { oncePerSession: true }));

// beta control split by session
console.log('\n--- ベータ統制(pt/保有h・gross): MIX-long vs randLong ---');
COST_RT = 0;
function expoDN(name: string, trades: Trade[]) {
  for (const [lab, set] of [['ALL', trades], ['Day', trades.filter(t => t.ses === 'Day')], ['Night', trades.filter(t => t.ses === 'Night')]] as const) {
    const s = set as Trade[]; const g = s.reduce((a, t) => a + t.pnl, 0); const h = s.reduce((a, t) => a + t.durMs, 0) / 3600_000;
    console.log(`${(name + ' ' + lab).padEnd(24)} n=${String(s.length).padStart(5)} gross=${g.toFixed(0).padStart(7)} pt/保有h=${(g / h).toFixed(2).padStart(6)}`);
  }
}
expoDN('MIX-long', runStrategy(mixLongDecide, { oncePerSession: true }));
{ let dG = { Day: 0, Night: 0, ALL: 0 }, dH = { Day: 0, Night: 0, ALL: 0 };
  for (let k = 0; k < 5; k++) { const seed = { v: 5000 + k * 331 }; const rl = runStrategy((c) => { seed.v = (seed.v * 1103515245 + 12345) & 0x7fffffff; return (seed.v % 100) < 3 ? 1 : 0; }, { oncePerSession: true });
    for (const key of ['Day', 'Night', 'ALL'] as const) { const s = key === 'ALL' ? rl : rl.filter(t => t.ses === key); dG[key] += s.reduce((a, t) => a + t.pnl, 0); dH[key] += s.reduce((a, t) => a + t.durMs, 0) / 3600_000; } }
  for (const key of ['ALL', 'Day', 'Night'] as const) console.log(`randLong ${key.padEnd(15)} gross=${(dG[key] / 5).toFixed(0).padStart(7)} pt/保有h=${(dG[key] / dH[key]).toFixed(2).padStart(6)}`);
}
COST_RT = 10;

// ================= 4サブバケット分離(Night=NY前後 / Day=12時前後)=================
console.log('\n\n################## 4サブバケット分離(MIX-long)##################');
const BUCKETS = ['Day-AM(前場)', 'Day-PM(後場)', 'Night-NY前', 'NY前半', 'NY後半'];
function bucketRows(label: string, trades: Trade[], showPerHr = false) {
  console.log('-- ' + label + ' --');
  for (const bk of BUCKETS) {
    const s = trades.filter(t => subBucket(t.entryT, t.ses) === bk);
    if (!s.length) { console.log('  ' + bk.padEnd(22) + ' (none)'); continue; }
    const g = s.reduce((a, t) => a + t.pnl, 0), h = s.reduce((a, t) => a + t.durMs, 0) / 3600_000;
    const w = s.filter(t => t.pnl > 0), gw = w.reduce((a, t) => a + t.pnl, 0), gl = s.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    const pf = gl !== 0 ? gw / -gl : Infinity;
    const ph = showPerHr ? ` pt/保有h=${(g / h).toFixed(2).padStart(6)}` : '';
    console.log(`  ${bk.padEnd(22)} n=${String(s.length).padStart(5)} pnl=${g.toFixed(0).padStart(7)} win%=${(100 * w.length / s.length).toFixed(0).padStart(3)} PF=${pf.toFixed(2).padStart(5)} avg=${(g / s.length).toFixed(1).padStart(6)}${ph}`);
  }
}
// 各窓を公平に埋めるため複数エントリー(gross=エッジ評価)。netは過剰取引で無意味なので gross のみ。
const ML = { oncePerSession: false };
COST_RT = 0; bucketRows('MIX-long gross(multi)', runStrategy(mixLongDecide, ML), true);
bucketRows('順張り中間 gross(multi)', runStrategy(trendMidOnlyDecide, ML));
bucketRows('逆張り買い(下限) gross(multi)', runStrategy(buyFadeOnlyDecide, ML));
bucketRows('逆張り売り(上限) gross(multi)', runStrategy(sellFadeOnlyDecide, ML));
// ベータ統制: バケット別 pt/保有h(MIX-long vs randLong avg・複数エントリー)
console.log('-- ベータ統制 pt/保有h(MIX-long vs randLong5seed・multi)--');
const mlB = runStrategy(mixLongDecide, ML);
const rlSeeds = [0, 1, 2, 3, 4].map(k => { const seed = { v: 5000 + k * 331 }; return runStrategy((c) => { seed.v = (seed.v * 1103515245 + 12345) & 0x7fffffff; return (seed.v % 100) < 3 ? 1 : 0; }, ML); });
for (const bk of BUCKETS) {
  const m = mlB.filter(t => subBucket(t.entryT, t.ses) === bk);
  const mPh = m.reduce((a, t) => a + t.pnl, 0) / (m.reduce((a, t) => a + t.durMs, 0) / 3600_000);
  let rg = 0, rh = 0; for (const rl of rlSeeds) { const s = rl.filter(t => subBucket(t.entryT, t.ses) === bk); rg += s.reduce((a, t) => a + t.pnl, 0); rh += s.reduce((a, t) => a + t.durMs, 0) / 3600_000; }
  const rPh = rg / rh;
  console.log(`  ${bk.padEnd(22)} MIX=${mPh.toFixed(2).padStart(5)} rand=${rPh.toFixed(2).padStart(5)} α=${((mPh / rPh - 1) * 100).toFixed(0).padStart(4)}%`);
}
COST_RT = 10;

// ================= リズム検定: 各時間帯は方向を「受け継ぐ(継続)」か「転換(反転)」か =================
console.log('\n\n################## リズム検定: 時間帯間の方向 継続 vs 転換 ##################');
// 各セッションをサブバケットに割り、バケットの方向move(last.c - first.o)を時系列で並べる
interface BR { t: number; bucket: string; ret: number; }
const brs: BR[] = [];
for (const S of sessions) {
  if (!S.complete || !S.bars.length) continue;
  const byB = new Map<string, Bar[]>();
  for (const b of S.bars) { const k = subBucket(b.t, S.ses); (byB.get(k) ?? byB.set(k, []).get(k)!).push(b); }
  for (const [bucket, bs] of byB) brs.push({ t: bs[0]!.t, bucket, ret: bs[bs.length - 1]!.c - bs[0]!.o });
}
brs.sort((a, b) => a.t - b.t);
// サイクル順の遷移を集計
const CYCLE: [string, string][] = [
  ['Day-AM(前場)', 'Day-PM(後場)'],
  ['Day-PM(後場)', 'Night-NY前'],
  ['Night-NY前', 'NY前半'],
  ['NY前半', 'NY後半'],
  ['NY後半', 'Day-AM(前場)'],
];
const want = new Map(CYCLE.map(([a, b]) => [a + '→' + b, { n: 0, agree: 0, contPnl: 0, sxy: 0, sx: 0, sy: 0, sxx: 0, syy: 0 }]));
for (let i = 1; i < brs.length; i++) {
  const p = brs[i - 1]!, c = brs[i]!;
  const key = p.bucket + '→' + c.bucket;
  const g = want.get(key); if (!g) continue;
  g.n++;
  if (Math.sign(p.ret) === Math.sign(c.ret)) g.agree++;
  g.contPnl += c.ret * Math.sign(p.ret);   // 前の方向に賭けた時の今バケット損益(正=継続/momentum, 負=反転)
  g.sxy += p.ret * c.ret; g.sx += p.ret; g.sy += c.ret; g.sxx += p.ret * p.ret; g.syy += c.ret * c.ret;
}
console.log('遷移(前→今)            n    符号一致%   継続pt/回   corr   判定(ユーザー仮説)');
const expect: Record<string, string> = {
  'Day-AM(前場)→Day-PM(後場)': '確定(継続予想)',
  'Day-PM(後場)→Night-NY前': '受継ぎ(継続予想)',
  'Night-NY前→NY前半': '★転換(反転予想)',
  'NY前半→NY後半': '確定(継続予想)',
  'NY後半→Day-AM(前場)': '受継ぎ(継続予想)',
};
for (const [a, b] of CYCLE) {
  const key = a + '→' + b; const g = want.get(key)!;
  const corr = (g.n * g.sxy - g.sx * g.sy) / (Math.sqrt(g.n * g.sxx - g.sx * g.sx) * Math.sqrt(g.n * g.syy - g.sy * g.sy));
  const verdict = g.contPnl / g.n > 0 ? '継続' : '反転';
  console.log(`${key.padEnd(26)} ${String(g.n).padStart(4)}  ${(100 * g.agree / g.n).toFixed(1).padStart(6)}%  ${(g.contPnl / g.n).toFixed(1).padStart(8)}  ${corr.toFixed(3).padStart(6)}  ${verdict}  [${expect[key]}]`);
}
console.log('\n※ 符号一致%>50 / 継続pt>0 / corr>0 = 継続(受け継ぐ・確定)。<50 / <0 = 反転(転換)。');

// ============ NY下げの大きさ別: 翌Dayは継続下落か / Day前半で底打ちか ============
console.log('\n\n################## NY下げ条件 → 翌Day の挙動 ##################');
// 夜セッションのNY部分(NY前半+NY後半)の move を、その夜のR(=adrUp+adrDown)で正規化。
// 直後のDayセッションの: 日中リターン・AM/PM・安値がAMで付いたか(=前半底打ち)・PM戻し。
function nightR(idx: number): number { const a = adrFor(idx, 'Night'); return a.up + a.down; }
interface Pair { nyRetR: number; dayRet: number; amRet: number; pmRet: number; lowInAM: boolean; recov: boolean; dayDown: boolean; }
const pairs: Pair[] = [];
for (let i = 0; i < sessions.length; i++) {
  const N = sessions[i]!;
  if (N.ses !== 'Night' || !N.complete) continue;
  const R = nightR(i); if (R <= 0) continue;
  const nyBars = N.bars.filter(b => { const sb = subBucket(b.t, 'Night'); return sb === 'NY前半' || sb === 'NY後半'; });
  if (nyBars.length < 10) continue;
  const nyRet = nyBars[nyBars.length - 1]!.c - nyBars[0]!.c;
  // 直後のDay
  let D: Sess | null = null;
  for (let j = i + 1; j < sessions.length && j < i + 4; j++) { if (sessions[j]!.ses === 'Day' && sessions[j]!.complete) { D = sessions[j]!; break; } }
  if (!D) continue;
  const am = D.bars.filter(b => subBucket(b.t, 'Day') === 'Day-AM(前場)');
  const pm = D.bars.filter(b => subBucket(b.t, 'Day') === 'Day-PM(後場)');
  if (am.length < 5 || pm.length < 5) continue;
  const amLow = Math.min(...am.map(b => b.l)), pmLow = Math.min(...pm.map(b => b.l));
  const amRet = am[am.length - 1]!.c - am[0]!.o, pmRet = pm[pm.length - 1]!.c - pm[0]!.o;
  const dayRet = D.close - D.open;
  pairs.push({ nyRetR: nyRet / R, dayRet, amRet, pmRet, lowInAM: amLow <= pmLow, recov: pmRet > 0, dayDown: dayRet < 0 });
}
// ビン(NY move / R)
const bins: [string, (x: number) => boolean][] = [
  ['NY急落 ≤-0.75R', x => x <= -0.75],
  ['NY中下げ -0.75〜-0.3R', x => x > -0.75 && x <= -0.3],
  ['NY小下げ -0.3〜0R', x => x > -0.3 && x < 0],
  ['NY上げ 0〜+0.3R', x => x >= 0 && x < 0.3],
  ['NY大幅上げ ≥+0.3R', x => x >= 0.3],
];
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`(全${pairs.length}夜→Dayペア)`);
console.log('NY下げ区分              n    翌Day平均  Day下落%  AM底打ち%  PM戻し%   AM平均  PM平均');
for (const [lab, f] of bins) {
  const s = pairs.filter(p => f(p.nyRetR)); if (!s.length) { console.log(lab.padEnd(22) + ' (none)'); continue; }
  console.log(`${lab.padEnd(22)} ${String(s.length).padStart(4)}  ${mean(s.map(p => p.dayRet)).toFixed(1).padStart(8)}  ${(100 * s.filter(p => p.dayDown).length / s.length).toFixed(0).padStart(6)}%  ${(100 * s.filter(p => p.lowInAM).length / s.length).toFixed(0).padStart(7)}%  ${(100 * s.filter(p => p.recov).length / s.length).toFixed(0).padStart(6)}%  ${mean(s.map(p => p.amRet)).toFixed(1).padStart(6)}  ${mean(s.map(p => p.pmRet)).toFixed(1).padStart(6)}`);
}
console.log('\n※ 仮説: NY急落→Day継続下落(Day下落%高・AM底打ち%低・PM戻し%低)/ NY小〜中下げ→AM底打ち%高・PM戻し%高');

// ================= 直近6ヶ月だけ(レジーム適応・長期前提にしない)=================
console.log('\n\n################## 直近6ヶ月 (RECENT) ##################');
const lastT = Math.max(...sessions.filter(s => s.bars.length).map(s => s.bars[s.bars.length - 1]!.t));
const FROM_T = lastT - 183 * 86400_000;
console.log(`期間: ${new Date(FROM_T).toISOString().slice(0, 10)} 〜 ${new Date(lastT).toISOString().slice(0, 10)}`);
const rec = (ts: Trade[]) => ts.filter(t => t.entryT >= FROM_T);
const ym = (t: number) => new Date(t).toISOString().slice(0, 7);

console.log('\n-- MIX-long 直近(全体)--');
COST_RT = 10; const mlR = rec(runStrategy(mixLongDecide, { oncePerSession: true }));
report('MIX-long cost10', mlR);
COST_RT = 5; report('MIX-long cost5', rec(runStrategy(mixLongDecide, { oncePerSession: true })));
COST_RT = 0; report('MIX-long gross', rec(runStrategy(mixLongDecide, { oncePerSession: true })));
for (const s of [[1, 'long'], [-1, 'short']] as const) report('  ' + s[1], mlR.filter(t => t.side === s[0]));
console.log('  -- by month (cost10) --');
const byM: Record<string, Trade[]> = {};
COST_RT = 10; for (const t of rec(runStrategy(mixLongDecide, { oncePerSession: true }))) (byM[ym(t.t)] ??= []).push(t);
for (const m of Object.keys(byM).sort()) report('  ' + m, byM[m]!);

console.log('\n-- 時間帯別 gross(multi・直近)--');
COST_RT = 0;
bucketRows('MIX-long 直近 gross', rec(runStrategy(mixLongDecide, ML)), true);
bucketRows('順張り中間 直近 gross', rec(runStrategy(trendMidOnlyDecide, ML)));
bucketRows('逆張り売り 直近 gross', rec(runStrategy(sellFadeOnlyDecide, ML)));

// NY条件→翌Day(直近のみ・粗3区分)
console.log('\n-- NY下げ条件→翌Day(直近・粗3区分)--');
const recP = pairs.length;  // pairs は t を持たないので再構築
const rp: { ny: number; dayRet: number; lowInAM: boolean; pmRet: number; amRet: number }[] = [];
for (let i = 0; i < sessions.length; i++) {
  const N = sessions[i]!; if (N.ses !== 'Night' || !N.complete) continue;
  const R = nightR(i); if (R <= 0) continue;
  const nyB = N.bars.filter(b => { const sb = subBucket(b.t, 'Night'); return sb === 'NY前半' || sb === 'NY後半'; });
  if (nyB.length < 10) continue;
  let D: Sess | null = null;
  for (let j = i + 1; j < sessions.length && j < i + 4; j++) if (sessions[j]!.ses === 'Day' && sessions[j]!.complete) { D = sessions[j]!; break; }
  if (!D || D.bars[0]!.t < FROM_T) continue;
  const am = D.bars.filter(b => subBucket(b.t, 'Day') === 'Day-AM(前場)'), pm = D.bars.filter(b => subBucket(b.t, 'Day') === 'Day-PM(後場)');
  if (am.length < 5 || pm.length < 5) continue;
  rp.push({ ny: (nyB[nyB.length - 1]!.c - nyB[0]!.c) / R, dayRet: D.close - D.open, lowInAM: Math.min(...am.map(b => b.l)) <= Math.min(...pm.map(b => b.l)), pmRet: pm[pm.length - 1]!.c - pm[0]!.o, amRet: am[am.length - 1]!.c - am[0]!.o });
}
const mn = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
console.log(`(直近${rp.length}ペア) 区分          n  翌Day平均  AM底打ち%  PM平均`);
for (const [lab, f] of [['NY急落≤-0.6R', (x: number) => x <= -0.6], ['NYその他下げ', (x: number) => x > -0.6 && x < 0], ['NY上げ', (x: number) => x >= 0]] as const) {
  const s = rp.filter(p => f(p.ny)); if (!s.length) { console.log('  ' + lab + ' none'); continue; }
  console.log(`  ${lab.padEnd(14)} ${String(s.length).padStart(3)}  ${mn(s.map(p => p.dayRet)).toFixed(1).padStart(7)}  ${(100 * s.filter(p => p.lowInAM).length / s.length).toFixed(0).padStart(7)}%  ${mn(s.map(p => p.pmRet)).toFixed(1).padStart(6)}`);
}
COST_RT = 10;

// ================= Track A: パラメータ詰め(直近6mo中心・時間ゲート/ stop幅)=================
console.log('\n\n################## Track A: 数値の詰め(時間ゲート + stop幅)##################');
const gateEveMorn = (t: number, ses: 'Day' | 'Night') => { const b = subBucket(t, ses); return b === 'Night-NY前' || b === 'Day-AM(前場)'; };
const gateEveOnly = (t: number, ses: 'Day' | 'Night') => subBucket(t, ses) === 'Night-NY前';
function rep2(name: string, ts: Trade[]) {
  const recT = ts.filter(t => t.entryT >= FROM_T);
  for (const [lab, s] of [['全9y', ts], ['直近6mo', recT]] as const) {
    const n = s.length, pnl = s.reduce((a, t) => a + t.pnl, 0), w = s.filter(t => t.pnl > 0);
    const gl = s.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0), pf = gl ? w.reduce((a, t) => a + t.pnl, 0) / -gl : Infinity;
    let cum = 0, pk = 0, dd = 0; for (const t of s) { cum += t.pnl; pk = Math.max(pk, cum); dd = Math.max(dd, pk - cum); }
    console.log(`  ${(name + ' [' + lab + ']').padEnd(34)} n=${String(n).padStart(5)} pnl=${pnl.toFixed(0).padStart(7)} PF=${pf.toFixed(2).padStart(5)} maxDD=${dd.toFixed(0).padStart(6)}`);
  }
}
console.log('\n--- 時間ゲートの効果(MIX-long・cost10・1セッション1回)---');
COST_RT = 10;
rep2('ゲート無し(全時間)', runStrategy(mixLongDecide, { oncePerSession: true }));
rep2('夕方+前場ゲート', runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveMorn }));
rep2('夕方のみ', runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveOnly }));

console.log('\n--- stop幅スイープ(夕方+前場ゲート・MIX-long・cost10)---');
for (const sf of [0.4, 0.5, 0.6, 0.75, 1.0]) { STOP_FRAC = sf; rep2(`stop=${sf}R`, runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveMorn })); }
STOP_FRAC = 0.5;

console.log('\n--- 最低利幅(②)スイープ(夕方+前場ゲート・cost10)---');
for (const mp of [0.2, 0.3, 0.4]) { MIN_PROFIT_FRAC = mp; rep2(`minProfit=${mp}R`, runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveMorn })); }
MIN_PROFIT_FRAC = 0.25;

// ===== Track A 最終候補: 夕方のみ + stop0.75R + minProfit0.3R =====
console.log('\n--- 最終候補: 夕方(Night-NY前)のみ・ロング順張り・stop0.75R・minProfit0.3R ---');
STOP_FRAC = 0.75; MIN_PROFIT_FRAC = 0.3;
for (const c of [10, 5, 0]) { COST_RT = c; const ts = runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveOnly }); rep2(`cost=${c}`, ts); }
COST_RT = 10; const fin = runStrategy(mixLongDecide, { oncePerSession: true, gate: gateEveOnly });
console.log('  by year (cost10):');
for (let y = 2018; y <= 2026; y++) { const ty = fin.filter(t => yr(t.t) === y); if (ty.length) report('   ' + y, ty); }
STOP_FRAC = 0.5; MIN_PROFIT_FRAC = 0.25;
