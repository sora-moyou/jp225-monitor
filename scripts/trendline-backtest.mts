// 有効トレンドラインのバックテスト(スイープ版)。3点接触ライン(condition 1)を過去データから「k点目が付いた
// 時刻 T_k で確定」(ルックアヘッド無し)し、T_k 以降の前方挙動で有効性を測る。接触数・ブレイク幅・時間分散の
// ゲートを振り、乱択(同点・ランダム傾き)ベースラインを各設定で上回るか=「有効ラインの見分け方」をデータで探す。
// 指標: 反発率(到達時にホールド=0.3×ADR以上戻る vs ブレイク=終値が逆側へ break%超)・寿命中央値。
//
// 使い方: npx tsx scripts/trendline-backtest.mts
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { extractSwingPivots, type SwingBar } from '../server/swingPivots.js';

const SYMBOL = 'NIY=F';
const JST = 9 * 3600_000, HOUR = 3600_000, DAY = 24 * HOUR;
const RECLAIM_1H = 120, RECLAIM_3H = 200;
const TOL_PCT = 0.0004;                 // 接触≒0(線に届いた点のみ)
const REACTION_ADR_MULT = 0.3;          // ホールド=線到達後 0.3×ADR 以上戻る
const MAX_FWD_DAYS = 90;
const BASELINE_PER_LINE = 2;

let _seed = 123456789;
const rnd = () => { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; };

