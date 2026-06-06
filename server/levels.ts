import type { SessionOHLC } from './sessionOHLC.js';
import { isSessionComplete } from './sessionOHLC.js';
import { deriveSwing, fibLevelsForSwing, currentSessionSwing, DEFAULT_SWING_WINDOWS } from './fibLevels.js';
import { resolveLevelsConfig } from './configStore.js';
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
  // 高安関係の全水準(クラスタ/上位N選抜・スコア合計によらず全件)。ダブルトップ/ボトム検知用に露出。
  hlLevels?: { price: number; label: string }[];
}

// ── 調整ノブ(Task5 で config 化予定。ここでは定数を既定値として参照)──
// 直近高安(直近2)の対象セッション数は config パラメータ(levelLookbackSessions / levelLookbackSessions2)。
// 既定は 10 / 20。PARAM_BOUNDS とUIノブ「直近高安の範囲」で可変。
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
// v0.6.10: 反応水準(価格が複数回反転した実反応の帯)を最重視。Fib は単独だと過剰だったため低減し、
// 反応帯/キリ番/セッション極値との「合流」で効くようにする(合流倍率は維持)。
const WEIGHTS = {
  sessHL: 1.0, todayHL: 1.0, open: 0.8,
  grid250: 0.4, grid500: 0.7, grid1000: 1.2,
  prevClose: 1.3, longHL: 1.6, adr: 0.7,
  fibRetr: 0.6, fibExt: 0.6, fibToday: 0.3,
  reaction: 1.0, reactionPer: 0.2,   // 反応水準: weight = reaction + reactionPer×min(反応回数,5)
  fibExtBreakout: 1.8,               // 高値/安値更新中、ブレイク側のFib拡張は前方目標として強める(ユーザー指定)
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
  fibConfluenceBonus: number;
  levelTestBonus: number;
}

/**
 * 価格昇順の候補を ±tol で束ね、スコア/ティア/代表価格を付与。
 * score = Σweight × (1 + LEVEL_TEST_BONUS×min(count,5)) × confluenceMult。
 * 被テスト count は「クラスタに寄与していないセッション」の high/low/close が代表価格±tol 内に入った数。
 */
