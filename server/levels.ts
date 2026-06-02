import type { SessionOHLC } from './sessionOHLC.js';
import { isSessionComplete } from './sessionOHLC.js';
import { deriveSwing, fibLevelsForSwing, currentSessionSwing, DEFAULT_SWING_WINDOWS } from './fibLevels.js';
// 後方互換のため再export(forecast.ts / forecastLoop.ts / 各テストは './levels.js' から import している)。
export type { SessionOHLC } from './sessionOHLC.js';
export { isSessionComplete } from './sessionOHLC.js';

export interface Level {
  price: number;
  dist: number;             // price - current (5円丸め)
  labels: string[];
  strong: boolean;          // 後方互換: tier>=1
  score: number;            // 意識度スコア
  tier: 0 | 1 | 2;          // 相対ランク(0=通常 / 1=★ / 2=★★合流帯)
  confluence: boolean;      // 合流倍率が掛かったか(tier2 判定に使用)
  fib?: number;             // 0.382 | 0.5 | 0.618 など
  reversalLine?: boolean;   // fib 50% の方向転換ライン
}
export interface LevelsResult {
  current: number;
  up: Level[];
  down: Level[];
  swing: { high: number; low: number; leg: 'up' | 'down' } | null;
  reversalSatisfied: boolean;
  asOf: number;
}

// ── 調整ノブ(Task5 で config 化予定。ここでは定数を既定値として参照)──
export const LOOKBACK_SESSIONS = 10;
export const CONFLUENCE_TOL = 30;   // 円(後方互換 export)
export const GRID = 250;            // 節目グリッド
export const NEAR_N = 4;            // 後方互換 export
export const FIB_SWING_SESSIONS = 5;
export const FIB_RATIOS = [0.382, 0.5, 0.618];

export const LEVEL_TOL = 25;              // 束ね許容(円)
export const LEVEL_SHOW_N = 5;            // up/down 各表示本数
export const SELECT_WINDOW_YEN = 1500;    // 近接選抜窓(円)
export const FIB_CONFLUENCE_BONUS = 1.5;  // 合流倍率
export const LEVEL_TEST_BONUS = 0.15;     // 被テスト加点係数

// ── 候補タイプ別重み ──
const WEIGHTS = {
  sessHL: 1.0, todayHL: 1.0, open: 0.8,
  grid250: 0.4, grid500: 0.7, grid1000: 1.2,
  prevClose: 1.3, longHL: 1.6, adr: 0.7,
  fibRetr: 1.0, fibExt: 0.5, fibToday: 0.5,
} as const;

interface Cand {
  price: number;
  label: string;
  weight: number;
  kind: string;
  fib?: number;
  reversalLine?: boolean;
  fibScale?: string;        // '5S' | '10S' | '20S' | '当日'(合流判定用)
  srcDate?: string;         // 由来セッション(被テスト自己除外用)
  srcSession?: 'Day' | 'Night';
}

function fmtSession(sd: string, ses: 'Day' | 'Night'): string {
  const [, m, d] = sd.split('-');   // YYYY-MM-DD
  return `${Number(m)}/${Number(d)}${ses === 'Day' ? '昼' : '夜'}`;
}

const round5 = (v: number): number => Math.round(v / 5) * 5;
function median(xs: number[]): number {
  const a = [...xs].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}
const isRound = (v: number): boolean =>
  v % 1000 === 0 || v % 500 === 0 || v % 100 === 0;

/**
 * クラスタの代表価格 = 最高 weight メンバーの実価格。
 * 同 weight 複数なら (1)節目(100/500/1000の倍数)優先 → (2)中央値に最も近いメンバー。最後に round5。
 */
function representativePrice(group: Cand[]): number {
  const maxW = Math.max(...group.map(g => g.weight));
  const top = group.filter(g => g.weight === maxW);
  if (top.length === 1) return round5(top[0]!.price);
  const med = median(group.map(g => g.price));
  const rounds = top.filter(g => isRound(g.price));
  const pool = rounds.length ? rounds : top;
  const best = pool.reduce((a, b) =>
    Math.abs(b.price - med) < Math.abs(a.price - med) ? b : a);
  return round5(best.price);
}

interface ClusterOpts {
  tol: number;
  sessions: SessionOHLC[];   // 被テスト count 用の全(寄り揃い)セッション
}

