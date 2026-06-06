// 有効トレンドラインのバックテスト。3点接触ライン(condition 1)を過去データから「k点目が付いた時刻 T_k で
// 確定」(ルックアヘッド無し)し、T_k 以降の前方挙動で有効性を測る。
//   指標: 反発率(到達時にホールド=0.3×ADR以上戻る vs ブレイク=終値が逆側へ break%超)・寿命中央値。
//   比較: 乱択(同点・ランダム傾き)ベースライン。
// 【②合流テスト】各ラインの確定時刻 T_k で、ライン価格 L_k が「T_k より前のスイング点が集積した水平S/R」と
//   重なる(=合流)かを判定し、合流ライン / 非合流ライン / 乱択 の反発率を比較する(合流の上乗せを測る)。
//
// 使い方: npx tsx scripts/trendline-backtest.mts
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { extractSwingPivots, type SwingBar, type SwingPivot } from '../server/swingPivots.js';

const SYMBOL = 'NIY=F';
const JST = 9 * 3600_000, HOUR = 3600_000, DAY = 24 * HOUR;
const RECLAIM_1H = 120, RECLAIM_3H = 200;
const TOL_PCT = 0.0004;
const REACTION_ADR_MULT = 0.3;
const MAX_FWD_DAYS = 90;
const BASELINE_PER_LINE = 2;

let _seed = 123456789;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

interface Bar { t: number; h: number; l: number; c: number; }
function resampleHL(bars: SwingBar[], tfMs: number): SwingBar[] {
  const m = new Map<number, SwingBar>();
  for (const b of bars) { const k = Math.floor(b.t / tfMs) * tfMs; const e = m.get(k); if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; } else m.set(k, { t: k, h: b.h, l: b.l }); }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare(`SELECT t,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t ASC`).all(SYMBOL) as Bar[];
db.close();
const hm = (t: number) => new Date(t + JST).toISOString().slice(0, 16).replace('T', ' ');

const dr = new Map<string, { hi: number; lo: number }>();
for (const b of bars) { const d = new Date(b.t + JST).toISOString().slice(0, 10); const e = dr.get(d); if (e) { if (b.h > e.hi) e.hi = b.h; if (b.l < e.lo) e.lo = b.l; } else dr.set(d, { hi: b.h, lo: b.l }); }
const rrng = [...dr.values()].map(r => r.hi - r.lo).filter(x => x > 0);
const ADR = rrng.reduce((a, b) => a + b, 0) / rrng.length;
const reactionThresh = REACTION_ADR_MULT * ADR;

const hl: SwingBar[] = bars.map(b => ({ t: b.t, h: b.h, l: b.l }));
const pivots = [...extractSwingPivots(resampleHL(hl, HOUR), RECLAIM_1H), ...extractSwingPivots(resampleHL(hl, 3 * HOUR), RECLAIM_3H)].sort((a, b) => a.t - b.t);
const pivotTimesAsc = pivots.map(p => p.t);

interface Line { kind: 'support' | 'resistance'; slope: number; anchorT: number; anchorPrice: number; touchTs: number[]; }
function confirmLines(breakPct: number): Line[] {
  const out: Line[] = [];
  for (const kind of ['support', 'resistance'] as const) {
    const want = kind === 'support' ? 'low' : 'high';
    const pts = pivots.filter(p => p.kind === want && p.price > 0);
    const seen = new Set<string>();
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j]; if (!a || !b || b.t === a.t) continue;
      const slope = (b.price - a.price) / (b.t - a.t);
      if (kind === 'support' ? !(slope > 0) : !(slope < 0)) continue;
      const lineAt = (t: number) => a.price + slope * (t - a.t);
      const touchTs: number[] = [];
      for (const q of pts) { const L = lineAt(q.t); if (L <= 0) continue; const diff = q.price - L; if (Math.abs(diff) <= L * TOL_PCT) touchTs.push(q.t); else if (kind === 'support' ? diff < -L * breakPct : diff > L * breakPct) break; }
      if (touchTs.length < 3) continue;
      const intercept = a.price - slope * a.t;
      const sig = `${kind}:${Math.round(slope * 1e9 / 30) * 30}:${Math.round(intercept / Math.max(a.price * TOL_PCT * 2, 1))}`;
      if (seen.has(sig)) continue; seen.add(sig);
      out.push({ kind, slope, anchorT: a.t, anchorPrice: a.price, touchTs });
    }
  }
  return out;
}

// 合流判定: T_k より前のスイング点(自ラインのタッチを除く)が、ライン価格 L_k の ±conflTol に conflMin 個以上
// 集積していれば「水平S/Rと合流」。= トレンドラインがキリ番でなく実反応の水平帯と交わる点で確定した。
function confluenceHits(line: Line, t3: number, Lk: number, conflTol: number): number {
  const own = new Set(line.touchTs);
  let n = 0;
  for (const p of pivots) { if (p.t >= t3) break; if (own.has(p.t)) continue; if (Math.abs(p.price - Lk) <= conflTol) n++; }
  return n;
}

