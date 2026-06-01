import type { Price } from './types.js';
import { computeContext, type AlertEvent } from './alertDetector.js';
import { getCachedBars } from './loops/alertLoop.js';
import { broadcast } from './sse/broker.js';
import { INSTRUMENTS } from './config.js';
import { isOnCooldown, markFired } from './alertCooldown.js';

// v0.3.17: 超短期 (5s/10s) フラッシュ検知。NIY=F (日経 225) 専用。
// v0.3.33: 価格がリアルタイム取得できるようになったので「値幅(円)」ベースに変更 (ユーザ要望)。
// 5〜10 秒窓で |値幅| >= ABSOLUTE_THRESHOLD_YEN(円) で発火。率ではなく円なので、ボード表示
// (超短期=+50円) と発火基準の単位が一致する。バッファは短期検知のローリング窓にも使うため拡大。

const TARGETS = new Set(['NIY=F']);
const BUFFER_MS = 6 * 60 * 1000;          // 6 min 保持 (超短期5/10s + 短期ローリング60s/5分の両用)
const ABSOLUTE_THRESHOLD_YEN = 80;         // 5〜10秒で 80円 以上の値幅で発火 (要調整ノブ)

interface Tick { t: number; price: number; }
const buffers = new Map<string, Tick[]>();

function findBaselinePrice(buf: Tick[], targetT: number): Tick | null {
  // buf は昇順時刻、targetT 以下で最大の t を持つエントリを返す (≒ 5s/10s 前のサンプル)
  let candidate: Tick | null = null;
  for (const t of buf) {
    if (t.t <= targetT) candidate = t;
    else break;
  }
  return candidate;
}

export function feedPrice(prices: Price[]): void {
  for (const price of prices) {
    if (!TARGETS.has(price.symbol)) continue;
    if (price.stale) continue;
    handleOne(price);
  }
}

function handleOne(price: Price): void {
  const now = price.timestamp;
  let buf = buffers.get(price.symbol) ?? [];
  buf.push({ t: now, price: price.price });
  const cutoff = now - BUFFER_MS;
  buf = buf.filter(t => t.t >= cutoff);
  buffers.set(price.symbol, buf);

  if (buf.length < 3) return;
  if (isOnCooldown(price.symbol, now)) return;

  // 5s と 10s 双方を評価、より大きい |値幅(円)| を採用
  const candidates: { window: number; ret: number; yen: number }[] = [];
  for (const win of [5, 10]) {
    const baseline = findBaselinePrice(buf, now - win * 1000);
    if (!baseline || baseline.price <= 0) continue;
    if (baseline.t === now) continue;       // 同一サンプル
    const yen = price.price - baseline.price;
    const ret = yen / baseline.price;
    if (Math.abs(yen) >= ABSOLUTE_THRESHOLD_YEN) candidates.push({ window: win, ret, yen });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => Math.abs(b.yen) - Math.abs(a.yen));
  const fired = candidates[0]!;

  markFired(price.symbol, now);
  const bars = getCachedBars(price.symbol);
  const ctx = computeContext(bars);
  const meta = INSTRUMENTS.find(i => i.symbol === price.symbol);
  const alert: AlertEvent = {
    symbol: price.symbol,
    symbolLabel: (meta?.labelJa ?? price.symbol) + ' (超短期)',
    changePercent: fired.ret * 100,
    windowSeconds: fired.window,
    detectionKind: 'slope',
    direction: fired.ret >= 0 ? 'up' : 'down',
    triggeredAt: now,
    change15min: ctx.change15min,
    pa15min: ctx.pa15min,
    range1h: ctx.range1h,
    zscore: 0,    // 絶対閾値方式のため未使用 (alertLoop の z-score 検知と区別)
  };
  console.log(`[tickDetector] ${price.symbol} ${fired.window}s ${fired.yen >= 0 ? '+' : ''}${Math.round(fired.yen)}円 (threshold ${ABSOLUTE_THRESHOLD_YEN}円)`);
  broadcast({ type: 'alert', payload: alert });
}

// v0.3.33: 価格ボード表示用。NIY=F の直近の動きをアラート2階層に対応して返す。
//   ultraShortYen = 超短期(5/10秒窓の値幅・円, |差|が大きい方) — tickDetector は値幅ベース
//   shortPct      = 短期(直近60秒の変化率 %) — alertLoop 1分burst 相当
// 既存の tick バッファ(2分保持)を再利用。窓に十分なサンプルが無ければ各値 null。
export function getMomentum(symbol: string = 'NIY=F'): { ultraShortYen: number | null; shortPct: number | null } | null {
  const buf = buffers.get(symbol);
  if (!buf || buf.length < 2) return null;
  const last = buf[buf.length - 1]!;
  const now = last.t, cur = last.price;
  const diffOver = (windowMs: number): number | null => {
    const base = findBaselinePrice(buf, now - windowMs);
    if (!base || base.t === now) return null;
    return cur - base.price;
  };
  const diffs = [diffOver(5000), diffOver(10_000)].filter((x): x is number => x !== null);
  const ultraShortYen = diffs.length ? diffs.sort((a, b) => Math.abs(b) - Math.abs(a))[0]! : null;
  const base60 = findBaselinePrice(buf, now - 60_000);
  const shortPct = base60 && base60.price > 0 && base60.t !== now
    ? ((cur - base60.price) / base60.price) * 100
    : null;
  return { ultraShortYen, shortPct };
}

// テスト用
export function _reset(): void { buffers.clear(); }