interface Bar { t: number; h: number; l: number; c: number; }
function resampleHL(bars: SwingBar[], tfMs: number): SwingBar[] {
  const m = new Map<number, SwingBar>();
  for (const b of bars) {
    const k = Math.floor(b.t / tfMs) * tfMs;
    const e = m.get(k);
    if (e) { if (b.h > e.h) e.h = b.h; if (b.l < e.l) e.l = b.l; }
    else m.set(k, { t: k, h: b.h, l: b.l });
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

const db = new DatabaseSync(join(process.env.APPDATA!, 'jp225-monitor', 'jp225.db'), { readOnly: true });
const bars = db.prepare(`SELECT t,h,l,c FROM bars_1m WHERE symbol=? ORDER BY t ASC`).all(SYMBOL) as Bar[];
db.close();
const hm = (t: number) => new Date(t + JST).toISOString().slice(0, 16).replace('T', ' ');

// ADR(日次レンジ平均)
const dr = new Map<string, { hi: number; lo: number }>();
for (const b of bars) { const d = new Date(b.t + JST).toISOString().slice(0, 10); const e = dr.get(d); if (e) { if (b.h > e.hi) e.hi = b.h; if (b.l < e.lo) e.lo = b.l; } else dr.set(d, { hi: b.h, lo: b.l }); }
const rr = [...dr.values()].map(r => r.hi - r.lo).filter(x => x > 0);
const ADR = rr.reduce((a, b) => a + b, 0) / rr.length;
const reactionThresh = REACTION_ADR_MULT * ADR;

const hl: SwingBar[] = bars.map(b => ({ t: b.t, h: b.h, l: b.l }));
const pivots = [...extractSwingPivots(resampleHL(hl, HOUR), RECLAIM_1H), ...extractSwingPivots(resampleHL(hl, 3 * HOUR), RECLAIM_3H)].sort((a, b) => a.t - b.t);

interface Line { kind: 'support' | 'resistance'; slope: number; anchorT: number; anchorPrice: number; touchTs: number[]; }
// breakPct ごとに、確定前(=最初のブレイクより前)の接触列を持つラインを抽出(dedup)。
function confirmLines(breakPct: number): Line[] {
  const out: Line[] = [];
  for (const kind of ['support', 'resistance'] as const) {
    const want = kind === 'support' ? 'low' : 'high';
    const pts = pivots.filter(p => p.kind === want && p.price > 0);
    const seen = new Set<string>();
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j];
      if (!a || !b || b.t === a.t) continue;
      const slope = (b.price - a.price) / (b.t - a.t);
      if (kind === 'support' ? !(slope > 0) : !(slope < 0)) continue;
      const lineAt = (t: number) => a.price + slope * (t - a.t);
      const touchTs: number[] = [];
      for (const q of pts) {
        const L = lineAt(q.t); if (L <= 0) continue;
        const diff = q.price - L;
        if (Math.abs(diff) <= L * TOL_PCT) touchTs.push(q.t);
        else if (kind === 'support' ? diff < -L * breakPct : diff > L * breakPct) break;   // 確定前破断→打ち切り
      }
      if (touchTs.length < 3) continue;
      const intercept = a.price - slope * a.t;
      const sig = `${kind}:${Math.round(slope * 1e9 / 30) * 30}:${Math.round(intercept / Math.max(a.price * TOL_PCT * 2, 1))}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ kind, slope, anchorT: a.t, anchorPrice: a.price, touchTs });
    }
  }
  return out;
}

function lowerBound(t: number): number { let lo = 0, hi = bars.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bars[m]!.t <= t) lo = m + 1; else hi = m; } return lo; }
interface Fwd { holds: number; broke: boolean; lifeMs: number | null; }
function forward(kind: 'support' | 'resistance', slope: number, anchorT: number, anchorPrice: number, t0: number, breakPct: number): Fwd {
  const lineAt = (t: number) => anchorPrice + slope * (t - anchorT);
  let holds = 0, near = false, ext = kind === 'support' ? Infinity : -Infinity, broke = false, breakT = 0;
  const endT = t0 + MAX_FWD_DAYS * DAY;
  for (let k = lowerBound(t0); k < bars.length; k++) {
    const bar = bars[k]!; if (bar.t > endT) break;
    const L = lineAt(bar.t); if (L <= 0) continue;
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

console.log(`=== トレンドライン バックテスト・スイープ (${SYMBOL}) ===`);
console.log(`データ ${bars.length}本 ${hm(bars[0]!.t)}〜${hm(bars.at(-1)!.t)} / ADR=${ADR.toFixed(0)}円 / 反発閾値=${reactionThresh.toFixed(0)}円 / スイング点${pivots.length}`);
console.log(`\nbreak%  接触≥  分散≥  本数   実反発率   乱択反発率  差(pt)  実寿命中央`);

// 確定はブレイク幅に依存するので breakPct ごとに1回。接触数・分散はその後の post-filter。
for (const breakPct of [0.0012, 0.003, 0.006]) {
  const lines = confirmLines(breakPct);
  // 各ラインの前方結果(確定=3点目を基準に算出した t3 群を、接触数ゲートで使い分けるため touchTs を保持)
  for (const minT of [3, 4, 5]) {
    for (const spanDays of [0, 2]) {
      const sel = lines.filter(l => l.touchTs.length >= minT && (l.touchTs[minT - 1]! - l.touchTs[0]!) >= spanDays * DAY);
      if (sel.length === 0) { continue; }
      const realF: Fwd[] = [], baseF: Fwd[] = [];
      const pool = sel.map(l => l.slope);
      for (const l of sel) {
        const t3 = l.touchTs[minT - 1]!;
        realF.push(forward(l.kind, l.slope, l.anchorT, l.anchorPrice, t3, breakPct));
        const anchorAtT3 = l.anchorPrice + l.slope * (t3 - l.anchorT);
        for (let b = 0; b < BASELINE_PER_LINE; b++) {
          const rs = pool[Math.floor(rnd() * pool.length)]!;
          const slope = l.kind === 'support' ? Math.abs(rs) : -Math.abs(rs);
          baseF.push(forward(l.kind, slope, t3, anchorAtT3, t3, breakPct));
        }
      }
      const r = agg(realF), bse = agg(baseF);
      const edge = (r.holdRate - bse.holdRate) * 100;
      const mark = edge >= 8 ? ' ✅' : edge >= 4 ? ' ・' : '';
      console.log(`${(breakPct * 100).toFixed(2)}%   ${minT}     ${spanDays}日   ${String(r.n).padStart(5)}  ` +
        `${(r.holdRate * 100).toFixed(1).padStart(6)}%   ${(bse.holdRate * 100).toFixed(1).padStart(6)}%   ${edge >= 0 ? '+' : ''}${edge.toFixed(1).padStart(4)}   ` +
        `${r.medLife != null ? r.medLife.toFixed(1) + '日' : '—'}${mark}`);
    }
  }
}
console.log('\n✅=差+8pt以上(明確に有効) / ・=差+4〜8pt。乱択を大きく上回る設定=有効ラインの条件。');