function lowerBound(t: number): number { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m]!.t <= t) lo = m + 1; else hi = m; } return lo; }
interface Fwd { holds: number; broke: boolean; lifeMs: number | null; }
function forward(kind: 'support' | 'resistance', slope: number, anchorT: number, anchorPrice: number, t0: number, breakPct: number): Fwd {
  const lineAt = (t: number) => anchorPrice + slope * (t - anchorT);
  let holds = 0, near = false, ext = kind === 'support' ? Infinity : -Infinity, broke = false, breakT = 0;
  const endT = t0 + MAX_FWD_DAYS * DAY;
  for (let k = lowerBound(t0); k < bars.length; k++) {
    const bar = bars[k]!; if (bar.t > endT) break; const L = lineAt(bar.t); if (L <= 0) continue;
    if (kind === 'support') {
      if (bar.c < L * (1 - breakPct)) { broke = true; breakT = bar.t; break; }
      if (bar.l <= L * (1 + TOL_PCT)) { near = true; if (bar.l < ext) ext = bar.l; }
      if (near && bar.h - ext >= reactionThresh) { holds++; near = false; ext = Infinity; }
    } else {
      if (bar.c > L * (1 + breakPct)) { broke = true; breakT = bar.t; break; }
      if (bar.h >= L * (1 - TOL_PCT)) { near = true; if (bar.h > ext) ext = bar.h; }
      if (near && ext - bar.l >= reactionThresh) { holds++; near = false; ext = -Infinity; }
    }
  }
  return { holds, broke, lifeMs: broke ? breakT - t0 : null };
}
function agg(fwds: Fwd[]) {
  const H = fwds.reduce((a, r) => a + r.holds, 0), B = fwds.filter(r => r.broke).length;
  const life = fwds.filter(r => r.lifeMs != null).map(r => r.lifeMs! / DAY).sort((a, b) => a - b);
  return { n: fwds.length, holdRate: H / Math.max(H + B, 1), medLife: life.length ? life[Math.floor(life.length / 2)]! : null };
}
function fwdBaseline(line: Line, t3: number, Lk: number, pool: number[], breakPct: number): Fwd[] {
  const r: Fwd[] = [];
  for (let b = 0; b < BASELINE_PER_LINE; b++) { const rs = pool[Math.floor(rnd() * pool.length)]!; const slope = line.kind === 'support' ? Math.abs(rs) : -Math.abs(rs); r.push(forward(line.kind, slope, t3, Lk, t3, breakPct)); }
  return r;
}

console.log(`=== トレンドライン合流テスト (${SYMBOL}) ===`);
console.log(`データ ${bars.length}本 ${hm(bars[0]!.t)}〜${hm(bars.at(-1)!.t)} / ADR=${ADR.toFixed(0)}円 / 反発閾値=${reactionThresh.toFixed(0)}円 / スイング点${pivots.length}`);
console.log(`合流=確定時点で「T_k以前のスイング点が ±conflTol に conflMin個以上集積する水平価格」とライン価格が重なる\n`);
console.log(`break% conflMin tol  合流本数 合流反発率 | 非合流本数 非合流反発率 | 乱択反発率 || 合流-乱択  合流-非合流`);

for (const breakPct of [0.003, 0.006]) {
  const lines = confirmLines(breakPct).filter(l => l.touchTs.length >= 3);
  const pool = lines.map(l => l.slope);
  // 各ラインの t3/Lk を1回算出
  const meta = lines.map(l => { const t3 = l.touchTs[2]!; const Lk = l.anchorPrice + l.slope * (t3 - l.anchorT); return { l, t3, Lk }; });
  const realF = meta.map(m => forward(m.l.kind, m.l.slope, m.l.anchorT, m.l.anchorPrice, m.t3, breakPct));
  const baseF = meta.flatMap(m => fwdBaseline(m.l, m.t3, m.Lk, pool, breakPct));
  const baseRate = agg(baseF).holdRate;

  for (const conflTol of [40]) {
    for (const conflMin of [1, 2, 3]) {
      const isConfl = meta.map(m => confluenceHits(m.l, m.t3, m.Lk, conflTol) >= conflMin);
      const cF = realF.filter((_, i) => isConfl[i]);
      const nF = realF.filter((_, i) => !isConfl[i]);
      const c = agg(cF), n = agg(nF);
      const eBase = (c.holdRate - baseRate) * 100, eNon = (c.holdRate - n.holdRate) * 100;
      const mark = eBase >= 8 && eNon >= 5 ? ' ✅' : eBase >= 4 ? ' ・' : '';
      console.log(`${(breakPct * 100).toFixed(2)}%   ${conflMin}    ${conflTol}円  ${String(c.n).padStart(5)}   ${(c.holdRate * 100).toFixed(1).padStart(6)}%  | ${String(n.n).padStart(6)}    ${(n.holdRate * 100).toFixed(1).padStart(6)}%  | ${(baseRate * 100).toFixed(1).padStart(6)}%  || ${eBase >= 0 ? '+' : ''}${eBase.toFixed(1).padStart(4)}    ${eNon >= 0 ? '+' : ''}${eNon.toFixed(1).padStart(4)}${mark}`);
    }
  }
}
console.log('\n✅=合流が乱択+8pt以上かつ非合流+5pt以上(=合流に明確な上乗せ)。');