function cluster(cands: Cand[], current: number, opts: ClusterOpts): Level[] {
  const { tol, sessions, fibConfluenceBonus, levelTestBonus } = opts;
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
    if (s >= 2 || (hasFib && hasNonFib)) mult = fibConfluenceBonus;
    if (s >= 3) mult *= 1.25;

    const sumWeight = group.reduce((acc, g) => acc + g.weight, 0);
    const score = sumWeight * (1 + levelTestBonus * Math.min(testCount, 5)) * mult;

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
  reactionLevels: { price: number; reactions: number }[] = [],   // v0.6.10: 反応帯(複数回反転した実水準)
): LevelsResult {
  const cfg = resolveLevelsConfig();
  const tol = cfg.tol;
  const showN = cfg.showN;
  const selectWindowYen = cfg.selectWindowYen;
  const isCurrent = (s: SessionOHLC): boolean =>
    !!currentSession && s.sessionDate === currentSession.sessionDate && s.session === currentSession.session;
  const inProgress = sessions.find(isCurrent) ?? null;
  const completed = sessions.filter(s => !isCurrent(s));

  const cands: Cand[] = [];
  // 寄りから揃っているセッションだけ高安を水準に使う(寄り欠け=収集途中のセッションは高安が不正確)。
  const completedComplete = completed.filter(isSessionComplete);
  const recent = completedComplete.slice(0, cfg.lookbackSessions);
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
  // 直近高/安は通常いずれかのセッション高安と一致する。重複時は新規候補にせず
  // 既存候補のラベルに併記する（同一価格をコンフルエンス本数に水増ししないため）。
  const mark = (price: number, label: string): void => {
    const ex = cands.find(c => c.price === price);
    if (ex) ex.label += `・${label}`;
    else cands.push({ price, label, weight: WEIGHTS.sessHL, kind: 'sessHL' });
  };
  if (recent.length) {
    mark(Math.max(...recent.map(s => s.high)), '直近高');
    mark(Math.min(...recent.map(s => s.low)), '直近安');
  }
  // 直近高安2: 少し長い期間(cfg.lookbackSessions2)のスイング高安。扱いは直近高安と同じ
  // (weight=sessHL / kind=sessHL → hlLevels に露出し、ダブル・水準抜けの監視対象になる)。
  const recent2 = completedComplete.slice(0, cfg.lookbackSessions2);
  if (recent2.length) {
    mark(Math.max(...recent2.map(s => s.high)), '直近高2');
    mark(Math.min(...recent2.map(s => s.low)), '直近安2');
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

  // ── 反応水準(v0.6.10): 価格が複数回反転した実反応の帯。最も意識される S/R なので高めの重み。
  // reactions(反転回数)が多いほど強い。キリ番/セッション極値と近ければ cluster で合流して更に上位化。
  for (const rl of reactionLevels) {
    if (!Number.isFinite(rl.price) || rl.price <= 0) continue;
    const w = WEIGHTS.reaction + WEIGHTS.reactionPer * Math.min(Math.max(rl.reactions, 0), 5);
    cands.push({ price: rl.price, label: `反応${rl.reactions}回`, weight: w, kind: 'reaction' });
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

  // 高値/安値更新中(ブレイク)の判定。直近レンジの上限/下限を現値が超えた=前方に過去S/Rが無い局面。
  // この時はブレイク側の Fib 拡張(127.2/161.8% など)を前方目標として強める(ユーザー指定: 更新中はFibが有効)。
  const rangeHigh = recent.length ? Math.max(...recent.map(s => s.high)) : current;
  const rangeLow = recent.length ? Math.min(...recent.map(s => s.low)) : current;
  const breakingUp = current >= rangeHigh;
  const breakingDown = current <= rangeLow;

  for (const { sw, today } of swings) {
    for (const fl of fibLevelsForSwing(sw)) {
      let weight: number = today ? WEIGHTS.fibToday : (fl.kind === 'retr' ? WEIGHTS.fibRetr : WEIGHTS.fibExt);
      if (fl.kind === 'ext' && !today) {
        if (breakingUp && fl.price > current) weight = WEIGHTS.fibExtBreakout;       // 上抜け継続の前方目標
        else if (breakingDown && fl.price < current) weight = WEIGHTS.fibExtBreakout; // 下抜け継続の前方目標
      }
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

  // 高安関係の固定水準(クラスタ/上位N選抜前)。ダブル/水準抜け検知の対象として露出。価格で重複排除。
  // 当日高安(todayHL)は現値追従(min/max(extreme, current))で動くため、固定水準としては使わない
  // (動く端を基準にすると下落中にダブルボトムが乱発する)。当日ぶんは levelsLoop が確定スイング
  // ピボット(swingPivots)を別途供給する。ここでは固定の sessHL/直近/長期のみ。
  const hlSeen = new Set<number>();
  const hlLevels: { price: number; label: string }[] = [];
  for (const c of cands) {
    if (c.kind !== 'sessHL' && c.kind !== 'longHL') continue;
    if (!(c.price > 0) || hlSeen.has(c.price)) continue;
    hlSeen.add(c.price);
    hlLevels.push({ price: c.price, label: c.label });
  }

  const clustered = cluster(cands, current, {
    tol,
    sessions: completedComplete,
    fibConfluenceBonus: cfg.fibConfluenceBonus,
    levelTestBonus: cfg.levelTestBonus,
  });

  // ── 選抜: 近接窓内スコア降順 + 直近1本 + 遠方(指値/逆指値用)主要水準 ──
  const inWindow = (l: Level): boolean => Math.abs(l.dist) <= selectWindowYen;
  const upAll = clustered.filter(l => l.dist > 0);
  const downAll = clustered.filter(l => l.dist < 0);

  // v0.6.11: 遠方の主要水準は「相場を見られない時の強力な指値/逆指値の置き場」。大変動セッションほど多く出す
  // (ボラ連動)。ADR(直近セッション平均レンジ)に対し直近レンジが大きい=大変動региムなら 4本、平常は 3本。
  const ranges = completedComplete.slice(0, 10).map(s => s.high - s.low).filter(x => x > 0);
  const adr = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : 0;
  const curRange = inProgress ? Math.max(inProgress.high, current) - Math.min(inProgress.low, current)
    : (ranges[0] ?? adr);
  const volRatio = adr > 0 ? curRange / adr : 1;
  const farCount = volRatio >= 1.3 ? 4 : 3;

  const pickSide = (side: Level[]): Level[] => {
    const win = side.filter(inWindow);
    const chosen: Level[] = [...win].sort((a, b) => b.score - a.score).slice(0, showN);
    const add = (l: Level | undefined): void => {
      if (l && !chosen.includes(l)) chosen.push(l);
    };
    // (a) 現値直近1本(窓内最近接)
    add([...win].sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))[0]);
    // (b) 遠い水準は指値/逆指値の置き場に有効(相場を見られない時・大変動時に特に)。窓外の強い水準を
    //     farCount 本まで表示(ボラ連動: 大変動セッションほど多く)。
    for (const f of side.filter(l => !inWindow(l)).sort((a, b) => b.score - a.score).slice(0, farCount)) add(f);
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

  // ── ティア = 相対ランク。基準は「近接(窓内)水準の最大スコア」にする。
  // 遠方の強水準(指値用)を含めても、近接の実戦水準の★が潰れないようにする(遠方は norm>1→★★扱い)。
  const display = [...up, ...down];
  const nearForTier = display.filter(l => Math.abs(l.dist) <= selectWindowYen);
  const maxScore = (nearForTier.length ? nearForTier : display).reduce((m, l) => Math.max(m, l.score), 0);
  for (const l of display) {
    const norm = maxScore > 0 ? l.score / maxScore : 0;
    if (norm >= 0.66 && l.confluence) l.tier = 2;
    else if (norm >= 0.40) l.tier = 1;
    else l.tier = 0;
    l.strong = l.tier >= 1;   // 後方互換
  }

  return { current, up, down, swing, reversalSatisfied, asOf, hlLevels };
}
