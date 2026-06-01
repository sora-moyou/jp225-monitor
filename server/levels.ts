export interface SessionOHLC {
  sessionDate: string;
  session: 'Day' | 'Night';
  open: number; high: number; low: number; close: number;
  highT: number; lowT: number;
}
export interface Level {
  price: number;
  dist: number;             // price - current (5円丸め)
  labels: string[];
  strong: boolean;          // コンフルエンス(>=2本)
  fib?: number;             // 0.382 | 0.5 | 0.618
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

// ── 調整ノブ ──
export const LOOKBACK_SESSIONS = 10;
export const CONFLUENCE_TOL = 30;   // 円
export const GRID = 250;            // 節目グリッド
export const NEAR_N = 4;            // up/down 各表示本数

interface Cand { price: number; label: string; fib?: number; reversalLine?: boolean; }

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

/** 価格昇順の候補を ±CONFLUENCE_TOL で束ねる。代表=中央値、strong=2本以上、fib/reversal は保持。 */
function cluster(cands: Cand[], current: number): Level[] {
  const sorted = [...cands].sort((a, b) => a.price - b.price);
  const out: Level[] = [];
  let group: Cand[] = [];
  const flush = () => {
    if (group.length === 0) return;
    const price = round5(median(group.map(g => g.price)));
    const labels: string[] = [];
    for (const g of group) if (!labels.includes(g.label)) labels.push(g.label);
    const fibMember = group.find(g => g.fib !== undefined);
    out.push({
      price,
      dist: round5(price - current),
      labels,
      strong: group.length >= 2,
      fib: fibMember?.fib,
      reversalLine: group.some(g => g.reversalLine) || undefined,
    });
    group = [];
  };
  for (const c of sorted) {
    if (group.length && c.price - group[group.length - 1]!.price > CONFLUENCE_TOL) flush();
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
): LevelsResult {
  const isCurrent = (s: SessionOHLC): boolean =>
    !!currentSession && s.sessionDate === currentSession.sessionDate && s.session === currentSession.session;
  const inProgress = sessions.find(isCurrent) ?? null;
  const completed = sessions.filter(s => !isCurrent(s));

  const cands: Cand[] = [];
  const recent = completed.slice(0, LOOKBACK_SESSIONS);
  for (const s of recent) {
    const tag = fmtSession(s.sessionDate, s.session);
    cands.push({ price: s.high, label: `${tag}高` });
    cands.push({ price: s.low, label: `${tag}安` });
  }
  if (inProgress) {
    cands.push({ price: inProgress.high, label: '当日高' });
    cands.push({ price: inProgress.low, label: '当日安' });
    cands.push({ price: inProgress.open, label: '当日始' });
  }
  if (recent.length) {
    const recentHigh = Math.max(...recent.map(s => s.high));
    const recentLow  = Math.min(...recent.map(s => s.low));
    // 直近高/安は既存候補と重複しない場合のみ追加
    if (!cands.some(c => c.price === recentHigh)) {
      cands.push({ price: recentHigh, label: '直近高' });
    }
    if (!cands.some(c => c.price === recentLow)) {
      cands.push({ price: recentLow, label: '直近安' });
    }
    // グリッド節目（履歴がある場合のみ）
    cands.push({ price: Math.ceil((current + 5) / GRID) * GRID, label: '節目' });
    cands.push({ price: Math.floor((current - 5) / GRID) * GRID, label: '節目' });
  }

  // フィボは別タスクで追加（ここでは swing=null）。
  const swing: LevelsResult['swing'] = null;
  const reversalSatisfied = false;

  const clustered = cluster(cands, current);
  const up = clustered.filter(l => l.dist > 0).sort((a, b) => a.dist - b.dist).slice(0, NEAR_N);
  const down = clustered.filter(l => l.dist < 0).sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist)).slice(0, NEAR_N);

  return { current, up, down, swing, reversalSatisfied, asOf };
}