/**
 * 価格昇順の候補を ±tol で束ね、スコア/ティア/代表価格を付与。
 * score = Σweight × (1 + LEVEL_TEST_BONUS×min(count,5)) × confluenceMult。
 * 被テスト count は「クラスタに寄与していないセッション」の high/low/close が代表価格±tol 内に入った数。
 */
function cluster(cands: Cand[], current: number, opts: ClusterOpts): Level[] {
  const { tol, sessions } = opts;
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  let group: Cand[] = [];

  const flush = () => {
    if (group.length === 0) return;
    const price = representativePrice(group);

    const labels: string[] = [];
    for (const g of group) if (!labels.includes(g.label)) labels.push(g.label);
    const fibMember = group.find(g => g.fib !== undefined);

    // クラスタに寄与したセッション(被テスト自己除外用)
    const memberSessions = new Set<string>();
    for (const g of group) {
      if (g.srcDate && g.srcSession) memberSessions.add(`${g.srcDate}|${g.srcSession}`);
    }

    // 被テスト: クラスタのメンバーでないセッションの high/low/close が price±tol に入った回数
    let testCount = 0;
    for (const s of sessions) {
      if (memberSessions.has(`${s.sessionDate}|${s.session}`)) continue;
      if (Math.abs(s.high - price) <= tol || Math.abs(s.low - price) <= tol || Math.abs(s.close - price) <= tol) {
        testCount++;
      }
    }

    // 合流倍率: 異なる fib スケール種類数 s(当日=0.5換算)+ 非fib構造水準の有無 b
    const fibScales = new Set<string>();
    let hasNonFib = false;
    for (const g of group) {
      if (g.fibScale) fibScales.add(g.fibScale);
      else hasNonFib = true;
    }
    let s = 0;
    for (const sc of fibScales) s += sc === '当日' ? 0.5 : 1;
    const hasFib = fibScales.size > 0;
    let mult = 1;
    if (s >= 2 || (hasFib && hasNonFib)) mult = FIB_CONFLUENCE_BONUS;
    if (s >= 3) mult *= 1.25;

    const sumWeight = group.reduce((acc, g) => acc + g.weight, 0);
    const score = sumWeight * (1 + LEVEL_TEST_BONUS * Math.min(testCount, 5)) * mult;

    out.push({
      price,
      dist: round5(price - current),
      labels,
      strong: false,        // tier 確定後に上書き
      score,
      tier: 0,              // 相対ランクで後段確定
      confluence: mult > 1,
      fib: fibMember?.fib,
      reversalLine: group.some(g => g.reversalLine) || undefined,
    });
    group = [];
  };

  for (const c of sorted) {
    if (group.length && c.price - group[group.length - 1]!.price > tol) flush();
    group.push(c);
  }
  flush();
  return out;
}

