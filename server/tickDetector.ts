import type { Price } from './types.js';
import { returns, stdDev, computeContext, type AlertEvent } from './alertDetector.js';
import { getCachedBars } from './loops/alertLoop.js';
import { broadcast } from './sse/broker.js';
import { INSTRUMENTS } from './config.js';
import { isOnCooldown, markFired } from './alertCooldown.js';

// v0.3.17: 超短期 (5s/10s) フラッシュ検知。
// Yahoo 価格の実体キャッシュは 10〜30s 程度なので、それより細かい "真の tick" は捕捉不可だが、
// ニュース反応等で Yahoo キャッシュを通り抜けた急変は拾える。
// めったに発火しないよう K_THRESHOLD=5.0、対象は NIY=F のみ。

const TARGETS = new Set(['NIY=F']);
const BUFFER_MS = 2 * 60 * 1000;          // 2 min 過去サンプル保持
const K_THRESHOLD = 5.0;                   // 1m σ から scale した 5s/10s σ の 5 倍超で発火
const BASELINE_LOOKBACK = 60;              // 1m σ 算出用 (alertLoop と同設定)
const MIN_BASELINE_RETURNS = 10;

interface Tick { t: number; price: number; }
const buffers = new Map<string, Tick[]>();

function getBaselineSigma1m(symbol: string): number | null {
  const bars = getCachedBars(symbol);
  if (bars.length < BASELINE_LOOKBACK + 1) return null;
  const baseline = bars.slice(-(BASELINE_LOOKBACK + 1), -1);
  const r = returns(baseline);
  if (r.length < MIN_BASELINE_RETURNS) return null;
  const s = stdDev(r);
  return s > 0 ? s : null;
}

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

  const sigma1m = getBaselineSigma1m(price.symbol);
  if (sigma1m === null) return;

  // 5s と 10s 双方を評価、より z が高い方を採用
  const candidates: { window: number; ret: number; z: number }[] = [];
  for (const win of [5, 10]) {
    const baseline = findBaselinePrice(buf, now - win * 1000);
    if (!baseline || baseline.price <= 0) continue;
    if (baseline.t === now) continue;       // 同一サンプル
    const ret = (price.price - baseline.price) / baseline.price;
    // ランダムウォーク仮定で 1m σ → win-second σ にスケール: σ_win = σ_1m × √(win/60)
    const sigmaWin = sigma1m * Math.sqrt(win / 60);
    const z = Math.abs(ret) / sigmaWin;
    if (z >= K_THRESHOLD) candidates.push({ window: win, ret, z });
  }
  if (candidates.length === 0) return;
  candidates.sort((a, b) => b.z - a.z);
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
    zscore: fired.z,
  };
  console.log(`[tickDetector] ${price.symbol} ${fired.window}s ${fired.ret >= 0 ? '+' : ''}${(fired.ret * 100).toFixed(3)}% (|z|=${fired.z.toFixed(1)}, σ1m=${(sigma1m * 100).toFixed(4)}%)`);
  broadcast({ type: 'alert', payload: alert });
}

// テスト用
export function _reset(): void { buffers.clear(); }