export function computeLevels(
  sessions: SessionOHLC[],
  current: number,
  asOf: number,
  currentSession: { sessionDate: string; session: 'Day' | 'Night' } | null,
  extraLevels: { price: number; label: string }[] = [],
): LevelsResult {
  const tol = LEVEL_TOL;
  const isCurrent = (s: SessionOHLC): boolean =>
    !!currentSession && s.sessionDate === currentSession.sessionDate && s.session === currentSession.session;
  const inProgress = sessions.find(isCurrent) ?? null;
  const completed = sessions.filter(s => !isCurrent(s));

  const cands: Cand[] = [];
  // 寄りから揃っているセッションだけ高安を水準に使う(寄り欠け=収集途中のセッションは高安が不正確)。
  const completedComplete = completed.filter(isSessionComplete);
  const recent = completedComplete.slice(0, LOOKBACK_SESSIONS);
  for (const s of recent) {
    const tag = fmtSession(s.sessionDate, s.session);
    cands.push({ price: s.high, label: `${tag}高`, weight: WEIGHTS.sessHL, kind: 'sessHL', srcDate: s.sessionDate, srcSession: s.session });
    cands.push({ price: s.low, label: `${tag}安`, weight: WEIGHTS.sessHL, kind: 'sessHL', srcDate: s.sessionDate, srcSession: s.session });
  }
  if (inProgress && isSessionComplete(inProgress)) {
    // 当日も寄りから揃っている時だけ。高/安はライブ現値で即時拡張(DB書込待ちのラグ解消)。
    cands.push({ price: Math.max(inProgress.high, current), label: '当日高', weight: WEIGHTS.todayHL, kind: 'todayHL', srcDate: inProgress.sessionDate, srcSession: inProgress.session });
    cands.push({ price: Math.min(inProgress.low, current), label: '当日安', weight: WEIGHTS.todayHL, kind: 'todayHL', srcDate: inProgress.sessionDate, srcSession: inProgress.session });
    cands.push({ price: inProgress.open, label: '当日始', weight: WEIGHTS.open, kind: 'open' });
  }
  if (recent.length) {
    const recentHigh = Math.max(...recent.map(s => s.high));
    const recentLow  = Math.min(...recent.map(s => s.low));
    // 直近高/安は通常いずれかのセッション高安と一致する。重複時は新規候補にせず
    // 既存候補のラベルに併記する（同一価格をコンフルエンス本数に水増ししないため）。
    const mark = (price: number, label: string): void => {
      const ex = cands.find(c => c.price === price);
      if (ex) ex.label += `・${label}`;
      else cands.push({ price, label, weight: WEIGHTS.sessHL, kind: 'sessHL' });
    };
    mark(recentHigh, '直近高');
    mark(recentLow, '直近安');
  }
  if (completed.length) {
    // グリッド節目（履歴データがあれば現値から。寄り欠け判定とは独立）。
    cands.push({ price: Math.ceil((current + 5) / GRID) * GRID, label: '節目', weight: WEIGHTS.grid250, kind: 'grid250' });
    cands.push({ price: Math.floor((current - 5) / GRID) * GRID, label: '節目', weight: WEIGHTS.grid250, kind: 'grid250' });
    // 500/1000 円節目(現値の上下最近1本ずつ)
    cands.push({ price: Math.ceil((current + 5) / 500) * 500, label: '節目500', weight: WEIGHTS.grid500, kind: 'grid500' });
    cands.push({ price: Math.floor((current - 5) / 500) * 500, label: '節目500', weight: WEIGHTS.grid500, kind: 'grid500' });
    cands.push({ price: Math.ceil((current + 5) / 1000) * 1000, label: '節目1000', weight: WEIGHTS.grid1000, kind: 'grid1000' });
    cands.push({ price: Math.floor((current - 5) / 1000) * 1000, label: '節目1000', weight: WEIGHTS.grid1000, kind: 'grid1000' });
  }

  // ── 前日終値: 直近の完了 Day / Night の close ──
  const latestDay = completedComplete.find(s => s.session === 'Day');
  const latestNight = completedComplete.find(s => s.session === 'Night');
  if (latestDay) cands.push({ price: latestDay.close, label: '前日Day終値', weight: WEIGHTS.prevClose, kind: 'prevClose', srcDate: latestDay.sessionDate, srcSession: latestDay.session });
  if (latestNight) cands.push({ price: latestNight.close, label: '前日Night終値', weight: WEIGHTS.prevClose, kind: 'prevClose', srcDate: latestNight.sessionDate, srcSession: latestNight.session });

  // ── 長期高安: 取得セッション全体(寄り揃い)の最大高・最小安 ──
  if (completedComplete.length) {
    const hiS = completedComplete.reduce((a, b) => (b.high > a.high ? b : a));
    const loS = completedComplete.reduce((a, b) => (b.low < a.low ? b : a));
    cands.push({ price: hiS.high, label: '長期高', weight: WEIGHTS.longHL, kind: 'longHL', srcDate: hiS.sessionDate, srcSession: hiS.session });
    cands.push({ price: loS.low, label: '長期安', weight: WEIGHTS.longHL, kind: 'longHL', srcDate: loS.sessionDate, srcSession: loS.session });
  }

  // ── 外部レベル注入（予測ADR上限/下限など）──
  for (const e of extraLevels) {
    if (Number.isFinite(e.price) && e.price > 0) cands.push({ price: e.price, label: e.label, weight: WEIGHTS.adr, kind: 'adr' });
  }

  // ── 多スイング・多比率フィボ ──
  // 後方互換: swing/reversalSatisfied は従来 FIB_SWING_SESSIONS(=5)スイングで決める。
  let swing: LevelsResult['swing'] = null;
  let reversalSatisfied = false;
  const baseSwing = deriveSwing(completed, FIB_SWING_SESSIONS);
  if (baseSwing) {
    swing = { high: baseSwing.high, low: baseSwing.low, leg: baseSwing.leg };
    const range = baseSwing.high - baseSwing.low;
    const fib50 = baseSwing.leg === 'down' ? baseSwing.low + 0.5 * range : baseSwing.high - 0.5 * range;
    reversalSatisfied = baseSwing.leg === 'down' ? current > fib50 : current < fib50;
  }

  // 各完了セッション窓 {5,10,20} + 当日スイングの fib を候補化。
  const swings: ({ sw: import('./fibLevels.js').Swing; today: boolean })[] = [];
  for (const n of DEFAULT_SWING_WINDOWS) {
    const sw = deriveSwing(completed, n);
    if (sw) swings.push({ sw, today: false });
  }
  const todaySw = currentSessionSwing(inProgress && isSessionComplete(inProgress) ? inProgress : null, current);
  if (todaySw) swings.push({ sw: todaySw, today: true });

  for (const { sw, today } of swings) {
    for (const fl of fibLevelsForSwing(sw)) {
      const weight = today ? WEIGHTS.fibToday : (fl.kind === 'retr' ? WEIGHTS.fibRetr : WEIGHTS.fibExt);
      const pct = (fl.ratio * 100).toFixed(1).replace(/\.0$/, '');
      cands.push({
        price: fl.price,
        label: `Fib${pct}%(${fl.scaleLabel})`,
        weight,
        kind: today ? 'fib-today' : (fl.kind === 'retr' ? 'fib-retr' : 'fib-ext'),
        fib: fl.ratio,
        reversalLine: fl.reversalLine || undefined,
        fibScale: fl.scaleLabel,
      });
    }
  }

  const clustered = cluster(cands, current, { tol, sessions: completedComplete });

  // ── 選抜: 近接窓内スコア降順 + 直近1本 + 最上位1本(各側)──
  const inWindow = (l: Level): boolean => Math.abs(l.dist) <= SELECT_WINDOW_YEN;
  const upAll = clustered.filter(l => l.dist > 0);
  const downAll = clustered.filter(l => l.dist < 0);

  const pickSide = (side: Level[]): Level[] => {
    const win = side.filter(inWindow);
    const chosen: Level[] = [...win].sort((a, b) => b.score - a.score).slice(0, LEVEL_SHOW_N);
    const add = (l: Level | undefined): void => {
      if (l && !chosen.includes(l)) chosen.push(l);
    };
    // (a) 現値直近1本(窓内最近接)
    add([...win].sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0]);
    // (b) スコア最上位1本(窓外でも)
    add([...side].sort((a, b) => b.score - a.score)[0]);
    return chosen;
  };

  let up = pickSide(upAll);
  let down = pickSide(downAll);

  // fib50(方向転換ライン)が選抜から漏れたら、現値の上下どちらかへ強制追加。
  const fib50Level = clustered.find(l => l.reversalLine);
  if (fib50Level && ![...up, ...down].includes(fib50Level)) {
    if (fib50Level.dist > 0 && !up.includes(fib50Level)) up.push(fib50Level);
    else if (fib50Level.dist < 0 && !down.includes(fib50Level)) down.push(fib50Level);
  }

  // 価格で重複排除
  const dedup = (arr: Level[]): Level[] => {
    const seen = new Set<number>();
    const res: Level[] = [];
    for (const l of arr) {
      if (seen.has(l.price)) continue;
      seen.add(l.price);
      res.push(l);
    }
    return res;
  };
  up = dedup(up).sort((a, b) => a.price - b.price);
  down = dedup(down).sort((a, b) => b.price - a.price);

  // ── ティア = 相対ランク(表示集合 up+down で正規化)──
  const display = [...up, ...down];
  const maxScore = display.reduce((m, l) => Math.max(m, l.score), 0);
  for (const l of display) {
    const norm = maxScore > 0 ? l.score / maxScore : 0;
    if (norm >= 0.66 && l.confluence) l.tier = 2;
    else if (norm >= 0.40) l.tier = 1;
    else l.tier = 0;
    l.strong = l.tier >= 1;   // 後方互換
  }

  return { current, up, down, swing, reversalSatisfied, asOf };
}
